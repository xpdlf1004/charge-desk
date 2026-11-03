// Normalized shapes the core logic works on. The PayPal adapter maps API payloads into these.
// Everything runs on the MERCHANT's PayPal account: the merchant sees its own sales.

export interface Money {
  currency: string; // ISO 4217, e.g. "USD", "KRW"
  value: number;
}

/** One line from a card / bank statement, when the customer pastes it as-is. */
export interface StatementLine {
  raw: string;
  descriptor: string; // text after the "PAYPAL *" prefix, as printed (already truncated)
  date: string; // YYYY-MM-DD (posting date on the statement)
  amount: Money;
}

/** What the customer told us about the charge. Any field may be missing. */
export interface ChargeQuery {
  descriptor?: string; // e.g. "BRIGHTLEAF ST" or "PAYPAL *BRIGHTLEAFST"
  amount?: Money; // as shown on the card statement (often in the card's currency)
  date?: string; // YYYY-MM-DD statement date, if known
}

/** A sale on the merchant's PayPal account (Transaction Search, fields=all). */
export interface PaypalTx {
  id: string; // transaction id (= capture id for Orders v2 captures)
  date: string; // YYYY-MM-DD (initiation date)
  eventCode: string; // e.g. T0006 checkout, T0002 subscription payment, T1107 refund
  amount: Money; // positive = money into the merchant account
  status: string; // S = success, P = pending, V = reversed ...
  payerId: string; // payer's PayPal account id
  payerEmail?: string;
  referenceId?: string; // e.g. subscription id when referenceType is SUB
  referenceType?: string; // SUB, PAP, TXN, ODR ...
  orderId?: string; // filled from the capture's related order id
  items?: { name: string; quantity: number }[];
  customField?: string; // merchant's own key (custom_id), e.g. the store's customer email for guest card checkouts
  invoiceId?: string;
}

/** The merchant itself: how it shows up on statements. */
export interface MerchantProfile {
  displayName: string;
  descriptorPrefix: string; // merchant-level descriptor set on the PayPal account
  softDescriptors: string[]; // per-order soft descriptors the merchant uses
  website?: string;
}

/** Subscription details (Subscriptions v1 GET + its plan). */
export interface SubscriptionInfo {
  id: string;
  planName: string;
  status: string; // ACTIVE, CANCELLED ...
  trialCyclesCompleted: number;
  regularCyclesCompleted: number;
}

/** Merchant order details (Orders v2 GET). */
export interface OrderInfo {
  orderId: string;
  softDescriptor?: string;
  items: { name: string; quantity: number; unitAmount?: Money }[];
}
