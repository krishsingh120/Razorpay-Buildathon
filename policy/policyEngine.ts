/**
 * Policy Engine — deterministic rule-based decision maker.
 *
 * This is the safety-critical core of the system. It takes a failure event and its
 * LLM diagnosis and returns exactly ONE recovery action. All hard rules are enforced
 * here in plain if/else logic — NO LLM calls, no randomness, no external dependencies.
 *
 * Design principle: even if the LLM is wrong about the diagnosis, the hard rules here
 * bound the blast radius (e.g. max retries enforced here regardless of what LLM said).
 */

import { DiagnosisCategory, DiagnosisResult, FailureEvent, PolicyAction, PolicyDecision } from "../shared/types";

// Economic floor: payments below this amount (in paise) are not worth recovering.
// ₹100 = 10000 paise. Spending on SMS or ops time is not justified below this.
const ECONOMIC_FLOOR_PAISE = 10000;

// Max retries for card-based subscriptions: T+1, T+2, T+3 days (NPCI-style rule)
const MAX_CARD_RETRIES = 3;

// Max retries for UPI Autopay: 1 original + 3 retries (NPCI mandate requirement)
const MAX_UPI_RETRIES = 3;

// Peak hours for UPI (10am–10pm IST, in 24h). Retries must be scheduled outside this range.
const UPI_PEAK_HOUR_START = 10;
const UPI_PEAK_HOUR_END = 22;

// Minimum LLM confidence below which we always escalate to human review
const MIN_CONFIDENCE_FOR_AUTO_ACTION = 0.6;

/**
 * Calculates how many minutes to delay before the next retry.
 * Card retries: spaced 24h apart (T+1, T+2, T+3 days).
 * UPI retries: scheduled for next off-peak window.
 *
 * attempt_count is how many times we've tried so far (including the current failure).
 */
function getRetryDelayMinutes(paymentMethod: FailureEvent["payment_method"], attemptCount: number): number {
  if (paymentMethod === "upi") {
    // For UPI, schedule for next off-peak window (after 10pm = 22:00)
    // We just return a fixed "next off-peak" window: 12 hours from now as a safe proxy
    return 12 * 60; // 12 hours in minutes — will land in the 10pm–10am window
  }

  // For cards: T+1, T+2, T+3 days based on attempt number
  const daysDelay = attemptCount; // attempt 1 → delay 1 day, attempt 2 → delay 2 days, etc.
  return daysDelay * 24 * 60;
}

/**
 * Checks whether the payment method + attempt count would violate retry caps.
 * Returns true if we are still within the allowed retry budget.
 */
function isWithinRetryBudget(method: FailureEvent["payment_method"], attemptCount: number): boolean {
  if (method === "upi") {
    // NPCI allows 1 original + 3 retries, so if we've already tried 4 times we're done
    return attemptCount < MAX_UPI_RETRIES + 1;
  }

  // Card subscriptions: max 3 retries total
  return attemptCount < MAX_CARD_RETRIES;
}

/**
 * Decides the exact recovery action for a given failure + diagnosis.
 *
 * This function applies all hard rules in a fixed priority order:
 * 1. Economic floor (amount too small → NO_ACTION)
 * 2. Risk hold (suspected fraud → always ESCALATE)
 * 3. Low LLM confidence (→ always ESCALATE)
 * 4. Category-specific rules (card expired, mandate cancelled, etc.)
 * 5. Retry budget enforcement (max retries reached → NOTIFY_CUSTOMER or NO_ACTION)
 * 6. Default path: schedule retry or notify
 */
export function decideAction(event: FailureEvent, diagnosis: DiagnosisResult): PolicyDecision {
  const { amount, payment_method, attempt_count } = event;
  const { category, confidence } = diagnosis;

  // ── RULE 1: Economic floor ─────────────────────────────────────────────────
  // If the payment amount is below ₹100, recovery cost exceeds the value.
  // We log this explicitly — it must NOT be silently dropped.
  if (amount < ECONOMIC_FLOOR_PAISE) {
    return makeDecision(event, diagnosis, "NO_ACTION",
      `Amount ₹${(amount / 100).toFixed(2)} is below the ₹100 economic floor — not worth recovering`);
  }

  // ── RULE 2: Risk hold — ALWAYS escalate, never retry ─────────────────────
  // A fraud-flagged payment must go to human review. No exceptions.
  if (category === "risk_hold") {
    return makeDecision(event, diagnosis, "ESCALATE_HUMAN",
      "Diagnosis is risk_hold (suspected fraud) — hard rule: always escalate, never auto-retry");
  }

  // ── RULE 3: Low LLM confidence — ALWAYS escalate ─────────────────────────
  // If the LLM is not confident enough, do not guess. Human reviews are cheaper than mistakes.
  if (confidence < MIN_CONFIDENCE_FOR_AUTO_ACTION) {
    return makeDecision(event, diagnosis, "ESCALATE_HUMAN",
      `LLM confidence ${confidence.toFixed(2)} is below threshold ${MIN_CONFIDENCE_FOR_AUTO_ACTION} — escalating to human review`);
  }

  // ── RULE 4a: Card expired or invalid — never retry, notify instead ─────────
  // Retrying an expired card will always fail. Send the customer a card update request.
  if (category === "card_expired_or_invalid") {
    return makeDecision(event, diagnosis, "NOTIFY_CUSTOMER",
      "Card is expired or invalid — retrying is pointless, notifying customer to update payment info");
  }

  // ── RULE 4b: Mandate cancelled/paused (UPI Autopay) ───────────────────────
  // If the UPI mandate is cancelled, auto-retry won't help. Customer must re-authorize.
  if (category === "mandate_cancelled_or_paused") {
    return makeDecision(event, diagnosis, "NOTIFY_CUSTOMER",
      "UPI mandate is cancelled or paused — customer must re-authorize the autopay mandate");
  }

  // ── RULE 4c: Checkout abandoned ───────────────────────────────────────────
  // Customer left without paying. Send a recovery nudge (email/SMS with payment link).
  if (category === "checkout_abandoned") {
    return makeDecision(event, diagnosis, "NOTIFY_CUSTOMER",
      "Checkout was abandoned — sending recovery email/SMS with payment link");
  }

  // ── RULE 5: Retry budget enforcement ──────────────────────────────────────
  // Check if we've exhausted the allowed number of retries before scheduling more.
  if (!isWithinRetryBudget(payment_method, attempt_count)) {
    // Card subscriptions: on 3rd failure, move to NOTIFY_CUSTOMER (never retry again)
    if (payment_method === "card" || payment_method === "netbanking") {
      return makeDecision(event, diagnosis, "NOTIFY_CUSTOMER",
        `Card subscription has reached max ${MAX_CARD_RETRIES} retries — notifying customer to update payment info`);
    }

    // UPI: NPCI 1+3 cap exceeded
    if (payment_method === "upi") {
      return makeDecision(event, diagnosis, "NO_ACTION",
        `UPI Autopay has reached NPCI max of ${MAX_UPI_RETRIES + 1} attempts — no further auto-retries allowed`);
    }

    // Other methods: treat conservatively
    return makeDecision(event, diagnosis, "NOTIFY_CUSTOMER",
      "Max retry attempts reached — notifying customer");
  }

  // ── RULE 6: Category-driven scheduling ────────────────────────────────────
  // Categories that suggest a transient error (timeout, auth failure) → schedule retry
  // Categories that suggest the customer must act → notify them

  if (category === "bank_or_network_timeout") {
    const delayMinutes = getRetryDelayMinutes(payment_method, attempt_count);
    return makeDecisionWithDelay(event, diagnosis, "RETRY_SCHEDULED",
      `Bank/network timeout — scheduling retry in ${delayMinutes} minutes`, delayMinutes);
  }

  if (category === "authentication_failed") {
    // Authentication failure may be OTP mis-entry (one-time issue) → retry once more,
    // but if it keeps failing the retry cap above will catch it
    const delayMinutes = getRetryDelayMinutes(payment_method, attempt_count);
    return makeDecisionWithDelay(event, diagnosis, "RETRY_SCHEDULED",
      `Authentication failed (wrong OTP/3DS) — scheduling retry in ${delayMinutes} minutes`, delayMinutes);
  }

  if (category === "insufficient_funds") {
    // Insufficient funds → customer needs to add money. Notify them, don't retry immediately.
    // A delayed retry (hoping funds arrive) is also valid but NOTIFY is more user-friendly.
    return makeDecision(event, diagnosis, "NOTIFY_CUSTOMER",
      "Insufficient funds — notifying customer to add funds or use an alternate payment method");
  }

  if (category === "unknown_low_confidence") {
    // Should have been caught by Rule 3 if confidence < 0.6, but handle here as safety net
    return makeDecision(event, diagnosis, "ESCALATE_HUMAN",
      "Category is unknown_low_confidence — escalating to human for manual diagnosis");
  }

  // ── DEFAULT: unknown category ─────────────────────────────────────────────
  // Should never reach here if the LLM respects the category enum, but be safe
  return makeDecision(event, diagnosis, "ESCALATE_HUMAN",
    `Unrecognized diagnosis category '${category}' — escalating to human review`);
}

/**
 * Helper to build a PolicyDecision object without a retry delay.
 */
function makeDecision(
  event: FailureEvent,
  diagnosis: DiagnosisResult,
  action: PolicyAction,
  reason: string
): PolicyDecision {
  return {
    event_id: event.event_id,
    action,
    reason,
    metadata: {
      diagnosis_category: diagnosis.category,
      confidence: diagnosis.confidence,
      attempt_count: event.attempt_count,
      amount: event.amount,
    },
  };
}

/**
 * Helper to build a PolicyDecision with a retry delay (for RETRY_SCHEDULED actions).
 */
function makeDecisionWithDelay(
  event: FailureEvent,
  diagnosis: DiagnosisResult,
  action: PolicyAction,
  reason: string,
  retryAfterMinutes: number
): PolicyDecision {
  return {
    event_id: event.event_id,
    action,
    reason,
    retry_after_minutes: retryAfterMinutes,
    metadata: {
      diagnosis_category: diagnosis.category,
      confidence: diagnosis.confidence,
      attempt_count: event.attempt_count,
      amount: event.amount,
    },
  };
}
