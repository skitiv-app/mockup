# Mockup Studio -> Vercel + Supabase + Auth0 (with Teams & Roles)

Goal: host the app on Vercel, log users in with Auth0, and persist each
**organization's** mockup library to Supabase (images in Storage, placement
frames in Postgres). Save is triggered when a mockup is **locked**.

Teams: an **owner** account has a shared mockup library and can invite
**sub-users** (members). Members can do everything **except unlock a mockup or
add a new one**. The design is never saved — it is a transient reference used
only to position frames.

---

## 1. Architecture

```
Browser (React SPA)
  |  Auth0 login (into an Organization) -> JWT with `org_id` + roles claim
  |
  |-- Auth0 Organizations (@auth0/auth0-react)
  |     roles: owner | member ; identity + org membership
  |
  |-- supabase-js (configured with the Auth0 token)
  |     |-- Storage bucket `mockups`  -> PNG images, path = {org_id}/{mockupId}.png
  |     \-- Postgres table `mockups`  -> frames (jsonb) + metadata + locked
  |           RLS scopes rows to auth.jwt()->>'org_id'
  |           - INSERT allowed only if role = owner
  |           - trigger blocks members from setting locked true->false
  |
  \-- Vercel serverless functions  (/api/*)  [only for team management]
        use Auth0 Management API (server-side secret) to invite / list /
        remove members and assign roles. Never exposed to the browser.
```

Key points:
- **Data is org-scoped**, not per individual user. Everyone in the org shares
  one mockup library.
- **Supabase** stays client-side for all mockup reads/writes.
- **Vercel functions** exist only for Auth0 org/member management (needs a
  secret). Everything else is the static Vite build.
- **The design is never uploaded or saved.** A mockup = shirt photo + placement
  frames (box x/y/w/h/rotation per shape) + tone + brand. You are building a
  reusable mockup-template library.

---

## 2. Roles & permissions

| Action                          | Owner | Member |
|---------------------------------|:-----:|:------:|
| View mockup library             |  Yes  |  Yes   |
| Drop in a design + export       |  Yes  |  Yes   |
| Move / resize frames            |  Yes  |  Yes   |
| Delete a mockup                 |  Yes  |  Yes*  |
| **Add a new mockup**            |  Yes  |  **No**|
| **Unlock a mockup**             |  Yes  |  **No**|
| Invite / remove sub-users       |  Yes  |  No    |

\* Members can delete per the "everything except unlock/add" choice. To also
block delete, restrict the DELETE policy to owners (one-line change, noted below).

Enforcement:
- **Add (insert)** -> blocked by RLS `with check` requiring the owner role.
- **Unlock** -> blocked by a `BEFORE UPDATE` trigger comparing old/new `locked`
  (RLS can't see the old row, so a trigger is required).
- **Invite/remove** -> only reachable through the Vercel functions, which verify
  the caller is an owner before calling the Auth0 Management API.

---

## 3. What changes in the code (build phase, not now)

Current: everything (mockup base64 images + design + presets + settings) is one
blob in **IndexedDB** via `src/storage.ts`.

New:

| Today (IndexedDB)               | New                                                |
|---------------------------------|----------------------------------------------------|
| one blob, all mockups           | one row per mockup in `mockups`, scoped to `org_id`|
| image as base64 data URL        | image in Storage bucket; row holds the path        |
| saved on every change           | saved when a mockup is **locked**                  |
| no users                        | Auth0 org + roles; RLS + trigger enforce limits    |
| design saved                    | design kept in local React state only, never saved |

Files to edit later:
- `src/main.tsx` — wrap in `<Auth0Provider>` with organization login.
- new `src/supabase.ts` — client using the Auth0 access token.
- new login gate + role context (expose `isOwner`).
- `src/storage.ts` — replace load/save with Supabase (load = org rows + signed
  URLs; save-on-lock = upload image + upsert row with frames).
- `src/App.tsx` / `src/components/MockupCard.tsx` — hide/disable "Add mockup" and
  the unlock control for members; call `saveMockup()` on lock.
- new `src/team/` UI — owner-only: invite member, list members, remove, set role
  (talks to `/api/*`).
- CORS gotcha: images from Supabase need `crossOrigin="anonymous"` in
  `render.ts` or canvas export taints. Private bucket -> use signed URLs.

---

## 4. Supabase setup

### 4a. Project
supabase.com -> New project. Note **Project URL** + **anon public key**
(Settings -> API).

### 4b. Storage bucket
Storage -> New bucket -> `mockups` -> **Private**.

### 4c. Tables
```sql
create table public.mockups (
  id          text primary key,
  org_id      text not null,           -- Auth0 organization id
  created_by  text,                     -- Auth0 sub of creator (info only)
  name        text not null,
  image_path  text not null,           -- "{org_id}/{id}.png"
  width       int  not null,
  height      int  not null,
  tone        text default 'light',
  brand       text default 'Comfort Colors',
  placements  jsonb not null default '{}'::jsonb,   -- the frames
  locked      boolean not null default false,
  updated_at  timestamptz not null default now()
);

-- Optional: shared org presets/settings
create table public.org_state (
  org_id     text primary key,
  presets    jsonb,
  settings   jsonb,
  updated_at timestamptz not null default now()
);

alter table public.mockups   enable row level security;
alter table public.org_state enable row level security;
```

### 4d. Helper (read role from the Auth0 JWT)
Auth0 adds roles as a namespaced claim (see 5c). Treat it as a jsonb array.
```sql
-- true when the logged-in user is an owner of the current org
create or replace function public.is_owner()
returns boolean language sql stable as $$
  select coalesce(
    (auth.jwt() -> 'https://mockupstudio/roles') ? 'owner',
    false
  );
$$;
```

### 4e. RLS policies (org scoping + owner-only insert)
```sql
-- read: any member of the org
create policy "org read" on public.mockups
  for select using (org_id = auth.jwt()->>'org_id');

-- insert (add mockup): owner only
create policy "owner insert" on public.mockups
  for insert with check (
    org_id = auth.jwt()->>'org_id' and public.is_owner()
  );

-- update (edit frames, lock, etc.): any member; unlock blocked by trigger below
create policy "org update" on public.mockups
  for update using (org_id = auth.jwt()->>'org_id')
  with check (org_id = auth.jwt()->>'org_id');

-- delete: any member (change to `and public.is_owner()` to restrict)
create policy "org delete" on public.mockups
  for delete using (org_id = auth.jwt()->>'org_id');

-- org_state: read any member, write owner only
create policy "state read"  on public.org_state
  for select using (org_id = auth.jwt()->>'org_id');
create policy "state write" on public.org_state
  for all using (org_id = auth.jwt()->>'org_id' and public.is_owner())
  with check (org_id = auth.jwt()->>'org_id' and public.is_owner());
```

### 4f. Trigger: members cannot unlock
```sql
create or replace function public.block_member_unlock()
returns trigger language plpgsql as $$
begin
  if not public.is_owner()
     and old.locked = true and new.locked = false then
    raise exception 'Members are not allowed to unlock mockups';
  end if;
  return new;
end $$;

create trigger member_unlock_guard
  before update on public.mockups
  for each row execute function public.block_member_unlock();
```

### 4g. Storage policies (folder = org_id)
```sql
create policy "org files read" on storage.objects
  for select using (
    bucket_id = 'mockups'
    and (storage.foldername(name))[1] = auth.jwt()->>'org_id'
  );

-- upload only by owners (new mockups)
create policy "owner files write" on storage.objects
  for insert with check (
    bucket_id = 'mockups'
    and (storage.foldername(name))[1] = auth.jwt()->>'org_id'
    and public.is_owner()
  );

create policy "org files delete" on storage.objects
  for delete using (
    bucket_id = 'mockups'
    and (storage.foldername(name))[1] = auth.jwt()->>'org_id'
  );
```

### 4h. Trust Auth0
Supabase -> Authentication -> **Third-Party Auth** -> Add **Auth0** ->
enter your Auth0 domain. Now `auth.jwt()` in the policies above resolves Auth0
tokens (including `org_id` and the roles claim).

---

## 5. Auth0 setup

### 5a. SPA application
Applications -> Create -> **Single Page Application**. Set:
- Allowed Callback URLs: `http://localhost:5173`, `https://YOUR-APP.vercel.app`
- Allowed Logout URLs / Web Origins: same two.

### 5b. API (so tokens are access tokens Supabase accepts)
APIs -> Create API -> Identifier (audience): `https://YOUR-PROJECT.supabase.co`.

### 5c. Organizations + roles
1. Enable **Organizations**. Each customer/owner = one Organization.
2. Define two **Roles**: `owner` and `member`.
3. Add an **Action** (Login flow) to put roles into the token:
```js
exports.onExecutePostLogin = async (event, api) => {
  const ns = 'https://mockupstudio/';
  const roles = event.authorization?.roles || [];
  api.accessToken.setCustomClaim(ns + 'roles', roles);
  api.idToken.setCustomClaim(ns + 'roles', roles);
};
```
4. In the SPA, log the user into their organization so the token carries
   `org_id` (use `organization` param, or Auth0's org login prompt).

### 5d. Management API app (for invites, server-side only)
APIs -> Auth0 Management API -> Machine-to-Machine app, grant scopes:
`read:organization_members`, `create:organization_invitations`,
`delete:organization_members`, `read:organization_member_roles`,
`create:organization_member_roles`. Note its **Client ID + Secret** — used only
by the Vercel functions.

---

## 6. Vercel serverless functions (team management)

Put these in `/api` (Vercel auto-detects). Each one: (1) verifies the caller's
Auth0 token, (2) checks the caller is an **owner** of the target org, (3) calls
the Auth0 Management API with the M2M secret.

- `POST /api/invite-member`   -> create org invitation (email + role)
- `GET  /api/members`         -> list org members + roles
- `POST /api/set-role`        -> change a member's role
- `POST /api/remove-member`   -> remove a member

The Management secret lives only in Vercel env vars, never in the browser.

---

## 7. Vercel env vars
```
# client (VITE_ prefix = exposed to browser, safe/public)
VITE_SUPABASE_URL      = https://YOUR-PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY = <anon public key>
VITE_AUTH0_DOMAIN      = your-tenant.us.auth0.com
VITE_AUTH0_CLIENT_ID   = <SPA client id>
VITE_AUTH0_AUDIENCE    = https://YOUR-PROJECT.supabase.co

# server only (NO VITE_ prefix = never sent to browser)
AUTH0_MGMT_CLIENT_ID     = <M2M client id>
AUTH0_MGMT_CLIENT_SECRET = <M2M secret>
AUTH0_DOMAIN             = your-tenant.us.auth0.com
```

---

## 8. Save-on-lock flow
1. Owner fixes the frames on a mockup and clicks lock.
2. App turns the mockup image data URL -> Blob.
3. Upload to `mockups/{org_id}/{mockupId}.png` (skip if already there).
4. Upsert the `mockups` row: `placements` (frames), `tone`, `brand`,
   `locked = true`, `org_id`.
5. Load on startup: fetch the org's rows, sign each image URL, rebuild mockups.
   Members see the same library; add/unlock controls are hidden for them and
   also enforced by RLS + trigger server-side.

---

## 9. Exporting finished images (NOT stored)
Finished PNGs are regenerated in-browser (source + design + frames + realism)
and written straight to a **local folder the user picks**, as individual files:
1. `window.showDirectoryPicker()` once -> user picks folder (one permission).
2. Per selected mockup: render PNG -> `getFileHandle(name,{create:true})` ->
   `createWritable()` -> `write(blob)`. No per-file prompt, no zip.
3. Persist the dir handle in IndexedDB to reuse next time.
Chromium only; Firefox/Safari fall back to individual downloads. `jszip` can be
dropped.

---

## 10. Build order
1. Auth0 SPA + Organizations login gate; expose `isOwner`. Verify org login works.
2. Supabase client + tables/policies/trigger; verify RLS with an owner and a member.
3. Image upload + save-on-lock (owner).
4. Load-on-startup (org rows + signed URLs, `crossOrigin`).
5. Member UI limits (hide add/unlock) + owner team-management UI.
6. Vercel `/api/*` functions for Auth0 Management (invite/list/remove/role).
7. Deploy, update Auth0 URLs, test end-to-end with an owner + a member.

## Dependencies (build phase)
```
npm i @supabase/supabase-js @auth0/auth0-react
# server-side, for /api functions:
npm i auth0 jose
```
