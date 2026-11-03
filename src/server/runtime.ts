// One desk per server process. PAYPAL_MODE picks the data source:
//   mock    — the built-in demo world, no PayPal account needed (default; what judges get)
//   sandbox — the merchant's real PayPal sandbox account via REST
// Kept on globalThis so dev hot reloads don't wipe verification state and cases.

import { createDesk, type Desk } from "../desk.ts";
import { ALTERNATIVES, CAPTURE_TO_ORDER, DEMO_TODAY, MERCHANT, ORDERS, RATES, SUBSCRIPTIONS, TXS } from "../demo/world.ts";
import { memoryStore } from "../core/verify.ts";
import { mockPaypal } from "../paypal/mock.ts";
import { paypalRest } from "../paypal/rest.ts";
import type { MerchantPaypal } from "../paypal/port.ts";

export type Mode = "mock" | "sandbox";

export interface Runtime {
  mode: Mode;
  desk: Desk;
  /** Demo inbox: codes "sent" by email, shown on screen so anyone can try the flow. */
  inbox: Map<string, { code: string; at: number }>;
  startedAt: number;
}

const g = globalThis as unknown as { __chargeDesk?: Runtime };

export function runtime(): Runtime {
  g.__chargeDesk ??= build();
  return g.__chargeDesk;
}

/** Fresh state for a clean demo or recording take. */
export function resetRuntime(): Runtime {
  g.__chargeDesk = build();
  return g.__chargeDesk;
}

function build(): Runtime {
  const mode: Mode = process.env.PAYPAL_MODE === "sandbox" ? "sandbox" : "mock";
  const inbox: Runtime["inbox"] = new Map();
  const paypal: MerchantPaypal =
    mode === "sandbox"
      ? paypalRest({
          clientId: required("PAYPAL_CLIENT_ID"),
          clientSecret: required("PAYPAL_CLIENT_SECRET"),
          baseUrl: process.env.PAYPAL_BASE_URL,
        })
      : mockPaypal(TXS, ORDERS, CAPTURE_TO_ORDER, SUBSCRIPTIONS);
  const desk = createDesk(
    paypal,
    {
      merchant: MERCHANT,
      rates: RATES,
      disputeFee: { currency: "USD", value: 15 },
      alternatives: ALTERNATIVES,
      lookbackDays: 120,
      today: () => (mode === "mock" ? DEMO_TODAY : new Date().toISOString().slice(0, 10)),
    },
    {
      store: memoryStore(),
      // No mail server in the demo: the code lands in an on-screen inbox for that address.
      send: (email, code) => void inbox.set(email, { code, at: Date.now() }),
    },
  );
  return { mode, desk, inbox, startedAt: Date.now() };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required when PAYPAL_MODE=sandbox`);
  return v;
}
