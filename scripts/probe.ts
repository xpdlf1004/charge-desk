// Day-1 probe: run the REST adapter against the sandbox and print what the desk would see.
// Usage: node --experimental-strip-types scripts/probe.ts <orderId> <subscriptionId> [captureId]
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { paypalRest } from "../src/paypal/rest.ts";

const env = Object.fromEntries(
  readFileSync(`${homedir()}/.config/paypal-hackathon/sandbox.env`, "utf8")
    .split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const pp = paypalRest({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, baseUrl: env.PAYPAL_BASE_URL });
const [orderId, subId, captureId] = process.argv.slice(2);
if (orderId) console.log("order", JSON.stringify(await pp.getOrder(orderId)));
if (subId) console.log("subscription", JSON.stringify(await pp.getSubscription(subId)));
if (captureId) console.log("capture->order", await pp.orderIdOfCapture(captureId));
try {
  const txs = await pp.searchTransactions("2026-11-01", "2026-11-05");
  console.log("search", txs.length, JSON.stringify(txs.slice(0, 8), null, 1));
} catch (e) {
  console.log("search failed:", String(e).slice(0, 160));
}
