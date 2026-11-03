// The customer-facing agent. Claude reads the customer's words, calls the desk through tools,
// and writes the explanation. The desk does the matching; the model never sees other customers'
// payments, never holds the verification token, and never moves money.

import Anthropic from "@anthropic-ai/sdk";
import { randomBytes } from "node:crypto";

import { fmt } from "../core/cases.ts";
import { buildStatementText } from "../core/descriptor.ts";
import { MERCHANT } from "../demo/world.ts";
import type { Candidate } from "../core/match.ts";
import type { ChargeQuery } from "../core/types.ts";
import type { FoundCharge } from "../desk.ts";
import { runtime } from "./runtime.ts";

/** What the page sends after the code checks out; not a question of its own. */
export const VERIFIED_NOTE = "I verified my email.";

const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";
const MAX_STEPS = 6;
const MAX_TURNS_PER_CHAT = 20;
// The demo runs on a prepaid key behind a public URL: stop answering once a day's spend reaches this.
const DAILY_BUDGET_USD = Number(process.env.DAILY_BUDGET_USD ?? 3);
// Claude Opus 5.5 list prices per million tokens (input, output, cache read, cache write 5m).
const PRICE = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };

export class BudgetExceeded extends Error {}

interface Spend { day: string; usd: number; calls: number; turns: number }
const gs = globalThis as unknown as { __spend?: Spend; __spendTotal?: number };

function spendToday(): Spend {
  const day = new Date().toISOString().slice(0, 10);
  if (gs.__spend?.day !== day) gs.__spend = { day, usd: 0, calls: 0, turns: 0 };
  return gs.__spend;
}

function record(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): number {
  const usd =
    (u.input_tokens * PRICE.input + u.output_tokens * PRICE.output + (u.cache_read_input_tokens ?? 0) * PRICE.cacheRead + (u.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite) / 1e6;
  const sp = spendToday();
  sp.usd += usd;
  sp.calls += 1;
  gs.__spendTotal = (gs.__spendTotal ?? 0) + usd;
  return usd;
}

export function spendReport() {
  const sp = spendToday();
  return { model: MODEL, today: { ...sp, usd: Math.round(sp.usd * 10000) / 10000 }, sinceStart: Math.round((gs.__spendTotal ?? 0) * 10000) / 10000, dailyBudget: DAILY_BUDGET_USD };
}

// --- what the screen shows next to the chat ---

export interface PaymentView {
  txIds: string[];
  date: string;
  amount: string; // merchant currency, e.g. "USD 9.99" (order total when charged in parts)
  items: string[];
  parts?: { date: string; amount: string }[]; // set when one order was charged in several parts
}

export type Card =
  | { type: "descriptor"; descriptor: string; ours: boolean; howWeAppear: string[] }
  | { type: "verify" }
  | { type: "charge"; caseId: string; payment: PaymentView; statement: string; quoted?: string; evidence: { kind: string; detail: string; strength: string }[]; recurring: boolean; subscriptionId?: string; alternatives: string[] }
  | { type: "choose"; reason: "ask" | "several"; field?: string; payments: PaymentView[] }
  | { type: "none" }
  | { type: "request"; caseId: string; kind: "refund" | "cancel"; status: string };

export interface TurnResult {
  reply: string;
  cards: Card[];
  verified: boolean;
}

// --- conversations ---

interface Chat {
  id: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  token?: string; // desk token after email verification; server-side only
  email?: string;
  offeredAlternatives?: Set<string>; // caseIds whose retention offer the customer has already seen
}

const g = globalThis as unknown as { __chats?: Map<string, Chat> };
const chats = (g.__chats ??= new Map());

export function newChatId(): string {
  return randomBytes(16).toString("hex");
}

function chat(id: string): Chat {
  let c = chats.get(id);
  if (!c) {
    c = { id, messages: [] };
    chats.set(id, c);
  }
  return c;
}

/** Called by the verify route once the code checks out. */
export function markVerified(chatId: string, token: string, email: string): void {
  const c = chat(chatId);
  c.token = token;
  c.email = email;
}

export function resetChats(): void {
  chats.clear();
}

// --- tools ---

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "check_descriptor",
    description:
      "Check whether a name printed on the customer's card statement belongs to this merchant. Safe before verification: it reveals nothing about any customer. Use it when the customer quotes a statement name.",
    input_schema: {
      type: "object",
      properties: { descriptor: { type: "string", description: "The name as printed, e.g. 'PAYPAL *BRIGHTLEAFST'" } },
      required: ["descriptor"],
    },
  },
  {
    name: "request_verification",
    description:
      "Show the customer an email verification form. Required before looking up any payment. After calling it, briefly tell the customer to enter the email they paid with and stop.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "find_charge",
    description:
      "Find the verified customer's payment that matches what they describe. Searches only that customer's own payments. Give every detail the customer mentioned; leave out what they did not say.",
    input_schema: {
      type: "object",
      properties: {
        amount_value: { type: "number", description: "Amount as the customer saw it, e.g. 13900" },
        amount_currency: { type: "string", description: "ISO currency of that amount, e.g. KRW or USD" },
        date: { type: "string", description: "Statement date YYYY-MM-DD, if the customer gave one" },
        descriptor: { type: "string", description: "Statement name, if the customer gave one" },
      },
    },
  },
  {
    name: "request_change",
    description:
      "Send the merchant a refund or cancellation request for a payment found with find_charge. The merchant approves or declines; you cannot promise the outcome. For subscriptions, offer the merchant's alternatives first and use this only if the customer still wants to cancel or get money back.",
    input_schema: {
      type: "object",
      properties: {
        case_id: { type: "string" },
        kind: { type: "string", enum: ["refund", "cancel"] },
        reason: { type: "string", description: "The customer's reason, in their words, one sentence" },
      },
      required: ["case_id", "kind", "reason"],
    },
  },
];

const SYSTEM = `You are the payment help desk for Brightleaf Studio, an online yoga studio that takes payments through PayPal.
Customers come to you when they see a charge on their card statement they don't recognize.

How you work:
- If the customer quotes a statement name, call check_descriptor first. If it is not ours, say so plainly and suggest they ask their bank; do not ask for their email.
- Before you say anything about a specific payment, the customer must verify their email: call request_verification. Never guess or reveal payment details before that.
- After verification, call find_charge with the details the customer gave (amount and currency as they saw it, date, statement name).
- Explain using only what the tools return. Lead with the answer in one sentence (what it was and why it was charged), then the key evidence. The screen already shows evidence cards, so do not repeat every detail.
- If find_charge asks for a detail, ask the customer for exactly that one detail.
- Refunds and cancellations: you never move money and never promise one. Never suggest a refund or cancellation yourself; only act on one when the customer asks. When they ask, call request_change; if it returns alternatives to offer first, present them warmly and ask which they prefer. Only if the customer still wants the cancellation or refund, call request_change again, then tell them the studio will decide and email them.
- Be brief and warm. Two to four short sentences. Plain text only: no markdown, no bold, no headings; use a simple dash list only when listing options. Reply in the customer's language.`;

interface FindInput { amount_value?: number; amount_currency?: string; date?: string; descriptor?: string }

async function runTool(c: Chat, name: string, input: Record<string, unknown>, cards: Card[]): Promise<string> {
  const { desk } = runtime();
  switch (name) {
    case "check_descriptor": {
      const descriptor = str(input.descriptor);
      if (!descriptor) return err("descriptor is required");
      const r = desk.checkDescriptor(descriptor, lastUserText(c));
      cards.push({ type: "descriptor", descriptor, ours: r.ours, howWeAppear: r.howWeAppear });
      return JSON.stringify({ ours: r.ours, how_we_appear_on_statements: r.howWeAppear });
    }
    case "request_verification": {
      if (c.token) return JSON.stringify({ already_verified: true, email: c.email });
      cards.push({ type: "verify" });
      return JSON.stringify({ form_shown: true });
    }
    case "find_charge": {
      if (!c.token) return err("Customer is not verified yet. Call request_verification first.");
      const i = input as FindInput;
      const query: ChargeQuery = {
        ...(typeof i.amount_value === "number" ? { amount: { value: i.amount_value, currency: (str(i.amount_currency) ?? "USD").toUpperCase() } } : {}),
        ...(str(i.date) ? { date: str(i.date) } : {}),
        ...(str(i.descriptor) ? { descriptor: str(i.descriptor) } : {}),
      };
      const found = await desk.findCharge(c.token, lastUserText(c), query);
      cards.push(toCard(found, query));
      return JSON.stringify(forModel(found));
    }
    case "request_change": {
      if (!c.token) return err("Customer is not verified.");
      const kind = input.kind === "cancel" ? "cancel" : input.kind === "refund" ? "refund" : undefined;
      const caseId = str(input.case_id);
      if (!kind || !caseId) return err("case_id and kind are required");
      const alternatives = runtime().desk.alternativesFor(c.token, caseId);
      if (alternatives.length && !c.offeredAlternatives?.has(caseId)) {
        // The merchant asked us to offer these before any cancellation or refund; the customer decides after seeing them.
        (c.offeredAlternatives ??= new Set()).add(caseId);
        return JSON.stringify({ not_sent_yet: true, offer_these_first: alternatives, then: "If the customer still wants it after hearing these, call request_change again." });
      }
      try {
        const r = desk.requestChange(c.token, caseId, kind, str(input.reason) ?? "");
        cards.push({ type: "request", caseId, kind, status: r.status });
        return JSON.stringify(r);
      } catch (e) {
        return err((e as Error).message);
      }
    }
  }
  return err(`unknown tool ${name}`);
}

export async function runTurn(chatId: string, text: string): Promise<TurnResult> {
  const c = chat(chatId);
  const cards: Card[] = [];
  const sp = spendToday();
  if (sp.usd >= DAILY_BUDGET_USD) throw new BudgetExceeded("daily demo budget reached");
  if (c.messages.filter((m) => m.role === "user" && typeof m.content === "string").length >= MAX_TURNS_PER_CHAT) {
    return { reply: "This demo chat has reached its length limit. Reload the page to start a new one.", cards, verified: !!c.token };
  }
  sp.turns += 1;
  let turnUsd = 0;
  c.messages.push({ role: "user", content: text });
  const client = new Anthropic();
  const today = await todayText();

  let reply = "";
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }, { type: "text", text: today }],
      tools: TOOLS,
      messages: c.messages,
    } as Anthropic.Beta.MessageCreateParamsNonStreaming);

    turnUsd += record(res.usage);
    c.messages.push({ role: "assistant", content: res.content });
    const text = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
    if (text) reply = text;

    if (res.stop_reason === "refusal") {
      reply ||= "Sorry, I can't help with that here. Please contact the studio by email.";
      break;
    }
    const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || uses.length === 0) break;

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const u of uses) {
      const out = await runTool(c, u.name, (u.input ?? {}) as Record<string, unknown>, cards);
      results.push({ type: "tool_result", tool_use_id: u.id, content: out, ...(out.startsWith('{"error"') ? { is_error: true } : {}) });
    }
    c.messages.push({ role: "user", content: results });
  }
  console.log(`[agent] turn $${turnUsd.toFixed(4)} | today $${spendToday().usd.toFixed(4)} over ${spendToday().calls} calls`);
  return { reply, cards, verified: !!c.token };
}

async function todayText(): Promise<string> {
  const rt = runtime();
  const today = rt.mode === "mock" ? (await import("../demo/world.ts")).DEMO_TODAY : new Date().toISOString().slice(0, 10);
  return `Today is ${today}.`;
}

// --- shaping desk results ---

function payment(cand: Candidate, sameOrder: string[] = []): PaymentView {
  return {
    txIds: [cand.tx.id, ...sameOrder],
    date: cand.tx.date,
    amount: fmt(cand.tx.amount),
    items: (cand.order?.items ?? cand.tx.items ?? []).map((i) => (i.quantity > 1 ? `${i.quantity} × ${i.name}` : i.name)),
  };
}

function withParts(p: PaymentView, f: FoundCharge): PaymentView {
  if (!f.parts || f.parts.length < 2) return p;
  const total = f.parts.reduce((sum, x) => sum + x.amount.value, 0);
  return {
    ...p,
    date: f.parts[0].date,
    amount: fmt({ currency: f.parts[0].amount.currency, value: Math.round(total * 100) / 100 }),
    parts: f.parts.map((x) => ({ date: x.date, amount: fmt(x.amount) })),
  };
}

function toCard(f: FoundCharge, q: ChargeQuery): Card {
  const d = f.decision;
  if (d.kind === "match") {
    return {
      type: "charge",
      caseId: f.caseId!,
      payment: withParts(payment(d.best, d.best.sameOrderTxIds), f),
      // What the bank prints for this sale (subscriptions carry no soft descriptor: just the account name)
      statement: buildStatementText(MERCHANT.descriptorPrefix, d.best.order?.softDescriptor),
      ...(q.amount ? { quoted: fmt(q.amount) } : {}),
      evidence: d.best.evidence.map((e) => ({ kind: e.kind, detail: e.detail, strength: e.strength })),
      recurring: !!f.recurring?.recurring,
      subscriptionId: f.recurring?.subscriptionId,
      alternatives: f.alternatives,
    };
  }
  if (d.kind === "ask" || d.kind === "several") {
    return { type: "choose", reason: d.kind, field: d.kind === "ask" ? d.field : undefined, payments: d.candidates.map((x) => payment(x)) };
  }
  return { type: "none" };
}

function forModel(f: FoundCharge): unknown {
  const d = f.decision;
  if (d.kind === "match") {
    const b = d.best;
    return {
      result: "match",
      case_id: f.caseId,
      date: b.tx.date,
      amount: fmt(b.tx.amount),
      other_parts_of_same_order: b.sameOrderTxIds.length,
      items: (b.order?.items ?? b.tx.items ?? []).map((i) => i.name),
      evidence: b.evidence.map((e) => e.detail),
      subscription: f.recurring?.recurring ? { id: f.recurring.subscriptionId, alternatives_to_offer_before_cancelling: f.alternatives } : null,
    };
  }
  if (d.kind === "ask") return { result: "need_detail", ask_customer_for: d.field, possible_payments: d.candidates.length };
  if (d.kind === "several") return { result: "several", payments: d.candidates.map((x) => ({ date: x.tx.date, amount: fmt(x.tx.amount) })) };
  if (d.kind === "not_ours") return { result: "not_ours" };
  return { result: "no_payment_found", case_id: f.caseId };
}

/** The customer's latest question, skipping the automatic "verified" note. */
function lastUserText(c: Chat): string {
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const m = c.messages[i];
    if (m.role === "user" && typeof m.content === "string" && m.content !== VERIFIED_NOTE) return m.content;
  }
  return "";
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function err(message: string): string {
  return JSON.stringify({ error: message });
}
