// Service-role Supabase client for privileged writes (paddle-webhook only).
//
// Deliberately uses the classic, long-stable `createClient` from
// @supabase/supabase-js directly, rather than relying on the newer
// `@supabase/server` convenience wrapper's admin-client shortcut — this
// function's correctness (writing verified subscription state) matters more
// than staying on the newest helper surface, and `createClient` with a
// service-role key is the unambiguous, fully-documented way to get a client
// that bypasses Row Level Security. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
// are both injected automatically into every Edge Function by Supabase; do
// not set them manually as Function secrets, and never send this client's
// key to any client application.
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

export function createServiceRoleClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not available in this environment.");
  }
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
