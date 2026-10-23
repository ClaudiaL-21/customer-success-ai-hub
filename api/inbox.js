import { requireDemoAdmin } from "./_auth.js";
import { loadInboxDataset } from "./_accounts.js";

// Sprint 15C — now carries the same requireDemoAdmin identity check as Gate
// 1/2 (api/_auth.js) instead of being open like api/accounts.js: this data
// exists specifically to support a later step (surfacing sender_email for
// unknown/ambiguous signals) that needs the endpoint itself to refuse an
// unauthenticated caller, not just the SPA's own login screen. The
// service-role key still never leaves _accounts.js; nothing here forwards it.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const user = await requireDemoAdmin(req, res);
  if (!user) return;
  try {
    const signals = await loadInboxDataset();
    return res.status(200).json({ signals });
  } catch {
    return res.status(503).json({ error: "Inbox data is currently unavailable. Please try again." });
  }
}
