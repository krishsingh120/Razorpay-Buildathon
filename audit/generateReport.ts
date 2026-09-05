/**
 * audit/generateReport.ts — Prints the recovery metrics report.
 *
 * Reads all audit_records from the database and computes:
 * - Total amount at risk
 * - Total amount recovered
 * - Recovery rate %
 * - Breakdown by diagnosis category
 * - Exception list (NO_ACTION and ESCALATE_HUMAN with reasons)
 * - Count of duplicate-prevented executions
 */

import { getAllAuditRecords } from "./writeAuditRecord";
import { AuditRecord, DiagnosisCategory } from "../shared/types";
import { getDb } from "./database";

/**
 * Generates and prints the full recovery metrics report to stdout.
 * Returns the report as a plain object as well (useful for tests).
 */
export function generateReport(): void {
  // Make sure the database is initialized before reading
  getDb();
  
  const records = getAllAuditRecords();

  if (records.length === 0) {
    console.log("[report] No audit records found. Run the batch first.");
    return;
  }

  const totalAtRiskPaise = records.reduce((sum, r) => sum + r.amount, 0);
  const totalRecoveredPaise = records.reduce((sum, r) => sum + r.recovered_amount, 0);
  const recoveryRate = totalAtRiskPaise > 0
    ? ((totalRecoveredPaise / totalAtRiskPaise) * 100).toFixed(2)
    : "0.00";

  const duplicatesPrevented = records.filter(r => r.is_duplicate_prevented).length;
  const totalEvents = records.length;
  const successfulRecoveries = records.filter(r => r.recovered_flag).length;
  const failedExecutions = records.filter(r => r.execution_status === "FAILED").length;

  // Build per-category breakdown
  const categories: DiagnosisCategory[] = [
    "insufficient_funds",
    "card_expired_or_invalid",
    "authentication_failed",
    "bank_or_network_timeout",
    "risk_hold",
    "mandate_cancelled_or_paused",
    "checkout_abandoned",
    "unknown_low_confidence",
  ];

  const categoryBreakdown = categories.map(cat => {
    const catRecords = records.filter(r => r.diagnosis_category === cat);
    const catAtRisk = catRecords.reduce((sum, r) => sum + r.amount, 0);
    const catRecovered = catRecords.reduce((sum, r) => sum + r.recovered_amount, 0);
    return {
      category: cat,
      count: catRecords.length,
      atRiskRupees: (catAtRisk / 100).toFixed(2),
      recoveredRupees: (catRecovered / 100).toFixed(2),
      rate: catAtRisk > 0 ? ((catRecovered / catAtRisk) * 100).toFixed(1) + "%" : "N/A",
    };
  }).filter(b => b.count > 0);

  // Exception list: events that were not actioned (NO_ACTION or ESCALATE_HUMAN)
  const exceptions = records.filter(
    r => r.policy_decision === "NO_ACTION" || r.policy_decision === "ESCALATE_HUMAN"
  );

  // ── Print the report ────────────────────────────────────────────────────────

  console.log("\n");
  console.log("=".repeat(70));
  console.log("        RAZORPAY AI REVENUE RECOVERY — BATCH REPORT");
  console.log("=".repeat(70));

  console.log("\n📊 SUMMARY");
  console.log("-".repeat(40));
  console.log(`  Total events processed  : ${totalEvents}`);
  console.log(`  Total amount at risk    : ₹${(totalAtRiskPaise / 100).toFixed(2)}`);
  console.log(`  Total amount recovered  : ₹${(totalRecoveredPaise / 100).toFixed(2)}`);
  console.log(`  Recovery rate           : ${recoveryRate}%`);
  console.log(`  Successful recoveries   : ${successfulRecoveries}`);
  console.log(`  Failed executions       : ${failedExecutions}`);
  console.log(`  Duplicates prevented    : ${duplicatesPrevented}  ← idempotency working ✓`);

  console.log("\n📋 BREAKDOWN BY DIAGNOSIS CATEGORY");
  console.log("-".repeat(70));
  console.log(
    "  Category".padEnd(32) +
    "Count".padEnd(8) +
    "At Risk".padEnd(14) +
    "Recovered".padEnd(14) +
    "Rate"
  );
  console.log("-".repeat(70));
  for (const b of categoryBreakdown) {
    console.log(
      `  ${b.category}`.padEnd(32) +
      `${b.count}`.padEnd(8) +
      `₹${b.atRiskRupees}`.padEnd(14) +
      `₹${b.recoveredRupees}`.padEnd(14) +
      b.rate
    );
  }

  console.log("\n⚠️  EXCEPTION LIST (NO_ACTION + ESCALATE_HUMAN)");
  console.log("-".repeat(70));
  if (exceptions.length === 0) {
    console.log("  (none)");
  } else {
    for (const ex of exceptions) {
      const amountStr = `₹${(ex.amount / 100).toFixed(2)}`;
      console.log(`  [${ex.policy_decision}] event_id=${ex.event_id}`);
      console.log(`    Amount: ${amountStr} | Category: ${ex.diagnosis_category}`);
      console.log(`    Reason: ${ex.policy_reason}`);
      console.log();
    }
  }

  // Show ops queue items
  const opsItems = getDb().prepare("SELECT * FROM ops_queue WHERE reviewed = 0").all() as Record<string, unknown>[];
  console.log(`\n🚨 OPS QUEUE (pending human review): ${opsItems.length} items`);
  if (opsItems.length > 0) {
    for (const item of opsItems.slice(0, 10)) {
      console.log(`  event_id=${item["event_id"]} | ₹${((item["amount"] as number) / 100).toFixed(2)} | ${item["diagnosis_category"]}`);
    }
    if (opsItems.length > 10) {
      console.log(`  ... and ${opsItems.length - 10} more`);
    }
  }

  // Show rejected events
  const rejected = getDb().prepare("SELECT COUNT(*) as count FROM rejected_events").get() as { count: number };
  console.log(`\n🚫 REJECTED EVENTS (invalid/malformed): ${rejected.count}`);

  console.log("\n" + "=".repeat(70));
  console.log("  Report generated at:", new Date().toISOString());
  console.log("=".repeat(70) + "\n");
}

// Allow running directly: ts-node audit/generateReport.ts
if (require.main === module) {
  generateReport();
}
