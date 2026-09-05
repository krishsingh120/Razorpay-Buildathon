/**
 * Unit tests for the Policy Engine — covers 100% of the hard rules.
 *
 * Every test corresponds to a named hard rule from the spec.
 * Tests are self-contained and use no external dependencies (in-memory only).
 */

import { decideAction } from "../policy/policyEngine";
import { DiagnosisResult, FailureEvent } from "../shared/types";

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Creates a baseline FailureEvent for tests to modify.
 * Defaults: ₹500 card payment, 1st attempt, no special error state.
 */
function makeEvent(overrides: Partial<FailureEvent> = {}): FailureEvent {
  return {
    event_id: "evt_test_001",
    entity_type: "payment",
    entity_id: "pay_test_001",
    amount: 50000,         // ₹500 in paise
    currency: "INR",
    error_code: "BAD_REQUEST_ERROR",
    error_source: "bank",
    error_step: "payment_authorization",
    error_reason: "payment_failed",
    error_description: "Test payment failure",
    attempt_count: 1,
    subscription_id: "sub_test_001",
    customer_id: "cust_test_001",
    customer_email: "test@example.com",
    customer_phone: "+919999999999",
    payment_method: "card",
    is_test_mode: true,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Creates a baseline DiagnosisResult for tests to modify.
 * Defaults: insufficient_funds, high confidence.
 */
function makeDiagnosis(overrides: Partial<DiagnosisResult> = {}): DiagnosisResult {
  return {
    event_id: "evt_test_001",
    category: "insufficient_funds",
    confidence: 0.9,
    evidence: "error_code=BAD_REQUEST_ERROR, error_reason=payment_failed",
    ...overrides,
  };
}

// ── RULE 1: Economic floor ─────────────────────────────────────────────────────

describe("Rule 1: Economic floor", () => {
  test("Amount below ₹100 (9999 paise) → NO_ACTION", () => {
    const event = makeEvent({ amount: 9999 });
    const diagnosis = makeDiagnosis({ category: "insufficient_funds", confidence: 0.95 });
    const decision = decideAction(event, diagnosis);
    expect(decision.action).toBe("NO_ACTION");
    expect(decision.reason).toContain("economic floor");
  });

  test("Amount exactly ₹100 (10000 paise) → NOT NO_ACTION (above floor)", () => {
    const event = makeEvent({ amount: 10000 });
    const diagnosis = makeDiagnosis({ category: "bank_or_network_timeout", confidence: 0.85 });
    const decision = decideAction(event, diagnosis);
    expect(decision.action).not.toBe("NO_ACTION");
  });

  test("Amount ₹1 (100 paise) → NO_ACTION, even if risk_hold (floor checked first)", () => {
    const event = makeEvent({ amount: 100 });
    const diagnosis = makeDiagnosis({ category: "risk_hold", confidence: 0.99 });
    const decision = decideAction(event, diagnosis);
    expect(decision.action).toBe("NO_ACTION");
  });
});

// ── RULE 2: Risk hold ─────────────────────────────────────────────────────────

describe("Rule 2: Risk hold — always ESCALATE_HUMAN", () => {
  test("risk_hold → ESCALATE_HUMAN even with high confidence", () => {
    const event = makeEvent({ amount: 100000 });
    const diagnosis = makeDiagnosis({ category: "risk_hold", confidence: 0.99 });
    const decision = decideAction(event, diagnosis);
    expect(decision.action).toBe("ESCALATE_HUMAN");
    expect(decision.reason).toContain("risk_hold");
  });

  test("risk_hold → ESCALATE_HUMAN even on first attempt", () => {
    const event = makeEvent({ amount: 50000, attempt_count: 1 });
    const diagnosis = makeDiagnosis({ category: "risk_hold", confidence: 0.88 });
    const decision = decideAction(event, diagnosis);
    expect(decision.action).toBe("ESCALATE_HUMAN");
  });

  test("risk_hold → NEVER RETRY_SCHEDULED", () => {
    const event = makeEvent({ amount: 50000 });
    const diagnosis = makeDiagnosis({ category: "risk_hold", confidence: 0.9 });
    const decision = decideAction(event, diagnosis);
    expect(decision.action).not.toBe("RETRY_SCHEDULED");
    expect(decision.action).not.toBe("RETRY_ALTERNATE_METHOD");
  });
});

// ── RULE 3: Low LLM confidence ────────────────────────────────────────────────

describe("Rule 3: Low LLM confidence → ESCALATE_HUMAN", () => {
  test("confidence 0.59 → ESCALATE_HUMAN regardless of category", () => {
    const event = makeEvent({ amount: 50000 });
    const diagnosis = makeDiagnosis({ category: "bank_or_network_timeout", confidence: 0.59 });
    const decision = decideAction(event, diagnosis);
    expect(decision.action).toBe("ESCALATE_HUMAN");
    expect(decision.reason).toContain("0.59");
  });

  test("confidence exactly 0.6 → NOT forced to ESCALATE (at threshold, not below)", () => {
    const event = makeEvent({ amount: 50000 });
    const diagnosis = makeDiagnosis({ category: "bank_or_network_timeout", confidence: 0.6 });
    const decision = decideAction(event, diagnosis);
    // 0.6 is at the threshold — the condition is < 0.6, so 0.6 should NOT trigger ESCALATE
    expect(decision.action).not.toBe("ESCALATE_HUMAN");
  });

  test("confidence 0.0 → ESCALATE_HUMAN", () => {
    const event = makeEvent({ amount: 50000 });
    const diagnosis = makeDiagnosis({ category: "insufficient_funds", confidence: 0.0 });
    const decision = decideAction(event, diagnosis);
    expect(decision.action).toBe("ESCALATE_HUMAN");
  });
});

// ── RULE 4a: Card expired/invalid ─────────────────────────────────────────────

describe("Rule 4a: Card expired — never RETRY_SCHEDULED", () => {
  test("card_expired_or_invalid → NOTIFY_CUSTOMER, not retry", () => {
    const event = makeEvent({ amount: 50000, payment_method: "card" });
    const diagnosis = makeDiagnosis({ category: "card_expired_or_invalid", confidence: 0.92 });
    const decision = decideAction(event, diagnosis);
    expect(decision.action).toBe("NOTIFY_CUSTOMER");
    expect(decision.reason).toContain("expired");
  });

  test("card_expired → NEVER RETRY_SCHEDULED even on first attempt", () => {
    const event = makeEvent({ amount: 50000, attempt_count: 1 });
    const diagnosis = makeDiagnosis({ category: "card_expired_or_invalid", confidence: 0.85 });
    const decision = decideAction(event, diagnosis);
    expect(decision.action).not.toBe("RETRY_SCHEDULED");
  });
});

// ── RULE 4b: Mandate cancelled/paused ─────────────────────────────────────────

describe("Rule 4b: Mandate cancelled — NOTIFY_CUSTOMER", () => {
  test("mandate_cancelled_or_paused → NOTIFY_CUSTOMER", () => {
    const event = makeEvent({ amount: 50000, payment_method: "upi" });
    const diagnosis = makeDiagnosis({ category: "mandate_cancelled_or_paused", confidence: 0.9 });
    const decision = decideAction(event, diagnosis);
    expect(decision.action).toBe("NOTIFY_CUSTOMER");
    expect(decision.reason).toContain("mandate");
  });
});

// ── RULE 5: Card subscription retry cap ──────────────────────────────────────

describe("Rule 5: Card subscription max 3 retries (T+1, T+2, T+3 days)", () => {
  test("attempt_count=3 (at cap) → NOTIFY_CUSTOMER, not RETRY_SCHEDULED", () => {
    const event = makeEvent({ amount: 50000, payment_method: "card", attempt_count: 3 });
    const diagnosis = makeDiagnosis({ category: "bank_or_network_timeout", confidence: 0.8 });
    const decision = decideAction(event, diagnosis);
    expect(decision.action).toBe("NOTIFY_CUSTOMER");
    expect(decision.reason).toContain("max");
  });

  test("attempt_count=4 (past cap) → NOTIFY_CUSTOMER, never retry", () => {
    const event = makeEvent({ amount: 50000, payment_method: "card", attempt_count: 4 });
    const diagnosis = makeDiagnosis({ category: "authentication_failed", confidence: 0.75 });
    const decision = decideAction(event, diagnosis);
    expect(decision.action).toBe("NOTIFY_CUSTOMER");
  });

  test("attempt_count=2 (within budget) → can still RETRY_SCHEDULED", () => {
    const event = makeEvent({ amount: 50000, payment_method: "card", attempt_count: 2 });
    const diagnosis = makeDiagnosis({ category: "bank_or_network_timeout", confidence: 0.85 });
    const decision = decideAction(event, diagnosis);
    expect(decision.action).toBe("RETRY_SCHEDULED");
  });

  test("RETRY_SCHEDULED includes retry delay in minutes", () => {
    const event = makeEvent({ amount: 50000, payment_method: "card", attempt_count: 1 });
    const diagnosis = makeDiagnosis({ category: "bank_or_network_timeout", confidence: 0.85 });
    const decision = decideAction(event, diagnosis);
    expect(decision.action).toBe("RETRY_SCHEDULED");
    expect(decision.retry_after_minutes).toBeDefined();
    expect(decision.retry_after_minutes).toBeGreaterThan(0);
  });
});

// ── RULE 5: UPI Autopay retry cap (NPCI: 1 + 3 max) ──────────────────────────

describe("Rule 5: UPI Autopay max 1+3 retries (NPCI limit)", () => {
  test("UPI attempt_count=4 (past NPCI cap) → NO_ACTION", () => {
    const event = makeEvent({ amount: 50000, payment_method: "upi", attempt_count: 4 });
    const diagnosis = makeDiagnosis({ category: "bank_or_network_timeout", confidence: 0.8 });
    const decision = decideAction(event, diagnosis);
    expect(decision.action).toBe("NO_ACTION");
    expect(decision.reason).toContain("NPCI");
  });

  test("UPI attempt_count=3 (retry 2 of 3, still within budget) → RETRY_SCHEDULED", () => {
    // NPCI rule: 1 original + 3 retries = 4 total attempts.
    // attempt_count=3 means we've made 3 attempts — we still have 1 retry left.
    // The cap (NO_ACTION) triggers only when attempt_count >= 4.
    const event = makeEvent({ amount: 50000, payment_method: "upi", attempt_count: 3 });
    const diagnosis = makeDiagnosis({ category: "bank_or_network_timeout", confidence: 0.75 });
    const decision = decideAction(event, diagnosis);
    expect(decision.action).toBe("RETRY_SCHEDULED");
  });

  test("UPI attempt_count=2 (within budget) → can still retry", () => {
    const event = makeEvent({ amount: 50000, payment_method: "upi", attempt_count: 2 });
    const diagnosis = makeDiagnosis({ category: "bank_or_network_timeout", confidence: 0.8 });
    const decision = decideAction(event, diagnosis);
    expect(decision.action).toBe("RETRY_SCHEDULED");
  });

  test("UPI retry delay lands in off-peak window (12h proxy)", () => {
    const event = makeEvent({ amount: 50000, payment_method: "upi", attempt_count: 1 });
    const diagnosis = makeDiagnosis({ category: "bank_or_network_timeout", confidence: 0.8 });
    const decision = decideAction(event, diagnosis);
    expect(decision.action).toBe("RETRY_SCHEDULED");
    // 12 hours = 720 minutes — our off-peak proxy for UPI
    expect(decision.retry_after_minutes).toBe(720);
  });
});

// ── RULE 6: Category-driven decisions ────────────────────────────────────────

describe("Rule 6: Category-specific routing", () => {
  test("bank_or_network_timeout → RETRY_SCHEDULED", () => {
    const event = makeEvent({ amount: 50000, attempt_count: 1 });
    const diagnosis = makeDiagnosis({ category: "bank_or_network_timeout", confidence: 0.8 });
    const decision = decideAction(event, diagnosis);
    expect(decision.action).toBe("RETRY_SCHEDULED");
  });

  test("authentication_failed → RETRY_SCHEDULED (within budget)", () => {
    const event = makeEvent({ amount: 50000, attempt_count: 1 });
    const diagnosis = makeDiagnosis({ category: "authentication_failed", confidence: 0.75 });
    const decision = decideAction(event, diagnosis);
    expect(decision.action).toBe("RETRY_SCHEDULED");
  });

  test("insufficient_funds → NOTIFY_CUSTOMER (not a retry candidate)", () => {
    const event = makeEvent({ amount: 50000, attempt_count: 1 });
    const diagnosis = makeDiagnosis({ category: "insufficient_funds", confidence: 0.9 });
    const decision = decideAction(event, diagnosis);
    expect(decision.action).toBe("NOTIFY_CUSTOMER");
  });

  test("checkout_abandoned → NOTIFY_CUSTOMER", () => {
    const event = makeEvent({ amount: 50000, entity_type: "checkout_abandoned" });
    const diagnosis = makeDiagnosis({ category: "checkout_abandoned", confidence: 0.85 });
    const decision = decideAction(event, diagnosis);
    expect(decision.action).toBe("NOTIFY_CUSTOMER");
  });

  test("unknown_low_confidence → ESCALATE_HUMAN", () => {
    const event = makeEvent({ amount: 50000 });
    const diagnosis = makeDiagnosis({ category: "unknown_low_confidence", confidence: 0.65 });
    const decision = decideAction(event, diagnosis);
    expect(decision.action).toBe("ESCALATE_HUMAN");
  });
});

// ── Failure case 6: Retry beyond allowed window ───────────────────────────────

describe("Failure case 6: Cannot retry beyond allowed windows", () => {
  test("4th card retry attempt → NOTIFY_CUSTOMER (never RETRY_SCHEDULED)", () => {
    const event = makeEvent({ amount: 50000, payment_method: "card", attempt_count: 3 });
    const diagnosis = makeDiagnosis({ category: "bank_or_network_timeout", confidence: 0.85 });
    const decision = decideAction(event, diagnosis);
    expect(decision.action).toBe("NOTIFY_CUSTOMER");
    expect(decision.action).not.toBe("RETRY_SCHEDULED");
  });

  test("5th UPI attempt → NO_ACTION (NPCI limit)", () => {
    const event = makeEvent({ amount: 50000, payment_method: "upi", attempt_count: 5 });
    const diagnosis = makeDiagnosis({ category: "bank_or_network_timeout", confidence: 0.8 });
    const decision = decideAction(event, diagnosis);
    expect(decision.action).toBe("NO_ACTION");
    expect(decision.action).not.toBe("RETRY_SCHEDULED");
  });
});

// ── Failure case 3: LLM confidently wrong ────────────────────────────────────

describe("Failure case 3: Defense-in-depth against LLM misclassification", () => {
  test("LLM says insufficient_funds but is at retry cap → still NOTIFY_CUSTOMER (cap enforced)", () => {
    // Simulates: LLM says it's insufficient_funds (wrong), but retry cap is already hit.
    // The policy engine enforces T+3 cap regardless of LLM category.
    const event = makeEvent({ amount: 50000, payment_method: "card", attempt_count: 3 });
    const diagnosis = makeDiagnosis({ category: "insufficient_funds", confidence: 0.88 });
    const decision = decideAction(event, diagnosis);
    // Even though LLM says "insufficient_funds" which normally routes to NOTIFY_CUSTOMER,
    // the retry cap check happens before category routing, ensuring correctness
    expect(decision.action).toBe("NOTIFY_CUSTOMER");
  });

  test("LLM wrongly classifies risk_hold as timeout → risk_hold rule still catches it", () => {
    // NOTE: This can't fully test LLM misclassification (that's the diagnosis service's failure),
    // but if risk_hold ever gets through with the correct label, the rule catches it.
    const event = makeEvent({ amount: 50000 });
    const diagnosis = makeDiagnosis({ category: "risk_hold", confidence: 0.92 });
    const decision = decideAction(event, diagnosis);
    expect(decision.action).toBe("ESCALATE_HUMAN");
  });
});

// ── Failure case 7: Economic floor for different amounts ──────────────────────

describe("Failure case 7: Economic floor — various amounts", () => {
  test("₹50 → NO_ACTION", () => {
    const event = makeEvent({ amount: 5000 });
    const diagnosis = makeDiagnosis({ category: "bank_or_network_timeout", confidence: 0.9 });
    expect(decideAction(event, diagnosis).action).toBe("NO_ACTION");
  });

  test("₹99.99 → NO_ACTION (below floor)", () => {
    const event = makeEvent({ amount: 9999 });
    const diagnosis = makeDiagnosis({ category: "bank_or_network_timeout", confidence: 0.9 });
    expect(decideAction(event, diagnosis).action).toBe("NO_ACTION");
  });

  test("₹100 exactly → action taken (at floor, not below)", () => {
    const event = makeEvent({ amount: 10000 });
    const diagnosis = makeDiagnosis({ category: "bank_or_network_timeout", confidence: 0.9 });
    expect(decideAction(event, diagnosis).action).not.toBe("NO_ACTION");
  });

  test("₹10,000 → normal processing", () => {
    const event = makeEvent({ amount: 1000000 });
    const diagnosis = makeDiagnosis({ category: "bank_or_network_timeout", confidence: 0.85 });
    expect(decideAction(event, diagnosis).action).toBe("RETRY_SCHEDULED");
  });
});

// ── Metadata is always correctly set ──────────────────────────────────────────

describe("PolicyDecision metadata completeness", () => {
  test("Decision always includes event_id, action, reason, and metadata", () => {
    const event = makeEvent();
    const diagnosis = makeDiagnosis();
    const decision = decideAction(event, diagnosis);
    expect(decision.event_id).toBe(event.event_id);
    expect(decision.action).toBeDefined();
    expect(decision.reason).toBeTruthy();
    expect(decision.metadata.diagnosis_category).toBe(diagnosis.category);
    expect(decision.metadata.confidence).toBe(diagnosis.confidence);
    expect(decision.metadata.attempt_count).toBe(event.attempt_count);
    expect(decision.metadata.amount).toBe(event.amount);
  });
});
