import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabase, supabaseConfigured } from "../supabase";
import { auth0Config } from "./config";

const SupabaseCtx = createContext<SupabaseClient | null>(null);

export function SupabaseProvider({ children }: { children: ReactNode }) {
  const { getAccessTokenSilently } = useAuth0();

  const client = useMemo(() => {
    if (!supabaseConfigured) return null;
    return createSupabase(() =>
      getAccessTokenSilently({
        authorizationParams: { audience: auth0Config.audience },
      })
    );
  }, [getAccessTokenSilently]);

  return <SupabaseCtx.Provider value={client}>{children}</SupabaseCtx.Provider>;
}

// Returns the Supabase client, or null if env vars aren't set yet.
export function useSupabase(): SupabaseClient | null {
  return useContext(SupabaseCtx);
}
