// Single source of truth for the fixed demo reference date — used both for
// the calculations below and for display (see src/app.js's Trust view). A
// string primitive, not a Date object: Date instances are mutable even when
// frozen (Object.freeze doesn't protect a Date's internal time value), so an
// ISO string is what's actually immutable here.
export const REFERENCE_DATE_ISO = "2026-08-10";
const TODAY = new Date(REFERENCE_DATE_ISO);

function daysBetween(fromISO, toDate) {
  const from = new Date(fromISO);
  return Math.round((toDate - from) / (1000 * 60 * 60 * 24));
}
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

const ALL_MODULES = [
  "Journey Orchestration", "Digital Intelligence", "Identity Resolution",
  "Offer Management", "Data Activation Hub", "Predictive Analytics"
];

const WEIGHTS = {
  usageDecline: 0.20,
  recurringTicket: 0.15,
  csatTrend: 0.15,
  nps: 0.15,
  championRisk: 0.15,
  interactionRecency: 0.10,
  execSponsor: 0.05,
  qbrOverdue: 0.05,
};

function scoreUsageDecline(account) {
  const { adoptionRatePct, sessionsTrendPct } = account.usage;
  const trendRisk = clamp(((-sessionsTrendPct) + 10) / 60 * 100, 0, 100);
  const adoptionRisk = clamp(100 - adoptionRatePct, 0, 100);
  const risk = trendRisk * 0.5 + adoptionRisk * 0.5;
  return {
    key: "usageDecline", label: "Usage/Adoption Decline",
    rawValue: `Adoption ${adoptionRatePct}% · Sessions trend ${sessionsTrendPct > 0 ? "+" : ""}${sessionsTrendPct}%`,
    riskPct: Math.round(risk),
  };
}

function scoreRecurringTicket(account) {
  const { recurringTicketTopic, openTickets } = account.support;
  const risk = recurringTicketTopic ? 100 : clamp(openTickets * 15, 0, 60);
  return {
    key: "recurringTicket", label: "Recurring Ticket Topic",
    rawValue: recurringTicketTopic ? recurringTicketTopic : `${openTickets} open ticket(s), no recurring topic`,
    riskPct: Math.round(risk),
  };
}

function scoreCSATTrend(account) {
  const scores = account.relationship.weeklyCSAT.map(w => w.score);
  const first4 = scores.slice(0, 4);
  const last4 = scores.slice(-4);
  const avgFirst = first4.reduce((a, b) => a + b, 0) / first4.length;
  const avgLast = last4.reduce((a, b) => a + b, 0) / last4.length;
  const levelRisk = clamp((5 - avgLast) / 4 * 100, 0, 100);
  const trendRisk = avgLast < avgFirst ? 20 : 0;
  const risk = clamp(levelRisk + trendRisk, 0, 100);
  return {
    key: "csatTrend", label: "CSAT Trend (8 weeks)",
    rawValue: `avg. now ${avgLast.toFixed(1)} (was ${avgFirst.toFixed(1)})`,
    riskPct: Math.round(risk),
  };
}

function scoreNPS(account) {
  const hist = account.relationship.npsHistory;
  const latest = hist[hist.length - 1].score;
  const first = hist[0].score;
  const levelRisk = clamp((10 - latest) / 10 * 100, 0, 100);
  const trendRisk = latest < first ? 15 : 0;
  const risk = clamp(levelRisk + trendRisk, 0, 100);
  return {
    key: "nps", label: "NPS (3 quarters)",
    rawValue: `now ${latest} (was ${first})`,
    riskPct: Math.round(risk),
  };
}

function scoreChampionRisk(account) {
  const status = account.relationship.championStatus;
  const risk = status === "recently_departed" ? 100 : status === "unknown" ? 50 : 0;
  const labelMap = { active: "active", unknown: "unclear", recently_departed: "recently departed" };
  return {
    key: "championRisk", label: "Champion Risk",
    rawValue: `${account.relationship.championName} (${labelMap[status]})`,
    riskPct: risk,
  };
}

function scoreInteractionRecency(account) {
  const days = account.relationship.lastInteractionDaysAgo;
  const risk = clamp(days / 30 * 100, 0, 100);
  return {
    key: "interactionRecency", label: "Interaction Recency",
    rawValue: `${days} days since last interaction`,
    riskPct: Math.round(risk),
  };
}

function scoreExecSponsor(account) {
  const engaged = account.relationship.execSponsorEngaged;
  return {
    key: "execSponsor", label: "Exec Sponsor Engagement",
    rawValue: engaged ? "engaged" : "not engaged",
    riskPct: engaged ? 0 : 100,
  };
}

function scoreQBROverdue(account) {
  const daysSinceLastQBR = daysBetween(account.relationship.lastQBRDate, TODAY);
  const daysToNextQBR = daysBetween(TODAY, new Date(account.relationship.nextQBRDate));
  let risk = 0;
  if (daysSinceLastQBR > 100 && daysToNextQBR > 20) risk = 100;
  else if (daysSinceLastQBR > 70) risk = 50;
  return {
    key: "qbrOverdue", label: "QBR Cadence",
    rawValue: `last QBR ${daysSinceLastQBR} days ago · next in ${daysToNextQBR} days`,
    riskPct: risk,
  };
}

export function computeBaseHealthScore(account) {
  const criteria = [
    scoreUsageDecline(account),
    scoreRecurringTicket(account),
    scoreCSATTrend(account),
    scoreNPS(account),
    scoreChampionRisk(account),
    scoreInteractionRecency(account),
    scoreExecSponsor(account),
    scoreQBROverdue(account),
  ].map(c => ({ ...c, weight: WEIGHTS[c.key], points: c.riskPct * WEIGHTS[c.key] }));

  // Each criterion's `points` is a risk contribution (higher = more concerning) —
  // that's what the breakdown table explains. The Health Score itself is the
  // inverse, matching standard CS convention (Gainsight etc.): higher = healthier.
  const riskPoints = criteria.reduce((sum, c) => sum + c.points, 0);
  const score = Math.round(100 - riskPoints);
  const riskCategory = riskPoints >= 60 ? "high" : riskPoints >= 30 ? "medium" : "low";

  return { score, riskCategory, criteria: criteria.sort((a, b) => b.points - a.points) };
}

// The original eight-factor snapshot stays intact. Live email risk is a
// separately explained adjustment; the strongest matched risk signal wins,
// so duplicate/related emails cannot stack an unbounded penalty.
//
// Sprint 16 — Customer Intelligence Inbox, Package 4 (Confirmed-Gate): a
// signal only counts here once its account link is human-confirmed
// (accountConfirmed) and it isn't tied to a resolved case (caseActive).
// Both checks use `!== false` rather than `=== true` on purpose: neither
// field exists on any signal object built before this package (every
// existing test fixture, and every historical Sprint 15C row surfaced
// through hub_account_dataset()'s pre-Package-4 shape), so `undefined`
// must keep behaving exactly like it always has — only an explicit `false`
// (which only Package 5's genuinely-unconfirmed signals, or a resolved
// case, will ever produce) excludes a signal. caseActive has no real
// effect yet (no case lifecycle exists to ever set it false today) — the
// check is wired in now so Package 9 can flip it later without touching
// this function again.
export function computeHealthScore(account) {
  const base = computeBaseHealthScore(account);
  const riskSignals = (account.customerSignals || []).filter(s => s.type === "risk"
    && Number.isInteger(s.healthDelta) && [-10, -5].includes(s.healthDelta)
    && s.accountConfirmed !== false && s.caseActive !== false);
  const strongest = riskSignals.reduce((best, signal) =>
    !best || signal.healthDelta < best.healthDelta ? signal : best, null);
  const signalDelta = strongest?.healthDelta ?? 0;
  const baseRiskPoints = base.criteria.reduce((sum, c) => sum + c.points, 0);
  const effectiveRiskPoints = baseRiskPoints - signalDelta;
  return {
    ...base,
    score: Math.max(0, base.score + signalDelta),
    riskCategory: effectiveRiskPoints >= 60 ? "high" : effectiveRiskPoints >= 30 ? "medium" : "low",
    baseScore: base.score,
    signalDelta,
    signalId: strongest?.signalId ?? null,
    signalRule: strongest?.healthRule ?? null,
  };
}

export function computeExpansionScore(account) {
  const { adoptionRatePct } = account.usage;
  const scores = account.relationship.weeklyCSAT.map(w => w.score);
  const avgRecentCSAT = scores.slice(-4).reduce((a, b) => a + b, 0) / 4;
  const latestNPS = account.relationship.npsHistory.slice(-1)[0].score;
  const licensedNames = account.licensedModules.map(m => m.name);
  const whitespaceRatio = (ALL_MODULES.length - licensedNames.length) / ALL_MODULES.length;

  const score = clamp(Math.round(
    adoptionRatePct * 0.30 +
    (avgRecentCSAT / 5 * 100) * 0.25 +
    (latestNPS / 10 * 100) * 0.25 +
    whitespaceRatio * 100 * 0.20
  ), 0, 100);

  const whitespaceModules = ALL_MODULES.filter(m => !licensedNames.includes(m));
  const category = score >= 70 ? "high" : score >= 30 ? "medium" : "low";
  return { score, whitespaceModules, category };
}

// Deterministic priority/urgency ranking — separate from the Health Score.
// Health Score answers "how healthy is this account"; this answers "which
// account needs attention first". Combines risk, value at stake, renewal
// timing, and engagement, per common CS prioritization practice (risk alone
// or ARR alone are each known to be poor single-factor rankers).
const ARR_REFERENCE_CEILING = 550000; // just above this dataset's max ARR ($525k)

function renewalUrgencyScore(daysToRenewal) {
  // Non-linear on purpose: urgency should spike as renewal approaches, not
  // climb steadily from day one. A renewal 400 days out shouldn't compete
  // with one 60 days out just because both are "far" vs "near".
  if (daysToRenewal <= 0) return 100;
  if (daysToRenewal <= 30) return 90;
  if (daysToRenewal <= 60) return 70;
  if (daysToRenewal <= 90) return 50;
  return clamp(30 - (daysToRenewal - 90) / 20, 0, 30);
}

export function computePriorityScore(account) {
  const health = computeHealthScore(account);
  const daysToRenewal = daysFromToday(account.contract.nextRenewalDate);

  const riskComponent = 100 - health.score;
  const arrComponent = clamp(account.contract.arrUSD / ARR_REFERENCE_CEILING * 100, 0, 100);
  const renewalComponent = renewalUrgencyScore(daysToRenewal);
  const engagementComponent = health.criteria.find(c => c.key === "interactionRecency")?.riskPct ?? 0;

  const score = Math.round(
    riskComponent * 0.40 +
    arrComponent * 0.25 +
    renewalComponent * 0.20 +
    engagementComponent * 0.15
  );

  return { score, daysToRenewal, health };
}

export function daysSince(dateISO) {
  return daysBetween(dateISO, TODAY);
}

export function daysFromToday(dateISO) {
  return daysBetween(TODAY.toISOString(), new Date(dateISO));
}

// Development Day 1 — Manager View: deterministic portfolio-level rollup
// over a given list of accounts. Purely additive — calls computeHealthScore
// and daysFromToday (both above, unchanged) per account, invents no new
// scoring rule. Self-contained (computes health/renewal per account itself)
// so it works identically whether called client-side (state.accounts, which
// already carries a precomputed .health) or server-side (raw ACCOUNTS array,
// no precomputed fields) — same function, same numbers, either caller.
// That symmetry is what guarantees the KPI cards the CSM/manager sees and
// the numbers the "portfolio-summary" AI mode is grounded in can never
// silently diverge (see api/analyze.js's handlePortfolioSummary).
const RENEWAL_WINDOWS = [
  { key: "days30", label: "≤30 days", min: 0, max: 30 },
  { key: "days3160", label: "31–60 days", min: 31, max: 60 },
  { key: "days6190", label: "61–90 days", min: 61, max: 90 },
];

export function computePortfolioKpis(accounts) {
  const rows = accounts.map(account => ({
    account,
    health: computeHealthScore(account),
    daysToRenewal: daysFromToday(account.contract.nextRenewalDate),
  }));

  const totalAccounts = rows.length;
  const totalArrUSD = rows.reduce((s, r) => s + r.account.contract.arrUSD, 0);
  const avgHealth = totalAccounts ? Math.round(rows.reduce((s, r) => s + r.health.score, 0) / totalAccounts) : 0;

  const riskCounts = { high: 0, medium: 0, low: 0 };
  rows.forEach(r => { riskCounts[r.health.riskCategory]++; });

  const arrAtRiskUSD = rows
    .filter(r => r.health.riskCategory === "high")
    .reduce((s, r) => s + r.account.contract.arrUSD, 0);

  const renewalWindows = {};
  RENEWAL_WINDOWS.forEach(w => {
    const inWindow = rows.filter(r => r.daysToRenewal >= w.min && r.daysToRenewal <= w.max);
    renewalWindows[w.key] = {
      label: w.label,
      accountCount: inWindow.length,
      arrUSD: inWindow.reduce((s, r) => s + r.account.contract.arrUSD, 0),
      arrAtRiskUSD: inWindow.filter(r => r.health.riskCategory === "high").reduce((s, r) => s + r.account.contract.arrUSD, 0),
    };
  });

  // Development Day 3 — Numerical Grounding Hardening: the combined ARR
  // renewing across all three windows, computed once here (sum of the
  // already-computed per-window arrUSD figures — no second calculation
  // logic). Exists so nothing downstream (AI prompt included) ever has to
  // add the per-window figures together itself.
  const totalRenewalArrUSD = Object.values(renewalWindows).reduce((s, w) => s + w.arrUSD, 0);
  const totalRenewalAccountCount = Object.values(renewalWindows).reduce((s, w) => s + w.accountCount, 0);

  return { totalAccounts, totalArrUSD, avgHealth, riskCounts, arrAtRiskUSD, renewalWindows, totalRenewalArrUSD, totalRenewalAccountCount };
}

// Directional signal from the most recent weekly CSAT data: are the last
// 4 weeks trending up, down, or flat vs. the first 4 weeks of the window.
export function computeTrend(account) {
  const scores = account.relationship.weeklyCSAT.map(w => w.score);
  const avgFirst = scores.slice(0, 4).reduce((a, b) => a + b, 0) / 4;
  const avgLast = scores.slice(-4).reduce((a, b) => a + b, 0) / 4;
  const diff = avgLast - avgFirst;
  if (diff > 0.15) return "up";
  if (diff < -0.15) return "down";
  return "flat";
}
