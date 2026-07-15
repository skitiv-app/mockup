import { useAuth0 } from "@auth0/auth0-react";
import { auth0Config } from "./auth/config";

type Opts = { method?: string; body?: any };

// Calls a /api serverless function with the caller's Auth0 access token.
export function useApi() {
  const { getAccessTokenSilently } = useAuth0();
  return async function call(path: string, opts: Opts = {}) {
    const token = await getAccessTokenSilently({
      authorizationParams: { audience: auth0Config.audience },
    });
    const r = await fetch(path, {
      method: opts.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  };
}

export function isSuperAdminEmail(email?: string | null): boolean {
  if (!email) return false;
  const list = (import.meta.env.VITE_SUPER_ADMIN_EMAILS || "")
    .split(",").map((s) => s.trim().toLowerCase());
  return list.includes(email.toLowerCase());
}
