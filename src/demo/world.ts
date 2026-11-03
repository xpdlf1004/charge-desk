// The demo world: one fictional merchant (Brightleaf Studio, an online yoga studio) and its customers.
// Mina pays with a Korean card, so her statement shows KRW.

import type { MerchantProfile, OrderInfo, PaypalTx, SubscriptionInfo } from "../core/types.ts";
import type { FxRate } from "../core/match.ts";

export const MERCHANT: MerchantProfile = {
  displayName: "Brightleaf Studio",
  descriptorPrefix: "Brightleaf Studio",
  softDescriptors: ["10 class pack", "Membership", "Gear"],
  website: "brightleaf.example",
};

export const RATES: FxRate[] = [{ from: "USD", to: "KRW", rate: 1395 }];

export const ALTERNATIVES = ["Pause the membership for one month (no charge)", "Switch to the 4-class pack (USD 6.00, no renewal)"];

const usd = (value: number) => ({ currency: "USD", value });
const MINA = { payerId: "P-MINA", payerEmail: "mina@example.com" };
const JORDAN = { payerId: "P-JORDAN", payerEmail: "jordan@example.com" };
const SAM = { payerId: "P-SAM", payerEmail: "sam@example.com" };

export const TXS: PaypalTx[] = [
  // Mina: a class pack, a gear order shipped in two parts, then the first membership charge after a 1-day trial.
  { id: "CAP-101", date: "2026-10-20", eventCode: "T0006", amount: usd(12), status: "S", ...MINA, orderId: "O-101" },
  { id: "CAP-102A", date: "2026-10-28", eventCode: "T0006", amount: usd(64), status: "S", ...MINA, orderId: "O-102" },
  { id: "CAP-102B", date: "2026-10-30", eventCode: "T0006", amount: usd(36), status: "S", ...MINA, orderId: "O-102" },
  { id: "SUB-PAY-1", date: "2026-11-03", eventCode: "T0002", amount: usd(9.99), status: "S", ...MINA, referenceId: "I-MINA0001", referenceType: "SUB" },
  // Jordan: monthly member for months, charged the same day and amount as Mina.
  { id: "SUB-PAY-J1", date: "2026-08-03", eventCode: "T0002", amount: usd(9.99), status: "S", ...JORDAN, referenceId: "I-JORD0001", referenceType: "SUB" },
  { id: "SUB-PAY-J2", date: "2026-09-03", eventCode: "T0002", amount: usd(9.99), status: "S", ...JORDAN, referenceId: "I-JORD0001", referenceType: "SUB" },
  { id: "SUB-PAY-J3", date: "2026-10-03", eventCode: "T0002", amount: usd(9.99), status: "S", ...JORDAN, referenceId: "I-JORD0001", referenceType: "SUB" },
  { id: "SUB-PAY-J4", date: "2026-11-03", eventCode: "T0002", amount: usd(9.99), status: "S", ...JORDAN, referenceId: "I-JORD0001", referenceType: "SUB" },
  // Sam: bought a pack, then got refunded.
  { id: "CAP-201", date: "2026-11-01", eventCode: "T0006", amount: usd(12), status: "S", ...SAM, orderId: "O-201" },
  { id: "REF-201", date: "2026-11-02", eventCode: "T1107", amount: usd(-12), status: "S", ...SAM },
];

export const ORDERS: OrderInfo[] = [
  { orderId: "O-101", softDescriptor: "10 class pack", items: [{ name: "10-class pack", quantity: 1, unitAmount: usd(12) }] },
  {
    orderId: "O-102",
    softDescriptor: "Gear",
    items: [
      { name: "Cork yoga mat", quantity: 1, unitAmount: usd(64) },
      { name: "Yoga block set", quantity: 1, unitAmount: usd(36) },
    ],
  },
  { orderId: "O-201", softDescriptor: "10 class pack", items: [{ name: "10-class pack", quantity: 1, unitAmount: usd(12) }] },
];

export const SUBSCRIPTIONS: SubscriptionInfo[] = [
  { id: "I-MINA0001", planName: "Monthly membership", status: "ACTIVE", trialCyclesCompleted: 1, regularCyclesCompleted: 1 },
  { id: "I-JORD0001", planName: "Monthly membership", status: "ACTIVE", trialCyclesCompleted: 1, regularCyclesCompleted: 4 },
];

export const CAPTURE_TO_ORDER: Record<string, string> = Object.fromEntries(
  TXS.filter((t) => t.orderId).map((t) => [t.id, t.orderId!]),
);

export const DEMO_TODAY = "2026-11-05";
