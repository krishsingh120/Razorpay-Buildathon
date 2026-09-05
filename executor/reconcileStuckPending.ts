/**
 * executor/reconcileStuckPending.ts — Reconciliation sweep for stuck PENDING records.
 *
 * Failure Case 5: The executor may crash after writing PENDING to the audit table
 * but before completing the action. On restart, these records stay PENDING forever.
 *
 * This script finds any PENDING records older than RECONCILE_TIMEOUT_MINUTES and
 * marks them FAILED. They are NOT automatically re-executed — that would violate
 * the idempotency guarantee. A human or the next webhook retry decides next steps.
 *
 * Run this on service startup or periodically via cron.
 */

import dotenv from "dotenv";
import { findStuckPendingRecords, updateAuditRecord } from "../audit/writeAuditRecord";
import { getDb } from "../audit/database";

dotenv.config();

const TIMEOUT_MINUTES = parseInt(process.env.RECONCILE_TIMEOUT_MINUTES ?? "10", 10);

/**
 * Finds PENDING records older than TIMEOUT_MINUTES and marks them FAILED.
 * Returns the number of records remediated.
 */
export function reconcileStuckPending(): number {
  // Ensure DB is initialized
  getDb();
  
  const stuckRecords = findStuckPendingRecords(TIMEOUT_MINUTES);

  if (stuckRecords.length === 0) {
    console.log(`[reconcile] No stuck PENDING records found (timeout: ${TIMEOUT_MINUTES}min)`);
    return 0;
  }

  console.log(`[reconcile] Found ${stuckRecords.length} stuck PENDING records — marking FAILED`);

  for (const record of stuckRecords) {
    console.log(`[reconcile] Marking FAILED: event_id=${record.event_id} (stuck since ${record.timestamp})`);
    updateAuditRecord(
      record.event_id,
      "FAILED",
      false,
      0,
      `Stuck PENDING for >${TIMEOUT_MINUTES} minutes — marked FAILED by reconciliation sweep`
    );
  }

  console.log(`[reconcile] Remediated ${stuckRecords.length} stuck records`);
  return stuckRecords.length;
}

// Run directly: ts-node executor/reconcileStuckPending.ts
if (require.main === module) {
  const count = reconcileStuckPending();
  console.log(`[reconcile] Done. ${count} records remediated.`);
  process.exit(0);
}
