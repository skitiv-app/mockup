import type { ReactNode } from "react";
import { Auth0Provider } from "@auth0/auth0-react";
import { auth0Config } from "./config";

// Wraps the app in Auth0. Requests an access token for the Supabase audience so
// the same token can be handed to supabase-js later (Phase 2).
export default function AuthProvider({ children }: { children: ReactNode }) {
  return (
    <Auth0Provider
      domain={auth0Config.domain}
      clientId={auth0Config.clientId}
      authorizationParams={{
        redirect_uri: window.location.origin,
        audience: auth0Config.audience,
      }}
      cacheLocation="localstorage"
      useRefreshTokens
    >
      {children}
    </Auth0Provider>
  );
}
