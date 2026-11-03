// In-memory PayPal for tests and the offline demo. Records every money-moving call.

import type { Money, OrderInfo, PaypalTx, SubscriptionInfo } from "../core/types.ts";
import type { MerchantPaypal } from "./port.ts";

export interface MockPaypal extends MerchantPaypal {
  refunds: { captureId: string; amount: Money; requestId: string }[];
  cancellations: { subscriptionId: string; reason: string }[];
}

export function mockPaypal(
  txs: PaypalTx[],
  orders: OrderInfo[],
  captureToOrder: Record<string, string>,
  subscriptions: SubscriptionInfo[] = [],
): MockPaypal {
  const refunds: MockPaypal["refunds"] = [];
  const cancellations: MockPaypal["cancellations"] = [];
  const seenRequests = new Map<string, string>();
  return {
    refunds,
    cancellations,
    async searchTransactions(start, end) {
      // Drop the order id: real Transaction Search doesn't return it, the desk must look it up.
      return txs.filter((t) => t.date >= start && t.date <= end).map(({ orderId: _drop, ...t }) => ({ ...t }));
    },
    async orderIdOfCapture(captureId) {
      return captureToOrder[captureId];
    },
    async getOrder(orderId) {
      return orders.find((o) => o.orderId === orderId);
    },
    async getSubscription(id) {
      const s = subscriptions.find((x) => x.id === id);
      return s && { ...s, status: cancellations.some((c) => c.subscriptionId === id) ? "CANCELLED" : s.status };
    },
    async refundCapture(captureId, amount, requestId) {
      const existing = seenRequests.get(requestId);
      if (existing) return { refundId: existing, status: "COMPLETED" };
      const refundId = `R-${refunds.length + 1}`;
      seenRequests.set(requestId, refundId);
      refunds.push({ captureId, amount, requestId });
      return { refundId, status: "COMPLETED" };
    },
    async cancelSubscription(subscriptionId, reason) {
      cancellations.push({ subscriptionId, reason });
    },
  };
}
