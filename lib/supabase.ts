import { createClient } from "@supabase/supabase-js";

// Server-only client. Uses the service-role key — never import this into a
// client component. Single-user app: access is gated by being server-side.
export function supabaseAdmin() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}
