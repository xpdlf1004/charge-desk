// The charge desk: everything the AI agent can call, as plain functions.
// Customer side: check a descriptor, verify email, find the charge, ask for a change.
// Merchant side: see cases, approve or decline requests, read the dashboard numbers.

import { randomBytes } from "node:crypto";

import { buildStatementText } from "./core/descriptor.ts";
import { buildRequest, merchantMetrics, type CaseRecord, type MerchantMetrics } from "./core/cases.ts";
import {
  DEFAULT_MATCH,
  decide,
  descriptorFit,
  detectRecurring,
  OURS_THRESHOLD,
  rankCandidates,
  type Candidate,
  type Decision,
  type FxRate,
  type RecurringInfo,
} from "./core/match.ts";
import type { ChargeQuery, MerchantProfile, Money, OrderInfo, PaypalTx } from "./core/types.ts";
import { checkCode, normalizeEmail, startVerification, type VerifyDeps } from "./core/verify.ts";
import type { MerchantPaypal } from "./paypal/port.ts";

export interface DeskConfig {
  merchant: MerchantProfile;
  rates: FxRate[];
  disputeFee: Money;
  alternatives: string[]; // what the merchant lets the agent offer before a cancellation
  lookbackDays: number;
  today: () => string; // YYYY-MM-DD
}

export interface FoundCharge {
  caseId?: string; // set once the inquiry ends (not while we are asking a follow-up question)
  decision: Decision;
  recurring?: RecurringInfo;
  /** Offered only for subscriptions, before any cancellation request. */
  alternatives: string[];
  /** Every capture of the matched order (one entry unless it was charged in parts). */
  parts?: { id: string; date: string; amount: Money }[];
}

export function createDesk(paypal: MerchantPaypal, cfg: DeskConfig, verifyDeps: VerifyDeps) {
  const verified = new Map<string, string>(); // desk token -> verified email
  const cases: CaseRecord[] = [];
  const matches = new Map<string, Candidate & { recurring: RecurringInfo }>(); // caseId -> matched sale

  // Transaction Search is slow and rate-limited; reuse one result for a short while.
  let cache: { at: number; txs: PaypalTx[] } | undefined;
  const CACHE_MS = 60_000;

  async function sales(): Promise<PaypalTx[]> {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.txs.map((t) => ({ ...t }));
    const end = cfg.today();
    const start = addDays(end, -cfg.lookbackDays);
    const txs = await paypal.searchTransactions(start, end);
    cache = { at: Date.now(), txs };
    return txs.map((t) => ({ ...t }));
  }

  function openCase(c: Omit<CaseRecord, "id" | "openedAt">): CaseRecord {
    const rec = { id: `case-${cases.length + 1}`, openedAt: new Date().toISOString(), ...c };
    cases.push(rec);
    return rec;
  }

  function requireEmail(token: string): string {
    const email = verified.get(token);
    if (!email) throw new Error("not verified");
    return email;
  }

  return {
    // --- customer side ---

    /** Safe before verification: says whether a descriptor is ours, reveals nothing about customers. */
    checkDescriptor(descriptor: string, question = descriptor) {
      const fit = descriptorFit(descriptor, cfg.merchant);
      const ours = fit >= OURS_THRESHOLD;
      if (!ours) openCase({ question, outcome: "not_ours", txIds: [] });
      const howWeAppear = [...new Set([undefined, ...cfg.merchant.softDescriptors].map((s) => buildStatementText(cfg.merchant.descriptorPrefix, s)))];
      return { ours, fit, howWeAppear };
    },

    async startVerification(email: string) {
      const payers = new Set((await sales()).map(customerEmailOf).filter((e): e is string => !!e));
      return startVerification(email, payers, verifyDeps);
    },

    confirmCode(sessionId: string, code: string) {
      const r = checkCode(sessionId, code, verifyDeps);
      if (!r.ok) return r;
      const token = randomBytes(16).toString("hex");
      verified.set(token, r.email);
      return { ok: true as const, token };
    },

    /** Find the sale the verified customer is asking about. Only their own payments are searched. */
    async findCharge(token: string, question: string, query: ChargeQuery): Promise<FoundCharge> {
      const email = requireEmail(token);
      const all = await sales();
      const mine = all.filter((t) => customerEmailOf(t) === email);
      const orders = await enrich(paypal, mine);
      const ranked = rankCandidates(query, mine, cfg.merchant, orders, { ...DEFAULT_MATCH, rates: cfg.rates });
      const decision = decide(query, ranked, cfg.merchant);

      // A follow-up question is part of the same inquiry: record a case only when the conversation ends.
      if (decision.kind === "ask" || decision.kind === "several") return { decision, alternatives: [] };
      if (decision.kind !== "match") {
        const outcome = decision.kind === "not_ours" ? "not_ours" : "no_match";
        const rec = openCase({ customerEmail: email, question, outcome, txIds: [] });
        return { caseId: rec.id, decision, alternatives: [] };
      }
      const best = decision.best;
      const recurring = detectRecurring(best.tx, mine.filter((t) => t.id !== best.tx.id));
      best.evidence.push(...recurring.evidence);
      if (recurring.subscriptionId) {
        const sub = await paypal.getSubscription(recurring.subscriptionId);
        if (sub) {
          best.tx.items ??= [{ name: sub.planName, quantity: 1 }];
          const nth = sub.regularCyclesCompleted;
          best.evidence.push({
            kind: "order",
            detail: sub.trialCyclesCompleted > 0 && nth <= 1
              ? `${sub.planName}: the free trial ended and this is the first paid month`
              : `${sub.planName}: paid month ${nth}`,
            strength: "strong",
          });
        }
      }
      const group = [best.tx, ...mine.filter((t) => best.sameOrderTxIds.includes(t.id))].sort((a, b) => a.date.localeCompare(b.date));
      const parts = group.map((t) => ({ id: t.id, date: t.date, amount: t.amount }));
      // Asking about the second line of the same order is the same inquiry, not a new one.
      const existing = cases.find((c) => c.customerEmail === email && c.txIds.some((id) => group.some((t) => t.id === id)));
      if (existing) {
        matches.set(existing.id, { ...best, recurring });
        return { caseId: existing.id, decision, recurring, alternatives: recurring.recurring ? cfg.alternatives : [], parts };
      }
      const rec = openCase({
        customerEmail: email,
        question,
        outcome: "explained",
        txIds: group.map((t) => t.id),
        amount: { currency: best.tx.amount.currency, value: round2(group.reduce((s, t) => s + t.amount.value, 0)) },
      });
      matches.set(rec.id, { ...best, recurring });
      return { caseId: rec.id, decision, recurring, alternatives: recurring.recurring ? cfg.alternatives : [], parts };
    },

    /** The customer still wants money back or to stop the subscription: queue it for the merchant. */
    requestChange(token: string, caseId: string, kind: "refund" | "cancel", reason: string) {
      const email = requireEmail(token);
      const rec = cases.find((c) => c.id === caseId && c.customerEmail === email);
      const match = matches.get(caseId);
      if (!rec || !match) throw new Error("unknown case");
      if (kind === "cancel" && !match.recurring.subscriptionId) throw new Error("not a subscription");
      const offered = match.recurring.recurring ? cfg.alternatives : [];
      rec.request = buildRequest(kind, match, match.recurring, reason, offered, cfg.disputeFee);
      rec.outcome = "request";
      return { status: rec.request.status, message: "Sent to the merchant for approval. You'll hear back by email." };
    },

    /** Retention options to show before a change request on this case (subscriptions only). */
    alternativesFor(token: string, caseId: string): string[] {
      const email = requireEmail(token);
      const rec = cases.find((c) => c.id === caseId && c.customerEmail === email);
      const match = matches.get(caseId);
      return rec && match?.recurring.recurring ? cfg.alternatives : [];
    },

    // --- merchant side ---

    cases(): readonly CaseRecord[] {
      return cases;
    },

    async approve(caseId: string) {
      const rec = cases.find((c) => c.id === caseId);
      const req = rec?.request;
      if (!req || req.status !== "pending") throw new Error("nothing to approve");
      if (req.kind === "refund") {
        const r = await paypal.refundCapture(req.txId, req.amount, `refund-${caseId}`);
        req.paypalRefundId = r.refundId;
      } else {
        await paypal.cancelSubscription(req.subscriptionId!, `Customer request via charge desk (${caseId})`);
      }
      req.status = "approved";
      return req;
    },

    decline(caseId: string) {
      const req = cases.find((c) => c.id === caseId)?.request;
      if (!req || req.status !== "pending") throw new Error("nothing to decline");
      req.status = "declined";
      return req;
    },

    /** Current status on PayPal, to show the merchant the cancellation really happened there. */
    async subscriptionStatus(subscriptionId: string) {
      const sub = await paypal.getSubscription(subscriptionId);
      return sub ? { subscriptionId, status: sub.status, planName: sub.planName } : undefined;
    },

    metrics(): MerchantMetrics {
      return merchantMetrics(cases, { disputeFee: cfg.disputeFee });
    },
  };
}

export type Desk = ReturnType<typeof createDesk>;

/**
 * Who paid, as an email. PayPal wallet payments carry the payer's email; guest card checkouts may not,
 * so the merchant's own key (custom_id set to the store's customer email) is the fallback.
 */
export function customerEmailOf(t: PaypalTx): string | undefined {
  const raw = t.payerEmail ?? (t.customField?.includes("@") ? t.customField : undefined);
  return raw ? normalizeEmail(raw) : undefined;
}

/** Fill order ids for captures (Transaction Search omits them) and fetch those orders. */
async function enrich(paypal: MerchantPaypal, txs: PaypalTx[]): Promise<Map<string, OrderInfo>> {
  const orders = new Map<string, OrderInfo>();
  for (const t of txs) {
    if (t.referenceType === "SUB" || t.amount.value <= 0) continue;
    t.orderId ??= await paypal.orderIdOfCapture(t.id);
    if (t.orderId && !orders.has(t.orderId)) {
      const o = await paypal.getOrder(t.orderId);
      if (o) orders.set(o.orderId, o);
    }
  }
  return orders;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(date + "T00:00:00Z") + days * 86_400_000).toISOString().slice(0, 10);
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
