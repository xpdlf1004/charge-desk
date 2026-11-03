import { test } from "node:test";
import assert from "node:assert/strict";

import { dateChunks, mapOrder, mapSubscription, mapTransactionDetail, paypalRest } from "../src/paypal/rest.ts";

// Shape from the Transaction Search API reference; re-check against a real sandbox response on day 1.
const DETAIL = {
  transaction_info: {
    transaction_id: "5TY05013RG002845M",
    paypal_reference_id: "I-MINA0001",
    paypal_reference_id_type: "SUB",
    transaction_event_code: "T0002",
    transaction_initiation_date: "2026-11-03T01:02:03+0000",
    transaction_amount: { currency_code: "USD", value: "9.99" },
    transaction_status: "S",
  },
  payer_info: { account_id: "QWERTY123", email_address: "mina@example.com" },
  cart_info: { item_details: [{ item_name: "Monthly membership", item_quantity: "1" }] },
};

test("maps a Transaction Search row", () => {
  assert.deepEqual(mapTransactionDetail(DETAIL), {
    id: "5TY05013RG002845M",
    date: "2026-11-03",
    eventCode: "T0002",
    amount: { currency: "USD", value: 9.99 },
    status: "S",
    payerId: "QWERTY123",
    payerEmail: "mina@example.com",
    referenceId: "I-MINA0001",
    referenceType: "SUB",
    items: [{ name: "Monthly membership", quantity: 1 }],
  });
  assert.equal(mapTransactionDetail({}), null);
});

test("maps an order with its soft descriptor", () => {
  const o = mapOrder({
    id: "O-102",
    purchase_units: [{ soft_descriptor: "Gear", items: [{ name: "Cork yoga mat", quantity: "1", unit_amount: { currency_code: "USD", value: "64.00" } }] }],
  });
  assert.deepEqual(o, { orderId: "O-102", softDescriptor: "Gear", items: [{ name: "Cork yoga mat", quantity: 1, unitAmount: { currency: "USD", value: 64 } }] });
});

test("maps a subscription with its plan name and billing progress", () => {
  const s = mapSubscription(
    { id: "I-MINA0001", status: "ACTIVE", plan_id: "P-1", billing_info: { cycle_executions: [{ tenure_type: "TRIAL", cycles_completed: 1 }, { tenure_type: "REGULAR", cycles_completed: 1 }] } },
    { id: "P-1", name: "Monthly membership" },
  );
  assert.deepEqual(s, { id: "I-MINA0001", planName: "Monthly membership", status: "ACTIVE", trialCyclesCompleted: 1, regularCyclesCompleted: 1 });
});

test("search ranges are split into 31-day requests", () => {
  assert.deepEqual(dateChunks("2026-09-01", "2026-11-05", 31), [
    ["2026-09-01", "2026-10-01"],
    ["2026-10-02", "2026-11-01"],
    ["2026-11-02", "2026-11-05"],
  ]);
});

test("token is fetched once, pages are followed, refunds send an idempotency key", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.endsWith("/v1/oauth2/token")) return json({ access_token: "T", expires_in: 3600 });
    if (url.includes("/v1/reporting/transactions")) {
      const page = new URL(url).searchParams.get("page");
      return json({ transaction_details: page === "1" ? [DETAIL] : [], total_pages: 2 });
    }
    if (url.endsWith("/refund")) return json({ id: "R1", status: "COMPLETED" });
    return json({});
  }) as typeof fetch;
  const pp = paypalRest({ clientId: "id", clientSecret: "secret", fetchImpl: fake });
  const txs = await pp.searchTransactions("2026-11-01", "2026-11-05");
  assert.equal(txs.length, 1);
  await pp.refundCapture("CAP", { currency: "USD", value: 12 }, "refund-case-1");
  assert.equal(calls.filter((c) => c.url.endsWith("/oauth2/token")).length, 1);
  assert.equal(calls.filter((c) => c.url.includes("/reporting/transactions")).length, 2);
  const refund = calls.find((c) => c.url.endsWith("/refund"))!;
  assert.equal((refund.init!.headers as Record<string, string>)["PayPal-Request-Id"], "refund-case-1");
  assert.equal(JSON.parse(String(refund.init!.body)).amount.value, "12.00");
});
