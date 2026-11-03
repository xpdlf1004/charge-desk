// PayPal REST adapter (merchant credentials). Field mapping follows the public API reference;
// confirm it against real sandbox responses on day 1 (concept.md §14 a–c) before relying on it.

import type { Money, OrderInfo, PaypalTx, SubscriptionInfo } from "../core/types.ts";
import type { MerchantPaypal } from "./port.ts";

export const SANDBOX = "https://api-m.sandbox.paypal.com";
const SEARCH_MAX_DAYS = 31; // Transaction Search allows at most 31 days per request

export interface RestConfig {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export function paypalRest(cfg: RestConfig): MerchantPaypal {
  const base = cfg.baseUrl ?? SANDBOX;
  const f = cfg.fetchImpl ?? fetch;
  let token: { value: string; expiresAt: number } | undefined;

  async function accessToken(): Promise<string> {
    if (token && Date.now() < token.expiresAt - 60_000) return token.value;
    const res = await f(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const body = (await ok(res, "oauth2/token")) as { access_token: string; expires_in: number };
    token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return token.value;
  }

  async function call(path: string, init: RequestInit = {}): Promise<unknown> {
    const res = await f(`${base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    return ok(res, path);
  }

  return {
    async searchTransactions(start, end) {
      const out: PaypalTx[] = [];
      for (const [from, to] of dateChunks(start, end, SEARCH_MAX_DAYS)) {
        let page = 1;
        let totalPages = 1;
        do {
          const q = new URLSearchParams({
            start_date: `${from}T00:00:00-0000`,
            end_date: `${to}T23:59:59-0000`,
            fields: "all",
            page_size: "500",
            page: String(page),
          });
          const body = (await call(`/v1/reporting/transactions?${q}`)) as { transaction_details?: unknown[]; total_pages?: number };
          for (const d of body.transaction_details ?? []) {
            const tx = mapTransactionDetail(d);
            if (tx) out.push(tx);
          }
          totalPages = body.total_pages ?? 1;
          page += 1;
        } while (page <= totalPages);
      }
      return out;
    },

    async orderIdOfCapture(captureId) {
      const body = (await call(`/v2/payments/captures/${encodeURIComponent(captureId)}`)) as {
        supplementary_data?: { related_ids?: { order_id?: string } };
      };
      return body.supplementary_data?.related_ids?.order_id;
    },

    async getOrder(orderId) {
      return mapOrder(await call(`/v2/checkout/orders/${encodeURIComponent(orderId)}`));
    },

    async getSubscription(subscriptionId) {
      const sub = (await call(`/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`)) as Json;
      if (!sub?.id) return undefined;
      const plan = sub.plan_id ? ((await call(`/v1/billing/plans/${encodeURIComponent(sub.plan_id)}`)) as Json) : {};
      return mapSubscription(sub, plan);
    },

    async refundCapture(captureId, amount, requestId) {
      const body = (await call(`/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
        method: "POST",
        headers: { "PayPal-Request-Id": requestId }, // idempotent: a double click refunds once
        body: JSON.stringify({ amount: { value: amount.value.toFixed(2), currency_code: amount.currency } }),
      })) as { id: string; status: string };
      return { refundId: body.id, status: body.status };
    },

    async cancelSubscription(subscriptionId, reason) {
      await call(`/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: reason.slice(0, 128) }),
      });
    },
  };
}

// --- mapping (exported for tests) ---

type Json = Record<string, any>;

export function mapTransactionDetail(raw: unknown): PaypalTx | null {
  const d = raw as Json;
  const info = d?.transaction_info as Json | undefined;
  if (!info?.transaction_id || !info.transaction_amount) return null;
  const payer = (d.payer_info ?? {}) as Json;
  const items = ((d.cart_info?.item_details ?? []) as Json[])
    .filter((i) => i.item_name)
    .map((i) => ({ name: String(i.item_name), quantity: Number(i.item_quantity ?? 1) }));
  return {
    id: String(info.transaction_id),
    date: String(info.transaction_initiation_date ?? "").slice(0, 10),
    eventCode: String(info.transaction_event_code ?? ""),
    amount: money(info.transaction_amount),
    status: String(info.transaction_status ?? ""),
    payerId: String(payer.account_id ?? ""),
    payerEmail: payer.email_address ? String(payer.email_address) : undefined,
    referenceId: info.paypal_reference_id ? String(info.paypal_reference_id) : undefined,
    referenceType: info.paypal_reference_id_type ? String(info.paypal_reference_id_type) : undefined,
    items: items.length ? items : undefined,
    ...(info.custom_field ? { customField: String(info.custom_field) } : {}),
    ...(info.invoice_id ? { invoiceId: String(info.invoice_id) } : {}),
  };
}

export function mapOrder(raw: unknown): OrderInfo | undefined {
  const o = raw as Json;
  if (!o?.id) return undefined;
  const pu = ((o.purchase_units ?? []) as Json[])[0] ?? {};
  return {
    orderId: String(o.id),
    softDescriptor: pu.soft_descriptor ? String(pu.soft_descriptor) : undefined,
    items: ((pu.items ?? []) as Json[]).map((i) => ({
      name: String(i.name),
      quantity: Number(i.quantity ?? 1),
      unitAmount: i.unit_amount ? money(i.unit_amount) : undefined,
    })),
  };
}

export function mapSubscription(sub: Json, plan: Json): SubscriptionInfo {
  const cycles = ((sub.billing_info?.cycle_executions ?? []) as Json[]);
  const completed = (type: string) =>
    cycles.filter((c) => c.tenure_type === type).reduce((n, c) => n + Number(c.cycles_completed ?? 0), 0);
  return {
    id: String(sub.id),
    planName: String(plan?.name ?? "Subscription"),
    status: String(sub.status ?? ""),
    trialCyclesCompleted: completed("TRIAL"),
    regularCyclesCompleted: completed("REGULAR"),
  };
}

function money(m: Json): Money {
  return { currency: String(m.currency_code), value: Number(m.value) };
}

export function dateChunks(start: string, end: string, maxDays: number): [string, string][] {
  const out: [string, string][] = [];
  const day = 86_400_000;
  let from = Date.parse(start + "T00:00:00Z");
  const last = Date.parse(end + "T00:00:00Z");
  while (from <= last) {
    const to = Math.min(from + (maxDays - 1) * day, last);
    out.push([iso(from), iso(to)]);
    from = to + day;
  }
  return out;
}

function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function ok(res: Response, what: string): Promise<unknown> {
  const text = await res.text();
  if (!res.ok) {
    const debugId = res.headers.get("paypal-debug-id") ?? "";
    throw new Error(`PayPal ${what} failed: ${res.status} ${debugId} ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}
