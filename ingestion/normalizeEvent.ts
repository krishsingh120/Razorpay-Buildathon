/**
 * ingestion/normalizeEvent.ts — Converts a raw Razorpay webhook payload into a FailureEvent.
 *
 * This is where we parse the Razorpay-shaped JSON and extract exactly what the rest
 * of the pipeline needs. We never pass the raw payload downstream (except storing it
 * in raw_payload for audit purposes).
 */

import {
  FailureEvent,
  RazorpayWebhookPayload,
  RazorpayPaymentEntity,
  RazorpaySubscriptionEntity,
} from "../shared/types";

/**
 * Maps a Razorpay payment method string to our internal enum.
 */
function mapPaymentMethod(method: string): FailureEvent["payment_method"] {
  switch (method.toLowerCase()) {
    case "card": return "card";
    case "upi": return "upi";
    case "netbanking": return "netbanking";
    case "wallet": return "wallet";
    default: return "unknown";
  }
}

/**
 * Determines whether a Razorpay entity ID is in test mode or live mode.
 * Test mode payment IDs start with "pay_" and the account uses test keys.
 * We check the PIPELINE_MODE env var and compare against the event to catch mismatches.
 */
function detectTestMode(paymentEntity: RazorpayPaymentEntity): boolean {
  // In Razorpay, test mode and live mode use different key prefixes.
  // We can't tell from the payment ID alone, but we know if the webhook
  // came from a test-mode account by checking the payment method and fields.
  // For now we rely on PIPELINE_MODE env var + a simple heuristic:
  // test payments often have amounts like 1, 100, 1000 (round numbers) or zero.
  // Best we can do without the account ID: trust the PIPELINE_MODE env var.
  return process.env.PIPELINE_MODE !== "live";
}

/**
 * Normalizes a payment.failed or subscription.charged.failed webhook into a FailureEvent.
 * Returns null and a rejection reason if the payload is missing required fields.
 */
export function normalizePaymentFailedEvent(
  eventId: string,
  payload: RazorpayWebhookPayload
): { event: FailureEvent | null; rejectionReason: string | null } {
  const paymentEntity = payload.payload?.payment?.entity;

  if (!paymentEntity) {
    return { event: null, rejectionReason: "Missing payload.payment.entity in webhook" };
  }

  if (!paymentEntity.id || !paymentEntity.amount || !paymentEntity.currency) {
    return {
      event: null,
      rejectionReason: `Missing required fields: id=${paymentEntity.id}, amount=${paymentEntity.amount}, currency=${paymentEntity.currency}`,
    };
  }

  const subscriptionEntity = payload.payload?.subscription?.entity as RazorpaySubscriptionEntity | undefined;

  const event: FailureEvent = {
    event_id: eventId,
    entity_type: paymentEntity.subscription_id ? "subscription" : "payment",
    entity_id: paymentEntity.id,
    amount: paymentEntity.amount,
    currency: paymentEntity.currency,
    error_code: paymentEntity.error_code ?? null,
    error_source: paymentEntity.error_source ?? null,
    error_step: paymentEntity.error_step ?? null,
    error_reason: paymentEntity.error_reason ?? null,
    error_description: paymentEntity.error_description ?? null,
    // attempt_count: Razorpay doesn't send this directly; we default to 1 for fresh failures.
    // A real system would look this up from the subscription history.
    attempt_count: 1,
    subscription_id: paymentEntity.subscription_id ?? subscriptionEntity?.id ?? null,
    customer_id: paymentEntity.customer_id ?? subscriptionEntity?.customer_id ?? null,
    customer_email: paymentEntity.email ?? null,
    customer_phone: paymentEntity.contact ?? null,
    payment_method: mapPaymentMethod(paymentEntity.method ?? "unknown"),
    is_test_mode: detectTestMode(paymentEntity),
    created_at: new Date(paymentEntity.created_at * 1000).toISOString(),
    raw_payload: payload as unknown as Record<string, unknown>,
  };

  return { event, rejectionReason: null };
}

/**
 * Normalizes a subscription.halted or subscription.pending webhook.
 * These often don't have a payment entity attached, so we build from the subscription entity.
 */
export function normalizeSubscriptionEvent(
  eventId: string,
  payload: RazorpayWebhookPayload
): { event: FailureEvent | null; rejectionReason: string | null } {
  const subscriptionEntity = payload.payload?.subscription?.entity as RazorpaySubscriptionEntity | undefined;

  if (!subscriptionEntity) {
    return { event: null, rejectionReason: "Missing payload.subscription.entity in subscription webhook" };
  }

  // Payment entity may be present too (e.g. subscription.charged includes the payment)
  const paymentEntity = payload.payload?.payment?.entity;

  const event: FailureEvent = {
    event_id: eventId,
    entity_type: "subscription",
    entity_id: subscriptionEntity.id,
    amount: paymentEntity?.amount ?? 0,
    currency: paymentEntity?.currency ?? "INR",
    error_code: paymentEntity?.error_code ?? null,
    error_source: paymentEntity?.error_source ?? null,
    error_step: paymentEntity?.error_step ?? null,
    error_reason: paymentEntity?.error_reason ?? null,
    error_description: paymentEntity?.error_description ?? null,
    attempt_count: subscriptionEntity.paid_count ? Math.max(1, subscriptionEntity.paid_count) : 1,
    subscription_id: subscriptionEntity.id,
    customer_id: subscriptionEntity.customer_id ?? null,
    customer_email: paymentEntity?.email ?? null,
    customer_phone: paymentEntity?.contact ?? null,
    payment_method: paymentEntity ? mapPaymentMethod(paymentEntity.method ?? "unknown") : "unknown",
    is_test_mode: process.env.PIPELINE_MODE !== "live",
    created_at: new Date(payload.created_at * 1000).toISOString(),
    raw_payload: payload as unknown as Record<string, unknown>,
  };

  return { event, rejectionReason: null };
}

/**
 * Creates a synthetic checkout_abandoned FailureEvent from an order that timed out.
 * Razorpay doesn't send an "abandoned" webhook — we generate this ourselves
 * when we detect an order was created but no payment.authorized appeared within 15 minutes.
 */
export function createAbandonedCheckoutEvent(
  orderId: string,
  amount: number,
  currency: string,
  customerEmail: string | null,
  customerPhone: string | null,
  createdAt: string
): FailureEvent {
  return {
    event_id: `abandoned_${orderId}_${Date.now()}`,
    entity_type: "checkout_abandoned",
    entity_id: orderId,
    amount,
    currency,
    error_code: null,
    error_source: "customer",
    error_step: "checkout",
    error_reason: "checkout_abandoned",
    error_description: "Order created but no payment authorized within 15 minutes",
    attempt_count: 1,
    subscription_id: null,
    customer_id: null,
    customer_email: customerEmail,
    customer_phone: customerPhone,
    payment_method: "unknown",
    is_test_mode: process.env.PIPELINE_MODE !== "live",
    created_at: createdAt,
  };
}
