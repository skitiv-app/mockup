// Auth0 configuration pulled from Vite env vars (see .env.example).
// The roles claim is namespaced; it must match the Auth0 Login Action.
export const ROLES_CLAIM = "https://mockupstudio/roles";

export const auth0Config = {
  domain: import.meta.env.VITE_AUTH0_DOMAIN,
  clientId: import.meta.env.VITE_AUTH0_CLIENT_ID,
  // Optional: only needed once Supabase is wired (Phase 2). Empty -> undefined
  // so basic login (ID token only) works without a registered API/audience.
  audience: import.meta.env.VITE_AUTH0_AUDIENCE || undefined,
  organization: import.meta.env.VITE_AUTH0_ORGANIZATION || undefined,
};

// Login only needs domain + clientId. Audience is validated later.
export const auth0Configured = Boolean(
  auth0Config.domain && auth0Config.clientId
);
