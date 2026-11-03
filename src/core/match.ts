// Find which sale a vague customer question ("what is this ₩13,900 charge?") refers to.
// Deterministic evidence only; the agent turns this into a reply. Every candidate carries
// evidence items the UI shows as cards, so the customer sees WHY we think it's that order.

import { descriptorScore } from "./descriptor.ts";
import type { ChargeQuery, MerchantProfile, Money, OrderInfo, PaypalTx } from "./types.ts";

export interface FxRate {
  from: string;
  to: string;
  rate: number; // 1 unit of `from` = rate units of `to`
}

export interface MatchOptions {
  dateWindowDays: number; // statements post a few days after the PayPal payment
  fxTolerance: number; // card FX spread + fees, e.g. 0.04 = ±4%
  rates: FxRate[];
}

export const DEFAULT_MATCH: MatchOptions = { dateWindowDays: 4, fxTolerance: 0.04, rates: [] };

export type EvidenceKind = "name" | "amount" | "date" | "order" | "recurring";

export interface Evidence {
  kind: EvidenceKind;
  detail: string;
  strength: "strong" | "medium" | "weak";
}

export type AmountKind = "exact" | "fx" | "partial";

export interface Candidate {
  tx: PaypalTx;
  order?: OrderInfo;
  score: number; // 0..1, averaged over the fields the customer gave us
  evidence: Evidence[];
  amountKind?: AmountKind;
  sameOrderTxIds: string[]; // other captures of the same order (split shipments show up as several lines)
}

/** Is the printed/quoted descriptor ours at all? Uses every soft descriptor the merchant uses. */
export function descriptorFit(descriptor: string, merchant: MerchantProfile): number {
  const variants = [undefined, ...merchant.softDescriptors];
  return Math.max(...variants.map((s) => descriptorScore(descriptor, merchant.descriptorPrefix, s)));
}

export const OURS_THRESHOLD = 0.8;

const WEIGHTS = { name: 0.25, amount: 0.5, date: 0.25 };

export function rankCandidates(
  query: ChargeQuery,
  txs: PaypalTx[],
  merchant: MerchantProfile,
  orders: Map<string, OrderInfo>,
  opts: MatchOptions = DEFAULT_MATCH,
): Candidate[] {
  const sales = txs.filter((t) => t.amount.value > 0 && t.status !== "V");
  const out: Candidate[] = [];
  for (const tx of sales) {
    const evidence: Evidence[] = [];
    let total = 0;
    let weight = 0;

    if (query.date) {
      const lag = daysBetween(tx.date, query.date); // positive = statement posted after the PayPal payment
      if (lag < -1 || lag > opts.dateWindowDays) continue;
      const s = 1 - Math.max(0, lag) / (opts.dateWindowDays + 1);
      evidence.push({
        kind: "date",
        detail: lag <= 0 ? `Paid on ${tx.date}, same day as the statement line` : `Paid on ${tx.date}; statements usually post ${lag} day(s) later`,
        strength: lag <= 2 ? "strong" : "medium",
      });
      total += WEIGHTS.date * s;
      weight += WEIGHTS.date;
    }

    let amountKind: AmountKind | undefined;
    if (query.amount) {
      const amt = compareAmount(query.amount, tx.amount, opts);
      if (!amt) continue;
      amountKind = amt.kind;
      evidence.push({ kind: "amount", detail: amt.detail, strength: amt.kind === "partial" ? "weak" : "strong" });
      total += WEIGHTS.amount * (amt.kind === "exact" ? 1 : amt.kind === "fx" ? 0.85 : 0.4);
      weight += WEIGHTS.amount;
    }

    const order = tx.orderId ? orders.get(tx.orderId) : undefined;
    if (query.descriptor) {
      const s = descriptorScore(query.descriptor, merchant.descriptorPrefix, order?.softDescriptor);
      evidence.push({
        kind: "name",
        detail: `"${query.descriptor.trim()}" matches how ${merchant.displayName} appears on statements (${Math.round(s * 100)}%)`,
        strength: s >= 0.9 ? "strong" : s >= 0.6 ? "medium" : "weak",
      });
      total += WEIGHTS.name * s;
      weight += WEIGHTS.name;
    }

    const items = order?.items.length ? order.items : tx.items ?? [];
    if (items.length) {
      evidence.push({ kind: "order", detail: `Order contains ${items.map((i) => `${i.quantity} × ${i.name}`).join(", ")}`, strength: "medium" });
    }

    const sameOrderTxIds = tx.orderId ? sales.filter((t) => t.id !== tx.id && t.orderId === tx.orderId).map((t) => t.id) : [];
    if (sameOrderTxIds.length) {
      evidence.push({ kind: "order", detail: `One order paid in ${sameOrderTxIds.length + 1} parts (shipped separately), so it shows as several statement lines`, strength: "strong" });
    }

    out.push({ tx, order, score: weight ? round(total / weight) : 0, evidence, amountKind, sameOrderTxIds });
  }
  return out.sort((a, b) => b.score - a.score || b.tx.date.localeCompare(a.tx.date));
}

function compareAmount(quoted: Money, paid: Money, opts: MatchOptions): { kind: AmountKind; detail: string } | null {
  const q = Math.abs(quoted.value);
  const p = Math.abs(paid.value);
  const paidText = `${paid.currency} ${p}`;
  if (quoted.currency === paid.currency) {
    if (near(q, p, 0.005)) return { kind: "exact", detail: `Amount ${paidText} matches exactly` };
    if (q < p) return { kind: "partial", detail: `${quoted.currency} ${q} is part of a ${paidText} payment` };
    return null;
  }
  const rate = findRate(opts.rates, paid.currency, quoted.currency);
  if (!rate) return null;
  const expected = p * rate;
  if (!near(q, expected, opts.fxTolerance)) return null;
  return {
    kind: "fx",
    detail: `${paidText} × ${rate} ≈ ${quoted.currency} ${Math.round(expected).toLocaleString("en-US")} after the card's FX conversion (within ±${opts.fxTolerance * 100}%)`,
  };
}

export interface RecurringInfo {
  recurring: boolean;
  occurrences: number;
  intervalDays?: number;
  subscriptionId?: string;
  evidence: Evidence[];
}

/** Same payer, similar amount, roughly regular interval — or PayPal marks it as a subscription. */
export function detectRecurring(target: PaypalTx, history: PaypalTx[]): RecurringInfo {
  const evidence: Evidence[] = [];
  const subscriptionId = target.referenceType === "SUB" ? target.referenceId : undefined;
  if (target.referenceType === "SUB" || target.eventCode === "T0002") {
    evidence.push({ kind: "recurring", detail: "PayPal marks this as a subscription payment", strength: "strong" });
  }
  if (target.referenceType === "PAP" || target.eventCode === "T0003") {
    evidence.push({ kind: "recurring", detail: "Paid under a pre-approved billing agreement", strength: "strong" });
  }

  const dates = Array.from(
    new Set([
      ...history
        .filter((t) => t.payerId === target.payerId && t.amount.currency === target.amount.currency)
        .filter((t) => near(Math.abs(t.amount.value), Math.abs(target.amount.value), 0.05))
        .map((t) => t.date),
      target.date,
    ]),
  ).sort();
  let intervalDays: number | undefined;
  if (dates.length >= 3) {
    const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d));
    const avg = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    if (gaps.every((g) => Math.abs(g - avg) <= 4)) {
      intervalDays = Math.round(avg);
      evidence.push({ kind: "recurring", detail: `${dates.length} payments about every ${intervalDays} days`, strength: "strong" });
    }
  }
  return { recurring: evidence.length > 0, occurrences: dates.length, intervalDays, subscriptionId, evidence };
}

export type Decision =
  | { kind: "not_ours"; fit: number }
  | { kind: "none" }
  | { kind: "match"; best: Candidate }
  | { kind: "ask"; field: "date" | "amount" | "descriptor"; candidates: Candidate[] }
  | { kind: "several"; candidates: Candidate[] };

const CONFIDENT = 0.6;
const CLEAR_GAP = 0.15;

/**
 * What to do next. Runs only on the verified customer's own sales, so asking
 * "which date?" or listing a few orders never reveals someone else's purchase.
 */
export function decide(query: ChargeQuery, candidates: Candidate[], merchant: MerchantProfile): Decision {
  if (query.descriptor) {
    const fit = descriptorFit(query.descriptor, merchant);
    if (fit < OURS_THRESHOLD) return { kind: "not_ours", fit };
  }
  if (!candidates.length) return { kind: "none" };
  const [best, second] = candidates;
  const clear = !second || best.score - second.score >= CLEAR_GAP || best.sameOrderTxIds.includes(second.tx.id);
  if (clear && best.score >= CONFIDENT && (query.amount || query.date || candidates.length === 1)) {
    return { kind: "match", best };
  }
  const field = !query.amount ? "amount" : !query.date ? "date" : !query.descriptor ? "descriptor" : null;
  const close = candidates.filter((c) => best.score - c.score < CLEAR_GAP).slice(0, 3);
  if (field) return { kind: "ask", field, candidates: close };
  return { kind: "several", candidates: close };
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
}

function findRate(rates: FxRate[], from: string, to: string): number | undefined {
  const direct = rates.find((r) => r.from === from && r.to === to);
  if (direct) return direct.rate;
  const inverse = rates.find((r) => r.from === to && r.to === from);
  return inverse ? 1 / inverse.rate : undefined;
}

function near(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= Math.max(Math.abs(b) * tol, 0.01);
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
