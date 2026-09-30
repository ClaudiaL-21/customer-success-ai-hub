// Sprint 16 — Customer Intelligence Inbox, Package 6: minimal UI.
//
// Reuses existing components rather than building a second approval path:
// renderApprovalControl + refreshAccountData are imported straight from
// app.js (a small circular import — safe here since both are only ever
// *called* from within a render pass, never read at module-load time).
// Gate 1 (account confirmation) is the only new interactive control; Gate 2
// is the exact same "Review action" box already used in the account detail
// view, wired up here a second time with the same signalId.

import { fetchInboxSignals, confirmSignalAccount } from "./ai.js";
import { renderApprovalControl, refreshAccountData } from "./app.js";

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}
const fmtDateTime = iso => new Date(iso).toLocaleString("en-US", { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });

const TYPE_LABEL = { risk: "Risk", growth: "Growth", routine: "Routine" };
// Reuses the existing nba-box variants (renderCustomerSignals already uses
// nba-box-risk the same way) instead of inventing new card colors.
const TYPE_CARD_CLASS = { risk: "nba-box-risk", growth: "nba-box-recommendation", routine: "" };
const PROCESSING_STATUS_LABEL = { needs_review: "Needs review", triaged: "Triaged", actioned: "Actioned", archived: "Archived" };

export async function loadInboxSignals(state, render) {
  state.inbox = { status: "loading", signals: state.inbox?.signals || [], error: null };
  render();
  try {
    const signals = await fetchInboxSignals();
    state.inbox = { status: "done", signals, error: null };
  } catch (e) {
    state.inbox = { status: "error", signals: [], error: e.message };
  }
  render();
}

function getFilteredSignals(state) {
  const { scope, type, processingStatus } = state.inboxFilters;
  const myCsm = state.filters.csm !== "all" ? state.filters.csm : null;
  return state.inbox.signals.filter(s => {
    if (scope === "unassigned" && s.accountId) return false;
    // "My Accounts" reuses the shared CSM filter already in the top bar
    // (there is no separate CSM login identity in this demo) — with no CSM
    // selected there, this scope deliberately matches nothing rather than
    // silently falling back to "All".
    if (scope === "my" && (!myCsm || s.csmId !== myCsm)) return false;
    if (type !== "all" && s.type !== type) return false;
    if (processingStatus !== "all" && s.processingStatus !== processingStatus) return false;
    return true;
  });
}

export function renderInboxView(state, render) {
  const wrap = document.createElement("div");
  wrap.className = "inbox-view";

  const header = document.createElement("div");
  header.className = "view-header";
  header.innerHTML = `<h2>Customer Intelligence Inbox</h2><p>Every classified customer signal — matched, unknown, or ambiguous — before and after account confirmation. Use the CSM filter above for "My Accounts".</p>`;
  wrap.appendChild(header);

  if (state.inbox.status === "loading" && !state.inbox.signals.length) {
    const p = document.createElement("p");
    p.className = "sub";
    p.textContent = "Loading inbox…";
    wrap.appendChild(p);
    return wrap;
  }
  if (state.inbox.status === "error") {
    const p = document.createElement("p");
    p.className = "ai-unavailable";
    p.textContent = `Could not load the inbox (${state.inbox.error}).`;
    wrap.appendChild(p);
    return wrap;
  }

  wrap.appendChild(renderInboxFilters(state, render));

  const filtered = getFilteredSignals(state);
  const list = document.createElement("div");
  list.className = "inbox-list";
  if (!filtered.length) {
    list.innerHTML = `<p class="sub">No signals match these filters.</p>`;
  } else {
    filtered.forEach(s => list.appendChild(renderInboxCard(s, state, render)));
  }
  wrap.appendChild(list);
  return wrap;
}

function renderInboxFilters(state, render) {
  const bar = document.createElement("div");
  bar.className = "inbox-filters";
  bar.innerHTML = `
    <label>Scope
      <select class="inbox-filter-scope">
        <option value="all">All</option>
        <option value="my">My Accounts</option>
        <option value="unassigned">Unassigned</option>
      </select>
    </label>
    <label>Risk / Growth / Routine
      <select class="inbox-filter-type">
        <option value="all">All</option>
        <option value="risk">Risk</option>
        <option value="growth">Growth</option>
        <option value="routine">Routine</option>
      </select>
    </label>
    <label>Processing status
      <select class="inbox-filter-status">
        <option value="all">All</option>
        <option value="needs_review">Needs review</option>
        <option value="triaged">Triaged</option>
        <option value="actioned">Actioned</option>
        <option value="archived">Archived</option>
      </select>
    </label>
  `;
  bar.querySelector(".inbox-filter-scope").value = state.inboxFilters.scope;
  bar.querySelector(".inbox-filter-type").value = state.inboxFilters.type;
  bar.querySelector(".inbox-filter-status").value = state.inboxFilters.processingStatus;
  bar.querySelector(".inbox-filter-scope").addEventListener("change", e => { state.inboxFilters.scope = e.target.value; render(); });
  bar.querySelector(".inbox-filter-type").addEventListener("change", e => { state.inboxFilters.type = e.target.value; render(); });
  bar.querySelector(".inbox-filter-status").addEventListener("change", e => { state.inboxFilters.processingStatus = e.target.value; render(); });
  return bar;
}

// Signal-specific health effect: mirrors the same "strongest signal wins"
// disclosure already used in the account detail view's Customer Signals
// card (src/app.js's renderCustomerSignals) — 0 if a stronger active signal
// on the same account is the one actually counting.
function healthEffectText(signal, state) {
  if (!signal.accountConfirmed || !signal.accountId) return "";
  const account = state.accounts.find(a => a.accountId === signal.accountId);
  if (!account) return "";
  if (account.health.signalId === signal.signalId) {
    return ` · Health effect: ${account.health.signalDelta} points (base ${account.health.baseScore} → ${account.health.score})`;
  }
  return signal.healthDelta ? " · Health effect: 0 points (a stronger active signal already counts for this account)" : "";
}

function renderInboxCard(signal, state, render) {
  const card = document.createElement("div");
  card.className = `nba-box inbox-card ${TYPE_CARD_CLASS[signal.type] || ""}`;

  // Fix (PO manual test, 2026-09-30): account_confirmed alone is not enough —
  // a handful of pre-existing rows have account_confirmed=true with no
  // accountId at all (a side effect of Package 1's backfill, which set the
  // flag on every existing row rather than only matched ones — harmless for
  // Health/NBA since those never join to any account, but misleading here,
  // where the flag itself now drives the UI). "Confirmed" is only ever shown
  // when there is an actual account to show.
  const effectivelyConfirmed = Boolean(signal.accountConfirmed && signal.accountId);

  const confirmedBlock = effectivelyConfirmed
    ? `<p class="approval-confirm">✓ Confirmed: ${escapeHtml(signal.accountName || signal.accountId)}${healthEffectText(signal, state)}</p>`
    : "";

  card.innerHTML = `
    <p class="nba-label">${escapeHtml(TYPE_LABEL[signal.type] || signal.type)} · ${escapeHtml(signal.topic)} · ${escapeHtml(signal.urgency)} urgency</p>
    <p>${escapeHtml(signal.summary)}</p>
    <p class="sub">Sentiment: ${escapeHtml(signal.sentiment)} · Evidence: ${escapeHtml(signal.evidence)}</p>
    <p class="sub">Category: ${signal.inboundCategory ? escapeHtml(signal.inboundCategory) : "not yet classified"} · Processing: ${escapeHtml(PROCESSING_STATUS_LABEL[signal.processingStatus] || signal.processingStatus)} · Received ${fmtDateTime(signal.createdAt)}</p>
    ${confirmedBlock}
    <div class="inbox-confirm"></div>
    <div class="inbox-gate2"></div>
  `;

  if (!effectivelyConfirmed) {
    renderConfirmControl(card.querySelector(".inbox-confirm"), signal, state, render);
  }

  const gate2Container = card.querySelector(".inbox-gate2");
  if (effectivelyConfirmed && signal.proposedAction) {
    if (signal.reviewStatus === "pending") {
      renderApprovalControl(gate2Container, signal.accountId, {
        category: signal.type === "growth" ? "growth" : "risk_mitigation",
        action: signal.proposedAction, rationale: signal.proposedRationale,
      }, signal.signalId);
    } else {
      gate2Container.innerHTML = `<p class="approval-confirm">Review status: ${escapeHtml(signal.reviewStatus)}</p>`;
    }
  }

  return card;
}

// Gate 1 — the only genuinely new interactive control in this package.
// Server-validated (api/confirm-signal-account.js re-checks the accountId
// against the real dataset); this control only offers the AI's suggestion
// as a pre-selected, always-changeable option, never a forced choice.
function renderConfirmControl(container, signal, state, render) {
  const options = state.accounts
    .map(a => `<option value="${escapeHtml(a.accountId)}" ${a.accountId === signal.suggestedAccountId ? "selected" : ""}>${escapeHtml(a.accountName)} (${escapeHtml(a.accountId)})</option>`)
    .join("");
  container.innerHTML = `
    <p class="review-required">${signal.suggestedAccountId
      ? `Suggested account: <strong>${escapeHtml(signal.suggestedAccountName || signal.suggestedAccountId)}</strong> (${escapeHtml(signal.suggestionSource || "")})${signal.suggestionEvidence ? ` — "${escapeHtml(signal.suggestionEvidence)}"` : ""}`
      : "No account suggestion — please choose manually."}</p>
    <label class="inbox-account-select">Account
      <select><option value="">— Choose an account —</option>${options}</select>
    </label>
    <button class="ai-load-btn approve-btn inbox-confirm-btn">Confirm Account</button>
    <p class="review-error inbox-confirm-error" hidden></p>
  `;
  const select = container.querySelector("select");
  const btn = container.querySelector(".inbox-confirm-btn");
  const errorEl = container.querySelector(".inbox-confirm-error");
  btn.addEventListener("click", async () => {
    const accountId = select.value;
    errorEl.hidden = true;
    if (!accountId) {
      errorEl.textContent = "Please choose an account first.";
      errorEl.hidden = false;
      return;
    }
    btn.disabled = true;
    btn.textContent = "Confirming…";
    try {
      await confirmSignalAccount(signal.signalId, accountId);
      // Refresh both: the Inbox list itself, and account data (so the
      // signal's health/NBA effect is correct if the CSM later opens that
      // account's own detail view).
      await Promise.all([loadInboxSignals(state, render), refreshAccountData()]);
      render();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "Confirm Account";
      errorEl.textContent = e.message;
      errorEl.hidden = false;
    }
  });
}
