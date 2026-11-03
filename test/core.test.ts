import { test } from "node:test";
import assert from "node:assert/strict";

import { buildStatementText, descriptorScore, previewForMerchant, STATEMENT_LIMIT } from "../src/core/descriptor.ts";
import { parseLine, parseStatement } from "../src/core/statement.ts";
import { decide, descriptorFit, detectRecurring, rankCandidates } from "../src/core/match.ts";
import type { MerchantProfile, OrderInfo, PaypalTx } from "../src/core/types.ts";

const OPTS = { year: 2026, defaultCurrency: "KRW" };

test("statement text follows the PayPal doc example (prefix + space + descriptor + space + soft descriptor, 22 chars)", () => {
  assert.equal(buildStatementText("Janes Gift", "800-123-1234"), "PAYPAL * Janes Gift 80");
  assert.equal(buildStatementText("Brightleaf Studio", "Yoga 10 pack").length, STATEMENT_LIMIT);
  assert.equal(buildStatementText("Brightleaf Studio", "Yoga 10 pack"), "PAYPAL * Brightleaf St");
});

test("printed descriptor matches its merchant even with squashed spaces", () => {
  assert.equal(descriptorScore("PAYPAL * BRIGHTLEAF ST", "Brightleaf Studio"), 1);
  // Bank squashed the spaces: still the same merchant.
  assert.equal(descriptorScore("PAYPAL *BRIGHTLEAFST", "Brightleaf Studio"), 1);
  // Bank cut the line even shorter: still a strong prefix match.
  assert.ok(descriptorScore("PAYPAL *BRIGHTLEAF", "Brightleaf Studio") >= 0.9);
  // Unrelated merchant scores low.
  assert.ok(descriptorScore("PAYPAL *BRIGHTLEAFST", "NovaPixel") < 0.4);
});

test("merchant preview shows what gets cut off", () => {
  const p = previewForMerchant("Brightleaf Studio", "Yoga 10 pack");
  assert.equal(p.truncated, true);
  assert.equal(p.lostText, "udio Yoga 10 pack");
});

test("parses common Korean card statement layouts", () => {
  const a = parseLine("2026.11.02 PAYPAL *BRIGHTLEAFST 16,820원", OPTS);
  assert.deepEqual(a && { d: a.descriptor, date: a.date, amt: a.amount }, {
    d: "BRIGHTLEAFST",
    date: "2026-11-02",
    amt: { currency: "KRW", value: 16820 },
  });
  const b = parseLine("PAYPAL *NOVAPIXEL 11/03 ₩13,900", OPTS);
  assert.equal(b?.descriptor, "NOVAPIXEL");
  assert.equal(b?.date, "2026-11-03");
  assert.equal(b?.amount.value, 13900);
  // Digits glued to the merchant name stay in the descriptor.
  const c = parseLine("11/04 PAYPAL *STUDIO80 $12.99", OPTS);
  assert.equal(c?.descriptor, "STUDIO80");
  assert.deepEqual(c?.amount, { currency: "USD", value: 12.99 });
});

test("non-PayPal lines are ignored", () => {
  const lines = parseStatement("11/02 스타벅스 강남점 5,600원\n11/02 PAYPAL *NOVAPIXEL 13,900원", OPTS);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].descriptor, "NOVAPIXEL");
});

const merchant: MerchantProfile = {
  displayName: "Brightleaf Studio",
  descriptorPrefix: "Brightleaf Studio",
  softDescriptors: ["10 class pack", "Membership"],
};
const orders = new Map<string, OrderInfo>([
  ["O1", { orderId: "O1", softDescriptor: "10 class pack", items: [{ name: "10-class pack", quantity: 1 }] }],
]);
const tx = (p: Partial<PaypalTx> & Pick<PaypalTx, "id" | "date" | "amount">): PaypalTx => ({
  eventCode: "T0006",
  status: "S",
  payerId: "P1",
  ...p,
});
const OPT = { dateWindowDays: 4, fxTolerance: 0.04, rates: [{ from: "USD", to: "KRW", rate: 1400 }] };

test("a descriptor that isn't ours is recognised as someone else's charge", () => {
  assert.ok(descriptorFit("PAYPAL *BRIGHTLEAFST", merchant) >= 0.9);
  assert.ok(descriptorFit("BRIGHTLEAF", merchant) >= 0.9);
  assert.ok(descriptorFit("PAYPAL *QUICKWINPRIZE", merchant) < 0.5);
  assert.equal(decide({ descriptor: "QUICKWINPRIZE" }, [], merchant).kind, "not_ours");
});

test("foreign-currency charge is matched through an FX range with evidence cards", () => {
  const txs = [
    tx({ id: "A", date: "2026-11-02", amount: { currency: "USD", value: 12 }, orderId: "O1" }),
    tx({ id: "B", date: "2026-11-02", amount: { currency: "USD", value: 40 } }),
    tx({ id: "C", date: "2026-10-20", amount: { currency: "USD", value: 12 } }),
  ];
  const ranked = rankCandidates({ descriptor: "BRIGHTLEAFST", date: "2026-11-03", amount: { currency: "KRW", value: 16820 } }, txs, merchant, orders, OPT);
  assert.deepEqual(ranked.map((c) => c.tx.id), ["A"], "B: amount off, C: outside the date window");
  assert.equal(ranked[0].amountKind, "fx");
  const kinds = ranked[0].evidence.map((e) => e.kind);
  for (const k of ["date", "amount", "name", "order"]) assert.ok(kinds.includes(k as never), k);
  assert.equal(decide({ amount: { currency: "KRW", value: 16820 }, date: "2026-11-03" }, ranked, merchant).kind, "match");
});

test("amount only, two same-priced sales: ask for the statement date instead of guessing", () => {
  const txs = [
    tx({ id: "A", date: "2026-11-02", amount: { currency: "USD", value: 12 } }),
    tx({ id: "B", date: "2026-10-12", amount: { currency: "USD", value: 12 } }),
  ];
  const q = { amount: { currency: "USD", value: 12 } };
  const d = decide(q, rankCandidates(q, txs, merchant, orders, OPT), merchant);
  assert.equal(d.kind, "ask");
  assert.equal(d.kind === "ask" && d.field, "date");
});

test("refunds and reversed payments are never offered as the charge", () => {
  const txs = [
    tx({ id: "R", date: "2026-11-02", eventCode: "T1107", amount: { currency: "USD", value: -12 } }),
    tx({ id: "V", date: "2026-11-02", status: "V", amount: { currency: "USD", value: 12 } }),
  ];
  assert.equal(rankCandidates({ amount: { currency: "USD", value: 12 } }, txs, merchant, orders, OPT).length, 0);
});

test("monthly charges from the same payer are recurring", () => {
  const h = ["2026-08-03", "2026-09-03", "2026-10-03"].map((d, i) => tx({ id: "H" + i, date: d, amount: { currency: "USD", value: 9.99 } }));
  const r = detectRecurring(tx({ id: "T", date: "2026-11-03", amount: { currency: "USD", value: 9.99 } }), h);
  assert.equal(r.recurring, true);
  assert.equal(r.occurrences, 4);
  assert.ok(r.intervalDays! >= 29 && r.intervalDays! <= 32);
});

test("PayPal subscription reference marks a first charge as recurring and gives the subscription id", () => {
  const r = detectRecurring(tx({ id: "T", date: "2026-11-03", amount: { currency: "USD", value: 9.99 }, referenceType: "SUB", referenceId: "I-1" }), []);
  assert.equal(r.recurring, true);
  assert.equal(r.subscriptionId, "I-1");
  assert.equal(detectRecurring(tx({ id: "T", date: "2026-11-03", amount: { currency: "USD", value: 12 } }), []).recurring, false);
});

test("split shipment: the statement line is one capture of an order paid in two parts", () => {
  const caps = [
    tx({ id: "C1", date: "2026-11-04", amount: { currency: "USD", value: 64 }, orderId: "O9" }),
    tx({ id: "C2", date: "2026-11-06", amount: { currency: "USD", value: 36 }, orderId: "O9" }),
  ];
  const ranked = rankCandidates({ date: "2026-11-07", amount: { currency: "USD", value: 36 } }, caps, merchant, new Map(), OPT);
  assert.equal(ranked[0].tx.id, "C2");
  assert.equal(ranked[0].amountKind, "exact");
  assert.deepEqual(ranked[0].sameOrderTxIds, ["C1"]);
  assert.equal(decide({ date: "2026-11-07", amount: { currency: "USD", value: 36 } }, ranked, merchant).kind, "match");
});
