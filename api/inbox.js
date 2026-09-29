import { loadInboxDataset } from "./_accounts.js";

// Same shape/security posture as api/accounts.js: read-only, GET, no auth
// gate of its own (this data carries no sender email or other raw contact
// data — hub_inbox_dataset() never returns it, see Package 2 — and the
// whole app already sits behind the Sprint 16 login gate in index.html).
// The service-role key never leaves _accounts.js; nothing here forwards it.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const signals = await loadInboxDataset();
    return res.status(200).json({ signals });
  } catch {
    return res.status(503).json({ error: "Inbox data is currently unavailable. Please try again." });
  }
}
