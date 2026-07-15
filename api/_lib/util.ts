// Shared helpers for the serverless API (Auth0 Management + Supabase service role).
import { jwtVerify, createRemoteJWKSet, type JWTPayload } from "jose";

const DOMAIN = process.env.AUTH0_DOMAIN!;
const ISSUER = `https://${DOMAIN}/`;
const AUDIENCE = process.env.AUTH0_AUDIENCE!;
const MGMT = `https://${DOMAIN}/api/v2`;
export const DB_CONNECTION_NAME = "Username-Password-Authentication";

const JWKS = createRemoteJWKSet(new URL(`${ISSUER}.well-known/jwks.json`));

// Verify an incoming Auth0 access token. Returns claims or null.
export async function verifyAuth(req: any): Promise<JWTPayload | null> {
  const h = (req.headers.authorization as string) || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    return payload;
  } catch {
    return null;
  }
}

// --- Auth0 Management API (client-credentials, cached) ---
let mgmtToken: { value: string; exp: number } | null = null;
async function getMgmtToken(): Promise<string> {
  if (mgmtToken && Date.now() < mgmtToken.exp) return mgmtToken.value;
  const r = await fetch(`https://${DOMAIN}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.AUTH0_MGMT_CLIENT_ID,
      client_secret: process.env.AUTH0_MGMT_CLIENT_SECRET,
      audience: `${MGMT}/`,
      grant_type: "client_credentials",
    }),
  });
  const j = await r.json();
  mgmtToken = { value: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return mgmtToken.value;
}

export async function mgmt(method: string, path: string, body?: any) {
  const token = await getMgmtToken();
  const r = await fetch(`${MGMT}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: r.status, data };
}

// --- Supabase REST via service role (bypasses RLS) ---
export async function supaRest(method: string, path: string, body?: any, extraHeaders: Record<string,string> = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: r.status, data };
}

// Email of a user by Auth0 sub.
export async function userEmail(sub: string): Promise<string | null> {
  const { status, data } = await mgmt("GET", `/users/${encodeURIComponent(sub)}?fields=email&include_fields=true`);
  return status === 200 ? (data?.email ?? null) : null;
}

export function isSuperAdmin(email: string | null): boolean {
  if (!email) return false;
  const list = (process.env.SUPER_ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase());
  return list.includes(email.toLowerCase());
}

export function json(res: any, status: number, body: any) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

// Body parsing that works whether or not the runtime pre-parses req.body.
export async function readJson(req: any): Promise<any> {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch { return {}; }
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

export function queryParam(req: any, key: string): string | undefined {
  try {
    if (req.query && typeof req.query === "object" && req.query[key] != null)
      return String(req.query[key]);
    const u = new URL(req.url, "http://localhost");
    return u.searchParams.get(key) ?? undefined;
  } catch { return undefined; }
}

export function slug(s: string): string {
  return (s || "workspace").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "workspace";
}

export function randomPassword(): string {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%";
  let p = "";
  for (let i = 0; i < 24; i++) p += c[Math.floor(Math.random() * c.length)];
  return p + "aA1!";
}

// Find an Auth0 user by email, or create one in the DB connection. Returns user_id.
export async function findOrCreateUser(email: string): Promise<string> {
  const q = await mgmt("GET", `/users-by-email?email=${encodeURIComponent(email)}`);
  if (q.status === 200 && Array.isArray(q.data) && q.data.length) return q.data[0].user_id;
  const c = await mgmt("POST", "/users", {
    email,
    connection: DB_CONNECTION_NAME,
    password: randomPassword(),
    email_verified: false,
    verify_email: false,
  });
  if (c.status === 201) return c.data.user_id;
  // race: created between calls
  const q2 = await mgmt("GET", `/users-by-email?email=${encodeURIComponent(email)}`);
  if (q2.status === 200 && Array.isArray(q2.data) && q2.data.length) return q2.data[0].user_id;
  throw new Error(`create user failed: ${c.status} ${JSON.stringify(c.data)}`);
}

// Password setup link the admin/owner can send to a new user.
export async function passwordTicket(userId: string): Promise<string | null> {
  const t = await mgmt("POST", "/tickets/password-change", {
    user_id: userId,
    mark_email_as_verified: true,
    ttl_sec: 7 * 24 * 3600,
  });
  return t.status === 201 ? t.data.ticket : null;
}

// The caller's org + role, resolved from their Auth0 sub.
export async function resolveUserOrg(sub: string): Promise<{ orgId: string; orgName: string; roles: string[] } | null> {
  const o = await mgmt("GET", `/users/${encodeURIComponent(sub)}/organizations`);
  if (o.status !== 200 || !Array.isArray(o.data) || !o.data.length) return null;
  const org = o.data[0];
  const r = await mgmt("GET", `/organizations/${org.id}/members/${encodeURIComponent(sub)}/roles`);
  const roles = r.status === 200 && Array.isArray(r.data) ? r.data.map((x: any) => x.name) : [];
  return { orgId: org.id, orgName: org.display_name || org.name, roles };
}
