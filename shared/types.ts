/**
 * shared/types.ts — Single source of truth for all data shapes used across the system.
 *
 * Ingestion, policy engine, executor, and audit all import from here.
 * Changing a type here affects all services — helps keep them in sync.
 */

// The normalized internal representation of any payment failure event.
// Produced by the ingestion layer after parsing a raw Razorpay webhook payload.
export interface FailureEvent {
  event_id: string;            // from x-razorpay-event-id header or generated for synthetic events
  entity_type: "payment" | "subscription" | "order" | "checkout_abandoned";
  entity_id: string;           // Razorpay payment ID, subscription ID, or order ID
  amount: number;              // in smallest currency unit — paise for INR (₹1 = 100 paise)
  currency: string;            // e.g. "INR"
  error_code: string | null;   // e.g. "BAD_REQUEST_ERROR", "GATEWAY_ERROR"
  error_source: string | null; // e.g. "bank", "customer", "business", "network"
  error_step: string | null;   // e.g. "payment_authentication", "payment_authorization"
  error_reason: string | null; // e.g. "payment_failed", "card_declined"
  error_description: string | null; // human-readable description from Razorpay
  attempt_count: number;       // how many times this payment has been attempted (including this one)
  subscription_id: string | null;
  customer_id: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  payment_method: "card" | "upi" | "netbanking" | "wallet" | "unknown";
  is_test_mode: boolean;       // true = test mode IDs (rzp_test_*), false = live mode
  created_at: string;          // ISO 8601 timestamp of when the failure occurred
  raw_payload?: Record<string, unknown>; // original webhook body — kept for audit, never sent to LLM
}

// The diagnosis returned by the Python FastAPI diagnosis service after LLM classification.
export interface DiagnosisResult {
  event_id: string;
  category: DiagnosisCategory;
  confidence: number;  // 0.0 to 1.0 — how confident the LLM is in this classification
  evidence: string;    // short plain-English summary of which fields led to this category
}

// All allowed diagnosis categories — the LLM must output exactly one of these strings.
// If it outputs anything else, the diagnosis service defaults to unknown_low_confidence.
export type DiagnosisCategory =
  | "insufficient_funds"
  | "card_expired_or_invalid"
  | "authentication_failed"
  | "bank_or_network_timeout"
  | "risk_hold"
  | "mandate_cancelled_or_paused"
  | "checkout_abandoned"
  | "unknown_low_confidence";

// All allowed recovery actions — the policy engine returns exactly one per event.
export type PolicyAction =
  | "RETRY_SCHEDULED"          // Schedule a retry after a delay
  | "RETRY_ALTERNATE_METHOD"   // Ask customer to use a different payment method
  | "NOTIFY_CUSTOMER"          // Send SMS/email to customer
  | "ESCALATE_HUMAN"           // Flag for manual ops review
  | "NO_ACTION";               // Not worth recovering (economic floor or max retries hit)

// What the policy engine returns after evaluating a failure event + its diagnosis.
export interface PolicyDecision {
  event_id: string;
  action: PolicyAction;
  reason: string;               // plain-English explanation logged in the audit trail
  retry_after_minutes?: number; // set only when action = RETRY_SCHEDULED
  metadata: {
    diagnosis_category: DiagnosisCategory;
    confidence: number;
    attempt_count: number;
    amount: number;
  };
}

// One row in the audit_records table — written per event processed.
export interface AuditRecord {
  event_id: string;
  diagnosis_category: DiagnosisCategory;
  confidence: number;
  evidence: string;
  policy_decision: PolicyAction;
  policy_reason: string;
  action_taken: string;                  // matches PolicyAction or "PENDING" / "FAILED"
  execution_status: "PENDING" | "SUCCESS" | "FAILED" | "SKIPPED" | "DUPLICATE_PREVENTED";
  amount: number;                        // in paise
  currency: string;
  recovered_flag: boolean;               // true if execution_status = SUCCESS
  recovered_amount: number;              // equals amount if recovered, else 0
  timestamp: string;                     // ISO 8601 when this record was written
  idempotency_key: string;               // event_id used as idempotency key
  is_duplicate_prevented: boolean;       // true if this was a duplicate that was blocked
  error_detail?: string;                 // set when execution_status = FAILED
}

// Razorpay webhook payload shape (what the ingestion layer receives)
// Based on Razorpay's documented webhook format:
// https://razorpay.com/docs/webhooks/payloads/payments/
export interface RazorpayWebhookPayload {
  entity: string;             // always "event"
  account_id: string;
  event: string;              // e.g. "payment.failed", "subscription.charged"
  contains: string[];         // e.g. ["payment"] or ["subscription", "payment"]
  payload: {
    payment?: {
      entity: RazorpayPaymentEntity;
    };
    subscription?: {
      entity: RazorpaySubscriptionEntity;
    };
    order?: {
      entity: Record<string, unknown>;
    };
  };
  created_at: number;         // Unix timestamp
}

// The payment entity within a Razorpay webhook payload
export interface RazorpayPaymentEntity {
  id: string;                 // e.g. "pay_XXXXXXXXXXXXXXXX"
  entity: string;             // always "payment"
  amount: number;             // in paise
  currency: string;
  status: string;             // e.g. "failed", "authorized", "captured"
  order_id: string | null;
  invoice_id: string | null;
  subscription_id: string | null;
  international: boolean;
  method: string;             // "card", "upi", "netbanking", "wallet"
  amount_refunded: number;
  captured: boolean;
  description: string | null;
  card_id: string | null;
  bank: string | null;
  wallet: string | null;
  vpa: string | null;         // UPI VPA
  email: string;
  contact: string;
  customer_id: string | null;
  token_id: string | null;
  notes: Record<string, string>;
  error_code: string | null;
  error_description: string | null;
  error_source: string | null;
  error_step: string | null;
  error_reason: string | null;
  created_at: number;         // Unix timestamp
}

// Minimal subscription entity shape
export interface RazorpaySubscriptionEntity {
  id: string;                 // e.g. "sub_XXXXXXXXXXXXXXXX"
  entity: string;             // always "subscription"
  plan_id: string;
  status: string;             // "active", "halted", "pending", "cancelled"
  current_start: number | null;
  current_end: number | null;
  charge_at: number | null;
  customer_id: string | null;
  total_count: number;
  paid_count: number;
  remaining_count: number;
}
