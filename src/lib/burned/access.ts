import "server-only";

import { PlusvibeError, requireAccountKey, resolveApiKey } from "@/lib/plusvibe-server";
import { accessFor, type Access } from "@/lib/jobs/burned";

// Who is asking about burned scans and removals.
//
// Everyone sees what their own key started. The weekly run's scans are
// started with the server's key, so they are shown to any key that is for
// the same Plusvibe account — the same check the other unattended
// automations' logs use. A key for another account, or Plusvibe being
// unreachable for the check, just means the weekly scans are not shown.

export async function burnedAccess(request: Request): Promise<{ apiKey: string; who: Access }> {
  const apiKey = resolveApiKey(request);
  let account = false;
  if (process.env.PLUSVIBE_API_KEY?.trim()) {
    try {
      await requireAccountKey(request);
      account = true;
    } catch (err) {
      if (!(err instanceof PlusvibeError)) throw err;
    }
  }
  return { apiKey, who: accessFor(apiKey, account) };
}
