/**
 * synthetic-data/runBatch.ts — Runs the full 60+ event synthetic batch and prints the report.
 *
 * This script:
 *   1. Generates all synthetic events
 *   2. Runs each through the ingestion normalizer
 *   3. Calls the diagnosis service (or uses a fallback if it's down)
 *   4. Runs the policy engine
 *   5. Writes audit records (with idempotency checks)
 *   6. Prints the final metrics report
 *
 * Usage: ts-node synthetic-data/runBatch.ts
 *
 * The diagnosis service must be running: uvicorn diagnosis.main:app --port 8000
 * If it's not running, events default to unknown_low_confidence (ESCALATE_HUMAN).
 */

import dotenv from "dotenv";
dotenv.config();

import { generateSyntheticBatch } from "./generateEvents";
import { normalizePaymentFailedEvent } from "../ingestion/normalizeEvent";
import { processEvent } from "../executor/executeAction";
import { generateReport } from "../audit/generateReport";
import { getDb } from "../audit/database";
import { reconcileStuckPending } from "../executor/reconcileStuckPending";

async function runBatch(): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("  RAZORPAY AI REVENUE RECOVERY — SYNTHETIC BATCH RUNNER");
  console.log("=".repeat(60));

  // Initialize database first
  getDb();

  // Run reconciliation sweep to clean up any stuck records from previous runs
  reconcileStuckPending();

  // Generate all events (full batch)
  const rawEvents = generateSyntheticBatch();
  console.log(`\n[batch] Processing ${rawEvents.length} events (this will take a while due to 13s delay for rate limits)...\n`);

  let processed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const { eventId, payload } of rawEvents) {
    // Normalize the raw webhook payload into a FailureEvent
    const normResult = normalizePaymentFailedEvent(eventId, payload);

    if (normResult.event === null) {
      console.warn(`[batch] Skipping malformed event ${eventId}: ${normResult.rejectionReason}`);
      skipped++;
      continue;
    }

    const event = normResult.event;

    // Process the event through the full pipeline
    try {
      await processEvent(event);
      processed++;

      // 13-second delay between events to avoid overwhelming the diagnosis service and hitting the 5 req/min Gemini rate limit
      console.log(`[batch] Sleeping 13 seconds to respect rate limits...`);
      await new Promise(resolve => setTimeout(resolve, 13000));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[batch] Error processing event ${eventId}: ${msg}`);
      errors.push(`${eventId}: ${msg}`);
    }

    // Progress indicator every 10 events
    if (processed % 10 === 0) {
      console.log(`[batch] Progress: ${processed}/${rawEvents.length} events processed`);
    }
  }

  console.log(`\n[batch] Done. Processed: ${processed}, Skipped: ${skipped}, Errors: ${errors.length}`);

  if (errors.length > 0) {
    console.log("\n[batch] Errors:");
    errors.forEach(e => console.log(`  - ${e}`));
  }

  // Print the final report
  console.log("\n[batch] Generating metrics report...");
  generateReport();
}

// Run
runBatch().catch(err => {
  console.error("[batch] Fatal error:", err);
  process.exit(1);
});
