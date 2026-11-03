// Inquiry log, merchant approval requests, and the numbers on the merchant dashboard.
// The agent never moves money: refunds and cancellations wait for the merchant's click.

import type { Candidate, RecurringInfo } from "./match.ts";
import type { Money } from "./types.ts";

export type Outcome = "explained" | "request" | "not_ours" | "no_match";

export interface MerchantRequest {
  kind: "refund" | "cancel";
  status: "pending" | "approved" | "declined";
  txId: string;
  amount: Money;
  subscriptionId?: string;
  customerReason: string;
  offeredAlternatives: string[];
  summary: string[]; // ready-to-read lines for the merchant
  paypalRefundId?: string; // set once the merchant approves a refund
}

export interface CaseRecord {
  id: string;
  openedAt: string; // ISO timestamp
  customerEmail?: string;
  question: string;
  outcome: Outcome;
  txIds: string[];
  amount?: Money; // merchant-currency amount of the matched sale(s)
  request?: MerchantRequest;
}

export interface MetricsOptions {
  disputeFee: Money; // per-dispute fee the merchant pays if the customer goes to the card issuer (merchant setting)
}

export function buildRequest(
  kind: "refund" | "cancel",
  match: Candidate,
  recurring: RecurringInfo,
  customerReason: string,
  offeredAlternatives: string[],
  disputeFee: Money,
): MerchantRequest {
  const tx = match.tx;
  const items = match.order?.items.length ? match.order.items : tx.items ?? [];
  const what = items.length ? items.map((i) => `${i.quantity} × ${i.name}`).join(", ") : `payment ${tx.id}`;
  const summary = [
    `Bought: ${what} on ${tx.date} for ${fmt(tx.amount)}${recurring.recurring ? " (subscription payment)" : ""}`,
    `Customer asks to ${kind === "refund" ? "refund it" : "cancel the subscription"}: "${customerReason.trim()}"`,
    offeredAlternatives.length
      ? `Already offered: ${offeredAlternatives.join("; ")} — customer declined`
      : "No alternatives were configured to offer",
    `How we matched it: ${match.evidence.filter((e) => e.strength === "strong").map((e) => e.detail).join(" · ") || "see evidence"}`,
    `If declined, the customer may dispute it with their card issuer: if that dispute is lost you could return ${fmt(tx.amount)} and pay about ${fmt(disputeFee)} in fees.`,
  ];
  return {
    kind,
    status: "pending",
    txId: tx.id,
    amount: tx.amount,
    subscriptionId: kind === "cancel" ? recurring.subscriptionId : undefined,
    customerReason,
    offeredAlternatives,
    summary,
  };
}

export interface MerchantMetrics {
  inquiries: number;
  explained: number; // ended with an explanation, no money returned
  keptRevenue: Money[]; // sum of explained sales, per currency
  pending: number;
  approved: number;
  declined: number;
  notOurs: number;
  noMatch: number;
  /** Fees that would apply if every case closed without a dispute had gone to the card issuer. An estimate from the fee setting, shown separately. */
  feesAtStake: Money;
}

export function merchantMetrics(cases: CaseRecord[], opts: MetricsOptions): MerchantMetrics {
  const explained = cases.filter((c) => c.outcome === "explained");
  const requests = cases.filter((c) => c.request).map((c) => c.request!);
  const approved = requests.filter((r) => r.status === "approved").length;
  const kept = new Map<string, number>();
  for (const c of explained) {
    if (c.amount) kept.set(c.amount.currency, round2((kept.get(c.amount.currency) ?? 0) + c.amount.value));
  }
  return {
    inquiries: cases.length,
    explained: explained.length,
    keptRevenue: [...kept].map(([currency, value]) => ({ currency, value })),
    pending: requests.filter((r) => r.status === "pending").length,
    approved,
    declined: requests.filter((r) => r.status === "declined").length,
    notOurs: cases.filter((c) => c.outcome === "not_ours").length,
    noMatch: cases.filter((c) => c.outcome === "no_match").length,
    feesAtStake: { currency: opts.disputeFee.currency, value: round2((explained.length + approved) * opts.disputeFee.value) },
  };
}

export function fmt(m: Money): string {
  return `${m.currency} ${m.value.toLocaleString("en-US", { minimumFractionDigits: m.currency === "KRW" ? 0 : 2, maximumFractionDigits: 2 })}`;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
