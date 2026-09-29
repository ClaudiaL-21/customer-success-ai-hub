import { computeHealthScore, computeExpansionScore, computePriorityScore, computePortfolioKpis, daysSince, daysFromToday, computeTrend, REFERENCE_DATE_ISO } from "./scoring.js";
import { fetchAccountInsight, askAboutAccount, fetchTeamPriority, approveAction, askAboutPortfolio, fetchQbrDraft, fetchPortfolioSummary, generateQbrPptx } from "./ai.js";
import { buildAccountActivity } from "./activity.js";
import { selectCustomerSafeSections } from "./qbrPreview.js";
import { mapQbrToHtmlContent } from "./qbrHtmlContentMap.js";
import { renderQbrHtml } from "./qbrHtmlRenderer.js";

const RISK_LABEL = { high: "High", medium: "Medium", low: "Low" };
const fmtUSD = n => "$" + n.toLocaleString("en-US");
const fmtDate = iso => new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "2-digit" });
// Development Day 2 — Account Activity Feed: only session-captured runtime
// timestamps (real time-of-day, not a historical date-only fact) use this.
const fmtDateTime = iso => new Date(iso).toLocaleString("en-US", { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
// Sprint 06 — compact calendar-date form for x-axis tick labels (space is
// tight there); the full fmtDate() form is still used for the axis's
// accessible name/title, so no precision is lost, only the on-axis label.
const fmtAxisDate = iso => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const adoptionCategory = pct => pct >= 70 ? "good" : pct >= 40 ? "warn" : "poor";
const CHAMPION_LABEL = { active: "active", unknown: "unclear", recently_departed: "recently departed" };
// Sprint 05B — Team: an initials placeholder derived from the CSM's own name
// field (already in data/accounts.json's csms list) — explicitly not a real
// photo, matching the sprint's "no real profile pictures" instruction.
const initialsOf = name => (name || "").trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? "").join("") || "?";

let state = {
  accounts: [], csms: [], view: "portfolio",
  filters: { csm: "all", region: "all", risk: "all", expansion: "all", trend: "all", search: "", accountIds: null, csmFromTeam: false },
  sort: { key: "score", dir: "asc" }, expanded: null, // asc = lowest Health Score (most concerning) first
  feedbackSort: { key: "count", dir: "desc" },
  matrixSelected: null, // accountId selected in the Matrix view (inline detail, no navigation)
  matrixMode: "value",  // "value" = Value Realization x Strategic Value, "renewal" = Health x days-to-renewal (bubble = ARR)
  renewalWindowDays: 90, // Renewal Radar time filter: 30 | 60 | 90 | 180 | "all"
  mapSelected: null,    // accountId selected in the Map view (inline detail, no navigation)
  mapMode: "health",    // "health" | "arr" | "renewal" — what the marker size encodes on the Map
  aiInsights: {}, // accountId -> { status: 'idle'|'loading'|'done'|'error', data, error }
  aiAsk: {},      // accountId -> { question, status, answer, error }
  approvals: {},  // accountId -> { status: 'idle'|'pending'|'done'|'error', result, error }
  // Sprint 15 — QBR Copilot. accountId -> { status: 'idle'|'loading'|'error'|'ready',
  // error, data (raw server draft), mode: 'review'|'preview',
  // review: { [sectionKey]: { included: bool, safeText: string } } — the ONLY
  // source the Customer QBR Preview renders from (never data.sections[].internal
  // or .customerSafeDefault directly, see renderQbrPreview).
  qbr: {},
  // Development Day 1 — Manager View. scopeKey: a stable string derived from
  // the exact set of accountId's the summary was requested for (see
  // scopeKeyOf() below). Compared against the *current* filtered list's own
  // scopeKey on every render — if they differ (filters changed since the
  // last load), the panel reverts to its idle "Load" state instead of
  // silently showing a summary for a scope that's no longer on screen.
  portfolioSummary: { status: "idle", data: null, error: null, scopeKey: null },
  teamPriority: { status: "idle", data: null, error: null, csmId: null }, // csmId: null = whole-team scope
  portfolioAsk: { status: "idle", question: "", answer: "", error: "" }, // scoped to whatever getFilteredAccounts() returns at ask time
  portfolioAskExpanded: false, // collapsed-by-default state for the Ask box on Map/Matrix/Features (Portfolio's own is never collapsible)
};

async function init() {
  await refreshAccountData();
  bindControls();
  render();
}

async function refreshAccountData() {
  const res = await fetch("/api/accounts", { cache: "no-store" });
  if (!res.ok) throw new Error("Account data is currently unavailable");
  const data = await res.json();
  state.csms = data.csms;
  state.accounts = data.accounts.map(acc => {
    const health = computeHealthScore(acc);
    const expansion = computeExpansionScore(acc);
    const trend = computeTrend(acc);
    return { ...acc, health, expansion, trend };
  });
  // Sprint 05B — the same fixed reference date the scoring math itself uses
  // (src/scoring.js), just made visible in the topbar so the "snapshot, not
  // live" framing is unavoidable rather than buried in the Trust view alone.
  const snapshotEl = document.getElementById("topbar-snapshot");
  if (snapshotEl) snapshotEl.textContent = `Snapshot as of ${fmtDate(REFERENCE_DATE_ISO)}`;
}

function bindControls() {
  document.getElementById("tab-portfolio").addEventListener("click", () => { state.view = "portfolio"; render(); });
  document.getElementById("tab-matrix").addEventListener("click", () => { state.view = "matrix"; render(); });
  document.getElementById("tab-map").addEventListener("click", () => { state.view = "map"; render(); });
  document.getElementById("tab-team").addEventListener("click", () => { state.view = "team"; render(); });
  document.getElementById("tab-qbrs").addEventListener("click", () => { state.view = "qbrs"; render(); });
  document.getElementById("tab-feedback").addEventListener("click", () => { state.view = "feedback"; render(); });
  document.getElementById("tab-trust").addEventListener("click", () => { state.view = "trust"; render(); });

  // Executive Drill-down — touching any of the primary filter controls below
  // is the user manually taking back control of the scope, so it clears a
  // still-active accountIds drill-down (see applyAccountDrillDown) instead of
  // silently ANDing with it. Without this, e.g. picking a CSM after "View 5
  // accounts →" would intersect the CSM's accounts with the 5 drilled-down
  // ones — a confusing near-empty result with no visible cause, since the
  // dropdowns never show the drill-down (it isn't one of their values).
  const setFilterAndClearDrillDown = (key, value) => {
    state.filters[key] = value;
    state.filters.accountIds = null;
    state.filters.csmFromTeam = false;
    render();
  };

  const csmSelect = document.getElementById("filter-csm");
  state.csms.forEach(c => {
    const opt = document.createElement("option");
    opt.value = c.csmId; opt.textContent = c.name;
    csmSelect.appendChild(opt);
  });
  csmSelect.addEventListener("change", e => setFilterAndClearDrillDown("csm", e.target.value));

  const regionSelect = document.getElementById("filter-region");
  regionSelect.addEventListener("change", e => setFilterAndClearDrillDown("region", e.target.value));

  const riskSelect = document.getElementById("filter-risk");
  riskSelect.addEventListener("change", e => setFilterAndClearDrillDown("risk", e.target.value));

  const expansionSelect = document.getElementById("filter-expansion");
  expansionSelect.addEventListener("change", e => setFilterAndClearDrillDown("expansion", e.target.value));

  const trendSelect = document.getElementById("filter-trend");
  trendSelect.addEventListener("change", e => setFilterAndClearDrillDown("trend", e.target.value));

  // PO polish — compact account search: filters the same getFilteredAccounts()
  // list every other filter and the Portfolio Copilot already read from, so
  // it composes with the dropdown filters and the Copilot's scope for free
  // instead of needing a second, parallel filtering path. Client-side only —
  // no backend/AI call. Uses "input" (not "change") so results update as the
  // CSM types. #filters (and this field) is static markup outside render()'s
  // #app root, so the input itself is never recreated — no focus loss.
  const searchInput = document.getElementById("filter-search");
  searchInput.addEventListener("input", e => setFilterAndClearDrillDown("search", e.target.value));
}

function getFilteredAccounts() {
  const search = state.filters.search.trim().toLowerCase();
  return state.accounts.filter(a =>
    (state.filters.csm === "all" || a.csmId === state.filters.csm) &&
    (state.filters.region === "all" || a.region === state.filters.region) &&
    (state.filters.risk === "all" || a.health.riskCategory === state.filters.risk) &&
    (state.filters.expansion === "all" || a.expansion.category === state.filters.expansion) &&
    (state.filters.trend === "all" || a.trend === state.filters.trend) &&
    (!search || a.accountName.toLowerCase().includes(search) || a.accountId.toLowerCase().includes(search)) &&
    (!state.filters.accountIds || state.filters.accountIds.includes(a.accountId))
  );
}

// Executive Drill-down — "View accounts" links on the Executive Portfolio
// Summary jump here. accountIds already came back from the server clamped to
// the scope that summary was generated for (see clampAccountIds in
// api/analyze.js), so the UI doesn't re-validate them — it only ever
// switches to Portfolio and narrows to that exact id list. Replaces (not
// adds to) the other filters, since "show me exactly these N accounts" is a
// clearer mental model than intersecting with whatever was already set.
function applyAccountDrillDown(accountIds) {
  state.filters = { csm: "all", region: "all", risk: "all", expansion: "all", trend: "all", search: "", accountIds };
  state.view = "portfolio";
  render();
  const csmSelect = document.getElementById("filter-csm");
  const regionSelect = document.getElementById("filter-region");
  const riskSelect = document.getElementById("filter-risk");
  const expansionSelect = document.getElementById("filter-expansion");
  const trendSelect = document.getElementById("filter-trend");
  const searchInput = document.getElementById("filter-search");
  if (csmSelect) csmSelect.value = "all";
  if (regionSelect) regionSelect.value = "all";
  if (riskSelect) riskSelect.value = "all";
  if (expansionSelect) expansionSelect.value = "all";
  if (trendSelect) trendSelect.value = "all";
  if (searchInput) searchInput.value = "";
}

function clearAccountDrillDown() {
  state.filters.accountIds = null;
  render();
}

// Executive Drill-down — a persistent indicator in the static #filters bar
// itself (not just the Portfolio-view banner further down the page), since
// user feedback was that the dropdown row up top looked untouched ("All"
// everywhere) with no visible sign a drill-down was narrowing the results.
// #filters lives outside render()'s #app root and is never recreated, so
// this updates it imperatively (display + onclick, not addEventListener,
// so re-running this on every render() never stacks duplicate listeners).
function syncDrillDownIndicator() {
  const el = document.getElementById("drilldown-indicator");
  if (!el) return;
  const ids = state.filters.accountIds;
  if (!ids) {
    el.hidden = true;
    el.onclick = null;
    return;
  }
  el.hidden = false;
  el.textContent = `Filtered: ${ids.length} account${ids.length === 1 ? "" : "s"} (AI Summary) ✕`;
  el.onclick = clearAccountDrillDown;
}

const RISK_SORT_RANK = { low: 1, medium: 2, high: 3 };

function getSorted(list) {
  const { key, dir } = state.sort;
  const sorted = [...list].sort((a, b) => {
    let va, vb;
    if (key === "score") { va = a.health.score; vb = b.health.score; }
    else if (key === "expansion") { va = a.expansion.score; vb = b.expansion.score; }
    else if (key === "adoption") { va = a.usage.adoptionRatePct; vb = b.usage.adoptionRatePct; }
    else if (key === "renewal") { va = new Date(a.contract.nextRenewalDate); vb = new Date(b.contract.nextRenewalDate); }
    else if (key === "arr") { va = a.contract.arrUSD; vb = b.contract.arrUSD; }
    else if (key === "region") { va = a.region; vb = b.region; }
    else if (key === "csm") { va = csmName(a.csmId); vb = csmName(b.csmId); }
    else if (key === "risk") { va = RISK_SORT_RANK[a.health.riskCategory]; vb = RISK_SORT_RANK[b.health.riskCategory]; }
    else if (key === "lastInteraction") { va = a.relationship.lastInteractionDaysAgo; vb = b.relationship.lastInteractionDaysAgo; }
    else if (key === "qbr") { va = new Date(a.relationship.nextQBRDate); vb = new Date(b.relationship.nextQBRDate); }
    else { va = a.accountName; vb = b.accountName; }
    if (va < vb) return dir === "asc" ? -1 : 1;
    if (va > vb) return dir === "asc" ? 1 : -1;
    return 0;
  });
  return sorted;
}

function csmName(csmId) {
  return state.csms.find(c => c.csmId === csmId)?.name ?? csmId;
}

// Sprint 05 — Part A.1/A.2: every view opens with the same title+description
// pattern instead of jumping straight into content, so the six views read as
// one product. Purely presentational — no state or behavior here. Trust
// keeps its own Sprint 04 hero instead of this (it already does more).
function renderViewHeader(title, description) {
  const header = document.createElement("div");
  header.className = "view-header";
  header.innerHTML = `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p>`;
  return header;
}

// Sprint 05B — Part 3: both AI-generated panels (Portfolio Ask, Team/Portfolio
// Prioritization) get the same clearly-labeled "AI Copilot" identity — an
// icon + eyebrow label + the existing trust disclaimer — instead of looking
// like a plain form box. Purely presentational; the underlying AI call and
// disclaimer text are unchanged.
const AI_SPARKLE_ICON = `<svg class="ai-copilot-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 2.3 11.7 7.9 17.3 9.6l-5.6 1.7L10 17l-1.7-5.7-5.6-1.7 5.6-1.7L10 2.3Z" fill="currentColor"/></svg>`;

function aiCopilotHeader(title) {
  return `
    <div class="ai-copilot-header">
      ${AI_SPARKLE_ICON}
      <div>
        <p class="ai-copilot-eyebrow">AI Copilot</p>
        <h4>${escapeHtml(title)} <span class="ai-disclaimer">— AI-generated, may be inaccurate, verify before acting</span></h4>
      </div>
    </div>
  `;
}

function render() {
  document.getElementById("tab-portfolio").classList.toggle("active", state.view === "portfolio");
  document.getElementById("tab-matrix").classList.toggle("active", state.view === "matrix");
  document.getElementById("tab-map").classList.toggle("active", state.view === "map");
  document.getElementById("tab-team").classList.toggle("active", state.view === "team");
  document.getElementById("tab-qbrs").classList.toggle("active", state.view === "qbrs");
  document.getElementById("tab-feedback").classList.toggle("active", state.view === "feedback");
  document.getElementById("tab-trust").classList.toggle("active", state.view === "trust");
  document.getElementById("filters").style.display = (state.view === "team" || state.view === "trust") ? "none" : "flex";
  document.getElementById("filters").classList.toggle("filters-csm-only", state.view === "qbrs");
  syncDrillDownIndicator();

  const root = document.getElementById("app");
  root.innerHTML = "";
  if (state.view === "portfolio") root.appendChild(renderPortfolio());
  else if (state.view === "matrix") root.appendChild(renderMatrix());
  else if (state.view === "map") root.appendChild(renderMap());
  else if (state.view === "qbrs") root.appendChild(renderQbrsOverview());
  else if (state.view === "feedback") root.appendChild(renderFeedback());
  else if (state.view === "trust") root.appendChild(renderTrust());
  else root.appendChild(renderTeam());
}

function renderSortHeader(label, key) {
  const th = document.createElement("th");
  th.className = "sortable";
  th.tabIndex = 0;
  th.textContent = label + (state.sort.key === key ? (state.sort.dir === "asc" ? " ▲" : " ▼") : "");
  th.setAttribute("aria-sort", state.sort.key === key ? (state.sort.dir === "asc" ? "ascending" : "descending") : "none");
  const doSort = () => {
    if (state.sort.key === key) state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
    else { state.sort.key = key; state.sort.dir = "desc"; }
    render();
  };
  th.addEventListener("click", doSort);
  th.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); doSort(); } });
  return th;
}

// Sprint 05B — KPI strip: four numbers that already exist elsewhere in this
// file (health.riskCategory, contract.arrUSD, and the same "renewal within
// 90 days" pattern renderTeam() already uses per CSM), just surfaced above
// the table for the currently filtered list. No new formulas, no new data.
function renderPortfolioKpis(list) {
  const wrap = document.createElement("div");
  wrap.className = "kpi-strip";

  const highRisk = list.filter(a => a.health.riskCategory === "high");
  const arrAtRisk = highRisk.reduce((s, a) => s + a.contract.arrUSD, 0);
  const upcomingRenewals = list.filter(a => {
    const d = daysFromToday(a.contract.nextRenewalDate);
    return d <= 90 && d >= 0;
  }).length;

  const kpis = [
    { label: "Accounts in view", value: String(list.length), tone: "neutral" },
    { label: "High risk", value: String(highRisk.length), tone: "high" },
    { label: "ARR at risk", value: fmtUSD(arrAtRisk), tone: "high" },
    { label: "Renewals ≤ 90 days", value: String(upcomingRenewals), tone: "medium" },
  ];

  wrap.innerHTML = kpis.map(k => `
    <div class="kpi-tile kpi-tile-${k.tone}">
      <span class="kpi-value">${escapeHtml(k.value)}</span>
      <span class="kpi-label">${escapeHtml(k.label)}</span>
    </div>
  `).join("");

  return wrap;
}

// Development Day 1 — Manager View: deterministic portfolio rollup, purely
// computed from computePortfolioKpis() (src/scoring.js) — no AI, no network
// call. Reuses the exact same .kpi-strip/.kpi-tile styling as
// renderPortfolioKpis() above (a second, additional tile row), and
// .breakdown-table for the renewal-window breakdown — no new CSS component.
function renderManagerKpis(list) {
  const wrap = document.createElement("div");
  const kpis = computePortfolioKpis(list);

  const tiles = [
    { label: "Total ARR", value: fmtUSD(kpis.totalArrUSD), tone: "neutral" },
    { label: "Average Health", value: String(kpis.avgHealth), tone: "neutral" },
    { label: "Medium risk", value: String(kpis.riskCounts.medium), tone: "medium" },
    { label: "Low risk", value: String(kpis.riskCounts.low), tone: "neutral" },
  ];
  const strip = document.createElement("div");
  strip.className = "kpi-strip manager-kpi-strip";
  strip.innerHTML = tiles.map(k => `
    <div class="kpi-tile kpi-tile-${k.tone}">
      <span class="kpi-value">${escapeHtml(k.value)}</span>
      <span class="kpi-label">${escapeHtml(k.label)}</span>
    </div>
  `).join("");
  wrap.appendChild(strip);

  const windows = [kpis.renewalWindows.days30, kpis.renewalWindows.days3160, kpis.renewalWindows.days6190];
  const table = document.createElement("table");
  table.className = "breakdown-table manager-renewal-table";
  table.innerHTML = `
    <thead><tr><th>Renewal window</th><th>Accounts</th><th>ARR renewing</th><th>ARR at risk</th></tr></thead>
    <tbody>
      ${windows.map(w => `
        <tr>
          <td>${escapeHtml(w.label)}</td>
          <td>${w.accountCount}</td>
          <td>${fmtUSD(w.arrUSD)}</td>
          <td>${fmtUSD(w.arrAtRiskUSD)}</td>
        </tr>
      `).join("")}
    </tbody>
  `;
  wrap.appendChild(table);

  return wrap;
}

// Development Day 1 — Manager View AI layer. Stable key for "which accounts
// is this summary about" — order-independent (sorted) so a re-sort of the
// same filtered set doesn't count as a scope change, but any actual filter
// change (different account set) does. Compared against the current list on
// every render (see renderPortfolioSummary) so a stale summary from a since-
// changed filter is never shown as if it still applied — the same class of
// bug this whole feature exists to prevent ("UI shows scope A, AI analyzed
// scope B"), just guarded against the *filter changed after loading* case
// too, not only the request-time case already covered server-side.
function scopeKeyOf(list) {
  return list.map(a => a.accountId).sort().join(",");
}

function renderPortfolioSummary(list) {
  const box = document.createElement("div");
  box.className = "team-priority-box ai-copilot-panel";
  const ps = state.portfolioSummary;
  const currentScopeKey = scopeKeyOf(list);
  const inScope = ps.scopeKey === currentScopeKey;

  box.innerHTML = aiCopilotHeader("Executive Portfolio Summary");
  const body = document.createElement("div");
  box.appendChild(body);

  if (!inScope || ps.status === "idle") {
    const btn = document.createElement("button");
    btn.className = "ai-load-btn";
    btn.textContent = "Load Executive Summary";
    btn.addEventListener("click", () => loadPortfolioSummary(list.map(a => a.accountId), currentScopeKey));
    body.appendChild(btn);
  } else if (ps.status === "loading") {
    body.innerHTML = `<p class="sub">Loading…</p>`;
  } else if (ps.status === "error") {
    body.innerHTML = `<p class="ai-unavailable">Unavailable (${escapeHtml(ps.error)}).</p>`;
    const retryBtn = document.createElement("button");
    retryBtn.className = "ai-load-btn";
    retryBtn.textContent = "Try Again";
    retryBtn.addEventListener("click", () => loadPortfolioSummary(list.map(a => a.accountId), currentScopeKey));
    body.appendChild(retryBtn);
  } else if (ps.status === "done") {
    const s = ps.data.summary;
    // Executive Drill-down — a small "View N accounts" link next to any text
    // block that came back with accountIds. Server-clamped ids only (see
    // clampAccountIds in api/analyze.js), never parsed from the text itself.
    const drillLink = ids => (ids && ids.length)
      ? `<button type="button" class="drilldown-link" data-ids="${escapeHtml(ids.join(","))}">View ${ids.length} account${ids.length === 1 ? "" : "s"} →</button>`
      : "";
    body.innerHTML = `
      <p class="review-section-label">What needs attention</p>
      <p class="ai-insight-body">${escapeHtml(s.whatNeedsAttention.text)} ${drillLink(s.whatNeedsAttention.accountIds)}</p>
      <p class="review-section-label">Why it matters</p>
      <p class="ai-insight-body">${escapeHtml(s.whyItMatters.text)} ${drillLink(s.whyItMatters.accountIds)}</p>
      <p class="review-section-label">Top 3 priorities this week</p>
      <ol class="ai-insight-body">${s.topPriorities.map(p => `<li>${escapeHtml(p.text)} ${drillLink(p.accountIds)}</li>`).join("")}</ol>
    `;
    body.querySelectorAll(".drilldown-link").forEach(btn => {
      btn.addEventListener("click", () => applyAccountDrillDown(btn.dataset.ids.split(",")));
    });
    const reloadBtn = document.createElement("button");
    reloadBtn.className = "reload-link";
    reloadBtn.textContent = "↻ Reload Summary";
    reloadBtn.addEventListener("click", () => loadPortfolioSummary(list.map(a => a.accountId), currentScopeKey));
    body.appendChild(reloadBtn);
  }

  return box;
}

async function loadPortfolioSummary(accountIds, scopeKey) {
  state.portfolioSummary = { status: "loading", data: null, error: null, scopeKey };
  render();
  try {
    const data = await fetchPortfolioSummary(accountIds);
    state.portfolioSummary = { status: "done", data, error: null, scopeKey };
  } catch (e) {
    state.portfolioSummary = { status: "error", data: null, error: e.message, scopeKey };
  }
  render();
}

function renderPortfolio() {
  const wrap = document.createElement("div");
  const list = getSorted(getFilteredAccounts());

  wrap.appendChild(renderViewHeader("Portfolio", "Prioritized view of every account — click a row to see the full score breakdown, evidence, and AI insight."));

  if (state.filters.csmFromTeam) {
    const backLink = document.createElement("button");
    backLink.className = "back-to-team-link";
    backLink.textContent = `← Back to Team`;
    backLink.addEventListener("click", backToTeamFromPortfolio);
    wrap.appendChild(backLink);
  }

  if (state.filters.accountIds) {
    const banner = document.createElement("div");
    banner.className = "drilldown-banner";
    banner.innerHTML = `<span>Filtered to ${state.filters.accountIds.length} account${state.filters.accountIds.length === 1 ? "" : "s"} from the Executive Summary.</span>`;
    const clearBtn = document.createElement("button");
    clearBtn.className = "drilldown-clear-btn";
    clearBtn.textContent = "Clear";
    clearBtn.addEventListener("click", clearAccountDrillDown);
    banner.appendChild(clearBtn);
    wrap.appendChild(banner);
  }

  wrap.appendChild(renderPortfolioKpis(list));
  wrap.appendChild(renderManagerKpis(list));
  wrap.appendChild(renderPortfolioSummary(list));

  if (state.filters.csm !== "all") {
    wrap.appendChild(renderPriorityBox(state.filters.csm, `AI Priorities for ${csmName(state.filters.csm)}`));
  }

  // PO review, round 2: the AI Copilot uses the full workspace width at
  // every breakpoint; the deterministic Attention Queue stays below it as
  // a compact area — see the .portfolio-ai-row rule.
  const aiRow = document.createElement("div");
  aiRow.className = "portfolio-ai-row";
  aiRow.appendChild(renderPortfolioAsk(list));
  aiRow.appendChild(renderAttentionQueue(list));
  wrap.appendChild(aiRow);

  const summary = document.createElement("div");
  summary.className = "summary-bar";
  const counts = { high: 0, medium: 0, low: 0 };
  list.forEach(a => counts[a.health.riskCategory]++);
  summary.innerHTML = `
    <div class="summary-chip risk-high">${counts.high} High</div>
    <div class="summary-chip risk-medium">${counts.medium} Medium</div>
    <div class="summary-chip risk-low">${counts.low} Low</div>
    <div class="summary-chip neutral">${list.length} accounts total</div>
  `;
  wrap.appendChild(summary);

  const legend = document.createElement("p");
  legend.className = "color-legend";
  legend.textContent = "Color legend: green/orange/red on Health Score and Adoption = risk level (Adoption is a real warning signal — low usage of what's licensed). Green/orange/gray on Expansion = upsell opportunity (low is neutral, not a warning).";
  wrap.appendChild(legend);

  const table = document.createElement("table");
  table.className = "portfolio-table portfolio-main-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.appendChild(renderSortHeader("Account", "name"));
  headRow.appendChild(renderSortHeader("Region", "region"));
  headRow.appendChild(renderSortHeader("CSM", "csm"));
  headRow.appendChild(renderSortHeader("ARR", "arr"));
  headRow.appendChild(renderSortHeader("Renewal", "renewal"));
  headRow.appendChild(renderSortHeader("Health Score", "score"));
  headRow.appendChild(renderSortHeader("Risk", "risk"));
  headRow.appendChild(renderSortHeader("Adoption", "adoption"));
  headRow.appendChild(renderSortHeader("Expansion", "expansion"));
  headRow.appendChild(renderSortHeader("Last Interaction", "lastInteraction"));
  headRow.appendChild(renderSortHeader("Next QBR", "qbr"));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  list.forEach(acc => {
    const row = document.createElement("tr");
    row.className = `risk-row-${acc.health.riskCategory}${state.expanded === acc.accountId ? " row-expanded" : ""}`;
    row.innerHTML = `
      <td class="account-cell">${escapeHtml(acc.accountName)}<div class="sub">${escapeHtml(acc.industry)} · ${escapeHtml(acc.accountId)}</div></td>
      <td>${acc.region}<div class="sub">${escapeHtml(acc.subregion)}</div></td>
      <td>${escapeHtml(csmName(acc.csmId))}</td>
      <td>${fmtUSD(acc.contract.arrUSD)}</td>
      <td>${fmtDate(acc.contract.nextRenewalDate)}</td>
      <td><span class="score-num risk-text-${acc.health.riskCategory}">${acc.health.score}</span></td>
      <td><span class="status-pill risk-${acc.health.riskCategory}">${RISK_LABEL[acc.health.riskCategory]}</span></td>
      <td><span class="score-num adopt-text-${adoptionCategory(acc.usage.adoptionRatePct)}">${acc.usage.adoptionRatePct}%</span></td>
      <td><span class="score-num exp-text-${acc.expansion.category}">${acc.expansion.score}</span></td>
      <td>${acc.relationship.lastInteractionDaysAgo}d</td>
      <td>${fmtDate(acc.relationship.nextQBRDate)}</td>
    `;
    row.addEventListener("click", () => {
      state.expanded = state.expanded === acc.accountId ? null : acc.accountId;
      render();
      if (state.expanded) document.getElementById(`detail-${acc.accountId}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    tbody.appendChild(row);

    if (state.expanded === acc.accountId) {
      const detailRow = document.createElement("tr");
      detailRow.id = `detail-${acc.accountId}`;
      detailRow.className = "detail-row";
      const td = document.createElement("td");
      td.colSpan = 11;
      td.appendChild(renderAccountDetail(acc));
      detailRow.appendChild(td);
      tbody.appendChild(detailRow);
    }
  });
  table.appendChild(tbody);
  const scrollWrap = document.createElement("div");
  scrollWrap.className = "table-scroll";
  scrollWrap.appendChild(table);
  wrap.appendChild(scrollWrap);
  const hint = document.createElement("p");
  hint.className = "table-scroll-hint";
  hint.textContent = "← Scroll horizontally to see all columns →";
  wrap.appendChild(hint);
  return wrap;
}

// Sprint 06 — x-axis tick selection: always the first/last history index,
// plus up to `midCount` additional interior indices spaced as evenly as
// possible across the array. Used to keep intermediate marks legible —
// they're only added where renderScoreTrend's width tier has room for them.
function pickTickIndices(n, midCount) {
  if (midCount <= 0 || n <= 2) return [0, n - 1];
  const indices = new Set([0, n - 1]);
  for (let k = 1; k <= midCount; k++) {
    const idx = Math.round((k / (midCount + 1)) * (n - 1));
    if (idx > 0 && idx < n - 1) indices.add(idx);
  }
  return [...indices].sort((a, b) => a - b);
}

function renderScoreTrend(history) {
  const first = history[0].score;
  const last = history[history.length - 1].score;
  const diff = last - first;
  const weeks = history.length - 1;
  const color = diff <= -8 ? "var(--red)" : diff >= 8 ? "var(--green)" : "var(--muted)";
  const arrow = diff <= -8 ? "▼" : diff >= 8 ? "▲" : "";
  const pct = first > 0 ? Math.round((diff / first) * 100) : 0;
  const pctLabel = `${diff > 0 ? "+" : ""}${pct}%`;
  const summary = diff <= -8
    ? `Health Score fell from ${first} to ${last} over the last ${weeks} weeks.`
    : diff >= 8
      ? `Health Score rose from ${first} to ${last} over the last ${weeks} weeks.`
      : `Health Score stayed roughly steady around ${last} over the last ${weeks} weeks.`;

  // PO polish — Sprint 06's original per-viewport width tiers existed because
  // this chart used to stand alone at full column width; now it always sits
  // in a fixed 50/50 .trend-row next to the CSAT chart, so a single fixed
  // geometry (shared 1:1 with renderCsatTrend below) replaces the tiers.
  // Using the *same* viewBox dimensions in both charts means the browser's
  // normal (uniform, non-distorting) aspect-ratio scaling — not a stretched
  // preserveAspectRatio="none" — is enough to keep their rendered heights
  // equal, since .trend-row gives both an equal share of the row's width.
  const w = 200, padTop = 10, plotH = 42, padBottom = 8, xAxisH = 16, axisLabelW = 24, padRight = 8;
  const h = padTop + plotH + padBottom + xAxisH;
  const plotX0 = axisLabelW, plotW = w - axisLabelW - padRight;
  const yFor = score => padTop + (1 - score / 100) * plotH;
  const xFor = i => plotX0 + (i / (history.length - 1)) * plotW;
  const points = history.map((p, i) => `${xFor(i).toFixed(1)},${yFor(p.score).toFixed(1)}`).join(" ");
  const firstX = plotX0;
  const lastX = plotX0 + plotW;

  const gridlines = [0, 50, 100].map(v => `
    <line x1="${plotX0}" y1="${yFor(v).toFixed(1)}" x2="${w - padRight}" y2="${yFor(v).toFixed(1)}" stroke="var(--border)" stroke-width="1" stroke-dasharray="2,2" />
    <text x="${plotX0 - 4}" y="${(yFor(v) + 3).toFixed(1)}" text-anchor="end" font-size="8" fill="var(--muted)">${v}</text>
  `).join("");

  const axisLineY = padTop + plotH + padBottom;
  const xAxisLine = `<line x1="${plotX0}" y1="${axisLineY}" x2="${(plotX0 + plotW).toFixed(1)}" y2="${axisLineY}" stroke="var(--border)" stroke-width="1" />`;
  const tickIndices = pickTickIndices(history.length, 0);
  const xAxisTicks = tickIndices.map(i => {
    const x = xFor(i).toFixed(1);
    const anchor = i === 0 ? "start" : i === history.length - 1 ? "end" : "middle";
    return `
      <line x1="${x}" y1="${axisLineY}" x2="${x}" y2="${axisLineY + 4}" stroke="var(--border)" stroke-width="1" />
      <text x="${x}" y="${axisLineY + 13}" text-anchor="${anchor}" font-size="9" fill="var(--muted)">${escapeHtml(fmtAxisDate(history[i].date))}</text>
    `;
  }).join("");

  // Accessible name for the whole graphic (calendar dates and score values,
  // not the abbreviated axis labels), since a screen reader encountering the
  // <svg> itself needs its own name — it can't rely on the sibling <p> text.
  const axisTitle = `Health Score trend, ${fmtDate(history[0].date)} to ${fmtDate(history[history.length - 1].date)}: started at ${first}, ended at ${last}.`;

  return `
    <div class="score-trend">
      <p class="score-trend-title">Health Score trend</p>
      <div class="score-trend-row">
        <svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" class="score-sparkline" role="img">
          <title>${escapeHtml(axisTitle)}</title>
          ${gridlines}
          <polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
          <circle cx="${firstX}" cy="${yFor(first).toFixed(1)}" r="2.5" fill="var(--muted)" />
          <text x="${firstX}" y="${(yFor(first) - 6).toFixed(1)}" text-anchor="start" font-size="9" fill="var(--muted)">${first}</text>
          <circle cx="${lastX}" cy="${yFor(last).toFixed(1)}" r="2.5" fill="${color}" />
          <text x="${lastX}" y="${(yFor(last) - 6).toFixed(1)}" text-anchor="end" font-size="9" font-weight="700" fill="${color}">${last}</text>
          ${xAxisLine}
          ${xAxisTicks}
        </svg>
        <div class="score-trend-pct-block">
          <div class="score-trend-pct" style="color:${color};">${arrow} ${pctLabel}</div>
          <div class="score-trend-pct-caption">over ${weeks} weeks</div>
        </div>
      </div>
      <p class="sub">${escapeHtml(summary)}</p>
    </div>
  `;
}

// PO polish: a compact CSAT Trend (8 weeks) mini-chart, shown next to the
// Health Score trend so both trends are visible at a glance — the existing
// "CSAT Trend (8 weeks)" criterion row in the breakdown table stays exactly
// as-is (it explains the risk-points contribution; this chart is purely a
// visual companion). Data is account.relationship.weeklyCSAT, the same 8
// weekly {weekStartDate, score} points src/scoring.js's scoreCSATTrend()
// already uses — no new or invented data. CSAT is a 0-5 scale (not 0-100
// like the Health Score), so the "meaningful move" thresholds below are the
// same 8%-of-range rule as renderScoreTrend (8% of 5 = 0.4), just rescaled.
// Shares its axis-labeling and geometry approach with renderScoreTrend (see
// that function's comment) rather than using viewport-based width tiers: it
// always sits in a fixed half-width column next to the Health Score trend,
// not stand-alone full-width.
function renderCsatTrend(weeklyCSAT) {
  const first = weeklyCSAT[0].score;
  const last = weeklyCSAT[weeklyCSAT.length - 1].score;
  const diff = last - first;
  const weeks = weeklyCSAT.length - 1;
  const color = diff <= -0.4 ? "var(--red)" : diff >= 0.4 ? "var(--green)" : "var(--muted)";
  const arrow = diff <= -0.4 ? "▼" : diff >= 0.4 ? "▲" : "";
  const pct = first > 0 ? Math.round((diff / first) * 100) : 0;
  const pctLabel = `${diff > 0 ? "+" : ""}${pct}%`;
  const summary = diff <= -0.4
    ? `CSAT fell from ${first.toFixed(1)} to ${last.toFixed(1)} over the last ${weeks} weeks.`
    : diff >= 0.4
      ? `CSAT rose from ${first.toFixed(1)} to ${last.toFixed(1)} over the last ${weeks} weeks.`
      : `CSAT stayed roughly steady around ${last.toFixed(1)} over the last ${weeks} weeks.`;

  // Same geometry (viewBox width/height, padding, axis-label gutter) as
  // renderScoreTrend on purpose — matching aspect ratios are what let both
  // charts render at the same pixel height via normal (uniform, non-
  // distorting) scaling once .trend-row gives them equal width. Only the Y
  // domain (0-5 instead of 0-100) and tick values differ.
  const w = 200, padTop = 10, plotH = 42, padBottom = 8, xAxisH = 16, axisLabelW = 24, padRight = 8;
  const h = padTop + plotH + padBottom + xAxisH;
  const plotX0 = axisLabelW, plotW = w - axisLabelW - padRight;
  const yFor = score => padTop + (1 - score / 5) * plotH;
  const xFor = i => plotX0 + (i / (weeklyCSAT.length - 1)) * plotW;
  const points = weeklyCSAT.map((wk, i) => `${xFor(i).toFixed(1)},${yFor(wk.score).toFixed(1)}`).join(" ");
  const gridlines = [0, 2.5, 5].map(v => `
    <line x1="${plotX0}" y1="${yFor(v).toFixed(1)}" x2="${w - padRight}" y2="${yFor(v).toFixed(1)}" stroke="var(--border)" stroke-width="1" stroke-dasharray="2,2" />
    <text x="${plotX0 - 4}" y="${(yFor(v) + 3).toFixed(1)}" text-anchor="end" font-size="8" fill="var(--muted)">${v}</text>
  `).join("");
  const axisLineY = padTop + plotH + padBottom;
  const xAxisLine = `<line x1="${plotX0}" y1="${axisLineY}" x2="${(plotX0 + plotW).toFixed(1)}" y2="${axisLineY}" stroke="var(--border)" stroke-width="1" />`;
  const xAxisTicks = `
    <text x="${plotX0}" y="${axisLineY + 13}" text-anchor="start" font-size="9" fill="var(--muted)">${escapeHtml(fmtAxisDate(weeklyCSAT[0].weekStartDate))}</text>
    <text x="${(plotX0 + plotW).toFixed(1)}" y="${axisLineY + 13}" text-anchor="end" font-size="9" fill="var(--muted)">${escapeHtml(fmtAxisDate(weeklyCSAT[weeklyCSAT.length - 1].weekStartDate))}</text>
  `;
  const axisTitle = `CSAT trend, ${fmtDate(weeklyCSAT[0].weekStartDate)} to ${fmtDate(weeklyCSAT[weeklyCSAT.length - 1].weekStartDate)}: started at ${first.toFixed(1)}, ended at ${last.toFixed(1)}.`;

  return `
    <div class="score-trend csat-trend">
      <p class="score-trend-title">CSAT trend</p>
      <div class="score-trend-row">
        <svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" class="score-sparkline" role="img">
          <title>${escapeHtml(axisTitle)}</title>
          ${gridlines}
          <polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
          <circle cx="${xFor(0).toFixed(1)}" cy="${yFor(first).toFixed(1)}" r="2.5" fill="var(--muted)" />
          <text x="${xFor(0).toFixed(1)}" y="${(yFor(first) - 6).toFixed(1)}" text-anchor="start" font-size="9" fill="var(--muted)">${first.toFixed(1)}</text>
          <circle cx="${xFor(weeklyCSAT.length - 1).toFixed(1)}" cy="${yFor(last).toFixed(1)}" r="2.5" fill="${color}" />
          <text x="${xFor(weeklyCSAT.length - 1).toFixed(1)}" y="${(yFor(last) - 6).toFixed(1)}" text-anchor="end" font-size="9" font-weight="700" fill="${color}">${last.toFixed(1)}</text>
          ${xAxisLine}
          ${xAxisTicks}
        </svg>
        <div class="score-trend-pct-block">
          <div class="score-trend-pct" style="color:${color};">${arrow} ${pctLabel}</div>
          <div class="score-trend-pct-caption">over ${weeks} weeks</div>
        </div>
      </div>
      <p class="sub">${escapeHtml(summary)}</p>
    </div>
  `;
}

function renderAccountDetail(acc) {
  const div = document.createElement("div");
  div.className = "account-detail";

  const criteriaRows = acc.health.criteria.map(c => `
    <tr>
      <td>${escapeHtml(c.label)}</td>
      <td class="sub">${escapeHtml(String(c.rawValue))}</td>
      <td>${Math.round(c.weight * 100)}%</td>
      <td>${c.points.toFixed(1)} pts</td>
      <td style="width:120px;"><div class="bar-wrap"><div class="bar-fill" style="width:${c.riskPct}%;"></div></div></td>
    </tr>
  `).join("");

  const modules = acc.licensedModules.map(m => `<li>${escapeHtml(m.name)} — ${m.tier} (${m.licensedUsers} users)</li>`).join("");
  const whitespace = acc.expansion.whitespaceModules.length
    ? `<p class="sub">Unused modules (expansion whitespace): ${acc.expansion.whitespaceModules.join(", ")}</p>`
    : `<p class="sub">All modules licensed.</p>`;

  const artifacts = acc.freeTextArtifacts.map(a => `
    <div class="artifact">
      <span class="artifact-type">${a.type}</span> · <span class="sub">${fmtDate(a.date)}</span>
      <p>"${escapeHtml(a.text)}"</p>
    </div>
  `).join("");

  const milestone = acc.valueMilestone
    ? `<div class="milestone-box"><p class="milestone-label">Value Milestone — ${fmtDate(acc.valueMilestone.achievedDate)}</p><p>${escapeHtml(acc.valueMilestone.description)}</p></div>`
    : "";

  // Demo-stabilization polish — surface the existing topFeatureRequest/
  // featureRequestSentiment/featureRequestsCount/featureRequestSince fields
  // (already used in the Features portfolio view and the QBR content
  // contract) on the account profile itself, so a CSM doesn't have to leave
  // the account to see it. Real fields only, no new data.
  const featureRequestBox = acc.support.topFeatureRequest
    ? `<div class="milestone-box">
         <p class="milestone-label">Feature Request</p>
         <p>"${escapeHtml(acc.support.topFeatureRequest)}"</p>
         <p class="sub">${acc.support.featureRequestSentiment ? `Sentiment: ${escapeHtml(acc.support.featureRequestSentiment)}` : ""}${typeof acc.support.featureRequestsCount === "number" ? ` · ${acc.support.featureRequestsCount} request${acc.support.featureRequestsCount === 1 ? "" : "s"}` : ""}${acc.support.featureRequestSince ? ` · since ${fmtDate(acc.support.featureRequestSince)}` : ""}</p>
       </div>`
    : "";

  const scoreTrend = acc.healthScoreHistory ? renderScoreTrend(acc.healthScoreHistory) : "";
  const csatTrend = acc.relationship.weeklyCSAT ? renderCsatTrend(acc.relationship.weeklyCSAT) : "";
  const trendRow = (scoreTrend || csatTrend) ? `<div class="trend-row">${scoreTrend}${csatTrend}</div>` : "";

  div.innerHTML = `
    <div class="detail-grid">
      <div>
        <h4>Score Breakdown</h4>
        <p class="sub">Eight-factor snapshot: ${acc.health.baseScore} = 100 − ${Math.round(acc.health.criteria.reduce((s, c) => s + c.points, 0))} risk points.${acc.health.signalDelta ? ` Customer signal: ${acc.health.signalDelta} → current Health Score ${acc.health.score}.` : ""}</p>
        ${trendRow}
        <table class="breakdown-table"><tbody>${criteriaRows}</tbody></table>
      </div>
      <div>
        <h4>Contract & Licensing</h4>
        <p>${acc.contract.type === "multi-year" ? `Multi-year contract (${acc.contract.termYears} years)` : "Single-year contract"}, since ${fmtDate(acc.contract.startDate)}</p>
        <ul>${modules}</ul>
        ${whitespace}
        ${milestone}
        <h4>Relationship</h4>
        <p>Champion: ${escapeHtml(acc.relationship.championName)} (${CHAMPION_LABEL[acc.relationship.championStatus]})<br/>
        Exec sponsor: ${acc.relationship.execSponsorEngaged ? "engaged" : "not engaged"}<br/>
        Last QBR: ${fmtDate(acc.relationship.lastQBRDate)}</p>
        ${featureRequestBox}
        <h4>Notes (Support/Communication)</h4>
        ${artifacts}
      </div>
    </div>
    <div class="ai-section customer-signals" id="customer-signals-${acc.accountId}"></div>
    <div class="ai-section" id="ai-section-${acc.accountId}"></div>
    <div class="ai-section qbr-section" id="qbr-section-${acc.accountId}"></div>
  `;

  renderCustomerSignals(div.querySelector(`#customer-signals-${acc.accountId}`), acc);
  renderAiSection(div.querySelector(`#ai-section-${acc.accountId}`), acc);
  renderQbrSection(div.querySelector(`#qbr-section-${acc.accountId}`), acc);
  div.appendChild(renderAccountActivity(acc));
  return div;
}

function renderCustomerSignals(container, acc) {
  const signals = acc.customerSignals || [];
  container.innerHTML = `<h4>Customer Signals <span class="ai-disclaimer">— persistent, classified from demo email</span></h4>`;
  if (!signals.length) {
    container.insertAdjacentHTML("beforeend", `<p class="sub">No new email signals for this account.</p>`);
    return;
  }
  for (const signal of signals) {
    const card = document.createElement("div");
    card.className = "nba-box nba-box-risk";
    const effect = signal.signalId === acc.health.signalId ? signal.healthDelta : 0;
    card.innerHTML = `
      <p class="nba-label">${escapeHtml(signal.type)} · ${escapeHtml(signal.topic)} · ${escapeHtml(signal.urgency)} urgency</p>
      <p>${escapeHtml(signal.summary)}</p>
      <p class="sub">Sentiment: ${escapeHtml(signal.sentiment)} · Evidence: ${escapeHtml(signal.evidence)}</p>
      <p class="sub">Health effect: ${effect} points${effect ? ` (${escapeHtml(signal.healthRule)}; base ${acc.health.baseScore} → ${acc.health.score})` : " (strongest risk signal already counted or no risk adjustment)"} · Received ${fmtDateTime(signal.createdAt)}</p>
      ${signal.proposedAction ? `<p><strong>Next Best Action — ${signal.reviewStatus === "pending" ? "Pending human review" : escapeHtml(signal.reviewStatus)}</strong></p><p>${escapeHtml(signal.proposedAction)}</p><p class="sub">${escapeHtml(signal.proposedRationale)}</p>` : ""}
      <div class="signal-review"></div>`;
    container.appendChild(card);
    if (!signal.proposedAction) continue;
    const review = card.querySelector(".signal-review");
    if (signal.reviewStatus === "pending") {
      renderApprovalControl(review, acc.accountId, {
        category: signal.type === "growth" ? "growth" : "risk_mitigation",
        action: signal.proposedAction, rationale: signal.proposedRationale,
      }, signal.signalId);
    } else {
      review.innerHTML = `<p class="approval-confirm">Review status: ${escapeHtml(signal.reviewStatus)}${signal.reviewedAt ? ` · ${fmtDateTime(signal.reviewedAt)}` : ""}${signal.reviewedByCsmId ? ` · Demo CSM ${escapeHtml(signal.reviewedByCsmId)} (identity not verified)` : ""}</p>`;
    }
  }
}

// Development Day 2 — Account Activity Feed. Purely additive read of
// already-existing data (account record + this session's aiInsight/approval
// state) via buildAccountActivity() (src/activity.js) — no new AI call, no
// new persistence. Reuses the exact same .artifact/.artifact-type/.sub
// markup the Notes section above already renders freeTextArtifacts with —
// no new CSS component.
const ACTIVITY_TYPE_LABEL = {
  value_milestone: "Value Milestone",
  qbr_held: "QBR",
  ai_insight_loaded: "AI Insight",
  ai_insight_error: "AI Insight",
  action_reviewed: "Human Review",
  action_error: "Human Review",
};

function renderAccountActivity(acc) {
  const wrap = document.createElement("div");
  wrap.className = "ai-section";
  const items = buildAccountActivity(acc, {
    aiInsight: state.aiInsights[acc.accountId],
    approval: state.approvals[acc.accountId],
  });

  const rows = items.map(item => {
    const dt = item.sessionOnly ? fmtDateTime(item.timestamp) : fmtDate(item.timestamp);
    const sessionTag = item.sessionOnly ? ` · <span class="sub">this session</span>` : "";
    const typeLabel = ACTIVITY_TYPE_LABEL[item.type] ?? item.type;
    return `
      <div class="artifact">
        <span class="artifact-type">${escapeHtml(typeLabel)}</span> · <span class="sub">${dt}</span>${sessionTag}
        <p>${escapeHtml(item.title)}${item.detail ? ` — ${escapeHtml(item.detail)}` : ""}</p>
      </div>
    `;
  }).join("");

  wrap.innerHTML = `
    <h4>Account Activity <span class="ai-disclaimer">— existing account history, plus this session's activity</span></h4>
    ${items.length ? rows : `<p class="sub">No activity recorded yet.</p>`}
  `;
  return wrap;
}

function renderAiSection(container, acc) {
  const insight = state.aiInsights[acc.accountId] || { status: "idle" };
  const ask = state.aiAsk[acc.accountId] || { status: "idle", question: "" };

  container.innerHTML = `
    <h4>AI Insights <span class="ai-disclaimer">— AI-generated, may be inaccurate, verify before acting</span></h4>
    <div class="ai-insight-body"></div>
    <div class="ai-ask">
      <input type="text" class="ai-ask-input" placeholder="Ask a question about this account…" value="${escapeHtml(ask.question || "")}" />
      <button class="ai-ask-btn">Ask</button>
    </div>
    <div class="ai-ask-answer"></div>
  `;

  const body = container.querySelector(".ai-insight-body");
  if (insight.status === "idle") {
    const btn = document.createElement("button");
    btn.className = "ai-load-btn";
    btn.textContent = "Load AI Insights";
    btn.addEventListener("click", () => loadInsight(acc.accountId));
    body.appendChild(btn);
  } else if (insight.status === "loading") {
    body.innerHTML = `<p class="sub">Loading…</p>`;
  } else if (insight.status === "error") {
    body.innerHTML = `<p class="ai-unavailable">AI insights unavailable (${escapeHtml(insight.error)}). Calculated score remains valid.</p>`;
    const retryBtn = document.createElement("button");
    retryBtn.className = "ai-load-btn";
    retryBtn.textContent = "Try Again";
    retryBtn.addEventListener("click", () => loadInsight(acc.accountId));
    body.appendChild(retryBtn);
  } else if (insight.status === "done") {
    const d = insight.data;
    const conf = d.confidence || { level: "high", reason: "" };
    const confRisk = conf.level === "low" ? "high" : conf.level === "medium" ? "medium" : "low";
    const confLabel = conf.level === "low" ? "Low evidence confidence" : conf.level === "medium" ? "Medium evidence confidence" : "High evidence confidence";
    const nba = d.nextBestAction;
    const nbaLabel = nba?.category === "growth" ? "Next Best Action — Growth" : "Next Best Action — Risk Mitigation";
    const nbaClass = nba?.category === "growth" ? "low" : "high";
    // 2026-08 semantic color polish — same QBR card benchmark as the Review
    // UI (qbr-block-*): whole-card treatment by content TYPE, not per-word.
    // Facts (sentiment) -> neutral/Clarity Blue, interpretation (narrative)
    // -> Signal Teal, recommendation (growth NBA) -> Insight Violet, actual
    // risk content (risk_mitigation NBA) -> restrained red. Text/logic
    // unchanged — only the card class and (for NBA) the box variant differ.
    const nbaBoxClass = nba?.category === "growth" ? "nba-box-recommendation" : "nba-box-risk";
    body.innerHTML = `
      <div class="ai-fact-card"><p><strong>Sentiment:</strong> ${escapeHtml(d.sentiment?.label ?? "-")} — <span class="sub">${escapeHtml(d.sentiment?.rationale ?? "")}</span></p></div>
      <div class="ai-insight-card"><p>${escapeHtml(d.narrative ?? "")}</p></div>
      <p><span class="status-pill risk-${confRisk}">${confLabel}</span>${conf.reason ? ` <span class="sub">${escapeHtml(conf.reason)}</span>` : ""}</p>
      ${nba ? `
        <div class="nba-box ${nbaBoxClass}">
          <p class="nba-label risk-text-${nbaClass}">${nbaLabel}</p>
          <p><strong>${escapeHtml(nba.action)}</strong></p>
          <p class="sub">${escapeHtml(nba.rationale)}</p>
          <div class="nba-approval"></div>
        </div>
      ` : ""}
    `;

    if (nba) renderApprovalControl(container.querySelector(".nba-approval"), acc.accountId, nba);

    const reloadBtn = document.createElement("button");
    reloadBtn.className = "reload-link";
    reloadBtn.textContent = "↻ Reload Insight";
    reloadBtn.addEventListener("click", () => loadInsight(acc.accountId));
    body.appendChild(reloadBtn);
  }

  const askInput = container.querySelector(".ai-ask-input");
  const askBtn = container.querySelector(".ai-ask-btn");
  askBtn.addEventListener("click", () => submitAsk(acc.accountId, askInput.value));
  askInput.addEventListener("keydown", e => { if (e.key === "Enter") submitAsk(acc.accountId, askInput.value); });

  const answerBox = container.querySelector(".ai-ask-answer");
  if (ask.status === "loading") answerBox.innerHTML = `<p class="sub">Loading…</p>`;
  else if (ask.status === "error") answerBox.innerHTML = `<p class="ai-unavailable">Answer unavailable (${escapeHtml(ask.error)}).</p>`;
  else if (ask.status === "done") answerBox.innerHTML = formatAiAnswer(ask.answer);
}

// Sprint 02 — Human Review: the AI's nextBestAction is only ever a suggestion.
// A CSM must open this box, see/edit category+action+rationale, and explicitly
// confirm before anything reaches /api/approve-action. Draft edits live in
// state.approvals[accountId].draft (not local DOM state) so they survive any
// re-render (e.g. after a validation error) without reverting to the AI original.
function renderApprovalControl(container, accountId, nba, signalId = null) {
  const approvalKey = signalId || accountId;
  const approval = state.approvals[approvalKey] || { status: "idle" };

  if (approval.status === "reviewing" || approval.status === "pending" || approval.status === "error") {
    renderReviewForm(container, accountId, nba, approval, signalId);
    return;
  }

  if (approval.status === "done") {
    container.innerHTML = approval.result.workflowConnected
      ? `<p class="approval-confirm">✓ Reviewed by CSM and sent to your n8n workflow.</p>`
      : `<p class="approval-confirm">✓ Reviewed by CSM and logged (no n8n workflow connected yet).</p>`;
    return;
  }

  // idle (default)
  container.innerHTML = `<p class="review-required">Human review required</p>`;
  const btn = document.createElement("button");
  btn.className = "ai-load-btn approve-btn";
  btn.textContent = "Review action";
  btn.addEventListener("click", () => {
    state.approvals[approvalKey] = {
      status: "reviewing",
      draft: { category: nba.category, action: nba.action, rationale: nba.rationale },
    };
    render();
  });
  container.appendChild(btn);
}

// Sprint 07 — Part A: category badge color is purely a status indicator
// (Risk Mitigation = red, Growth = teal/green, reusing the same status-pill
// risk-high/risk-low colors used everywhere else in the app) — it tracks the
// CSM's current draft.category, not just the AI's original suggestion, and
// updates live if they change the Category dropdown below.
function reviewCategoryMeta(category) {
  return category === "growth"
    ? { label: "Growth", riskClass: "risk-low" }
    : { label: "Risk Mitigation", riskClass: "risk-high" };
}

function renderReviewForm(container, accountId, nba, approval, signalId = null) {
  const draft = approval.draft;
  const disabled = approval.status === "pending";
  const badgeMeta = reviewCategoryMeta(draft.category);

  container.innerHTML = `
    <div class="review-form">
      <div class="review-head">
        <p class="ai-copilot-eyebrow">HUMAN REVIEW</p>
        <div class="review-head-row">
          <h4 class="review-title">Review &amp; approve action</h4>
          <span class="status-pill review-category-badge ${badgeMeta.riskClass}">${badgeMeta.label}</span>
        </div>
      </div>

      <p class="review-section-label">AI suggestion</p>
      <div class="review-origin">
        <p class="sub review-original">${escapeHtml(nba.action)}</p>
      </div>

      <p class="review-section-label">Final action to send <span class="review-hint-inline">— this is the version that will be sent</span></p>
      <label class="review-field">Category
        <select class="review-category" ${disabled ? "disabled" : ""}>
          <option value="risk_mitigation" ${draft.category === "risk_mitigation" ? "selected" : ""}>Risk mitigation</option>
          ${!signalId || nba.category === "growth" ? `<option value="growth" ${draft.category === "growth" ? "selected" : ""}>Growth</option>` : ""}
        </select>
      </label>
      <label class="review-field">Recommended action
        <textarea class="review-action" rows="3" maxlength="700" ${disabled ? "disabled" : ""}>${escapeHtml(draft.action)}</textarea>
        <span class="review-charcount">${draft.action.length}/700</span>
      </label>
      <label class="review-field">Rationale
        <textarea class="review-rationale" rows="2" maxlength="500" ${disabled ? "disabled" : ""}>${escapeHtml(draft.rationale)}</textarea>
        <span class="review-charcount">${draft.rationale.length}/500</span>
      </label>
      ${approval.validationError ? `<p class="review-error">${escapeHtml(approval.validationError)}</p>` : ""}
      ${approval.status === "error" ? `<p class="ai-unavailable">Could not send (${escapeHtml(approval.error)}). Your edits are kept — you can try again.</p>` : ""}
      ${approval.status === "pending" ? `<p class="sub">Sending…</p>` : ""}
      <div class="review-actions">
        <button class="review-cancel-btn" ${disabled ? "disabled" : ""}>Cancel</button>
        <button class="review-confirm-btn approve-btn" ${disabled ? "disabled" : ""}>Confirm & Send to Workflow</button>
      </div>
    </div>
  `;

  const categorySel = container.querySelector(".review-category");
  const actionTa = container.querySelector(".review-action");
  const rationaleTa = container.querySelector(".review-rationale");
  const [actionCount, rationaleCount] = container.querySelectorAll(".review-charcount");
  const badgeEl = container.querySelector(".review-category-badge");

  categorySel.addEventListener("change", () => {
    draft.category = categorySel.value;
    const meta = reviewCategoryMeta(draft.category);
    badgeEl.textContent = meta.label;
    badgeEl.classList.remove("risk-high", "risk-low");
    badgeEl.classList.add(meta.riskClass);
  });
  actionTa.addEventListener("input", () => {
    draft.action = actionTa.value;
    actionCount.textContent = `${draft.action.length}/700`;
    if (draft.action.trim() && draft.action.length <= 700) container.querySelector(".review-error")?.remove();
  });
  rationaleTa.addEventListener("input", () => {
    draft.rationale = rationaleTa.value;
    rationaleCount.textContent = `${draft.rationale.length}/500`;
    if (draft.rationale.length <= 500) container.querySelector(".review-error")?.remove();
  });

  if (!disabled) {
    container.querySelector(".review-cancel-btn").addEventListener("click", () => {
      state.approvals[signalId || accountId] = { status: "idle" };
      render();
    });
    container.querySelector(".review-confirm-btn").addEventListener("click", () => {
      const validationError = reviewValidationError(draft);
      if (validationError) {
        state.approvals[signalId || accountId] = { status: "reviewing", draft, validationError };
        render();
        return;
      }
      submitApproval(accountId, draft, signalId);
    });
  }
}

// Mirrors the server-side checks in api/approve-action.js (empty action,
// 500-char limits) so invalid input never leaves the client — the server
// re-validates independently and remains the source of truth.
function reviewValidationError(draft) {
  if (!draft.action.trim()) return "Action cannot be empty.";
  if (draft.action.length > 700) return "Action must be 700 characters or fewer.";
  if (draft.rationale.length > 500) return "Rationale must be 500 characters or fewer.";
  return null;
}

async function submitApproval(accountId, draft, signalId = null) {
  const approvalKey = signalId || accountId;
  state.approvals[approvalKey] = { status: "pending", draft };
  render();
  try {
    const result = await approveAction(accountId, draft, signalId);
    // `at`: real runtime capture of the moment this resolved — feeds the
    // Account Activity Feed (src/activity.js). Never backfilled elsewhere.
    state.approvals[approvalKey] = { status: "done", result, at: new Date().toISOString() };
  } catch (e) {
    state.approvals[approvalKey] = { status: "error", draft, error: e.message, at: new Date().toISOString() };
  }
  if (signalId) {
    try { await refreshAccountData(); } catch { /* keep the review result visible; refresh on reload */ }
  }
  render();
}

async function loadInsight(accountId) {
  state.aiInsights[accountId] = { status: "loading" };
  render();
  try {
    const data = await fetchAccountInsight(accountId);
    // `at`: see the note in submitApproval above — same reasoning.
    state.aiInsights[accountId] = { status: "done", data, at: new Date().toISOString() };
  } catch (e) {
    state.aiInsights[accountId] = { status: "error", error: e.message, at: new Date().toISOString() };
  }
  render();
}

async function submitAsk(accountId, questionText) {
  if (!questionText || !questionText.trim()) return;
  state.aiAsk[accountId] = { status: "loading", question: questionText };
  render();
  try {
    const data = await askAboutAccount(accountId, questionText);
    state.aiAsk[accountId] = { status: "done", question: questionText, answer: data.answer };
  } catch (e) {
    state.aiAsk[accountId] = { status: "error", question: questionText, error: e.message };
  }
  render();
}

// Sprint 15 — AI QBR Copilot. Section titles come from the server response
// itself (see api/analyze.js withTitles()) so this file never needs its own
// copy of the section list to keep in sync.
//
// UI-only label, NOT the security boundary — mirrors SENSITIVE_QBR_SECTIONS
// in api/analyze.js just to flag these three sections with a visible
// "Manual review required" badge. The actual internal/customer-safe split is
// enforced twice already before this ever runs: server-side (these three
// keys' customerSafeDefault is forced null unconditionally) and structurally
// here (the Customer QBR Preview only ever reads state.qbr[id].review[key]
// .safeText — CSM-typed text — never .internal or .customerSafeDefault).
const QBR_SENSITIVE_KEYS = ["healthTrends", "risks", "previousInterventions"];

// UI-only mirror of api/analyze.js's QBR_SECTION_DEFS `listCapable` flag —
// same non-authoritative pattern as QBR_SENSITIVE_KEYS above. Sections here
// get an editable presentationItems[] list instead of (in addition to) the
// single-sentence presentationText field.
const QBR_LIST_CAPABLE_KEYS = ["openCommitments", "nextQuarterPlan"];

// QBR Workspace UX — groups the 12 flat sections into a small tab set so the
// review screen isn't one long vertical list. Purely a layout grouping: every
// section key still renders through the same qbr-item markup/listeners as
// before, and the internal/customer-safe security boundary (QBR_SENSITIVE_KEYS,
// selectCustomerSafeSections) is untouched by this grouping.
const QBR_TAB_GROUPS = [
  { id: "overview", label: "Overview", keys: ["executiveSummary", "businessObjectives"] },
  { id: "value-adoption", label: "Value & Adoption", keys: ["valueDelivered", "adoption", "healthTrends"] },
  { id: "relationships", label: "Relationships", keys: ["relationship", "featureRequests"] },
  { id: "risks", label: "Risks", keys: ["risks", "previousInterventions"] },
  { id: "commitments", label: "Commitments", keys: ["openCommitments", "renewalOutlook"] },
  { id: "next-quarter", label: "Next Quarter", keys: ["nextQuarterPlan"] },
];

function renderQbrSection(container, acc) {
  const accountId = acc.accountId;
  const qbr = state.qbr[accountId] || { status: "idle" };

  if (qbr.status === "idle") {
    container.innerHTML = `<h4>QBR Copilot <span class="ai-disclaimer">— AI-drafted, requires CSM review before customer use</span></h4>`;
    const btn = document.createElement("button");
    btn.className = "ai-load-btn";
    btn.textContent = "Prepare QBR";
    btn.addEventListener("click", () => loadQbrDraft(accountId));
    container.appendChild(btn);
    return;
  }

  if (qbr.status === "loading") {
    container.innerHTML = `<h4>QBR Copilot</h4><p class="sub">Preparing QBR…</p>`;
    return;
  }

  if (qbr.status === "error") {
    container.innerHTML = `<h4>QBR Copilot</h4><p class="ai-unavailable">QBR draft unavailable (${escapeHtml(qbr.error)}).</p>`;
    const retryBtn = document.createElement("button");
    retryBtn.className = "ai-load-btn";
    retryBtn.textContent = "Try Again";
    retryBtn.addEventListener("click", () => loadQbrDraft(accountId));
    container.appendChild(retryBtn);
    return;
  }

  // status === "ready"
  if (qbr.mode === "preview") renderQbrPreview(container, accountId, qbr);
  else renderQbrReview(container, accountId, qbr);
}

function renderQbrItemHtml(s, review) {
  const sensitive = QBR_SENSITIVE_KEYS.includes(s.key);
  const listCapable = QBR_LIST_CAPABLE_KEYS.includes(s.key);
  const state_ = review[s.key];
  const hasSafeText = state_.safeText.trim().length > 0;
  const placeholder = s.customerSafeDefault === null
    ? "Not included — write a customer-safe version if appropriate."
    : "Customer-safe draft — edit before it counts as reviewed.";
  // QBR Repair & Hardening — for sensitive sections, the generic "Include in
  // customer version" checkbox is misleading: it reads as if the internal
  // draft could be included, when only a human-written safeText ever can
  // (see renderQbrPreview — internal is never read there). Sensitive
  // sections instead start disabled with a label that says explicitly that
  // a customer-safe version is required first, and only become checkable
  // once the CSM has actually typed one (see the input listener below).
  const includeLabel = sensitive
    ? (hasSafeText ? "Include reviewed version in Customer QBR" : "Customer-safe version required")
    : "Include in customer version";
  const includeDisabled = sensitive && !hasSafeText;
  // Presentation content (2026-08 PPTX content contract) — a separate,
  // concise reviewed version used only by the PPTX exporter, never a
  // fallback to safeText/internal. presentationItems[] only applies to the
  // two list-capable sections (Open Commitments, Next Quarter Plan); edited
  // here as one item per line, joined back into an array on input.
  const presPlaceholder = "Presentation-safe version — used in the Web QBR and the exported PPTX. Leave blank to omit this slot.";
  const presentationFieldHtml = listCapable
    ? `<p class="qbr-block-label qbr-block-label-presentation">Presentation items <span class="review-hint-inline">one per line, for Web QBR / PPTX</span></p>
       <textarea class="qbr-presentation-items" data-key="${s.key}" rows="3" maxlength="1000" placeholder="${escapeHtml(presPlaceholder)}">${escapeHtml((state_.presentationItems || []).join("\n"))}</textarea>`
    : `<p class="qbr-block-label qbr-block-label-presentation">Presentation version <span class="review-hint-inline">Concise reviewed version for Web QBR / PPTX</span></p>
       <textarea class="qbr-presentation-text" data-key="${s.key}" rows="4" maxlength="400" placeholder="${escapeHtml(presPlaceholder)}">${escapeHtml(state_.presentationText || "")}</textarea>`;
  return `
    <div class="qbr-item${sensitive ? " qbr-item-sensitive" : ""}">
      <div class="qbr-item-head">
        <h5>${escapeHtml(s.title)}</h5>
        ${sensitive ? `<span class="status-pill risk-high">Manual review required</span>` : ""}
      </div>
      <div class="qbr-block qbr-block-internal">
        <p class="qbr-block-label qbr-block-label-internal">Internal — CS team only</p>
        <p class="qbr-block-hint qbr-block-hint-internal">AI working draft — never included in customer output</p>
        <div class="review-origin qbr-internal-text">${escapeHtml(s.internal)}</div>
      </div>
      <div class="qbr-block qbr-block-customer">
        <p class="qbr-block-label qbr-block-label-customer">Customer version</p>
        <label class="qbr-include-toggle">
          <input type="checkbox" class="qbr-include" data-key="${s.key}" ${state_.included ? "checked" : ""} ${includeDisabled ? "disabled" : ""}/>
          <span class="qbr-include-label">${escapeHtml(includeLabel)}</span>
        </label>
        <textarea class="qbr-safe-text" data-key="${s.key}" rows="3" maxlength="1500" placeholder="${escapeHtml(placeholder)}">${escapeHtml(state_.safeText)}</textarea>
      </div>
      <div class="qbr-block qbr-block-presentation">
        ${presentationFieldHtml}
      </div>
    </div>
  `;
}

function renderQbrReview(container, accountId, qbr) {
  const { data, review } = qbr;
  const sectionByKey = Object.fromEntries(data.sections.map(s => [s.key, s]));
  const activeTab = qbr.activeTab || QBR_TAB_GROUPS[0].id;

  const tabsHtml = QBR_TAB_GROUPS.map(g => {
    const flagged = g.keys.some(k => QBR_SENSITIVE_KEYS.includes(k) && !review[k]?.safeText.trim());
    return `
      <button type="button" class="qbr-tab-btn${g.id === activeTab ? " active" : ""}" data-tab="${g.id}">
        ${escapeHtml(g.label)}${flagged ? ` <span class="qbr-tab-flag" title="Manual review required">•</span>` : ""}
      </button>
    `;
  }).join("") + `<button type="button" class="qbr-tab-btn qbr-tab-btn-preview" data-action="preview">Customer Preview →</button>`;

  const panelsHtml = QBR_TAB_GROUPS.map(g => `
    <div class="qbr-tab-panel${g.id === activeTab ? " active" : ""}" data-tab-panel="${g.id}">
      <div class="qbr-sections">${g.keys.map(k => sectionByKey[k] ? renderQbrItemHtml(sectionByKey[k], review) : "").join("")}</div>
    </div>
  `).join("");

  container.innerHTML = `
    <div class="qbr-head">
      <p class="ai-copilot-eyebrow">QBR COPILOT</p>
      <h4>QBR Review <span class="ai-disclaimer">— AI-drafted, CSM review required before customer use</span></h4>
    </div>
    <nav class="qbr-tabs">${tabsHtml}</nav>
    ${panelsHtml}
    <div class="qbr-actions">
      <button class="review-cancel-btn qbr-reload-btn">↻ Regenerate Draft</button>
      <button class="review-confirm-btn qbr-preview-btn">Preview Customer QBR</button>
    </div>
  `;

  container.querySelectorAll(".qbr-include").forEach(cb => {
    cb.addEventListener("change", () => { review[cb.dataset.key].included = cb.checked; });
  });
  container.querySelectorAll(".qbr-safe-text").forEach(ta => {
    ta.addEventListener("input", () => {
      const key = ta.dataset.key;
      review[key].safeText = ta.value;
      if (!QBR_SENSITIVE_KEYS.includes(key)) return;
      // Sensitive section: unlock/relock the include checkbox live as the CSM
      // types, without a full render() (which would drop textarea focus).
      const item = ta.closest(".qbr-item");
      const cb = item.querySelector(".qbr-include");
      const label = item.querySelector(".qbr-include-label");
      const hasSafeText = ta.value.trim().length > 0;
      cb.disabled = !hasSafeText;
      if (!hasSafeText) { cb.checked = false; review[key].included = false; }
      if (label) label.textContent = hasSafeText ? "Include reviewed version in Customer QBR" : "Customer-safe version required";
    });
  });
  container.querySelectorAll(".qbr-presentation-text").forEach(ta => {
    ta.addEventListener("input", () => { review[ta.dataset.key].presentationText = ta.value; });
  });
  container.querySelectorAll(".qbr-presentation-items").forEach(ta => {
    ta.addEventListener("input", () => {
      review[ta.dataset.key].presentationItems = ta.value.split("\n").map(line => line.trim()).filter(Boolean);
    });
  });
  // Tab switching is pure visibility toggling (no render()), so in-progress
  // textarea edits on other tabs are never lost or re-rendered away.
  container.querySelectorAll(".qbr-tab-btn[data-tab]").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      qbr.activeTab = tab;
      container.querySelectorAll(".qbr-tab-btn[data-tab]").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
      container.querySelectorAll(".qbr-tab-panel").forEach(p => p.classList.toggle("active", p.dataset.tabPanel === tab));
    });
  });
  container.querySelector(".qbr-reload-btn").addEventListener("click", () => loadQbrDraft(accountId));
  const goToPreview = () => { state.qbr[accountId].mode = "preview"; render(); };
  container.querySelector(".qbr-preview-btn").addEventListener("click", goToPreview);
  container.querySelector(".qbr-tab-btn-preview").addEventListener("click", goToPreview);
}

// Renders ONLY from qbr.review[key] — the CSM-edited safeText and included
// flag — never from data.sections[].internal or .customerSafeDefault. This
// is the actual internal/customer-safe boundary (see the module comment
// above QBR_SENSITIVE_KEYS): nothing reaches this view without a human
// having opened the review panel and explicitly kept/edited/included it.
function renderQbrPreview(container, accountId, qbr) {
  const acc = state.accounts.find(a => a.accountId === accountId);
  const included = selectCustomerSafeSections(qbr.data.sections, qbr.review);
  const exp = qbr.export || { status: "idle" };

  const body = included.length
    ? included.map(s => `
        <div class="qbr-preview-item">
          <h5>${escapeHtml(s.title)}</h5>
          <p>${escapeHtml(qbr.review[s.key].safeText.trim())}</p>
        </div>
      `).join("")
    : `<p class="sub">No sections included yet — go back to review and include at least one section.</p>`;

  // Generate Customer QBR — exports the LIGHT PowerPoint deck from exactly
  // what's rendered above: selectCustomerSafeSections()'s output plus each
  // included section's reviewed safeText. Same security boundary the
  // preview already uses; the export request never carries `internal` or
  // `customerSafeDefault`.
  const warningsHtml = exp.status === "error" && exp.warnings?.length
    ? `<ul class="qbr-export-warnings">${exp.warnings.map(w => `<li><strong>${escapeHtml(w.slide)} — ${escapeHtml(w.slot)}:</strong> ${escapeHtml(w.message)}</li>`).join("")}</ul>`
    : "";

  container.innerHTML = `
    <div class="qbr-head">
      <p class="ai-copilot-eyebrow">CUSTOMER QBR PREVIEW</p>
      <h4>${escapeHtml(acc?.accountName ?? "")} — Customer QBR</h4>
    </div>
    <div class="qbr-preview-body">${body}</div>
    ${exp.status === "error" ? `<p class="ai-unavailable">${escapeHtml(exp.error)}</p>${warningsHtml}` : ""}
    <div class="qbr-actions">
      <button class="review-cancel-btn qbr-back-btn">← Back to Review</button>
      <button class="review-confirm-btn qbr-open-web-btn" ${included.length === 0 ? "disabled" : ""}>
        Open Web QBR
      </button>
      <button class="review-confirm-btn qbr-generate-btn" ${included.length === 0 || exp.status === "loading" ? "disabled" : ""}>
        ${exp.status === "loading" ? "Generating…" : "Download PowerPoint"}
      </button>
    </div>
  `;

  container.querySelector(".qbr-back-btn").addEventListener("click", () => {
    state.qbr[accountId].mode = "review";
    render();
  });
  container.querySelector(".qbr-open-web-btn").addEventListener("click", () => openWebQbr(accountId));
  container.querySelector(".qbr-generate-btn").addEventListener("click", () => downloadQbrPptx(accountId));
}

// Web QBR spike — same governed-content boundary as the PPTX export
// (selectCustomerSafeSections() + reviewed safeText/presentationText/
// presentationItems only), rendered client-side with no server round trip
// and no new LLM call. Opens the 3-page deck in a new tab via a Blob URL.
function openWebQbr(accountId) {
  const acc = state.accounts.find(a => a.accountId === accountId);
  const qbr = state.qbr[accountId];
  const included = selectCustomerSafeSections(qbr.data.sections, qbr.review);
  const sections = included.map(s => ({
    key: s.key,
    safeText: qbr.review[s.key].safeText.trim(),
    presentationText: (qbr.review[s.key].presentationText || "").trim(),
    presentationItems: qbr.review[s.key].presentationItems || [],
  }));
  const content = mapQbrToHtmlContent({ account: acc, sections });
  const html = renderQbrHtml({ account: acc, content, csmName: csmName(acc.csmId) });
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  window.open(url, "_blank");
}

async function downloadQbrPptx(accountId) {
  const qbr = state.qbr[accountId];
  const included = selectCustomerSafeSections(qbr.data.sections, qbr.review);
  // 2026-08 content contract — carries presentationText/presentationItems
  // alongside safeText, gated by the exact same included/safeText boundary
  // selectCustomerSafeSections() already enforces; never sourced from
  // s.internal or s.customerSafeDefault.
  const sections = included.map(s => ({
    key: s.key,
    safeText: qbr.review[s.key].safeText.trim(),
    presentationText: (qbr.review[s.key].presentationText || "").trim(),
    presentationItems: qbr.review[s.key].presentationItems || [],
  }));

  qbr.export = { status: "loading", error: null, warnings: null };
  render();
  try {
    const { blob, filename } = await generateQbrPptx(accountId, sections);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    qbr.export = { status: "idle", error: null, warnings: null };
  } catch (e) {
    qbr.export = { status: "error", error: e.message, warnings: e.warnings || null };
  }
  render();
}

async function loadQbrDraft(accountId) {
  state.qbr[accountId] = { status: "loading" };
  render();
  try {
    const data = await fetchQbrDraft(accountId);
    const review = {};
    data.sections.forEach(s => {
      const sensitive = QBR_SENSITIVE_KEYS.includes(s.key);
      review[s.key] = {
        included: !sensitive && s.customerSafeDefault !== null,
        safeText: sensitive ? "" : (s.customerSafeDefault || ""),
        // Presentation content (PPTX-only) — same sensitive-section
        // guardrail as safeText: the server already nulls these for
        // healthTrends/risks/previousInterventions, but init defensively.
        presentationText: sensitive ? "" : (s.presentationText || ""),
        presentationItems: sensitive ? [] : (Array.isArray(s.presentationItems) ? s.presentationItems : []),
      };
    });
    state.qbr[accountId] = { status: "ready", mode: "review", data, review };
  } catch (e) {
    state.qbr[accountId] = { status: "error", error: e.message };
  }
  render();
}

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const TREND_GLYPH = { up: "▲", down: "▼", flat: "" };
const TREND_TEXT = { up: "Improving ▲", down: "Declining ▼", flat: "Stable" };

// Shared custom tooltip for chart dots (replaces native SVG <title>, which
// can't be styled — no bold text, no forced line breaks). contentFn(account)
// returns the tooltip's inner HTML; delegated to `.matrix-dot` elements so it
// works for both the Matrix and Map views without duplicating listener setup.
function attachDotTooltip(wrap, list, contentFn) {
  const tip = document.createElement("div");
  tip.className = "chart-tooltip";
  wrap.appendChild(tip);

  wrap.querySelectorAll(".matrix-dot").forEach(dot => {
    dot.addEventListener("mouseenter", () => {
      const account = list.find(a => a.accountId === dot.dataset.accountId);
      if (!account) return;
      tip.innerHTML = contentFn(account);
      tip.style.display = "block";
    });
    dot.addEventListener("mousemove", e => {
      tip.style.left = `${e.clientX + 14}px`;
      tip.style.top = `${e.clientY + 14}px`;
    });
    dot.addEventListener("mouseleave", () => {
      tip.style.display = "none";
    });
  });
}

function renderMatrix() {
  const wrap = document.createElement("div");
  wrap.className = "matrix-view";
  const list = getFilteredAccounts();
  wrap.appendChild(renderViewHeader("Matrix", "Value Realization against Strategic Value, or renewal urgency — spot which accounts need attention first."));

  if (list.length === 0) {
    const empty = document.createElement("p");
    empty.className = "sub";
    empty.textContent = "No accounts match the current filters.";
    wrap.appendChild(empty);
    return wrap;
  }

  const mode = state.matrixMode;

  // Sprint 14B — Renewal Radar time filter: only accounts renewing within
  // the selected window are plotted/counted in renewal mode. "all" removes
  // the upper bound entirely (still excludes already-past renewal dates,
  // none of which exist in this dataset relative to the fixed reference
  // date anyway). Value mode is untouched by this — it keeps using the
  // full filtered `list`.
  const renewalWindow = state.renewalWindowDays;
  const renewalWindowLimit = renewalWindow === "all" ? Infinity : renewalWindow;
  const renewalWindowLabel = renewalWindow === "all" ? "any time" : `the next ${renewalWindow} days`;
  const displayList = mode === "renewal"
    ? list.filter(a => { const d = daysFromToday(a.contract.nextRenewalDate); return d >= 0 && d <= renewalWindowLimit; })
    : list;

  if (displayList.length === 0) {
    const wrapEmpty = document.createElement("div");
    wrapEmpty.innerHTML = `
      <div class="matrix-toggle">
        <button class="matrix-toggle-btn active" data-mode="renewal">Renewal Radar (Health × Time-to-Renewal)</button>
        <button class="matrix-toggle-btn" data-mode="value">Value Matrix (Value Realization × Strategic Value)</button>
      </div>
      <p class="sub">No accounts in the current filters have an upcoming renewal within ${renewalWindowLabel}.</p>
    `;
    wrap.appendChild(wrapEmpty);
    wrap.querySelectorAll(".matrix-toggle-btn").forEach(btn => {
      btn.addEventListener("click", () => { state.matrixMode = btn.dataset.mode; state.matrixSelected = null; render(); });
    });
    return wrap;
  }

  const W = 820, H = 520;
  const marginLeft = 70, marginRight = 24, marginTop = 40, marginBottom = 50;
  const plotW = W - marginLeft - marginRight;
  const plotH = H - marginTop - marginBottom;
  const xMid = 50;

  const arrValues = displayList.map(a => a.contract.arrUSD);
  const minArr = Math.min(...arrValues);
  const maxArr = Math.max(...arrValues);

  // Sprint 14B — Value Matrix axes, using the closest available proxy fields
  // (see the sprint report: no dedicated "value realization" field exists in
  // the demo data, so this composes from existing computed/raw fields
  // rather than inventing a new one):
  //   X = Value Realization  → usage.adoptionRatePct (how much of the
  //       licensed product the account actually uses)
  //   Y = Strategic / Revenue Value → expansion.score (the app's existing
  //       0-100 growth/upsell composite — closer to "strategic potential"
  //       than raw ARR, which is already the bubble size)
  // Renewal mode is unchanged: X = Health Score, Y = -days-to-renewal.
  const xPlotOf = a => mode === "value" ? a.usage.adoptionRatePct : a.health.score;
  // yPlot is the value actually placed on the Y axis (higher = nearer the top).
  // Value mode: yPlot = Expansion Score. Renewal mode: yPlot = -daysToRenewal
  // (sooner renewal = higher up = more urgent).
  const yPlotOf = a => mode === "renewal" ? -daysFromToday(a.contract.nextRenewalDate) : a.expansion.score;
  const yPlotValues = displayList.map(yPlotOf);
  const minY = Math.min(...yPlotValues);
  const maxY = Math.max(...yPlotValues);
  const yPlotMedian = median(yPlotValues);

  const xScale = v => marginLeft + (v / 100) * plotW;
  const yScale = yPlot => {
    if (maxY === minY) return marginTop + plotH / 2;
    return marginTop + (1 - (yPlot - minY) / (maxY - minY)) * plotH;
  };
  // Bubble size = ARR in both modes now (Sprint 14B): renewal mode already
  // used this (ARR is on neither axis there); value mode used to size by
  // Expansion Score, now matches the spec's "bubble size = ARR" directly —
  // Expansion Score still drives the Y axis instead, so no signal is lost.
  const radiusOf = a => {
    if (maxArr === minArr) return 9;
    return 5 + ((a.contract.arrUSD - minArr) / (maxArr - minArr)) * 11;
  };

  const quadrantX = xScale(xMid);
  const quadrantY = yScale(yPlotMedian);

  // Rough scale reference so the axes aren't just unlabeled lines — three
  // ticks per axis (start/mid/end), not a full gridline system. X is always
  // a fixed 0-100 domain (Health Score or Adoption %); Y uses the actual
  // plotted min/median/max for whichever metric is on it this mode
  // (Expansion Score, or renewal urgency in days, converting the negated
  // yPlot back to real days).
  const xTickVals = [0, 50, 100];
  const xTicks = xTickVals.map((v, i) => {
    const anchor = i === 0 ? "start" : i === xTickVals.length - 1 ? "end" : "middle";
    return `<text x="${xScale(v).toFixed(1)}" y="${(marginTop + plotH + 16).toFixed(1)}" class="axis-tick" text-anchor="${anchor}">${v}</text>`;
  }).join("");
  const yTickVals = [minY, yPlotMedian, maxY];
  const yTickLabel = v => mode === "renewal" ? `${Math.round(-v)}d` : String(Math.round(v));
  const yTicks = yTickVals.map(v =>
    `<text x="${(marginLeft - 8).toFixed(1)}" y="${(yScale(v) + 3).toFixed(1)}" class="axis-tick" text-anchor="end">${yTickLabel(v)}</text>`
  ).join("");

  const dots = displayList.map(a => {
    const cx = xScale(xPlotOf(a));
    const cy = yScale(yPlotOf(a));
    const r = radiusOf(a);
    const glyph = TREND_GLYPH[a.trend];
    const glyphSpan = glyph ? `<text x="${(cx + r + 2).toFixed(1)}" y="${(cy + 4).toFixed(1)}" class="trend-glyph trend-${a.trend}">${glyph}</text>` : "";
    // Renewal Radar — a dashed outer ring makes at-risk renewals within the
    // selected window ("Critical": high risk + renewing within the window)
    // clearly stand out beyond just their red fill color.
    const criticalRing = (mode === "renewal" && a.health.riskCategory === "high")
      ? `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(r + 3).toFixed(1)}" class="matrix-dot-critical-ring"></circle>`
      : "";
    return `${criticalRing}<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" class="matrix-dot risk-dot-${a.health.riskCategory}" data-account-id="${a.accountId}"></circle>${glyphSpan}`;
  }).join("");

  // Quadrant label blocks: title + one-line description, with a background
  // chip so they stay legible over dots. Positioned inset from the corners.
  const quadrantLabels = mode === "renewal" ? [
    { x: marginLeft + 12, y: marginTop + 12, anchor: "start", cls: "ql-save", title: "Save — Urgent!", desc: "At risk, renewing soon. Call today." },
    { x: marginLeft + plotW - 12, y: marginTop + 12, anchor: "end", cls: "ql-protect", title: "Confirm & Expand", desc: "Healthy, renewal coming up. Upsell moment." },
    { x: marginLeft + 12, y: marginTop + plotH - 34, anchor: "start", cls: "ql-monitor", title: "Fix Quietly", desc: "At risk, renewal is distant. Fix before urgent." },
    { x: marginLeft + plotW - 12, y: marginTop + plotH - 34, anchor: "end", cls: "ql-nurture", title: "Steady — Low Touch", desc: "Healthy, renewal is distant. No rush." },
  ] : [
    // Sprint 14B — Value Matrix quadrant naming: X = Value Realization
    // (Adoption %, low→high), Y = Strategic Value (Expansion Score,
    // low→high). Top-left = strategically important but under-using the
    // product = the biggest hidden risk, hence "Reassess"; top-right = both
    // high = the accounts worth protecting and using as proof points;
    // bottom-left = neither high = low-touch maintenance; bottom-right =
    // realizing value already but not yet strategically large = the best
    // growth candidates.
    { x: marginLeft + 12, y: marginTop + 12, anchor: "start", cls: "ql-save", title: "Reassess", desc: "Strategic account, low value realization. Find out why." },
    { x: marginLeft + plotW - 12, y: marginTop + 12, anchor: "end", cls: "ql-protect", title: "Protect & Prove Value", desc: "High realization, high strategic value. Protect & showcase." },
    { x: marginLeft + 12, y: marginTop + plotH - 34, anchor: "start", cls: "ql-monitor", title: "Maintain", desc: "Lower realization, lower strategic value. Low-touch upkeep." },
    { x: marginLeft + plotW - 12, y: marginTop + plotH - 34, anchor: "end", cls: "ql-nurture", title: "Grow", desc: "Realizing value well. Grow the strategic footprint." },
  ];
  const labelBlocks = quadrantLabels.map(l => `
    <text x="${l.x}" y="${l.y}" class="quadrant-label ${l.cls}" text-anchor="${l.anchor}">${escapeHtml(l.title)}</text>
    <text x="${l.x}" y="${l.y + 16}" class="quadrant-desc ${l.cls}" text-anchor="${l.anchor}">${escapeHtml(l.desc)}</text>
  `).join("");

  const svg = `
    <svg viewBox="0 0 ${W} ${H}" class="matrix-svg">
      <!-- quadrant backgrounds -->
      <rect x="${marginLeft}" y="${marginTop}" width="${quadrantX - marginLeft}" height="${quadrantY - marginTop}" class="quadrant-bg quadrant-save" />
      <rect x="${quadrantX}" y="${marginTop}" width="${marginLeft + plotW - quadrantX}" height="${quadrantY - marginTop}" class="quadrant-bg quadrant-protect" />
      <rect x="${marginLeft}" y="${quadrantY}" width="${quadrantX - marginLeft}" height="${marginTop + plotH - quadrantY}" class="quadrant-bg quadrant-monitor" />
      <rect x="${quadrantX}" y="${quadrantY}" width="${marginLeft + plotW - quadrantX}" height="${marginTop + plotH - quadrantY}" class="quadrant-bg quadrant-nurture" />

      <!-- quadrant divider lines -->
      <line x1="${quadrantX}" y1="${marginTop}" x2="${quadrantX}" y2="${marginTop + plotH}" class="quadrant-divider" />
      <line x1="${marginLeft}" y1="${quadrantY}" x2="${marginLeft + plotW}" y2="${quadrantY}" class="quadrant-divider" />

      <!-- axes -->
      <line x1="${marginLeft}" y1="${marginTop + plotH}" x2="${marginLeft + plotW}" y2="${marginTop + plotH}" class="axis-line" />
      <line x1="${marginLeft}" y1="${marginTop}" x2="${marginLeft}" y2="${marginTop + plotH}" class="axis-line" />

      <!-- rough axis scale (start/mid/end ticks, not a full gridline system) -->
      ${xTicks}
      ${yTicks}

      <!-- quadrant labels (title + description) -->
      ${labelBlocks}

      <!-- axis titles -->
      <text x="${marginLeft + plotW / 2}" y="${H - 12}" class="axis-title" text-anchor="middle">${mode === "renewal" ? "Health Score" : "Value Realization (Adoption %)"} →</text>
      <text x="16" y="${marginTop + plotH / 2}" class="axis-title" text-anchor="middle" transform="rotate(-90, 16, ${marginTop + plotH / 2})">${mode === "renewal" ? "Renewal urgency →" : "Strategic / Revenue Value →"}</text>
      <text x="${marginLeft + plotW / 2}" y="16" class="axis-title" text-anchor="middle">ARR (bubble size)</text>

      ${dots}
    </svg>
  `;

  const selected = state.matrixSelected ? displayList.find(a => a.accountId === state.matrixSelected) : null;
  const detailPanel = selected ? `
    <div class="matrix-detail">
      <button class="matrix-detail-close" aria-label="Close">&times;</button>
      <h4>${escapeHtml(selected.accountName)} <span class="status-pill risk-${selected.health.riskCategory}">${RISK_LABEL[selected.health.riskCategory]}</span></h4>
      <p class="sub">${escapeHtml(selected.industry)} · ${escapeHtml(selected.subregion)} · ${escapeHtml(csmName(selected.csmId))} · CSAT trend: <span class="trend-${selected.trend}">${TREND_TEXT[selected.trend]}</span></p>
      <div class="matrix-detail-stats">
        <div><span class="stat-num risk-text-${selected.health.riskCategory}">${selected.health.score}</span><span class="stat-label">Health Score</span></div>
        <div><span class="stat-num">${fmtUSD(selected.contract.arrUSD)}</span><span class="stat-label">ARR</span></div>
        <div><span class="stat-num exp-text-${selected.expansion.category}">${selected.expansion.score}</span><span class="stat-label">Expansion</span></div>
        <div><span class="stat-num">${daysFromToday(selected.contract.nextRenewalDate)}d</span><span class="stat-label">To Renewal</span></div>
      </div>
      <p class="sub">CSM: ${escapeHtml(csmName(selected.csmId))} · Top risk signal: ${escapeHtml(selected.health.criteria[0].label)} (${escapeHtml(String(selected.health.criteria[0].rawValue))})</p>
      <button class="ai-load-btn matrix-detail-link">View full details in Portfolio →</button>
    </div>
  ` : "";

  // Sprint 14B — no dedicated "value realization" field exists in the demo
  // data, so this is the proxy call-out required by the sprint brief: made
  // explicit here rather than silently redefining a metric.
  const modeDesc = mode === "renewal"
    ? `X: Health Score, Y: renewal urgency (sooner = higher), bubble size: ARR. Quadrant lines split at Health ${xMid} and the median renewal date of the accounts renewing within ${renewalWindowLabel}.`
    : `X: Adoption Rate % as a Value Realization proxy (no dedicated field exists in the demo data), Y: Expansion Score as a Strategic/Revenue Value proxy, bubble size: ARR. Quadrant lines split at 50% adoption and the median Expansion Score of the filtered accounts.`;

  // Renewal Radar KPI row + insight line — only meaningful in renewal mode,
  // computed directly from displayList (already windowed to renewalWindow
  // days). "Critical" = high risk AND renewing within the window, matching
  // the dashed critical-ring dots above — no invented likelihood/GRR/NRR.
  let renewalKpiRow = "", renewalInsight = "";
  if (mode === "renewal") {
    const arrRenewing = displayList.reduce((s, a) => s + a.contract.arrUSD, 0);
    const criticalAccounts = displayList.filter(a => a.health.riskCategory === "high");
    const arrAtRisk = criticalAccounts.reduce((s, a) => s + a.contract.arrUSD, 0);
    renewalKpiRow = `<div class="kpi-strip">${renderKpiTiles([
      { label: "ARR renewing", value: fmtUSD(arrRenewing), tone: "neutral" },
      { label: "ARR at risk", value: fmtUSD(arrAtRisk), tone: "high" },
      { label: "Renewals", value: String(displayList.length), tone: "neutral" },
      { label: "Critical", value: String(criticalAccounts.length), tone: "high" },
    ])}</div>`;
    renewalInsight = `<p class="sub geo-insight">${displayList.length} renewal(s) worth ${fmtUSD(arrRenewing)} fall within ${renewalWindowLabel} — ${criticalAccounts.length} flagged high risk (${fmtUSD(arrAtRisk)}).</p>`;
  }

  // Sprint 16 — the reused Ask box (see below) adds height above the chart
  // in both modes now, on top of renewal mode's own window-toggle/KPI row.
  // Chart width (and so, via the fixed aspect ratio, its height) shrinks a
  // bit further when the Ask box is expanded, so the chart itself stays
  // above the fold rather than pushing the page into a scroll. Tuned
  // empirically against 1440x900 — see the browser checks in this sprint's
  // report, not derived from a formula.
  const askExpanded = state.portfolioAskExpanded;
  const chartWidthFactor = mode === "renewal"
    ? (askExpanded ? 0.36 : 0.42)
    : (askExpanded ? 0.42 : 0.51);
  const chartMaxWidth = Math.min(700, Math.round(window.innerWidth * chartWidthFactor));

  // A dedicated content container (not wrap.innerHTML directly) — wrap
  // already holds the view header appended above, which a wrap.innerHTML
  // assignment would silently discard.
  const content = document.createElement("div");
  content.innerHTML = `
    <div class="matrix-toggle">
      <button class="matrix-toggle-btn ${mode === "value" ? "active" : ""}" data-mode="value">Value Matrix (Value Realization × Strategic Value)</button>
      <button class="matrix-toggle-btn ${mode === "renewal" ? "active" : ""}" data-mode="renewal">Renewal Radar (Health × Time-to-Renewal)</button>
    </div>
    ${mode === "renewal" ? `
      <div class="matrix-toggle matrix-window-toggle">
        ${[30, 60, 90, 180].map(d => `<button class="matrix-toggle-btn matrix-toggle-btn-sm ${renewalWindow === d ? "active" : ""}" data-window="${d}">${d} days</button>`).join("")}
        <button class="matrix-toggle-btn matrix-toggle-btn-sm ${renewalWindow === "all" ? "active" : ""}" data-window="all">All</button>
      </div>
      ${renewalKpiRow}
      ${renewalInsight}
    ` : ""}
    <div class="portfolio-ask-slot"></div>
    <p class="sub">Each dot is an account. ${modeDesc} ▲/▼ next to a dot = CSAT trend over the last 8 weeks. Click a dot for details.</p>
    <div class="matrix-wrap" style="max-width:${chartMaxWidth}px;">${svg}</div>
    ${detailPanel}
    <div class="summary-bar" style="margin-top:14px;">
      <div class="summary-chip risk-high">● High risk</div>
      <div class="summary-chip risk-medium">● Medium risk</div>
      <div class="summary-chip risk-low">● Low risk</div>
      <div class="summary-chip neutral">▲ improving / ▼ declining CSAT</div>
    </div>
  `;
  content.querySelector(".portfolio-ask-slot").replaceWith(
    renderPortfolioAsk(displayList, {
      title: "Ask AI about this view",
      scopeIntro: "AI answers based on the currently visible accounts",
      viewLabel: mode === "renewal" ? "Renewal Radar" : "Value Matrix",
      collapsible: true,
    })
  );
  wrap.appendChild(content);

  wrap.querySelectorAll(".matrix-toggle-btn[data-mode]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.matrixMode = btn.dataset.mode;
      state.matrixSelected = null;
      render();
    });
  });

  wrap.querySelectorAll(".matrix-toggle-btn[data-window]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.renewalWindowDays = btn.dataset.window === "all" ? "all" : Number(btn.dataset.window);
      state.matrixSelected = null;
      render();
    });
  });

  wrap.querySelectorAll(".matrix-dot").forEach(dot => {
    dot.addEventListener("click", () => {
      state.matrixSelected = dot.dataset.accountId;
      render();
    });
  });

  attachDotTooltip(wrap, displayList, a => `
    <div class="tt-name">${escapeHtml(a.accountName)}</div>
    <div class="tt-row"><span class="tt-label">Health Score:</span> <strong>${a.health.score}</strong> (${RISK_LABEL[a.health.riskCategory]} risk)</div>
    <div class="tt-row"><span class="tt-label">ARR:</span> ${fmtUSD(a.contract.arrUSD)}</div>
    ${mode === "renewal" ? `<div class="tt-row"><span class="tt-label">Renewal in:</span> ${daysFromToday(a.contract.nextRenewalDate)} days</div>` : `<div class="tt-row"><span class="tt-label">Adoption:</span> ${a.usage.adoptionRatePct}%</div><div class="tt-row"><span class="tt-label">Expansion:</span> ${a.expansion.score} (${a.expansion.category})</div>`}
    <div class="tt-row"><span class="tt-label">CSAT trend:</span> ${TREND_TEXT[a.trend]}</div>
  `);

  wrap.querySelector(".matrix-detail-close")?.addEventListener("click", () => {
    state.matrixSelected = null;
    render();
  });

  wrap.querySelector(".matrix-detail-link")?.addEventListener("click", () => {
    const id = state.matrixSelected;
    state.view = "portfolio";
    state.expanded = id;
    state.matrixSelected = null;
    render();
    document.getElementById(`detail-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  return wrap;
}

const RISK_HEX = { high: "#dc2626", medium: "#d97706", low: "#16a34a" };
let leafletMapInstance = null;

function renderKpiTiles(kpis) {
  return kpis.map(k => `
    <div class="kpi-tile kpi-tile-${k.tone}">
      <span class="kpi-value">${escapeHtml(k.value)}</span>
      <span class="kpi-label">${escapeHtml(k.label)}</span>
    </div>
  `).join("");
}

// Sprint 14B — Geo Intelligence: marker size encodes whatever state.mapMode
// is currently showing (color always stays risk level, for a consistent
// legend across all three modes). All three modes scale within the
// currently filtered list's own min/max, same min-max-normalize approach as
// the Matrix bubbles — "worse"/"bigger deal"/"more urgent" always renders
// as the bigger dot.
function mapMarkerRadius(a, mode, list) {
  if (mode === "arr") {
    const values = list.map(x => x.contract.arrUSD);
    const min = Math.min(...values), max = Math.max(...values);
    if (max === min) return 9;
    return 6 + ((a.contract.arrUSD - min) / (max - min)) * 10;
  }
  if (mode === "renewal") {
    const values = list.map(x => daysFromToday(x.contract.nextRenewalDate));
    const min = Math.min(...values), max = Math.max(...values);
    if (max === min) return 9;
    // Sooner renewal = more urgent = bigger dot, so invert the normalized value.
    const days = daysFromToday(a.contract.nextRenewalDate);
    return 6 + ((max - days) / (max - min)) * 10;
  }
  // health mode: lower Health Score = more at-risk = bigger dot.
  const values = list.map(x => x.health.score);
  const min = Math.min(...values), max = Math.max(...values);
  if (max === min) return 9;
  return 6 + ((max - a.health.score) / (max - min)) * 10;
}

function renderMap() {
  const wrap = document.createElement("div");
  const list = getFilteredAccounts().filter(a => a.location);
  wrap.appendChild(renderViewHeader("Geo Intelligence", "Fictional HQ locations, colored by risk level — a geographic read on the same filtered portfolio."));

  if (list.length === 0) {
    const empty = document.createElement("p");
    empty.className = "sub";
    empty.textContent = "No accounts with location data match the current filters.";
    wrap.appendChild(empty);
    return wrap;
  }

  const mode = state.mapMode;

  // Region Summary — grouped by the same top-level "region" field the
  // existing Region filter uses (not the finer-grained "subregion"), built
  // only from fields already on each account: no new/invented data.
  const regionGroups = {};
  list.forEach(a => {
    if (!regionGroups[a.region]) regionGroups[a.region] = [];
    regionGroups[a.region].push(a);
  });
  const regionStats = Object.entries(regionGroups).map(([region, accs]) => {
    const atRisk = accs.filter(a => a.health.riskCategory === "high");
    const arrAtRisk = atRisk.reduce((s, a) => s + a.contract.arrUSD, 0);
    const upcoming = accs.filter(a => {
      const d = daysFromToday(a.contract.nextRenewalDate);
      return d >= 0 && d <= 90;
    }).length;
    return {
      region,
      count: accs.length,
      arr: accs.reduce((s, a) => s + a.contract.arrUSD, 0),
      atRiskCount: atRisk.length,
      arrAtRisk,
      upcoming,
    };
  }).sort((a, b) => b.arr - a.arr);

  // Geo-Insight — purely computed from the region stats above (no AI call):
  // which region currently carries the most at-risk ARR. Only shown when
  // there's actually at-risk ARR somewhere, so it never reads as a false alarm.
  const topAtRiskRegion = [...regionStats].sort((a, b) => b.arrAtRisk - a.arrAtRisk)[0];
  const geoInsight = topAtRiskRegion && topAtRiskRegion.arrAtRisk > 0
    ? `<p class="sub geo-insight"><strong>${escapeHtml(topAtRiskRegion.region)}</strong> currently carries the most ARR at risk: ${fmtUSD(topAtRiskRegion.arrAtRisk)} across ${topAtRiskRegion.atRiskCount} high-risk account(s).</p>`
    : "";

  const regionCards = regionStats.map(r => `
    <div class="region-card">
      <p class="region-card-name">${escapeHtml(r.region)}</p>
      <div class="region-card-stats">
        <div><span class="stat-num">${r.count}</span><span class="stat-label">Accounts</span></div>
        <div><span class="stat-num">${fmtUSD(r.arr)}</span><span class="stat-label">ARR</span></div>
        <div><span class="stat-num${r.atRiskCount > 0 ? " risk-text-high" : ""}">${r.atRiskCount}</span><span class="stat-label">At Risk</span></div>
        <div><span class="stat-num">${r.upcoming}</span><span class="stat-label">Renewals ≤90d</span></div>
      </div>
    </div>
  `).join("");

  const selected = state.mapSelected ? list.find(a => a.accountId === state.mapSelected) : null;
  const detailPanel = selected ? `
    <div class="matrix-detail">
      <button class="matrix-detail-close" aria-label="Close">&times;</button>
      <h4>${escapeHtml(selected.accountName)} <span class="status-pill risk-${selected.health.riskCategory}">${RISK_LABEL[selected.health.riskCategory]}</span></h4>
      <p class="sub">${escapeHtml(selected.location.city)}, ${escapeHtml(selected.location.country)} · ${escapeHtml(selected.industry)} · ${escapeHtml(csmName(selected.csmId))}</p>
      <div class="matrix-detail-stats">
        <div><span class="stat-num risk-text-${selected.health.riskCategory}">${selected.health.score}</span><span class="stat-label">Health Score</span></div>
        <div><span class="stat-num">${fmtUSD(selected.contract.arrUSD)}</span><span class="stat-label">ARR</span></div>
        <div><span class="stat-num">${daysFromToday(selected.contract.nextRenewalDate)}d</span><span class="stat-label">To Renewal</span></div>
      </div>
      <p class="sub">CSM: ${escapeHtml(csmName(selected.csmId))} · Top risk signal: ${escapeHtml(selected.health.criteria[0].label)} (${escapeHtml(String(selected.health.criteria[0].rawValue))})</p>
      <button class="ai-load-btn matrix-detail-link">View full details in Portfolio →</button>
    </div>
  ` : "";

  const modeCopy = {
    health: "Dot color = risk level, size = how low the Health Score is (bigger = more at-risk).",
    arr: "Dot color = risk level, size = ARR (bigger = larger deal).",
    renewal: "Dot color = risk level, size = renewal urgency (bigger = renewing sooner).",
  };

  // Dedicated content container — see the same note in renderMatrix() for why
  // this can't be a direct wrap.innerHTML assignment (would drop the header).
  const content = document.createElement("div");
  content.innerHTML = `
    <div class="matrix-toggle">
      <button class="matrix-toggle-btn ${mode === "health" ? "active" : ""}" data-mode="health">Health</button>
      <button class="matrix-toggle-btn ${mode === "arr" ? "active" : ""}" data-mode="arr">ARR</button>
      <button class="matrix-toggle-btn ${mode === "renewal" ? "active" : ""}" data-mode="renewal">Renewal</button>
    </div>
    <div class="portfolio-ask-slot"></div>
    <p class="sub">Plotted on real OpenStreetMap data. ${modeCopy[mode]} Click a marker for details.</p>
    <div id="leaflet-map" class="leaflet-map"></div>
    ${detailPanel}
    <div class="summary-bar" style="margin-top:14px;">
      <div class="summary-chip risk-high">● High risk</div>
      <div class="summary-chip risk-medium">● Medium risk</div>
      <div class="summary-chip risk-low">● Low risk</div>
    </div>
    <h4 class="region-summary-heading">Region Summary</h4>
    ${geoInsight}
    <div class="region-card-grid">${regionCards}</div>
  `;
  content.querySelector(".portfolio-ask-slot").replaceWith(
    renderPortfolioAsk(list, { title: "Ask AI about this view", scopeIntro: "AI answers based on the currently visible accounts", viewLabel: "Map", collapsible: true })
  );
  wrap.appendChild(content);

  wrap.querySelectorAll(".matrix-toggle-btn[data-mode]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.mapMode = btn.dataset.mode;
      state.mapSelected = null;
      render();
    });
  });

  wrap.querySelector(".matrix-detail-close")?.addEventListener("click", () => {
    state.mapSelected = null;
    render();
  });

  wrap.querySelector(".matrix-detail-link")?.addEventListener("click", () => {
    const id = state.mapSelected;
    state.view = "portfolio";
    state.expanded = id;
    state.mapSelected = null;
    render();
    document.getElementById(`detail-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  // The map div isn't attached to the live DOM yet when renderMap() runs —
  // render() appends the returned wrap right after this returns. Defer
  // Leaflet init to the next tick so the container has a real size.
  setTimeout(() => initLeafletMap(list, mode), 0);

  return wrap;
}

function initLeafletMap(list, mode) {
  const el = document.getElementById("leaflet-map");
  if (!el || typeof L === "undefined") return;

  if (leafletMapInstance) {
    leafletMapInstance.remove();
    leafletMapInstance = null;
  }

  const map = L.map(el, { scrollWheelZoom: true }).setView([20, 10], 2);
  leafletMapInstance = map;

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 18,
  }).addTo(map);

  list.forEach(a => {
    const marker = L.circleMarker([a.location.lat, a.location.lng], {
      radius: mapMarkerRadius(a, mode, list),
      color: "#ffffff",
      weight: 1.5,
      fillColor: RISK_HEX[a.health.riskCategory],
      fillOpacity: 0.9,
    }).addTo(map);

    marker.bindTooltip(`
      <div class="tt-name">${escapeHtml(a.accountName)}</div>
      <div class="tt-row">${escapeHtml(a.location.city)}, ${escapeHtml(a.location.country)}</div>
      <div class="tt-row"><span class="tt-label">Health Score:</span> <strong>${a.health.score}</strong> (${RISK_LABEL[a.health.riskCategory]} risk)</div>
      <div class="tt-row"><span class="tt-label">ARR:</span> ${fmtUSD(a.contract.arrUSD)}</div>
      <div class="tt-row"><span class="tt-label">Renewal in:</span> ${daysFromToday(a.contract.nextRenewalDate)} days</div>
      <div class="tt-row"><span class="tt-label">CSAT trend:</span> ${TREND_TEXT[a.trend]}</div>
    `, { direction: "top", className: "leaflet-chart-tooltip", sticky: true });

    marker.on("click", () => {
      state.mapSelected = a.accountId;
      render();
    });
  });
}

const SENTIMENT_LABEL = { frustrated: "Frustrated", neutral: "Neutral", patient: "Patient" };
const SENTIMENT_RISK = { frustrated: "high", neutral: "medium", patient: "low" };

function renderFeedback() {
  const wrap = document.createElement("div");
  const list = getFilteredAccounts();
  wrap.appendChild(renderViewHeader("Feature Request Overview", "Which feature requests come up most, and from how much at-risk ARR — for the product team."));

  const groups = {};
  list.forEach(a => {
    const req = a.support.topFeatureRequest;
    if (!req) return;
    if (!groups[req]) groups[req] = { accounts: [] };
    groups[req].accounts.push(a);
  });

  const rows = Object.entries(groups).map(([request, { accounts }]) => {
    const withSince = accounts.filter(a => a.support.featureRequestSince);
    const oldestDays = withSince.length
      ? Math.max(...withSince.map(a => daysSince(a.support.featureRequestSince)))
      : null;
    const sentimentCounts = { frustrated: 0, neutral: 0, patient: 0 };
    accounts.forEach(a => {
      if (a.support.featureRequestSentiment) sentimentCounts[a.support.featureRequestSentiment]++;
    });
    return {
      request,
      count: accounts.length,
      totalArr: accounts.reduce((s, a) => s + a.contract.arrUSD, 0),
      avgHealth: Math.round(accounts.reduce((s, a) => s + a.health.score, 0) / accounts.length),
      oldestDays,
      sentimentCounts,
      accounts,
    };
  });

  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "sub";
    empty.textContent = "No feature requests recorded for the currently filtered accounts.";
    wrap.appendChild(empty);
    return wrap;
  }

  const requesters = new Set(list.filter(a => a.support.topFeatureRequest).map(a => a.accountId)).size;

  const summary = document.createElement("div");
  summary.className = "summary-bar";
  summary.innerHTML = `
    <div class="summary-chip neutral">${rows.length} distinct requests</div>
    <div class="summary-chip neutral">${requesters} accounts with a request</div>
    <div class="summary-chip neutral">${list.length} accounts in view</div>
  `;
  wrap.appendChild(summary);

  const intro = document.createElement("p");
  intro.className = "sub";
  intro.textContent = "Aggregated across the currently filtered accounts — not AI-generated, just counting. \"Oldest Ask\" and \"Sentiment\" are estimated from each account's risk trajectory (a proxy, not a live satisfaction survey) — click a column to sort.";
  wrap.appendChild(intro);

  wrap.appendChild(renderPortfolioAsk(list, {
    title: "Ask AI about this view",
    scopeIntro: "AI answers based on the currently visible accounts",
    viewLabel: "Features",
    collapsible: true,
  }));

  const sorted = [...rows].sort((a, b) => {
    const { key, dir } = state.feedbackSort;
    let va, vb;
    if (key === "arr") { va = a.totalArr; vb = b.totalArr; }
    else if (key === "health") { va = a.avgHealth; vb = b.avgHealth; }
    else if (key === "oldest") { va = a.oldestDays ?? -1; vb = b.oldestDays ?? -1; }
    else { va = a.count; vb = b.count; }
    return dir === "asc" ? va - vb : vb - va;
  });

  const table = document.createElement("table");
  table.className = "portfolio-table feedback-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const reqTh = document.createElement("th");
  reqTh.textContent = "Feature Request";
  reqTh.className = "feedback-col-request";
  headRow.appendChild(reqTh);
  headRow.appendChild(renderFeedbackSortHeader("# Accounts", "count"));
  headRow.appendChild(renderFeedbackSortHeader("Total ARR", "arr"));
  headRow.appendChild(renderFeedbackSortHeader("Avg Health Score", "health"));
  headRow.appendChild(renderFeedbackSortHeader("Oldest Ask", "oldest"));
  const sentimentTh = document.createElement("th");
  sentimentTh.textContent = "Sentiment";
  headRow.appendChild(sentimentTh);
  const reqAccTh = document.createElement("th");
  reqAccTh.textContent = "Requesting Accounts";
  headRow.appendChild(reqAccTh);
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  sorted.forEach(r => {
    const tr = document.createElement("tr");
    const healthCat = r.avgHealth >= 70 ? "low" : r.avgHealth >= 40 ? "medium" : "high";
    const sentimentBadges = ["frustrated", "neutral", "patient"]
      .filter(s => r.sentimentCounts[s] > 0)
      .map(s => `<span class="status-pill risk-${SENTIMENT_RISK[s]}">${r.sentimentCounts[s]} ${SENTIMENT_LABEL[s]}</span>`)
      .join(" ");
    tr.innerHTML = `
      <td class="account-cell feedback-col-request">${escapeHtml(r.request)}</td>
      <td><span class="score-num">${r.count}</span></td>
      <td>${fmtUSD(r.totalArr)}</td>
      <td><span class="score-num risk-text-${healthCat}">${r.avgHealth}</span></td>
      <td class="sub">${r.oldestDays != null ? r.oldestDays + "d" : "—"}</td>
      <td>${sentimentBadges || "—"}</td>
      <td class="sub">${r.accounts.map(a => escapeHtml(a.accountName)).join(", ")}</td>
    `;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  const scrollWrap = document.createElement("div");
  scrollWrap.className = "table-scroll";
  scrollWrap.appendChild(table);
  wrap.appendChild(scrollWrap);
  const hint = document.createElement("p");
  hint.className = "table-scroll-hint";
  hint.textContent = "← Scroll horizontally to see all columns →";
  wrap.appendChild(hint);

  return wrap;
}

function renderFeedbackSortHeader(label, key) {
  const th = document.createElement("th");
  th.className = "sortable";
  th.tabIndex = 0;
  th.textContent = label + (state.feedbackSort.key === key ? (state.feedbackSort.dir === "asc" ? " ▲" : " ▼") : "");
  th.setAttribute("aria-sort", state.feedbackSort.key === key ? (state.feedbackSort.dir === "asc" ? "ascending" : "descending") : "none");
  const doSort = () => {
    if (state.feedbackSort.key === key) state.feedbackSort.dir = state.feedbackSort.dir === "asc" ? "desc" : "asc";
    else { state.feedbackSort.key = key; state.feedbackSort.dir = "desc"; }
    render();
  };
  th.addEventListener("click", doSort);
  th.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); doSort(); } });
  return th;
}

// Co-PO review, round 1 — Point 3: a deterministic Attention Queue — the
// three most urgent accounts in the current filter, ranked purely by the
// existing computePriorityScore() (risk + ARR + renewal proximity +
// engagement recency, see src/scoring.js). No new formula, no AI, nothing
// beyond fields computePriorityScore already returns. Clicking an item opens
// the same Portfolio detail row the table rows / Matrix / Team links do.
function renderAttentionQueue(list) {
  const box = document.createElement("div");
  box.className = "attention-queue";

  const top = list
    .map(account => ({ account, priority: computePriorityScore(account) }))
    .sort((a, b) => b.priority.score - a.priority.score)
    .slice(0, 3);

  const items = top.map(({ account, priority }) => {
    const renewalText = priority.daysToRenewal <= 0
      ? "Renewal overdue"
      : `Renewal in ${priority.daysToRenewal}d`;
    return `
      <li class="attention-item" data-account-id="${account.accountId}" tabindex="0" role="button" aria-label="Open details for ${escapeHtml(account.accountName)}">
        <span class="status-pill risk-${priority.health.riskCategory}">${RISK_LABEL[priority.health.riskCategory]}</span>
        <span class="attention-item-body">
          <span class="attention-name">${escapeHtml(account.accountName)}</span>
          <span class="attention-meta">${escapeHtml(renewalText)} · Priority ${priority.score}/100</span>
        </span>
      </li>
    `;
  }).join("");

  box.innerHTML = `
    <h4>Attention Queue</h4>
    <p class="sub">Top ${top.length} by priority score — risk, ARR, renewal timing, and engagement, already combined.</p>
    ${top.length ? `<ol class="attention-list">${items}</ol>` : `<p class="sub">No accounts match the current filters.</p>`}
  `;

  box.querySelectorAll(".attention-item").forEach(item => {
    const openDetail = () => {
      const id = item.dataset.accountId;
      state.expanded = id;
      render();
      document.getElementById(`detail-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    item.addEventListener("click", openDetail);
    item.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(); } });
  });

  return box;
}

// Sprint 16 — reused as-is (same state.portfolioAsk, same askAboutPortfolio
// call, same getFilteredAccounts()-derived scope) on Map, Matrix and
// Features, not just Portfolio — no new AI endpoint or data mechanism, just
// this one component mounted in more places. `collapsible` starts the box
// collapsed (a single toggle line) on those newer placements, so the
// visualization stays the focal point; Portfolio's own call site below
// passes no options, so it keeps its exact original title/wording/always-
// expanded behavior. `viewLabel` (Portfolio/Map/Value Matrix/Renewal
// Radar/Features) is only ever one of a fixed set of app-defined strings —
// see the render*() call sites — never user input, and is re-validated
// server-side in api/analyze.js before it reaches the prompt.
function renderPortfolioAsk(list, opts = {}) {
  const {
    title = "Ask about this Portfolio",
    scopeIntro = "Answers are scoped to what's currently on screen",
    viewLabel = "Portfolio",
    collapsible = false,
  } = opts;
  const box = document.createElement("div");
  box.className = "team-priority-box ai-copilot-panel portfolio-ask-box";
  const pa = state.portfolioAsk;
  const expanded = !collapsible || state.portfolioAskExpanded;
  const hasActiveFilter = state.filters.csm !== "all" || state.filters.region !== "all" || state.filters.risk !== "all" || state.filters.expansion !== "all" || state.filters.trend !== "all" || state.filters.search.trim() !== "";
  const scopeLabel = hasActiveFilter
    ? `across the ${list.length} account(s) matching your current filters`
    : `across all ${list.length} accounts`;

  box.innerHTML = `
    <div class="portfolio-ask-head">
      ${aiCopilotHeader(title)}
      ${collapsible ? `<button class="portfolio-ask-toggle-btn">${expanded ? "Hide" : "Ask AI"}</button>` : ""}
    </div>
    ${expanded ? `
      <p class="sub">${escapeHtml(scopeIntro)} — ${escapeHtml(scopeLabel)}. Change the filters above to change the scope.</p>
      <div class="ai-ask">
        <input type="text" class="portfolio-ask-input" placeholder="e.g. list all champion contacts, or which accounts have a QBR this month…" value="${escapeHtml(pa.question)}" />
        <button class="ai-ask-btn portfolio-ask-btn">Ask</button>
      </div>
      <div class="portfolio-ask-answer"></div>
    ` : ""}
  `;

  if (collapsible) {
    box.querySelector(".portfolio-ask-toggle-btn").addEventListener("click", () => {
      state.portfolioAskExpanded = !state.portfolioAskExpanded;
      render();
    });
  }

  if (expanded) {
    const input = box.querySelector(".portfolio-ask-input");
    const btn = box.querySelector(".portfolio-ask-btn");
    const submit = () => submitPortfolioAsk(input.value, list.map(a => a.accountId), viewLabel);
    btn.addEventListener("click", submit);
    input.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });

    const answerBox = box.querySelector(".portfolio-ask-answer");
    if (pa.status === "loading") {
      answerBox.innerHTML = `<p class="sub">Loading…</p>`;
    } else if (pa.status === "error") {
      answerBox.innerHTML = `<p class="ai-unavailable">Answer unavailable (${escapeHtml(pa.error)}).</p>`;
      const retryBtn = document.createElement("button");
      retryBtn.className = "ai-load-btn";
      retryBtn.textContent = "Try Again";
      retryBtn.addEventListener("click", submit);
      answerBox.appendChild(retryBtn);
    } else if (pa.status === "done") {
      answerBox.innerHTML = formatAiAnswer(pa.answer);
    }
  }

  return box;
}

async function submitPortfolioAsk(question, accountIds, viewLabel) {
  const q = String(question || "").trim();
  if (!q) return;
  state.portfolioAsk = { status: "loading", question: q, answer: "", error: "" };
  render();
  try {
    const data = await askAboutPortfolio(accountIds, q, viewLabel);
    state.portfolioAsk = { status: "done", question: q, answer: data.answer, error: "" };
  } catch (e) {
    state.portfolioAsk = { status: "error", question: q, answer: "", error: e.message };
  }
  render();
}

function renderPriorityBox(scopeCsmId, title) {
  const box = document.createElement("div");
  box.className = "team-priority-box ai-copilot-panel";
  box.innerHTML = `${aiCopilotHeader(title)}<div class="team-priority-body"></div>`;
  const body = box.querySelector(".team-priority-body");
  const tp = state.teamPriority;
  const inScope = tp.csmId === (scopeCsmId || null);

  if (!inScope || tp.status === "idle") {
    const btn = document.createElement("button");
    btn.className = "ai-load-btn";
    btn.textContent = scopeCsmId ? "Load AI Prioritization for This Portfolio" : "Load AI Prioritization for the Whole Team";
    btn.addEventListener("click", () => loadTeamPriority(scopeCsmId));
    body.appendChild(btn);
  } else if (tp.status === "loading") {
    body.innerHTML = `<p class="sub">Loading…</p>`;
  } else if (tp.status === "error") {
    body.innerHTML = `<p class="ai-unavailable">Unavailable (${escapeHtml(tp.error)}).</p>`;
    const retryBtn = document.createElement("button");
    retryBtn.className = "ai-load-btn";
    retryBtn.textContent = scopeCsmId ? "Try Again" : "Try Again";
    retryBtn.addEventListener("click", () => loadTeamPriority(scopeCsmId));
    body.appendChild(retryBtn);
  } else if (tp.status === "done") {
    const priorities = tp.data.priorities || [];
    const patternAlert = tp.data.patternAlert
      ? `<p class="pattern-alert"><strong>Pattern across these accounts:</strong> ${escapeHtml(tp.data.patternAlert)}</p>`
      : "";
    body.innerHTML = `
      ${patternAlert}
      <ol class="priority-list">
        ${priorities.map(p => `
          <li class="priority-item">
            <div class="priority-item-head">
              <span class="status-pill risk-${p.riskCategory}">${RISK_LABEL[p.riskCategory] ?? p.riskCategory}</span>
              <button class="priority-account-link" data-account-id="${p.accountId}">${escapeHtml(p.accountName)}</button>
              <span class="sub">priority ${p.priorityScore}/100</span>
            </div>
            ${p.synthesis ? `<p class="sub">${escapeHtml(p.synthesis)}</p>` : ""}
            ${p.nextBestAction ? `
              <div class="nba-box">
                <p class="nba-label risk-text-${p.nextBestAction.category === "growth" ? "low" : "high"}">${p.nextBestAction.category === "growth" ? "Next Best Action — Growth" : "Next Best Action — Risk Mitigation"}</p>
                <p><strong>${escapeHtml(p.nextBestAction.action)}</strong></p>
                <p class="sub">${escapeHtml(p.nextBestAction.rationale)}</p>
                <div class="nba-approval" data-account-id="${p.accountId}"></div>
              </div>
            ` : ""}
          </li>
        `).join("")}
      </ol>
    `;

    body.querySelectorAll(".priority-account-link").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.accountId;
        const acc = state.accounts.find(a => a.accountId === id);
        if (acc) { state.filters.csm = acc.csmId; document.getElementById("filter-csm").value = acc.csmId; }
        state.view = "portfolio";
        state.expanded = id;
        render();
        document.getElementById(`detail-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });

    priorities.forEach(p => {
      if (!p.nextBestAction) return;
      const el = body.querySelector(`.nba-approval[data-account-id="${p.accountId}"]`);
      if (el) renderApprovalControl(el, p.accountId, p.nextBestAction);
    });

    const reloadBtn = document.createElement("button");
    reloadBtn.className = "reload-link";
    reloadBtn.textContent = "↻ Reload Prioritization";
    reloadBtn.addEventListener("click", () => loadTeamPriority(scopeCsmId));
    body.appendChild(reloadBtn);
  }
  return box;
}

// Bug fix — clicking a CSM card on Team navigates straight to Portfolio with
// no way back except rediscovering the top nav's Team tab (which several
// users didn't). csmFromTeam marks the filter as "came from a Team click, not
// a manual dropdown change" so Portfolio can show an explicit return link;
// any manual filter change (setFilterAndClearDrillDown) clears the flag
// again, since a deliberate re-filter supersedes the auto-navigation intent.
function goToCsmPortfolio(csmId) {
  state.filters.csm = csmId;
  state.filters.csmFromTeam = true;
  document.getElementById("filter-csm").value = csmId;
  state.view = "portfolio";
  render();
}

function backToTeamFromPortfolio() {
  state.filters.csm = "all";
  state.filters.csmFromTeam = false;
  document.getElementById("filter-csm").value = "all";
  state.view = "team";
  render();
}

function renderTeam() {
  const wrap = document.createElement("div");
  wrap.appendChild(renderViewHeader("Team", "Weekly priorities across the whole team, and per-CSM portfolio health at a glance."));
  wrap.appendChild(renderPriorityBox(null, "AI Weekly Priorities"));

  const grid = document.createElement("div");
  grid.className = "team-view";
  wrap.appendChild(grid);

  state.csms.forEach(csm => {
    const accs = state.accounts.filter(a => a.csmId === csm.csmId);
    const counts = { high: 0, medium: 0, low: 0 };
    accs.forEach(a => counts[a.health.riskCategory]++);
    const arrAtRisk = accs.filter(a => a.health.riskCategory === "high").reduce((s, a) => s + a.contract.arrUSD, 0);
    const upcomingRenewals = accs.filter(a => daysFromToday(a.contract.nextRenewalDate) <= 90 && daysFromToday(a.contract.nextRenewalDate) >= 0).length;
    const overdueQBRs = accs.filter(a => daysSince(a.relationship.lastQBRDate) > 100 && daysFromToday(a.relationship.nextQBRDate) > 20).length;

    const card = document.createElement("div");
    card.className = "csm-card";
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `View portfolio for ${csm.name}`);
    card.innerHTML = `
      <div class="csm-card-head">
        <span class="csm-avatar" aria-hidden="true">${escapeHtml(initialsOf(csm.name))}</span>
        <div>
          <h3>${escapeHtml(csm.name)}</h3>
          <p class="sub">${escapeHtml(csm.regionCoverage)} · ${accs.length} Accounts</p>
        </div>
      </div>
      <div class="summary-bar">
        <div class="summary-chip risk-high">${counts.high} High</div>
        <div class="summary-chip risk-medium">${counts.medium} Medium</div>
        <div class="summary-chip risk-low">${counts.low} Low</div>
      </div>
      <div class="csm-stats">
        <div><span class="stat-num">${fmtUSD(arrAtRisk)}</span><span class="stat-label">ARR in high-risk accounts</span></div>
        <div><span class="stat-num">${upcomingRenewals}</span><span class="stat-label">Renewals within 90 days</span></div>
        <div><span class="stat-num">${overdueQBRs}</span><span class="stat-label">QBR overdue</span></div>
      </div>
      <p class="sub csm-card-link">View portfolio & AI-analyze →</p>
    `;
    card.addEventListener("click", () => goToCsmPortfolio(csm.csmId));
    card.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goToCsmPortfolio(csm.csmId); }
    });
    grid.appendChild(card);
  });
  return wrap;
}

// QBRs menu item — a dedicated cadence view across every account (previously
// only reachable one account at a time, buried inside each Portfolio row's
// expanded detail). Reuses the exact overdue definition Team's "QBR overdue"
// stat already uses, just per-account instead of aggregated per-CSM.
function goToAccountQbr(accountId) {
  state.view = "portfolio";
  state.expanded = accountId;
  render();
  document.getElementById(`qbr-section-${accountId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderQbrsOverview() {
  const wrap = document.createElement("div");
  wrap.appendChild(renderViewHeader("QBRs", "Every account's QBR cadence — overdue first, then soonest upcoming. Opens straight into that account's QBR Copilot."));

  const csmFiltered = state.filters.csm === "all" ? state.accounts : state.accounts.filter(a => a.csmId === state.filters.csm);
  const rows = csmFiltered.map(acc => ({
    acc,
    overdue: daysSince(acc.relationship.lastQBRDate) > 100 && daysFromToday(acc.relationship.nextQBRDate) > 20,
    daysToNext: daysFromToday(acc.relationship.nextQBRDate),
  })).sort((a, b) => (a.overdue !== b.overdue) ? (a.overdue ? -1 : 1) : a.daysToNext - b.daysToNext);

  const table = document.createElement("table");
  table.className = "qbrs-table portfolio-table";
  table.innerHTML = `
    <thead><tr><th>Account</th><th>CSM</th><th>Last QBR</th><th>Next QBR</th><th>Status</th><th></th></tr></thead>
    <tbody>
      ${rows.map(({ acc, overdue, daysToNext }) => `
        <tr data-account-id="${acc.accountId}">
          <td><strong>${escapeHtml(acc.accountName)}</strong><div class="sub">${escapeHtml(acc.industry)} · ${escapeHtml(acc.accountId)}</div></td>
          <td>${escapeHtml(csmName(acc.csmId))}</td>
          <td>${fmtDate(acc.relationship.lastQBRDate)}</td>
          <td>${fmtDate(acc.relationship.nextQBRDate)}</td>
          <td>${overdue
            ? `<span class="status-pill risk-high">Overdue</span>`
            : daysToNext < 0
              ? `<span class="status-pill risk-medium">${Math.abs(daysToNext)}d past due</span>`
              : `<span class="sub">in ${daysToNext}d</span>`}</td>
          <td><button class="qbrs-open-btn" data-account-id="${acc.accountId}">Open QBR →</button></td>
        </tr>
      `).join("")}
    </tbody>
  `;
  wrap.appendChild(table);

  table.querySelectorAll("tbody tr").forEach(tr => {
    tr.addEventListener("click", () => goToAccountQbr(tr.dataset.accountId));
  });
  return wrap;
}

// Sprint 04 — Trust & Governance UI: a purely local, static view (no new AI
// call, no new API endpoint). All text here is fixed copy, not account data,
// so it's written directly rather than through escapeHtml(). The reference
// date is read from src/scoring.js's REFERENCE_DATE_ISO — the same constant
// the scoring calculations themselves use — so this can never drift from it.
function renderTrust() {
  const wrap = document.createElement("div");
  wrap.className = "trust-view";
  wrap.innerHTML = `
    <section class="trust-hero">
      <div class="trust-hero-content">
        <p class="trust-eyebrow">Trust &amp; Governance</p>
        <h2>Human-led AI, explainable by design</h2>
        <p class="sub trust-hero-sub">How fragmented customer signals become transparent priorities and controlled actions in this demo.</p>
        <p class="trust-refdate">Reference date for this demo: <strong>${fmtDate(REFERENCE_DATE_ISO)}</strong> — a fixed snapshot, not a live feed or a production forecast.</p>
      </div>
      <img src="assets/logo-horizontal-light.svg" alt="Customer Success AI Hub" class="trust-hero-logo" />
    </section>

    <section class="trust-section">
      <h3>How it works</h3>
      <ol class="trust-flow">
        <li class="trust-flow-step"><span class="trust-flow-num">1</span><span class="trust-flow-label">Customer signals</span></li>
        <li class="trust-flow-arrow" aria-hidden="true">→</li>
        <li class="trust-flow-step"><span class="trust-flow-num">2</span><span class="trust-flow-label">Rule-based scores</span></li>
        <li class="trust-flow-arrow" aria-hidden="true">→</li>
        <li class="trust-flow-step"><span class="trust-flow-num">3</span><span class="trust-flow-label">AI explanation</span></li>
        <li class="trust-flow-arrow" aria-hidden="true">→</li>
        <li class="trust-flow-step"><span class="trust-flow-num">4</span><span class="trust-flow-label">Human review</span></li>
        <li class="trust-flow-arrow" aria-hidden="true">→</li>
        <li class="trust-flow-step"><span class="trust-flow-num">5</span><span class="trust-flow-label">Logged action</span></li>
      </ol>
    </section>

    <section class="trust-section">
      <h3>Who does what</h3>
      <div class="trust-cards">
        <div class="trust-card trust-card-rules">
          <p class="trust-card-eyebrow">Calculated by rules</p>
          <ul>
            <li>Health Score — 8 weighted criteria</li>
            <li>Priority ranking</li>
            <li>Expansion Score</li>
            <li>Risk category (High / Medium / Low)</li>
          </ul>
        </div>
        <div class="trust-card trust-card-ai">
          <p class="trust-card-eyebrow">AI-assisted</p>
          <ul>
            <li>Plain-English narrative</li>
            <li>Next Best Action suggestion</li>
            <li>Answers to free-text questions</li>
            <li>Portfolio pattern alerts</li>
          </ul>
        </div>
        <div class="trust-card trust-card-human">
          <p class="trust-card-eyebrow">Human-controlled</p>
          <ul>
            <li>Review &amp; edit before sending</li>
            <li>Approve or cancel any action</li>
            <li>Nothing reaches a customer unreviewed</li>
          </ul>
        </div>
      </div>
    </section>

    <section class="trust-section">
      <h3>Guardrails &amp; limits</h3>
      <div class="trust-guardrail-grid">
        <div class="trust-guardrail-item">
          <span class="status-pill risk-high">Hard rule</span>
          <p>High-risk accounts never receive a server-side Growth action — enforced after every AI call, not just prompted for.</p>
        </div>
        <div class="trust-guardrail-item">
          <span class="status-pill risk-medium">Evidence, not probability</span>
          <p><strong>Evidence Confidence</strong> reflects the coverage, recency, and diversity of the supporting evidence — not the probability that the AI is right.</p>
        </div>
        <div class="trust-guardrail-item">
          <span class="status-pill risk-low">Human in the loop</span>
          <p>Every customer-facing action is reviewed and can be edited by a CSM before it is sent — an AI draft is never sent unreviewed.</p>
        </div>
        <div class="trust-guardrail-item">
          <span class="status-pill neutral">Logged, not silent</span>
          <p>Approved actions are sent through an authenticated workflow and logged. A failed send is never retried automatically.</p>
        </div>
      </div>
      <p class="sub trust-footnote">All accounts and customer data shown anywhere in this demo are entirely fictional. This is a snapshot at a fixed reference date, not a live or predictive system.</p>
    </section>

    <section class="trust-section">
      <h3>EU AI Act readiness</h3>
      <p class="sub trust-readiness-intro">Vorläufige, interne Readiness-Einschätzung für einen möglichen Pilotbetrieb — keine Rechtsberatung, keine Compliance-Zertifizierung. Details: <a href="docs/12_eu_ai_act_readiness.md">docs/12_eu_ai_act_readiness.md</a>.</p>
      <div class="trust-readiness-grid">
        <div class="trust-readiness-item">
          <span class="status-pill risk-low">Umgesetzt</span>
          <p><strong>AI-Inhalte gekennzeichnet</strong> — KI-generierte Inhalte sind in der Oberfläche durchgängig als „AI-assisted" markiert, getrennt von regelbasierten Werten.</p>
        </div>
        <div class="trust-readiness-item">
          <span class="status-pill risk-low">Umgesetzt</span>
          <p><strong>Human Review vor Aktionen</strong> — jede kundengerichtete Aktion durchläuft ein Review-Formular; nichts wird ungeprüft versendet.</p>
        </div>
        <div class="trust-readiness-item">
          <span class="status-pill risk-low">Umgesetzt</span>
          <p><strong>Nachvollziehbare regelbasierte Scores</strong> — Health-, Priority- und Expansion-Score folgen festen Kriterien, nicht der KI.</p>
        </div>
        <div class="trust-readiness-item">
          <span class="status-pill risk-low">Umgesetzt</span>
          <p><strong>Guardrails und Validierung</strong> — High-Risk-Accounts erhalten serverseitig nie eine Growth-Aktion; Eingaben werden vor dem Absenden validiert.</p>
        </div>
        <div class="trust-readiness-item">
          <span class="status-pill risk-low">Umgesetzt</span>
          <p><strong>Fiktive Demo-Daten</strong> — alle Accounts und Vorgänge in dieser Demo sind frei erfunden.</p>
        </div>
        <div class="trust-readiness-item">
          <span class="status-pill risk-medium">Teilweise</span>
          <p><strong>Action Logging</strong> — freigegebene Aktionen werden protokolliert; ein durchsuchbares Audit-Log fehlt noch.</p>
        </div>
        <div class="trust-readiness-item">
          <span class="status-pill neutral">Pilot-Gate</span>
          <p><strong>AI-Literacy / Betreiberrollen</strong> — vor einem Pilotbetrieb zu dokumentieren.</p>
        </div>
        <div class="trust-readiness-item">
          <span class="status-pill neutral">Pilot-Gate</span>
          <p><strong>Monitoring, Incident- und Abschaltprozess</strong> — vor einem Pilotbetrieb zu ergänzen.</p>
        </div>
        <div class="trust-readiness-item">
          <span class="status-pill neutral">Pilot-Gate</span>
          <p><strong>DSGVO-/DPIA-Prüfung</strong> — bei Einsatz mit echten Kundendaten erforderlich.</p>
        </div>
      </div>
      <p class="sub trust-footnote">Vorläufige Einordnung: wahrscheinlich nicht-hochriskanter interner B2B-Entscheidungsassistent, vorbehaltlich einer Prüfung des Einsatzkontexts. Offizielle Quelle: <a href="https://eur-lex.europa.eu/eli/reg/2024/1689/oj">EU AI Act, Verordnung (EU) 2024/1689</a> (Art. 4, 26, 50).</p>
    </section>

    <section class="trust-section">
      <h3>Roadmap</h3>
      <div class="trust-roadmap-grid">
        <div class="trust-roadmap-item">
          <span class="trust-roadmap-badge trust-roadmap-next">Next — not yet active</span>
          <p>EBR / QBR Prep</p>
        </div>
        <div class="trust-roadmap-item">
          <span class="trust-roadmap-badge trust-roadmap-later">Later — not yet active</span>
          <p>Additional data integrations &amp; read-only connectors</p>
        </div>
      </div>
    </section>
  `;
  return wrap;
}

async function loadTeamPriority(csmId) {
  state.teamPriority = { status: "loading", csmId: csmId || null };
  render();
  try {
    const data = await fetchTeamPriority(csmId);
    state.teamPriority = { status: "done", data, csmId: csmId || null };
  } catch (e) {
    state.teamPriority = { status: "error", error: e.message, csmId: csmId || null };
  }
  render();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// PO polish — AI answers were rendered as a single <p>, so any line breaks
// the model actually produced collapsed into one wall-of-text paragraph
// (normal HTML whitespace handling). This renders each line as its own
// paragraph inside one shared callout box instead of one box per line, and
// — when an answer is mostly "|"-delimited lines (the same separator style
// the account-data prompts use, so the model sometimes echoes it back for
// account-by-account answers) — renders it as a compact table instead,
// which is far more scannable than piped text.
function formatAiAnswer(raw) {
  const lines = String(raw || "").split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return "";
  const pipeLines = lines.filter(l => l.includes("|"));
  let inner;
  if (lines.length >= 2 && pipeLines.length === lines.length) {
    const rows = lines.map(l => l.split("|").map(c => c.trim()).filter(c => c !== ""));
    inner = `<table class="ai-answer-table"><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  } else {
    inner = lines.map(l => `<p>${escapeHtml(l)}</p>`).join("");
  }
  return `<div class="ai-answer">${inner}</div>`;
}

init().catch(() => {
  document.getElementById("app").innerHTML = '<div class="card"><h2>Account data is temporarily unavailable</h2><p>Please reload the page in a moment.</p></div>';
});
