import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeBaseHealthScore, computeHealthScore, computePriorityScore } from "../src/scoring.js";
import { buildCustomerContext, formatAccountContextText } from "../src/customerContext.js";

const account = JSON.parse(readFileSync(new URL("../data/accounts.json", import.meta.url), "utf8")).accounts[0];
const signal = (id, delta) => ({ signalId: id, type: "risk", healthDelta: delta, healthRule: "signal-risk-v1",
  topic: "Outage", urgency: delta === -10 ? "high" : "medium", sentiment: "negative",
  summary: "Customer reports an outage.", evidence: "Orders are blocked.", createdAt: "2026-09-29T10:00:00Z" });

test("live risk effect is separate from unchanged eight-factor base", () => {
  const base = computeBaseHealthScore(account);
  const withSignal = { ...account, customerSignals: [signal("one", -5)] };
  const health = computeHealthScore(withSignal);
  assert.equal(health.baseScore, base.score);
  assert.deepEqual(health.criteria, base.criteria);
  assert.equal(health.score, base.score - 5);
  assert.equal(health.signalDelta, -5);
  assert.equal(computePriorityScore(withSignal).health.score, health.score);
});

test("strongest risk wins; Growth and Routine do not alter health", () => {
  const withSignals = { ...account, customerSignals: [signal("one", -5), signal("two", -10), signal("three", -5),
    { type: "growth", healthDelta: 0 }, { type: "routine", healthDelta: 0 }] };
  const health = computeHealthScore(withSignals);
  assert.equal(health.score, computeBaseHealthScore(account).score - 10);
  assert.equal(health.signalId, "two");
});

test("AI context states both scores and treats the email as unverified", () => {
  const text = formatAccountContextText(buildCustomerContext({ ...account, customerSignals: [signal("one", -5)] }));
  assert.match(text, /Eight-factor snapshot score/);
  assert.match(text, /customer email signal adjustment: -5/);
  assert.match(text, /AI-classified customer statements, not verified facts/);
});

// Package 4 — Confirmed-Gate: unbestaetigte oder case-resolved Signale duerfen
// keine Health-Wirkung haben, aber jedes bestehende Fixture oben (ohne
// accountConfirmed/caseActive gesetzt) muss unveraendert weiter funktionieren.

test("an unconfirmed risk signal (accountConfirmed: false) has zero health effect, even as the only signal", () => {
  const withSignal = { ...account, customerSignals: [{ ...signal("one", -10), accountConfirmed: false }] };
  const health = computeHealthScore(withSignal);
  assert.equal(health.score, computeBaseHealthScore(account).score);
  assert.equal(health.signalDelta, 0);
  assert.equal(health.signalId, null);
});

test("an unconfirmed signal never wins over a weaker but confirmed one", () => {
  const withSignals = { ...account, customerSignals: [
    { ...signal("unconfirmed-strong", -10), accountConfirmed: false },
    { ...signal("confirmed-weak", -5), accountConfirmed: true },
  ] };
  const health = computeHealthScore(withSignals);
  assert.equal(health.score, computeBaseHealthScore(account).score - 5);
  assert.equal(health.signalId, "confirmed-weak");
});

test("a signal without an accountConfirmed field at all behaves exactly as before this package (backward compatibility)", () => {
  // No `accountConfirmed` key present, same as every historical Sprint 15C
  // row and every pre-Package-4 test fixture in this file.
  const withSignal = { ...account, customerSignals: [signal("legacy", -10)] };
  const health = computeHealthScore(withSignal);
  assert.equal(health.score, computeBaseHealthScore(account).score - 10);
  assert.equal(health.signalId, "legacy");
});

test("a signal tied to a resolved case (caseActive: false) has zero health effect — structural prep for later case lifecycle work", () => {
  const withSignal = { ...account, customerSignals: [{ ...signal("one", -10), accountConfirmed: true, caseActive: false }] };
  const health = computeHealthScore(withSignal);
  assert.equal(health.score, computeBaseHealthScore(account).score);
  assert.equal(health.signalDelta, 0);
});

test("a confirmed signal with an active (or no) case keeps affecting health as today", () => {
  const withSignal = { ...account, customerSignals: [{ ...signal("one", -10), accountConfirmed: true, caseActive: true }] };
  const health = computeHealthScore(withSignal);
  assert.equal(health.score, computeBaseHealthScore(account).score - 10);
});
