# Charge Desk

**Every charge, explained before it's disputed.**

A customer sees `PAYPAL * Brightleaf St  ₩13,900` on their card statement and doesn't remember it. The card app offers one button: *Dispute*. For the merchant, that tap means a lost sale, a dispute fee and a worse dispute rate, even when the charge was legitimate (for example, a free trial that just turned into the first paid month).

Charge Desk is an AI agent a PayPal merchant puts on its own site and receipt emails. The customer asks about the charge in their own words. After proving the email they paid with, they get the answer with evidence pulled from the merchant's PayPal records. If they still want a refund or cancellation, the request goes to the merchant, who approves it with one click. The AI explains; people decide on money.

## Try it

| Step | Where | What to do |
| --- | --- | --- |
| 1 | `/receipt` | The receipt email. Click **Questions about this charge?** |
| 2 | `/help` | Pick "I was charged ₩13,900 and I don't know why". When asked, verify `mina@example.com`. The code appears in the on-screen demo inbox. |
| 3 | `/help` | Ask to cancel. The agent offers the studio's alternatives first, then sends the request. |
| 4 | `/merchant` | Approve the cancellation. The page shows the subscription status PayPal returns. |

Other things to try: "What is PAYPAL *QUICKWINPRIZE?" (not this merchant, answered without asking for an email), and "Two charges, ₩89,280 and ₩50,220?" (one order paid in two parts).

Demo customers: `mina@example.com`, `jordan@example.com`, `sam@example.com`. Any other email gets the same reply but no code, so nobody can test whether a person bought here.

## How it works

```
customer words ──► Claude (tool use) ──► desk tools ──► merchant's PayPal data
                         │                   │
                         │                   ├─ check_descriptor   is this statement name ours? (no login needed)
                         │                   ├─ request_verification  email one-time code
                         │                   ├─ find_charge        match amount / date / name to the customer's own payments
                         │                   └─ request_change     queue a refund or cancellation for the merchant
                         ▼
               answer + evidence cards            merchant dashboard: approve ─► PayPal refund / subscription cancel
```

- **Matching** (`src/core/match.ts`): rebuilds the 22-character statement text PayPal prints, converts the customer's card currency (±4% for card FX fees), groups split captures by order, and spots subscriptions (PayPal's `SUB` reference, or a regular interval).
- **Privacy** (`src/core/verify.ts`, `src/desk.ts`): nothing about a payment is shown before the email is verified; searches only cover that customer's own payments; the verification token stays on the server, never in the model's hands.
- **Money** (`src/core/cases.ts`): the agent cannot refund or cancel. It writes a request; the merchant approves it and only then does the app call PayPal (refunds are idempotent with `PayPal-Request-Id`).

PayPal APIs used with the merchant's credentials: Transaction Search (`/v1/reporting/transactions`), Captures and Orders (`/v2/payments/captures`, `/v2/checkout/orders`), Subscriptions and Plans (`/v1/billing/...`), Refunds.

## Run locally

Node 22.6 or newer.

```bash
npm install
cp .env.example .env.local   # add ANTHROPIC_API_KEY
npm run dev                  # http://localhost:3000
npm test                     # core logic tests, no keys needed
```

`PAYPAL_MODE=mock` (default) uses a built-in demo store, so no PayPal account is needed. `PAYPAL_MODE=sandbox` reads a real PayPal sandbox merchant account (add `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`, with Transaction Search enabled on the app).

## License

MIT
