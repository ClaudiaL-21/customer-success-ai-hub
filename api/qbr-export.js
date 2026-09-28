// QBR Customer Presentation — export endpoint.
//
// Security boundary: this endpoint NEVER reads QBR `internal` text or
// `customerSafeDefault` for any account — it has no code path that could,
// since it never loads a QBR draft at all. It only accepts the exact
// {key, safeText, presentationText, presentationItems} tuples the client
// already produced via selectCustomerSafeSections() (src/qbrPreview.js) in
// the Review/Preview UI. Deterministic account facts (name, health score,
// adoption trend, CSAT, healthScoreHistory) are looked up through the shared
// server-side account loader — never trusted from the client — matching how
// the other AI endpoints resolve accountId, not client-supplied numbers.
//
// 2026-08 Block B — the master-template renderer (src/qbrMasterRenderer.js,
// pptx-automizer against the approved assets/qbr-master/QBR_Customer.pptx)
// replaces the PptxGenJS-built deck for Slides 1, 2, 6, 7. Slides 3-5/8-10
// still pass through the master unmodified (Block C/D will populate them);
// the old src/qbrPresentationMap.js + src/qbrPptxRenderer.js are unused by
// this endpoint now but left in place, not deleted, pending Block C/D.
import { applyGate } from "./_security.js";
import { loadAccountDataset } from "./_accounts.js";
import { QBR_SECTION_DEFS } from "./analyze.js";
import { mapQbrToMasterContent } from "../src/qbrMasterContentMap.js";
import { renderQbrMasterPptx } from "../src/qbrMasterRenderer.js";

const VALID_KEYS = new Set(QBR_SECTION_DEFS.map(d => d.key));
const LIST_CAPABLE_KEYS = new Set(QBR_SECTION_DEFS.filter(d => d.listCapable).map(d => d.key));

// Defensive re-validation of client-supplied section tuples — the app's own
// UI only ever sends what selectCustomerSafeSections() already filtered,
// but this endpoint doesn't trust that; anything malformed is dropped, not
// used to crash or to silently widen what can appear in the deck.
// presentationText/presentationItems are optional (a CSM may not have
// filled them in) — an absent or empty one simply means that PPTX slot is
// omitted, never a fallback to safeText/internal.
function sanitizeSections(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter(s => s && typeof s === "object" && VALID_KEYS.has(s.key) && typeof s.safeText === "string")
    .map(s => ({
      key: s.key,
      safeText: s.safeText.trim(),
      presentationText: typeof s.presentationText === "string" ? s.presentationText.trim().slice(0, 400) : "",
      presentationItems: LIST_CAPABLE_KEYS.has(s.key) && Array.isArray(s.presentationItems)
        ? s.presentationItems.filter(i => typeof i === "string" && i.trim().length > 0).map(i => i.trim().slice(0, 200)).slice(0, 5)
        : [],
    }))
    .filter(s => s.safeText.length > 0 && s.safeText.length <= 1500);
}

function safeFilenamePart(name) {
  return (name || "Account").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "Account";
}

export default async function handler(req, res) {
  if (!applyGate(req, res)) return;

  const { accountId, sections } = req.body || {};
  let data;
  try { data = await loadAccountDataset(); }
  catch { return res.status(503).json({ error: "Account data is currently unavailable. Please try again." }); }
  const account = data.accounts.find(a => a.accountId === accountId);
  if (!account) return res.status(404).json({ error: "Unknown accountId" });

  const cleanSections = sanitizeSections(sections);

  try {
    const { content, warnings } = mapQbrToMasterContent({ account, sections: cleanSections });
    if (warnings.length > 0) {
      return res.status(422).json({
        error: "Reviewed presentation content is too long for the approved layout in one or more slots. Shorten the presentation text in Review and try again.",
        warnings,
      });
    }

    const buffer = await renderQbrMasterPptx(content);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilenamePart(account.accountName)}-Customer-QBR.pptx"`);
    res.status(200);
    return res.end(buffer);
  } catch (err) {
    console.error("qbr-export.js error:", err.message);
    return res.status(500).json({ error: "QBR export failed" });
  }
}
