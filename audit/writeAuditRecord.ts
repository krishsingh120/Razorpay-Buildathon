/**
 * audit/writeAuditRecord.ts — Functions to create and update audit records.
 *
 * Every event that enters the pipeline gets a row in audit_records.
 * This module is the only place that writes to that table.
 */

import { getDb } from "./database";
import { AuditRecord, DiagnosisCategory, PolicyAction } from "../shared/types";

/**
 * Inserts a new audit record with status PENDING.
 * This is called BEFORE the executor attempts any action (idempotency guarantee).
 *
 * Returns true if inserted, false if a record with this event_id already exists
 * (which means a duplicate was detected at the executor level).
 */
export function insertAuditRecord(record: AuditRecord): boolean {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO audit_records (
      event_id, diagnosis_category, confidence, evidence,
      policy_decision, policy_reason, action_taken, execution_status,
      amount, currency, recovered_flag, recovered_amount,
      timestamp, idempotency_key, is_duplicate_prevented, error_detail
    ) VALUES (
      @event_id, @diagnosis_category, @confidence, @evidence,
      @policy_decision, @policy_reason, @action_taken, @execution_status,
      @amount, @currency, @recovered_flag, @recovered_amount,
      @timestamp, @idempotency_key, @is_duplicate_prevented, @error_detail
    )
  `);

  try {
    stmt.run({
      ...record,
      recovered_flag: record.recovered_flag ? 1 : 0,
      is_duplicate_prevented: record.is_duplicate_prevented ? 1 : 0,
      error_detail: record.error_detail ?? null,
      recovered_amount: record.recovered_amount ?? null,
    });
    return true;
  } catch (err: unknown) {
    // SQLite UNIQUE constraint violation means this event_id already exists
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("UNIQUE constraint failed")) {
      return false; // duplicate detected
    }
    throw err; // re-throw unexpected errors
  }
}

/**
 * Updates an existing audit record after execution completes.
 * Sets the final execution_status, recovered_flag, and any error detail.
 */
export function updateAuditRecord(
  eventId: string,
  executionStatus: AuditRecord["execution_status"],
  recovered: boolean,
  recoveredAmount: number,
  errorDetail?: string
): void {
  const db = getDb();
  db.prepare(`
    UPDATE audit_records
    SET execution_status = ?,
        action_taken = ?,
        recovered_flag = ?,
        recovered_amount = ?,
        error_detail = ?
    WHERE event_id = ?
  `).run(
    executionStatus,
    executionStatus,
    recovered ? 1 : 0,
    recoveredAmount,
    errorDetail ?? null,
    eventId
  );
}

/**
 * Marks an event as DUPLICATE_PREVENTED in the audit trail.
 * Called when a duplicate webhook is detected at the executor level
 * (a second attempt to process an event_id that's already been handled).
 */
export function markDuplicatePrevented(eventId: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE audit_records
    SET execution_status = 'DUPLICATE_PREVENTED',
        action_taken = 'DUPLICATE_PREVENTED',
        is_duplicate_prevented = 1
    WHERE event_id = ?
  `).run(eventId);
}

/**
 * Logs a rejected event (malformed payload, signature failure, mode mismatch).
 * These are stored in the rejected_events table for debugging, not the audit_records table.
 */
export function logRejectedEvent(
  rawEventId: string | undefined,
  rejectionReason: string,
  rawPayload?: unknown
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO rejected_events (raw_event_id, rejection_reason, raw_payload, rejected_at)
    VALUES (?, ?, ?, ?)
  `).run(
    rawEventId ?? null,
    rejectionReason,
    rawPayload ? JSON.stringify(rawPayload) : null,
    new Date().toISOString()
  );
}

/**
 * Adds an event to the ops escalation queue for human review.
 * Called when the policy engine decides ESCALATE_HUMAN.
 */
export function addToOpsQueue(
  eventId: string,
  diagnosisCategory: DiagnosisCategory,
  policyReason: string,
  amount: number,
  currency: string
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO ops_queue (event_id, diagnosis_category, policy_reason, amount, currency, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(eventId, diagnosisCategory, policyReason, amount, currency, new Date().toISOString());
}

/**
 * Finds all PENDING audit records older than N minutes.
 * Used by the reconciliation sweep to detect stuck executions.
 */
export function findStuckPendingRecords(olderThanMinutes: number): AuditRecord[] {
  const db = getDb();
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT * FROM audit_records
    WHERE execution_status = 'PENDING'
    AND timestamp < ?
  `).all(cutoff) as Record<string, unknown>[];

  return rows.map(rowToAuditRecord);
}

/**
 * Converts a raw SQLite row (with 0/1 integers) back to an AuditRecord with proper booleans.
 */
function rowToAuditRecord(row: Record<string, unknown>): AuditRecord {
  return {
    ...(row as unknown as AuditRecord),
    recovered_flag: Boolean(row["recovered_flag"]),
    is_duplicate_prevented: Boolean(row["is_duplicate_prevented"]),
  };
}

/**
 * Fetches a single audit record by event_id.
 * Returns null if not found.
 */
export function getAuditRecord(eventId: string): AuditRecord | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM audit_records WHERE event_id = ?").get(eventId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToAuditRecord(row);
}

/**
 * Fetches ALL audit records — used by the report generator.
 */
export function getAllAuditRecords(): AuditRecord[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM audit_records ORDER BY timestamp ASC").all() as Record<string, unknown>[];
  return rows.map(rowToAuditRecord);
}
