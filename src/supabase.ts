import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseConfigured = Boolean(url && anonKey);

// Build a Supabase client that attaches the caller's Auth0 access token to
// every request. supabase-js calls `accessToken` before each call, so RLS on
// the server always sees the current Auth0 JWT (org_id + roles claim).
export function createSupabase(
  getToken: () => Promise<string | null>
): SupabaseClient {
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    accessToken: async () => {
      try {
        return await getToken();
      } catch {
        return null;
      }
    },
  });
}
