/**
 * executor/executeAction.ts — Executes recovery actions decided by the policy engine.
 *
 * Pipeline per event:
 *   1. Call diagnosis service → get DiagnosisResult
 *   2. Call policy engine → get PolicyDecision
 *   3. Write PENDING audit record (idempotency guard)
 *   4. Execute the action (retry, notify, escalate, no-op)
 *   5. Update audit record to SUCCESS or FAILED
 *
 * Failure case handled here:
 *   - If the audit INSERT fails (UNIQUE constraint), a duplicate is detected → stop.
 *   - If the action execution throws, mark FAILED and don't retry in this function.
 *     The next reconciliation sweep decides what to do next.
 */

import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";

import { FailureEvent, DiagnosisResult, PolicyDecision, AuditRecord } from "../shared/types";
import { decideAction } from "../policy/policyEngine";
import {
  insertAuditRecord,
  updateAuditRecord,
  markDuplicatePrevented,
  addToOpsQueue,
  logRejectedEvent,
} from "../audit/writeAuditRecord";
import { retrySubscriptionCharge, createPaymentLink } from "../razorpayClient";
import { sendSms, buildRecoveryMessage } from "../smsClient";

dotenv.config();

const DIAGNOSIS_URL = process.env.DIAGNOSIS_SERVICE_URL ?? "http://localhost:8000";

/**
 * Calls the Python FastAPI diagnosis service to classify the failure event.
 * Returns a DiagnosisResult or throws on network/service error.
 */
async function callDiagnosisService(event: FailureEvent): Promise<DiagnosisResult> {
  const response = await axios.post<DiagnosisResult>(
    `${DIAGNOSIS_URL}/diagnose`,
    event,
    { timeout: 60000 } // 60-second timeout — Gemini API can sometimes be very slow
  );
  return response.data;
}

/**
 * The main entry point: processes a single FailureEvent end to end.
 * Called by the webhook handler after enqueueing the event.
 *
 * This function is idempotent — if it's called twice for the same event_id,
 * the second call is blocked by the UNIQUE constraint on the audit record.
 */
export async function processEvent(event: FailureEvent): Promise<void> {
  console.log(`[executor] Processing event_id=${event.event_id} entity=${event.entity_id}`);

  // ── Step 1: Call diagnosis service ──────────────────────────────────────────
  let diagnosis: DiagnosisResult;
  try {
    diagnosis = await callDiagnosisService(event);
    console.log(`[executor] Diagnosis: category=${diagnosis.category} confidence=${diagnosis.confidence}`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[executor] Diagnosis service error for ${event.event_id}: ${errorMsg}`);
    // If diagnosis fails, default to unknown_low_confidence so the policy escalates to human
    diagnosis = {
      event_id: event.event_id,
      category: "unknown_low_confidence",
      confidence: 0.0,
      evidence: `Diagnosis service unavailable: ${errorMsg}`,
    };
  }

  // ── Step 2: Run policy engine ────────────────────────────────────────────────
  const decision: PolicyDecision = decideAction(event, diagnosis);
  console.log(`[executor] Policy decision: ${decision.action} — ${decision.reason}`);

  // ── Step 3: Write PENDING audit record (idempotency guard) ──────────────────
  const now = new Date().toISOString();
  const auditRecord: AuditRecord = {
    event_id: event.event_id,
    diagnosis_category: diagnosis.category,
    confidence: diagnosis.confidence,
    evidence: diagnosis.evidence,
    policy_decision: decision.action,
    policy_reason: decision.reason,
    action_taken: "PENDING",
    execution_status: "PENDING",
    amount: event.amount,
    currency: event.currency,
    recovered_flag: false,
    recovered_amount: 0,
    timestamp: now,
    idempotency_key: event.event_id, // use event_id as idempotency key
    is_duplicate_prevented: false,
  };

  const inserted = insertAuditRecord(auditRecord);
  if (!inserted) {
    // Another process already inserted this event_id — this is a race condition duplicate
    console.warn(`[executor] DUPLICATE PREVENTED for event_id=${event.event_id} — another process already handled it`);
    markDuplicatePrevented(event.event_id);
    return;
  }

  // ── Step 4: Execute the action ───────────────────────────────────────────────
  try {
    await executeDecision(event, decision, diagnosis);
  } catch (err) {
    // Execution failed (network error, API error, etc.)
    // Mark FAILED — do NOT retry here. Let reconciliation or next webhook retry decide.
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[executor] Action execution FAILED for ${event.event_id}: ${errorMsg}`);
    updateAuditRecord(event.event_id, "FAILED", false, 0, errorMsg);
  }
}

/**
 * Routes to the correct action handler based on the policy decision.
 * Updates the audit record to SUCCESS on completion.
 */
async function executeDecision(
  event: FailureEvent,
  decision: PolicyDecision,
  diagnosis: DiagnosisResult
): Promise<void> {
  switch (decision.action) {
    case "RETRY_SCHEDULED":
      await handleRetryScheduled(event, decision);
      break;

    case "RETRY_ALTERNATE_METHOD":
      await handleRetryAlternateMethod(event, decision);
      break;

    case "NOTIFY_CUSTOMER":
      await handleNotifyCustomer(event, decision, diagnosis);
      break;

    case "ESCALATE_HUMAN":
      await handleEscalateHuman(event, decision, diagnosis);
      break;

    case "NO_ACTION":
      handleNoAction(event, decision);
      break;

    default:
      throw new Error(`Unknown policy action: ${decision.action}`);
  }
}

/**
 * Schedules a retry charge via the Razorpay subscription charge API.
 * The actual delay is stored in the audit trail; this call kicks off the charge now
 * (in a real system, you'd schedule this via a job queue for the future).
 */
async function handleRetryScheduled(event: FailureEvent, decision: PolicyDecision): Promise<void> {
  if (!event.subscription_id) {
    // No subscription ID — create a payment link instead as fallback
    console.log(`[executor] No subscription_id for RETRY_SCHEDULED — falling back to NOTIFY_CUSTOMER`);
    await handleNotifyCustomerFallback(event, decision);
    return;
  }

  console.log(`[executor] Triggering retry charge for subscription ${event.subscription_id} (delay: ${decision.retry_after_minutes}min)`);

  // Call the real Razorpay API (will fail with auth error if keys aren't set)
  const chargeResult = await retrySubscriptionCharge(
    event.subscription_id,
    event.amount,
    event.currency
  );

  console.log(`[executor] Retry charge created:`, JSON.stringify(chargeResult).slice(0, 200));
  updateAuditRecord(event.event_id, "SUCCESS", true, event.amount);
}

/**
 * Handles the RETRY_ALTERNATE_METHOD action — creates a payment link for the customer
 * to complete their payment via a different method (card instead of UPI, etc.)
 */
async function handleRetryAlternateMethod(event: FailureEvent, decision: PolicyDecision): Promise<void> {
  console.log(`[executor] Creating alternate payment link for event ${event.event_id}`);

  if (!event.customer_email && !event.customer_phone) {
    throw new Error("Cannot send alternate method link: no customer email or phone");
  }

  const link = await createPaymentLink(
    event.amount,
    event.currency,
    "Valued Customer",
    event.customer_email ?? "",
    event.customer_phone ?? "",
    "Please complete your payment using an alternate method"
  );

  console.log(`[executor] Payment link created: ${(link as { short_url?: string }).short_url ?? "N/A"}`);
  
  // Send SMS with the payment link
  if (event.customer_phone) {
    const msg = buildRecoveryMessage(
      "Valued Customer",
      event.amount / 100,
      "generic",
      (link as { short_url?: string }).short_url
    );
    await sendSms(event.customer_phone, msg);
  }
  
  updateAuditRecord(event.event_id, "SUCCESS", false, 0);
}

/**
 * Handles NOTIFY_CUSTOMER — sends an SMS (and optionally email) based on the diagnosis.
 */
async function handleNotifyCustomer(
  event: FailureEvent,
  decision: PolicyDecision,
  diagnosis: DiagnosisResult
): Promise<void> {
  const phone = event.customer_phone;
  if (!phone) {
    console.warn(`[executor] No customer phone for event ${event.event_id} — cannot send SMS`);
    updateAuditRecord(event.event_id, "FAILED", false, 0, "No customer phone number available");
    return;
  }

  // Map diagnosis category to SMS message type
  const reasonMap: Record<string, Parameters<typeof buildRecoveryMessage>[2]> = {
    insufficient_funds: "insufficient_funds",
    card_expired_or_invalid: "card_expired_or_invalid",
    checkout_abandoned: "checkout_abandoned",
    mandate_cancelled_or_paused: "mandate_cancelled_or_paused",
  };
  const reason = reasonMap[diagnosis.category] ?? "generic";

  const message = buildRecoveryMessage("Valued Customer", event.amount / 100, reason);
  const result = await sendSms(phone, message);

  if (result.success) {
    console.log(`[executor] SMS sent to ${phone} (SID: ${result.messageSid})`);
    updateAuditRecord(event.event_id, "SUCCESS", false, 0);
  } else {
    // SMS failed to send — mark FAILED so ops can follow up
    updateAuditRecord(event.event_id, "FAILED", false, 0, result.error);
  }
}

/**
 * Fallback for when we have no subscription_id but need to notify.
 */
async function handleNotifyCustomerFallback(event: FailureEvent, decision: PolicyDecision): Promise<void> {
  const phone = event.customer_phone;
  if (phone) {
    const message = buildRecoveryMessage("Valued Customer", event.amount / 100, "generic");
    const result = await sendSms(phone, message);
    if (result.success) {
      updateAuditRecord(event.event_id, "SUCCESS", false, 0);
      return;
    }
  }
  updateAuditRecord(event.event_id, "SKIPPED", false, 0, "No subscription_id or customer_phone");
}

/**
 * Handles ESCALATE_HUMAN — adds the event to the ops queue for manual review.
 * This is a lightweight operation that always "succeeds" (just a database write).
 */
async function handleEscalateHuman(
  event: FailureEvent,
  decision: PolicyDecision,
  diagnosis: DiagnosisResult
): Promise<void> {
  console.log(`[executor] Escalating event ${event.event_id} to ops queue`);
  addToOpsQueue(
    event.event_id,
    diagnosis.category,
    decision.reason,
    event.amount,
    event.currency
  );
  updateAuditRecord(event.event_id, "SUCCESS", false, 0);
}

/**
 * Handles NO_ACTION — logs the reason explicitly and marks as SKIPPED.
 * The spec requires this to be logged, not silently dropped.
 */
function handleNoAction(event: FailureEvent, decision: PolicyDecision): void {
  console.log(`[executor] NO_ACTION for event ${event.event_id}: ${decision.reason}`);
  updateAuditRecord(event.event_id, "SKIPPED", false, 0, decision.reason);
}
