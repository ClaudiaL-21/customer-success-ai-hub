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
