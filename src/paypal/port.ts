// What the desk needs from PayPal, all with the merchant's own credentials.
// `rest.ts` implements it against the PayPal REST API; `mock.ts` is the offline demo world.

import type { Money, OrderInfo, PaypalTx, SubscriptionInfo } from "../core/types.ts";

export interface MerchantPaypal {
  /** Sales on the merchant account between two dates (YYYY-MM-DD, inclusive). */
  searchTransactions(start: string, end: string): Promise<PaypalTx[]>;
  /** Order id a capture belongs to (split shipments = several captures of one order). */
  orderIdOfCapture(captureId: string): Promise<string | undefined>;
  getOrder(orderId: string): Promise<OrderInfo | undefined>;
  /** Plan name and billing progress, so a subscription charge can be named ("Monthly membership"). */
  getSubscription(subscriptionId: string): Promise<SubscriptionInfo | undefined>;
  refundCapture(captureId: string, amount: Money, requestId: string): Promise<{ refundId: string; status: string }>;
  cancelSubscription(subscriptionId: string, reason: string): Promise<void>;
}
