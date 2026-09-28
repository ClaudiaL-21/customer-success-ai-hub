import { accountDataSource, loadAccountDataset } from "./_accounts.js";

// The current portfolio is fictional demo data, just like the previous public
// JSON file. Do not add mailbox contents or private customer data to this route
// before introducing authenticated CSM access and account-level authorization.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const data = await loadAccountDataset();
    return res.status(200).json({ ...data, dataSource: accountDataSource() });
  } catch {
    return res.status(503).json({ error: "Account data is currently unavailable. Please try again." });
  }
}
