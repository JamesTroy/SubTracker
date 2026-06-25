import { supabaseAdmin } from "./supabase";

// App-wide toggles, backed by the app_settings table (migration 0005). All reads
// are defensive: if the table isn't there yet (pre-migration) or a read fails,
// strict mode is simply OFF — the app keeps working, it just isn't gated.

export async function getStrictMode(): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin()
      .from("app_settings").select("value").eq("key", "strict_mode").maybeSingle();
    if (error) return false;
    return data?.value === "true";
  } catch {
    return false;
  }
}

export async function setStrictMode(on: boolean): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabaseAdmin()
    .from("app_settings")
    .upsert({ key: "strict_mode", value: on ? "true" : "false", updated_at: new Date().toISOString() }, { onConflict: "key" });
  return error ? { ok: false, error: error.message } : { ok: true };
}
