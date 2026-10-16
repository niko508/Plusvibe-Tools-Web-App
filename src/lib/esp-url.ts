// Reading the ESP app's address out of ESP_APP_URL. Kept apart from
// esp-app.ts, which is server-only, so it can be checked on its own.

/**
 * The app's address from a variable as people actually paste it: the whole
 * "NAME=value" line, in quotes, or with a path on the end are all taken to
 * mean the address. Empty when there's nothing usable.
 */
export function cleanEspUrl(raw: string | undefined): string {
  let v = (raw ?? "").trim();
  v = v.replace(/^[A-Z_][A-Z0-9_]*\s*=\s*/, "").trim();
  v = v.replace(/^(["'])(.*)\1$/, "$2").trim();
  if (!v) return "";
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  try {
    const u = new URL(v);
    if (!u.hostname.includes(".") && u.hostname !== "localhost") return "";
    return u.origin;
  } catch {
    return "";
  }
}
