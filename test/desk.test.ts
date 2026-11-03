import { test } from "node:test";
import assert from "node:assert/strict";

import { createDesk } from "../src/desk.ts";
import { ALTERNATIVES, CAPTURE_TO_ORDER, DEMO_TODAY, MERCHANT, ORDERS, RATES, SUBSCRIPTIONS, TXS } from "../src/demo/world.ts";
import { mockPaypal } from "../src/paypal/mock.ts";
import { memoryStore, START_MESSAGE } from "../src/core/verify.ts";

function setup() {
  const paypal = mockPaypal(TXS, ORDERS, CAPTURE_TO_ORDER, SUBSCRIPTIONS);
  const sent: { email: string; code: string }[] = [];
  let clock = Date.parse("2026-11-05T09:00:00Z");
  const desk = createDesk(
    paypal,
    { merchant: MERCHANT, rates: RATES, disputeFee: { currency: "USD", value: 15 }, alternatives: ALTERNATIVES, lookbackDays: 60, today: () => DEMO_TODAY },
    { store: memoryStore(), send: (email, code) => void sent.push({ email, code }), now: () => clock },
  );
  const login = async (email: string) => {
    const s = await desk.startVerification(email);
    const code = sent.find((x) => x.email === email)!.code;
    const r = desk.confirmCode(s.sessionId, code);
    assert.ok(r.ok);
    return r.token;
  };
  return { desk, paypal, sent, login, tick: (ms: number) => (clock += ms) };
}

test("unknown email gets the same reply and no code is sent", async () => {
  const { desk, sent } = setup();
  const a = await desk.startVerification("mina@example.com");
  const b = await desk.startVerification("stranger@example.com");
  assert.equal(a.message, START_MESSAGE);
  assert.equal(b.message, START_MESSAGE);
  assert.deepEqual(sent.map((s) => s.email), ["mina@example.com"]);
  // Guessing codes on the decoy session never succeeds and locks out.
  for (let i = 0; i < 5; i++) assert.equal(desk.confirmCode(b.sessionId, String(i).padStart(6, "0")).ok, false);
  const last = desk.confirmCode(b.sessionId, "000000");
  assert.equal(!last.ok && last.reason, "locked");
});

test("codes expire after 10 minutes", async () => {
  const { desk, sent, tick } = setup();
  const s = await desk.startVerification("Mina@Example.com ");
  tick(11 * 60_000);
  const r = desk.confirmCode(s.sessionId, sent[0].code);
  assert.equal(!r.ok && r.reason, "expired");
});

test("nothing is searched before verification", async () => {
  const { desk } = setup();
  await assert.rejects(desk.findCharge("bad-token", "what is this", { amount: { currency: "KRW", value: 13900 } }), /not verified/);
});

test("₩13,900: Mina's first membership charge, not Jordan's identical one", async () => {
  const { desk, login } = setup();
  const token = await login("mina@example.com");
  const r = await desk.findCharge(token, "What is this ₩13,900 charge?", { amount: { currency: "KRW", value: 13900 }, date: "2026-11-04" });
  assert.equal(r.decision.kind, "match");
  if (r.decision.kind !== "match") return;
  assert.equal(r.decision.best.tx.id, "SUB-PAY-1");
  assert.equal(r.recurring?.subscriptionId, "I-MINA0001");
  assert.ok(r.decision.best.evidence.some((e) => e.kind === "recurring"));
  assert.deepEqual(r.alternatives, ALTERNATIVES, "offer alternatives before any cancellation");
  assert.deepEqual(r.decision.best.tx.items, [{ name: "Monthly membership", quantity: 1 }]);
  assert.ok(r.decision.best.evidence.some((e) => e.detail.includes("free trial ended")));
});

test("a follow-up question doesn't count as a second inquiry", async () => {
  const { desk, login } = setup();
  const token = await login("mina@example.com");
  const first = await desk.findCharge(token, "What's the ₩16,740?", { amount: { currency: "KRW", value: 16740 } });
  // Only one sale fits that amount, so it's matched directly; force the follow-up path with a vaguer question.
  const vague = await desk.findCharge(token, "What did I pay you?", {});
  assert.equal(first.decision.kind, "match");
  assert.equal(vague.decision.kind, "ask");
  assert.equal(vague.caseId, undefined);
  const answered = await desk.findCharge(token, "₩13,900 on Nov 4", { amount: { currency: "KRW", value: 13900 }, date: "2026-11-04" });
  assert.equal(answered.decision.kind, "match");
  assert.equal(desk.metrics().inquiries, 2);
});

test("two KRW lines are one gear order shipped in two parts", async () => {
  const { desk, login } = setup();
  const token = await login("mina@example.com");
  const r = await desk.findCharge(token, "₩50,400 charge?", { amount: { currency: "KRW", value: 50400 }, date: "2026-10-31" });
  assert.equal(r.decision.kind, "match");
  if (r.decision.kind !== "match") return;
  assert.equal(r.decision.best.tx.id, "CAP-102B");
  assert.deepEqual(r.decision.best.sameOrderTxIds, ["CAP-102A"]);
  assert.ok(r.decision.best.evidence.some((e) => e.detail.includes("Yoga block set")));
});

test("someone else's PayPal charge: we say it isn't ours", async () => {
  const { desk } = setup();
  assert.equal(desk.checkDescriptor("PAYPAL *QUICKWINPRIZE").ours, false);
  assert.equal(desk.checkDescriptor("PAYPAL *BRIGHTLEAFST").ours, true);
});

test("cancellation waits for the merchant; approval cancels the PayPal subscription; dashboard counts it", async () => {
  const { desk, paypal, login } = setup();
  const mina = await login("mina@example.com");
  const sub = await desk.findCharge(mina, "₩13,900?", { amount: { currency: "KRW", value: 13900 }, date: "2026-11-04" });
  const pack = await desk.findCharge(mina, "₩16,740?", { amount: { currency: "KRW", value: 16740 }, date: "2026-10-21" });
  desk.checkDescriptor("QUICKWINPRIZE");

  desk.requestChange(mina, sub.caseId!, "cancel", "I forgot the trial would renew");
  assert.equal(paypal.cancellations.length, 0, "agent never acts alone");
  assert.throws(() => desk.requestChange(mina, pack.caseId!, "cancel", "x"), /not a subscription/);
  const jordan = await login("jordan@example.com");
  assert.throws(() => desk.requestChange(jordan, sub.caseId!, "refund", "x"), /unknown case/, "cannot touch another customer's case");

  const pending = desk.cases().find((c) => c.id === sub.caseId)!.request!;
  assert.ok(pending.summary.some((l) => l.includes("forgot the trial")));
  assert.ok(pending.summary.some((l) => l.includes("USD 15.00")));

  await desk.approve(sub.caseId!);
  assert.deepEqual(paypal.cancellations.map((c) => c.subscriptionId), ["I-MINA0001"]);
  await assert.rejects(desk.approve(sub.caseId!), /nothing to approve/);

  const m = desk.metrics();
  assert.equal(m.inquiries, 3);
  assert.equal(m.explained, 1);
  assert.deepEqual(m.keptRevenue, [{ currency: "USD", value: 12 }]);
  assert.equal(m.approved, 1);
  assert.equal(m.notOurs, 1);
  assert.deepEqual(m.feesAtStake, { currency: "USD", value: 30 });
});

test("refund approval calls PayPal once even if clicked twice", async () => {
  const { desk, paypal, login } = setup();
  const mina = await login("mina@example.com");
  const r = await desk.findCharge(mina, "₩16,740?", { amount: { currency: "KRW", value: 16740 }, date: "2026-10-21" });
  desk.requestChange(mina, r.caseId!, "refund", "Moved away, can't attend");
  await Promise.all([desk.approve(r.caseId!), desk.approve(r.caseId!).catch(() => "second click rejected")]);
  assert.deepEqual(paypal.refunds.map((x) => [x.captureId, x.amount.value]), [["CAP-101", 12]]);
});

test("guest card checkout: custom_id email identifies the customer when payer email is missing", async () => {
  const { customerEmailOf } = await import("../src/desk.ts");
  assert.equal(customerEmailOf({ id: "X", date: "2026-11-03", eventCode: "T0006", amount: { currency: "USD", value: 12 }, status: "S", payerId: "", customField: "Mina@Example.com" }), "mina@example.com");
  assert.equal(customerEmailOf({ id: "Y", date: "2026-11-03", eventCode: "T0006", amount: { currency: "USD", value: 12 }, status: "S", payerId: "", customField: "store-order-42" }), undefined);
});

test("asking about both lines of a split order is one inquiry, counted once", async () => {
  const { desk, login } = setup();
  const token = await login("mina@example.com");
  const a = await desk.findCharge(token, "two charges?", { amount: { currency: "KRW", value: 89280 } });
  const b = await desk.findCharge(token, "two charges?", { amount: { currency: "KRW", value: 50220 } });
  assert.equal(a.caseId, b.caseId);
  assert.deepEqual(b.parts?.map((p) => p.amount.value), [64, 36]);
  assert.equal(desk.metrics().explained, 1);
  assert.deepEqual(desk.metrics().keptRevenue, [{ currency: "USD", value: 100 }]);
});

test("statement names are listed once each", () => {
  const { desk } = setup();
  const r = desk.checkDescriptor("PAYPAL *QUICKWINPRIZE");
  assert.equal(new Set(r.howWeAppear).size, r.howWeAppear.length);
});
