// Auth0 configuration pulled from Vite env vars (see .env.example).
// The roles claim is namespaced; it must match the Auth0 Login Action.
export const ROLES_CLAIM = "https://mockupstudio/roles";

export const auth0Config = {
  domain: import.meta.env.VITE_AUTH0_DOMAIN,
  clientId: import.meta.env.VITE_AUTH0_CLIENT_ID,
  audience: import.meta.env.VITE_AUTH0_AUDIENCE,
  organization: import.meta.env.VITE_AUTH0_ORGANIZATION || undefined,
};

// True when the essential Auth0 env vars are present. Lets us show a helpful
// message instead of a blank screen when the app is misconfigured.
export const auth0Configured = Boolean(
  auth0Config.domain && auth0Config.clientId && auth0Config.audience
);
