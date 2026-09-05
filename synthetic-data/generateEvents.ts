/**
 * synthetic-data/generateEvents.ts — Generates 60+ realistic fake Razorpay webhook events.
 *
 * Each event follows Razorpay's actual webhook payload shape.
 * The distribution matches the spec:
 *   ~35% insufficient_funds
 *   ~20% bank_or_network_timeout
 *   ~15% card_expired_or_invalid
 *   ~10% authentication_failed
 *   ~10% risk_hold
 *   ~10% ambiguous/mixed (to test unknown_low_confidence)
 *   + A handful of checkout_abandoned and mandate_cancelled events
 *
 * IMPORTANT: These are test-mode events only — all IDs use test prefixes.
 */

import { v4 as uuidv4 } from "uuid";
import { RazorpayWebhookPayload } from "../shared/types";

// ── Error code templates for each failure category ────────────────────────────

const INSUFFICIENT_FUNDS_ERRORS = [
  { error_code: "BAD_REQUEST_ERROR", error_source: "bank", error_step: "payment_authorization", error_reason: "payment_failed", error_description: "Your payment failed due to insufficient funds in your account." },
  { error_code: "BAD_REQUEST_ERROR", error_source: "bank", error_step: "payment_authorization", error_reason: "low_balance", error_description: "Insufficient balance in your account to complete this payment." },
  { error_code: "GATEWAY_ERROR", error_source: "bank", error_step: "payment_authorization", error_reason: "insufficient_funds", error_description: "Transaction declined: insufficient funds." },
];

const BANK_TIMEOUT_ERRORS = [
  { error_code: "GATEWAY_ERROR", error_source: "network", error_step: "payment_authorization", error_reason: "payment_failed", error_description: "The bank did not respond in time. Please try again." },
  { error_code: "SERVER_ERROR", error_source: "gateway", error_step: "payment_authorization", error_reason: "payment_failed", error_description: "A server error occurred. Please try again after some time." },
  { error_code: "GATEWAY_ERROR", error_source: "network", error_step: "payment_authentication", error_reason: "connection_error", error_description: "Network error while connecting to the bank." },
];

const CARD_EXPIRED_ERRORS = [
  { error_code: "BAD_REQUEST_ERROR", error_source: "customer", error_step: "payment_authorization", error_reason: "invalid_card", error_description: "Your card is expired. Please use a different card." },
  { error_code: "BAD_REQUEST_ERROR", error_source: "customer", error_step: "payment_authorization", error_reason: "card_expired", error_description: "Your card has expired. Please update your card details." },
  { error_code: "BAD_REQUEST_ERROR", error_source: "bank", error_step: "payment_authorization", error_reason: "invalid_card_details", error_description: "Card details are invalid or card is blocked." },
];

const AUTH_FAILED_ERRORS = [
  { error_code: "BAD_REQUEST_ERROR", error_source: "customer", error_step: "payment_authentication", error_reason: "payment_failed", error_description: "OTP entered was incorrect. Payment authentication failed." },
  { error_code: "BAD_REQUEST_ERROR", error_source: "customer", error_step: "payment_authentication", error_reason: "authentication_failed", error_description: "3D Secure authentication failed. Please try again." },
  { error_code: "GATEWAY_ERROR", error_source: "bank", error_step: "payment_authentication", error_reason: "payment_failed", error_description: "Bank declined authentication. OTP may have expired." },
];

const RISK_HOLD_ERRORS = [
  { error_code: "BAD_REQUEST_ERROR", error_source: "business", error_step: "payment_authorization", error_reason: "payment_failed", error_description: "Your payment has been declined due to suspected fraudulent activity." },
  { error_code: "GATEWAY_ERROR", error_source: "issuer", error_step: "payment_authorization", error_reason: "suspected_fraud", error_description: "Transaction blocked due to fraud risk. Please contact your bank." },
];

// Ambiguous errors that should result in unknown_low_confidence
const AMBIGUOUS_ERRORS = [
  { error_code: "GATEWAY_ERROR", error_source: null, error_step: null, error_reason: "payment_failed", error_description: "Payment failed." },
  { error_code: "SERVER_ERROR", error_source: "gateway", error_step: null, error_reason: null, error_description: "An error occurred." },
  { error_code: "BAD_REQUEST_ERROR", error_source: "bank", error_step: "payment_authorization", error_reason: "unknown", error_description: "Unknown bank error." },
];

const MANDATE_ERRORS = [
  { error_code: "BAD_REQUEST_ERROR", error_source: "customer", error_step: "payment_authorization", error_reason: "mandate_cancelled", error_description: "UPI Autopay mandate has been cancelled by the customer." },
  { error_code: "GATEWAY_ERROR", error_source: "bank", error_step: "payment_authorization", error_reason: "mandate_paused", error_description: "UPI Autopay mandate is currently paused." },
];

// ── Helper functions ──────────────────────────────────────────────────────────

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function randomAmount(): number {
  // Generate realistic subscription amounts in paise: ₹99 to ₹9,999
  const amounts = [9900, 19900, 29900, 49900, 99900, 199900, 499900, 999900];
  return pick(amounts);
}

function makePaymentId(): string {
  return `pay_test_${uuidv4().replace(/-/g, "").slice(0, 14)}`;
}

function makeSubscriptionId(): string {
  return `sub_test_${uuidv4().replace(/-/g, "").slice(0, 14)}`;
}

function makeCustomerId(): string {
  return `cust_test_${uuidv4().replace(/-/g, "").slice(0, 12)}`;
}

function makeEventId(): string {
  return `evt_${uuidv4().replace(/-/g, "").slice(0, 16)}`;
}

/**
 * Creates a single Razorpay webhook payload for a payment failure event.
 * The shape exactly matches Razorpay's documented webhook format.
 */
function makePaymentFailedWebhook(
  errorTemplate: { error_code: string; error_source: string | null; error_step: string | null; error_reason: string | null; error_description: string },
  method: "card" | "upi" = "card",
  attemptCount: number = 1,
  subscriptionId?: string
): { eventId: string; payload: RazorpayWebhookPayload } {
  const eventId = makeEventId();
  const paymentId = makePaymentId();
  const amount = randomAmount();
  const customerId = makeCustomerId();
  const subId = subscriptionId ?? (Math.random() > 0.3 ? makeSubscriptionId() : null);
  const createdAt = Math.floor(Date.now() / 1000) - randomInt(60, 3600);

  const payload: RazorpayWebhookPayload = {
    entity: "event",
    account_id: "acc_test_buildathon",
    event: "payment.failed",
    contains: ["payment"],
    payload: {
      payment: {
        entity: {
          id: paymentId,
          entity: "payment",
          amount,
          currency: "INR",
          status: "failed",
          order_id: `order_test_${uuidv4().replace(/-/g, "").slice(0, 14)}`,
          invoice_id: null,
          subscription_id: subId,
          international: false,
          method,
          amount_refunded: 0,
          captured: false,
          description: "Monthly subscription payment",
          card_id: method === "card" ? `card_test_${uuidv4().replace(/-/g, "").slice(0, 14)}` : null,
          bank: method === "card" ? pick(["HDFC", "ICICI", "SBI", "AXIS", "KOTAK"]) : null,
          wallet: null,
          vpa: method === "upi" ? `customer${randomInt(100, 999)}@upi` : null,
          email: `user${randomInt(1000, 9999)}@example.com`,
          contact: `+91${randomInt(7000000000, 9999999999)}`,
          customer_id: customerId,
          token_id: `token_test_${uuidv4().replace(/-/g, "").slice(0, 14)}`,
          notes: { attempt_count: String(attemptCount) },
          error_code: errorTemplate.error_code,
          error_description: errorTemplate.error_description,
          error_source: errorTemplate.error_source,
          error_step: errorTemplate.error_step,
          error_reason: errorTemplate.error_reason,
          created_at: createdAt,
        },
      },
      ...(subId ? {
        subscription: {
          entity: {
            id: subId,
            entity: "subscription",
            plan_id: `plan_test_${uuidv4().replace(/-/g, "").slice(0, 14)}`,
            status: "halted",
            current_start: createdAt - 2592000, // 30 days ago
            current_end: createdAt,
            charge_at: createdAt,
            customer_id: customerId,
            total_count: 12,
            paid_count: randomInt(1, 6),
            remaining_count: randomInt(1, 6),
          },
        },
      } : {}),
    },
    created_at: createdAt,
  };

  return { eventId, payload };
}

/**
 * Generates the full batch of 60+ synthetic failure events.
 * Returns an array of { eventId, payload } objects ready to be sent to /webhook.
 */
export function generateSyntheticBatch(): Array<{ eventId: string; payload: RazorpayWebhookPayload }> {
  const events: Array<{ eventId: string; payload: RazorpayWebhookPayload }> = [];

  // ~35% insufficient_funds (21 events)
  for (let i = 0; i < 21; i++) {
    events.push(makePaymentFailedWebhook(pick(INSUFFICIENT_FUNDS_ERRORS), "card", randomInt(1, 2)));
  }

  // ~20% bank_or_network_timeout (12 events)
  for (let i = 0; i < 12; i++) {
    events.push(makePaymentFailedWebhook(pick(BANK_TIMEOUT_ERRORS), pick(["card", "upi"]), randomInt(1, 3)));
  }

  // ~15% card_expired_or_invalid (9 events)
  for (let i = 0; i < 9; i++) {
    events.push(makePaymentFailedWebhook(pick(CARD_EXPIRED_ERRORS), "card", randomInt(1, 2)));
  }

  // ~10% authentication_failed (6 events)
  for (let i = 0; i < 6; i++) {
    events.push(makePaymentFailedWebhook(pick(AUTH_FAILED_ERRORS), pick(["card", "upi"]), randomInt(1, 2)));
  }

  // ~10% risk_hold (6 events)
  for (let i = 0; i < 6; i++) {
    events.push(makePaymentFailedWebhook(pick(RISK_HOLD_ERRORS), "card", 1));
  }

  // ~10% ambiguous/unknown (6 events)
  for (let i = 0; i < 6; i++) {
    events.push(makePaymentFailedWebhook(pick(AMBIGUOUS_ERRORS), pick(["card", "upi"]), randomInt(1, 2)));
  }

  // UPI mandate cancelled (3 events)
  for (let i = 0; i < 3; i++) {
    events.push(makePaymentFailedWebhook(pick(MANDATE_ERRORS), "upi", randomInt(1, 3)));
  }

  // Low-amount events to test economic floor (3 events — all should be NO_ACTION)
  for (let i = 0; i < 3; i++) {
    const evt = makePaymentFailedWebhook(pick(INSUFFICIENT_FUNDS_ERRORS), "card", 1);
    evt.payload.payload.payment!.entity.amount = randomInt(100, 9000); // below ₹100 floor
    events.push(evt);
  }

  // At-retry-cap card events (2 events — should trigger NOTIFY_CUSTOMER)
  for (let i = 0; i < 2; i++) {
    events.push(makePaymentFailedWebhook(pick(BANK_TIMEOUT_ERRORS), "card", 3));
  }

  // Duplicate event (same eventId as the first event — to test deduplication)
  if (events.length > 0) {
    events.push({ eventId: events[0]!.eventId, payload: events[0]!.payload });
  }

  console.log(`[generateEvents] Generated ${events.length} synthetic events (including 1 duplicate)`);
  return events;
}
