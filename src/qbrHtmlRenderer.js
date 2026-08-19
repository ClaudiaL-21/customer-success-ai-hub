// HTML QBR spike — renders the 3-page web presentation from the content
// produced by src/qbrHtmlContentMap.js. Pure function returning a
// self-contained HTML document string (own <style>, no external assets),
// so it can be opened directly in a new tab via a Blob URL. Reuses the
// approved CUSTOMER SUCCESS AI | HUB LIGHT design tokens (see src/styles.css)
// and, for the icon-badge/KPI-tile/Fact-Interpretation-Recommendation card
// language, the approved QBR visual reference (qbr-klickdummy) — hand-drawn
// monoline SVG icons here, not copied art, since the reference is images-only.
//
// No new LLM call happens here or anywhere in this module — every string is
// either a deterministic account fact or reviewed presentationText/
// presentationItems/safeText already produced upstream. Owner/Due Date/
// Status columns from the reference's commitments table are deliberately
// NOT reproduced — no field exists for them (same decision as the PPTX path).
import { REFERENCE_DATE_ISO } from "./scoring.js";

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function quarterOf(dateISO) {
  const d = new Date(dateISO);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `Q${q} ${d.getUTCFullYear()}`;
}

// Small monoline icon set, single <path>/<circle> per glyph, currentColor
// stroke — stylistically consistent with the approved reference, not traced
// from it (the reference is flattened PNG slides, nothing to trace).
const ICON = {
  trendUp: '<path d="M4 16l5-5 4 4 7-8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 7h5v5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  users: '<circle cx="9" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3.5 20c0-3.3 2.5-6 5.5-6s5.5 2.7 5.5 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="17.5" cy="9" r="2.3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15.3 20c0-2.6 1.1-4.6 3.2-5.1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  chat: '<path d="M4 5.5h16v11H9l-4 3.5v-3.5H4v-11z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  check: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 12.5l2.5 2.5L16 9.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  target: '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
  chart: '<path d="M4 20V11M10.5 20V4M17 20v-8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M3 20h18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  heart: '<path d="M12 20s-7-4.2-9-8.1C1.4 8.6 3.4 5.5 6.6 5.5c2 0 3.5 1.4 5.4 3.6 1.9-2.2 3.4-3.6 5.4-3.6 3.2 0 5.2 3.1 3.6 6.4C19 15.8 12 20 12 20z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
};

function iconSvg(name) {
  return `<svg viewBox="0 0 24 24" width="22" height="22">${ICON[name] || ""}</svg>`;
}

function badge(name, colorClass) {
  return `<span class="icon-badge ${colorClass}">${iconSvg(name)}</span>`;
}

const SENTIMENT_LABEL = { frustrated: "Frustrated", neutral: "Neutral", patient: "Patient" };
// Deliberately muted, not alarming — no red/neon. Frustrated reads as an
// amber signal (attention-worthy, not a crisis), patient/neutral as calm.
const SENTIMENT_CLASS = { frustrated: "sentiment-amber", neutral: "sentiment-slate", patient: "sentiment-teal" };

function pageHeader(eyebrow, title) {
  return `
    <header class="page-head">
      <p class="eyebrow">${escapeHtml(eyebrow)}</p>
      <h1 class="page-title">${escapeHtml(title)}</h1>
    </header>`;
}

function kpiTile(icon, colorClass, value, unit, label, caption) {
  return `
    <div class="kpi-tile">
      ${badge(icon, colorClass)}
      <div class="kpi-tile-body">
        <div class="kpi-label">${escapeHtml(label)}</div>
        <div class="kpi-value">${escapeHtml(value)}${unit ? `<span class="kpi-unit">${escapeHtml(unit)}</span>` : ""}</div>
        ${caption ? `<div class="kpi-caption">${escapeHtml(caption)}</div>` : ""}
      </div>
    </div>`;
}

function renderPage1(p1) {
  const hasInterpretation = Boolean(p1.adoptionInterpretationText);
  const hasFeatureRequest = Boolean(p1.topFeatureRequestText);
  const sentimentKey = p1.featureRequestSentiment;
  const sentimentBadge = sentimentKey && SENTIMENT_LABEL[sentimentKey]
    ? `<span class="sentiment-badge ${SENTIMENT_CLASS[sentimentKey]}">${escapeHtml(SENTIMENT_LABEL[sentimentKey])}</span>`
    : "";
  const evidenceBits = [
    typeof p1.featureRequestsCount === "number" ? `${p1.featureRequestsCount} request${p1.featureRequestsCount === 1 ? "" : "s"}` : null,
    p1.featureRequestSinceText,
  ].filter(Boolean).join(" · ");

  return `
    <section class="page page-adoption${hasFeatureRequest ? "" : " no-feature-card"}">
      ${pageHeader("Quarterly review", "Adoption & Product Feedback")}
      <div class="page-body two-col">
        <div class="col col-adoption">
          <div class="kpi-row">
            ${p1.adoptionRatePct != null ? kpiTile("trendUp", "badge-teal", p1.adoptionRatePct, "%", "Adoption Rate", "of licensed capacity") : ""}
            ${p1.activeUsers != null ? kpiTile("users", "badge-teal", p1.activeUsers, "", "Active Users", "currently active") : ""}
          </div>
          ${hasInterpretation ? `
          <div class="insight-card insight-teal">
            <p class="insight-head">${badge("chart", "badge-teal")}<span>Interpretation</span></p>
            <p class="insight-text">${escapeHtml(p1.adoptionInterpretationText)}</p>
          </div>` : ""}
        </div>
        ${hasFeatureRequest ? `
        <div class="col col-feature">
          <div class="feature-card">
            <p class="feature-card-eyebrow">${badge("chat", "badge-on-teal")}<span>Product Feedback</span></p>
            <p class="feature-quote">&ldquo;${escapeHtml(p1.topFeatureRequestText)}&rdquo;</p>
            <div class="feature-meta">
              ${sentimentBadge}
              ${evidenceBits ? `<span class="feature-evidence">${escapeHtml(evidenceBits)}</span>` : ""}
            </div>
          </div>
        </div>` : ""}
      </div>
    </section>`;
}

function commitmentDensityClass(n) {
  if (n <= 1) return "density-1";
  if (n <= 3) return "density-2-3";
  return "density-4-5";
}

function renderPage2(p2) {
  const items = p2.commitmentItems || [];
  const cols = items.length <= 1 ? 1 : items.length <= 3 ? items.length : 2;
  const body = items.length
    ? `<div class="commitments-grid ${commitmentDensityClass(items.length)}" style="--cols:${cols}">
        ${items.map((text, i) => `
          <div class="commitment-card">
            ${badge("check", "badge-teal")}
            <p class="commitment-text">${escapeHtml(text)}</p>
          </div>`).join("")}
      </div>`
    : `<p class="empty-state">No open commitments in the reviewed content.</p>`;

  return `
    <section class="page page-commitments">
      ${pageHeader("Quarterly review", "Open Commitments & Actions")}
      <div class="page-body">${body}</div>
    </section>`;
}

function csatDots(current) {
  if (current == null) return "";
  const dots = [1, 2, 3, 4, 5].map(n => `<span class="csat-dot${n <= Math.round(current) ? " filled" : ""}"></span>`).join("");
  return `<div class="csat-dots">${dots}</div>`;
}

function renderPage3(p3) {
  const hasObjective = Boolean(p3.businessObjectivesText);
  const hasValue = Boolean(p3.valueDeliveredFullText);
  const hasCsat = p3.csatCurrent != null;
  const deltaText = p3.csatDelta != null
    ? `<span class="csat-delta ${p3.csatDelta >= 0 ? "csat-delta-up" : "csat-delta-down"}">${p3.csatDelta >= 0 ? "+" : ""}${p3.csatDelta.toFixed(1)}</span>`
    : "";

  return `
    <section class="page page-objectives">
      ${pageHeader("Quarterly review", "Business Objectives & Value")}
      <div class="page-body three-col">
        ${hasObjective ? `
        <div class="col col-objective">
          <div class="objective-card">
            <p class="insight-head">${badge("target", "badge-violet")}<span>Business Objective</span></p>
            <p class="objective-text">${escapeHtml(p3.businessObjectivesText)}</p>
          </div>
        </div>` : ""}
        ${hasValue ? `
        <div class="col col-value">
          <div class="value-card">
            <p class="insight-head">${badge("chart", "badge-teal")}<span>Value Delivered</span></p>
            <p class="value-text">${escapeHtml(p3.valueDeliveredFullText)}</p>
          </div>
        </div>` : ""}
        ${hasCsat ? `
        <div class="col col-csat">
          <div class="csat-card">
            <p class="insight-head">${badge("heart", "badge-blue")}<span>Current CSAT</span></p>
            <div class="csat-value">${p3.csatCurrent.toFixed(1)}<span class="csat-scale">/5</span> ${deltaText}</div>
            ${csatDots(p3.csatCurrent)}
          </div>
        </div>` : ""}
      </div>
    </section>`;
}

const STYLE = `
  :root {
    --navy: #25333a; --teal: #007f83; --teal-bg: #e5f3f3; --mint: #a9e5d3;
    --clarity-blue: #226fbd; --clarity-blue-bg: #eaf2fa;
    --insight-violet: #7462a6; --violet-bg: #f1eefa;
    --canvas: #f7faf9; --canvas-alt: #eef3f1; --text: #1f2937; --muted: #6b7280;
    --border: #e5e7eb; --amber: #b6790a; --amber-bg: #fbf3e2;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--navy); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }
  body { display: flex; flex-direction: column; }

  /* Persistent top navigation — same "wordmark left, page links, context
     right" shape as the approved qbr-klickdummy reference nav, adapted with
     real customer context (account name/industry/CSM) instead of a static
     "Start" link list. --topnav-h is subtracted from the deck viewport so
     the 16:9 stage below still fits without scrolling. */
  :root { --topnav-h: 52px; }
  .topnav { height: var(--topnav-h); flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 0 20px; background: var(--navy); color: #e7eef5; z-index: 10; }
  .topnav-brand { font-size: 12.5px; font-weight: 800; letter-spacing: 0.04em; white-space: nowrap; }
  .topnav-brand span { color: var(--mint); }
  .topnav-links { display: flex; gap: 4px; }
  .topnav-link { font: inherit; font-size: 12.5px; font-weight: 600; color: rgba(231,238,245,0.65); background: none; border: none; border-bottom: 2px solid transparent; padding: 6px 10px; cursor: pointer; white-space: nowrap; }
  .topnav-link:hover { color: #fff; }
  .topnav-link.active { color: #fff; border-bottom-color: var(--mint); }
  .topnav-customer { display: flex; align-items: baseline; gap: 8px; font-size: 12px; text-align: right; min-width: 0; }
  .topnav-customer-name { font-weight: 700; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .topnav-customer-meta { color: rgba(231,238,245,0.6); white-space: nowrap; }

  .deck-viewport { height: calc(100vh - var(--topnav-h)); display: flex; align-items: center; justify-content: center; overflow: hidden; }
  .deck-stage { position: relative; width: min(100vw, calc((100vh - var(--topnav-h)) * 16 / 9)); height: min(calc(100vh - var(--topnav-h)), calc(100vw * 9 / 16)); background: linear-gradient(180deg, var(--canvas-alt) 0%, var(--canvas) 22%); box-shadow: 0 20px 60px rgba(0,0,0,0.35); overflow: hidden; }
  .page { position: absolute; inset: 0; display: none; flex-direction: column; padding: 4.5% 5.5%; }
  .page.active { display: flex; }
  .page-head { flex: 0 0 auto; margin-bottom: 2%; padding-bottom: 1.2%; border-bottom: 2px solid var(--teal); }
  .eyebrow { margin: 0 0 2px; font-size: clamp(10px, 1.2vw, 13px); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--teal); }
  .page-title { margin: 0; font-size: clamp(22px, 3.4vw, 38px); font-weight: 800; color: var(--navy); letter-spacing: -0.01em; }
  .page-body { flex: 1 1 auto; display: flex; min-height: 0; }
  .page-body.two-col { gap: 3.5%; }
  .page-body.three-col { gap: 3%; }
  .col { display: flex; flex-direction: column; min-width: 0; }
  .col-adoption { flex: 1 1 55%; justify-content: flex-start; gap: 3%; }
  .col-feature { flex: 1 1 45%; justify-content: center; }

  .icon-badge { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 2.4em; height: 2.4em; border-radius: 50%; }
  .badge-teal { background: var(--teal-bg); color: var(--teal); }
  .badge-blue { background: var(--clarity-blue-bg); color: var(--clarity-blue); }
  .badge-violet { background: var(--violet-bg); color: var(--insight-violet); }
  .badge-on-teal { background: rgba(255,255,255,0.6); color: var(--teal); }

  .kpi-row { display: flex; gap: 3.5%; }
  .kpi-tile { flex: 1; display: flex; align-items: center; gap: 12px; background: #fff; border: 1px solid var(--border); border-radius: 14px; padding: 5.5% 5%; box-shadow: 0 6px 18px rgba(15,23,42,0.06); }
  .kpi-label { font-size: clamp(10px, 1.1vw, 12.5px); font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.03em; }
  .kpi-value { font-size: clamp(24px, 4vw, 40px); font-weight: 800; color: var(--navy); line-height: 1.15; }
  .kpi-unit { font-size: 0.55em; font-weight: 700; color: var(--teal); margin-left: 2px; }
  .kpi-caption { font-size: clamp(9.5px, 1vw, 11.5px); color: var(--muted); font-weight: 500; }

  .insight-card { border-radius: 14px; padding: 5% 5.5%; border: 1px solid var(--border); background: #fff; }
  .insight-teal { border-top: 3px solid var(--teal); }
  .insight-head { display: flex; align-items: center; gap: 10px; margin: 0 0 3%; font-size: clamp(11px, 1.25vw, 13.5px); font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--teal); }
  .insight-text { margin: 0; font-size: clamp(13px, 1.55vw, 16.5px); line-height: 1.6; color: var(--text); }

  .feature-card { height: 100%; display: flex; flex-direction: column; justify-content: center; background: linear-gradient(165deg, var(--teal-bg) 0%, #fff 68%); border: 1px solid var(--teal); border-radius: 16px; padding: 7%; box-shadow: 0 8px 24px rgba(0,127,131,0.12); }
  .feature-card-eyebrow { display: flex; align-items: center; gap: 10px; margin: 0 0 5%; font-size: clamp(10px, 1.2vw, 13px); font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--teal); }
  .feature-quote { margin: 0 0 5%; font-size: clamp(15px, 2vw, 21px); font-weight: 600; line-height: 1.4; color: var(--navy); }
  .feature-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .sentiment-badge { font-size: clamp(10px, 1.1vw, 12px); font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; padding: 5px 12px; border-radius: 999px; }
  .sentiment-amber { background: var(--amber-bg); color: var(--amber); }
  .sentiment-slate { background: var(--canvas-alt); color: var(--navy); }
  .sentiment-teal { background: var(--teal-bg); color: var(--teal); }
  .feature-evidence { font-size: clamp(11px, 1.2vw, 13px); color: var(--muted); }
  .no-feature-card .col-adoption { flex: 1 1 100%; }

  .commitments-grid { display: grid; gap: 3.5%; width: 100%; align-content: center; }
  .density-1 { grid-template-columns: 1fr; }
  .density-1 .commitment-card { padding: 5.5%; }
  .density-1 .commitment-text { font-size: clamp(17px, 2.4vw, 25px); }
  .density-2-3 { grid-template-columns: repeat(var(--cols, 2), 1fr); align-items: stretch; }
  .density-4-5 { grid-template-columns: repeat(2, 1fr); }
  .commitment-card { display: flex; align-items: flex-start; gap: 14px; background: #fff; border: 1px solid var(--border); border-radius: 12px; padding: 4.5% 5%; box-shadow: 0 4px 14px rgba(15,23,42,0.06); }
  .commitment-text { margin: 0.15em 0 0; font-size: clamp(13px, 1.5vw, 17px); line-height: 1.5; color: var(--text); font-weight: 500; }
  .empty-state { margin: auto; color: var(--muted); font-size: 16px; }

  .col-objective { flex: 1 1 40%; justify-content: center; }
  .col-value { flex: 1 1 35%; justify-content: center; }
  .col-csat { flex: 1 1 25%; justify-content: center; }
  .objective-card, .value-card, .csat-card { background: #fff; border: 1px solid var(--border); border-radius: 16px; padding: 8% 7%; box-shadow: 0 6px 18px rgba(15,23,42,0.06); width: 100%; }
  .objective-card { border-top: 3px solid var(--insight-violet); }
  .value-card { border-top: 3px solid var(--teal); }
  .csat-card { border-top: 3px solid var(--clarity-blue); }
  .objective-card .insight-head { color: var(--insight-violet); }
  .value-card .insight-head { color: var(--teal); }
  .csat-card .insight-head { color: var(--clarity-blue); }
  .objective-text { margin: 0; font-size: clamp(15px, 2.1vw, 22px); font-weight: 700; line-height: 1.45; color: var(--navy); }
  .value-text { margin: 0; font-size: clamp(13px, 1.5vw, 16px); line-height: 1.6; color: var(--text); }
  .csat-value { font-size: clamp(26px, 3.8vw, 42px); font-weight: 800; color: var(--navy); display: flex; align-items: baseline; gap: 8px; }
  .csat-scale { font-size: 0.4em; font-weight: 700; color: var(--muted); }
  .csat-delta { font-size: clamp(13px, 1.5vw, 16px); font-weight: 700; }
  .csat-delta-up { color: var(--teal); }
  .csat-delta-down { color: var(--amber); }
  .csat-dots { display: flex; gap: 6px; margin-top: 10px; }
  .csat-dot { width: 12px; height: 12px; border-radius: 50%; background: var(--canvas-alt); border: 1px solid var(--border); }
  .csat-dot.filled { background: var(--clarity-blue); border-color: var(--clarity-blue); }

  .page-footer { position: absolute; left: 5.5%; right: 5.5%; bottom: 2.8%; display: flex; justify-content: space-between; align-items: center; font-size: clamp(9.5px, 0.95vw, 11px); color: var(--muted); z-index: 3; }
  .page-footer-brand { font-weight: 700; letter-spacing: 0.03em; }
  .page-footer-brand span { color: var(--teal); }

  .deck-nav { position: absolute; left: 0; right: 0; bottom: 1%; display: flex; align-items: center; justify-content: center; gap: 16px; z-index: 5; }
  .deck-nav button { font: inherit; font-weight: 700; font-size: 13px; letter-spacing: 0.02em; color: var(--navy); background: rgba(255,255,255,0.85); border: 1px solid var(--border); border-radius: 999px; padding: 8px 18px; cursor: pointer; }
  .deck-nav button:hover { background: #fff; border-color: var(--teal); color: var(--teal); }
  .deck-nav button:disabled { opacity: 0.35; cursor: default; }
  .deck-nav .deck-page-count { font-size: 12px; color: var(--muted); font-weight: 600; }
`;

const SCRIPT = `
  (function () {
    var pages = Array.prototype.slice.call(document.querySelectorAll(".page"));
    var navLinks = Array.prototype.slice.call(document.querySelectorAll(".topnav-link"));
    var idx = 0;
    var counter = document.getElementById("deck-page-count");
    var prevBtn = document.getElementById("deck-prev");
    var nextBtn = document.getElementById("deck-next");
    function render() {
      pages.forEach(function (p, i) { p.classList.toggle("active", i === idx); });
      navLinks.forEach(function (l, i) { l.classList.toggle("active", i === idx); });
      counter.textContent = (idx + 1) + " / " + pages.length;
      prevBtn.disabled = idx === 0;
      nextBtn.disabled = idx === pages.length - 1;
    }
    function goTo(i) { idx = i; render(); }
    prevBtn.addEventListener("click", function () { if (idx > 0) goTo(idx - 1); });
    nextBtn.addEventListener("click", function () { if (idx < pages.length - 1) goTo(idx + 1); });
    navLinks.forEach(function (l, i) { l.addEventListener("click", function () { goTo(i); }); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight") { if (idx < pages.length - 1) goTo(idx + 1); }
      if (e.key === "ArrowLeft") { if (idx > 0) goTo(idx - 1); }
    });
    render();
  })();
`;

const NAV_PAGES = [
  { id: "page-adoption", label: "Adoption & Feedback" },
  { id: "page-commitments", label: "Commitments" },
  { id: "page-objectives", label: "Objectives & Value" },
];

export function renderQbrHtml({ account, content, csmName }) {
  const pagesHtml = [renderPage1(content.page1), renderPage2(content.page2), renderPage3(content.page3)].join("\n");
  const title = `${account?.accountName || "Customer"} — Web QBR`;
  const footer = `
    <div class="page-footer">
      <span>${escapeHtml(account?.accountName || "")} · ${escapeHtml(quarterOf(REFERENCE_DATE_ISO))}</span>
      <span class="page-footer-brand">CUSTOMER SUCCESS <span>AI | HUB</span></span>
    </div>`;
  const customerMeta = [account?.industry, csmName ? `CSM: ${csmName}` : null].filter(Boolean).join(" · ");
  const topnav = `
    <nav class="topnav">
      <span class="topnav-brand">CUSTOMER SUCCESS <span>AI | HUB</span></span>
      <div class="topnav-links">
        ${NAV_PAGES.map(p => `<button type="button" class="topnav-link">${escapeHtml(p.label)}</button>`).join("")}
      </div>
      <div class="topnav-customer">
        <span class="topnav-customer-name">${escapeHtml(account?.accountName || "")}</span>
        ${customerMeta ? `<span class="topnav-customer-meta">${escapeHtml(customerMeta)}</span>` : ""}
      </div>
    </nav>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
  ${topnav}
  <div class="deck-viewport">
    <div class="deck-stage">
      ${pagesHtml}
      ${footer}
      <nav class="deck-nav">
        <button id="deck-prev" type="button">← Prev</button>
        <span id="deck-page-count" class="deck-page-count"></span>
        <button id="deck-next" type="button">Next →</button>
      </nav>
    </div>
  </div>
  <script>${SCRIPT}</script>
</body>
</html>`;
}
