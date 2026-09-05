/**
 * ingestion/server.ts — Express webhook server.
 *
 * Exposes POST /webhook for Razorpay events.
 * Pipeline per request:
 *   1. Read raw body (needed for HMAC verification)
 *   2. Verify Razorpay signature → reject 401 if invalid
 *   3. Check x-razorpay-event-id deduplication → ack 200 and drop if seen
 *   4. Validate mode (test vs live) → reject 400 if mismatch
 *   5. Normalize the payload into a FailureEvent
 *   6. Push to queue → ack 200 to Razorpay
 *   7. Async: process the event (diagnose → policy → execute)
 */

import express, { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";
import { verifyWebhookSignature } from "../razorpayClient";
import { hasBeenSeen, pushEvent } from "./eventQueue";
import {
  normalizePaymentFailedEvent,
  normalizeSubscriptionEvent,
} from "./normalizeEvent";
import { logRejectedEvent } from "../audit/writeAuditRecord";
import { processEvent } from "../executor/executeAction";
import { RazorpayWebhookPayload } from "../shared/types";

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? "";
const PIPELINE_MODE = process.env.PIPELINE_MODE ?? "test";

// We need the raw body for HMAC signature verification — JSON middleware would parse it.
// So we use express.raw() instead of express.json() for the /webhook route.
app.use("/webhook", express.raw({ type: "application/json" }));

// For all other routes (health, etc.) use JSON parsing
app.use(express.json());

/**
 * Health check endpoint — useful for confirming the server is up.
 */
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", mode: PIPELINE_MODE, timestamp: new Date().toISOString() });
});

/**
 * Main webhook handler — receives all events from Razorpay.
 */
app.post("/webhook", async (req: Request, res: Response) => {
  const rawBody = req.body as Buffer;
  const razorpaySignature = req.headers["x-razorpay-signature"] as string | undefined;
  const eventId = req.headers["x-razorpay-event-id"] as string | undefined;

  // ── Step 1: Signature verification ──────────────────────────────────────────
  if (!razorpaySignature) {
    console.warn("[webhook] Missing x-razorpay-signature header — rejecting");
    logRejectedEvent(eventId, "Missing x-razorpay-signature header");
    return res.status(401).json({ error: "Missing signature" });
  }

  if (!WEBHOOK_SECRET || WEBHOOK_SECRET === "your_webhook_secret_here") {
    // In test mode without a real secret, we skip signature verification and log a warning
    console.warn("[webhook] RAZORPAY_WEBHOOK_SECRET not configured — skipping signature check (test mode only)");
  } else {
    const rawBodyStr = rawBody.toString("utf-8");
    const isValid = verifyWebhookSignature(rawBodyStr, razorpaySignature, WEBHOOK_SECRET);
    if (!isValid) {
      console.warn(`[webhook] Invalid signature for event_id=${eventId} — rejecting`);
      logRejectedEvent(eventId, "Invalid HMAC SHA256 webhook signature");
      return res.status(401).json({ error: "Invalid signature" });
    }
  }

  // ── Step 2: Parse the JSON payload ─────────────────────────────────────────
  let webhookPayload: RazorpayWebhookPayload;
  try {
    webhookPayload = JSON.parse(rawBody.toString("utf-8")) as RazorpayWebhookPayload;
  } catch {
    console.warn("[webhook] Malformed JSON body — rejecting");
    logRejectedEvent(eventId, "Malformed JSON webhook payload");
    return res.status(400).json({ error: "Malformed JSON" });
  }

  // ── Step 3: Validate required top-level fields ──────────────────────────────
  if (!webhookPayload.event || !webhookPayload.payload) {
    logRejectedEvent(eventId, "Missing required fields: event or payload");
    return res.status(400).json({ error: "Invalid payload structure" });
  }

  // ── Step 4: Generate or use event_id ───────────────────────────────────────
  const resolvedEventId = eventId ?? `synthetic_${Date.now()}`;

  // ── Step 5: Deduplication — drop if already seen ───────────────────────────
  if (hasBeenSeen(resolvedEventId)) {
    console.log(`[webhook] Duplicate event_id=${resolvedEventId} — acking and dropping`);
    // Return 200 so Razorpay stops retrying this delivery
    return res.status(200).json({ status: "duplicate", event_id: resolvedEventId });
  }

  // ── Step 6: Mode validation ─────────────────────────────────────────────────
  // Razorpay uses "live" or "test" in the account_id or the payment entity ID prefix.
  // We use a simple heuristic: test mode entity IDs start with the test prefix.
  // Full validation would check the account_id against a known list.
  const paymentId = webhookPayload.payload.payment?.entity?.id ?? "";
  const isTestEvent = !paymentId.startsWith("pay_live_") && !paymentId.startsWith("sub_live_");

  if (PIPELINE_MODE === "test" && !isTestEvent) {
    logRejectedEvent(resolvedEventId, "Live-mode event received in test-mode pipeline", webhookPayload);
    return res.status(400).json({ error: "Mode mismatch: live event in test pipeline" });
  }
  if (PIPELINE_MODE === "live" && isTestEvent && paymentId.length > 0) {
    logRejectedEvent(resolvedEventId, "Test-mode event received in live-mode pipeline", webhookPayload);
    return res.status(400).json({ error: "Mode mismatch: test event in live pipeline" });
  }

  // ── Step 7: Normalize the event ─────────────────────────────────────────────
  const eventType = webhookPayload.event;
  let normResult: { event: import("../shared/types").FailureEvent | null; rejectionReason: string | null };

  if (eventType === "payment.failed" || eventType === "subscription.charged.failed") {
    normResult = normalizePaymentFailedEvent(resolvedEventId, webhookPayload);
  } else if (eventType === "subscription.halted" || eventType === "subscription.pending") {
    normResult = normalizeSubscriptionEvent(resolvedEventId, webhookPayload);
  } else {
    // Unknown event type — ack and ignore (Razorpay sends many event types we don't handle)
    console.log(`[webhook] Unhandled event type '${eventType}' — acking and ignoring`);
    return res.status(200).json({ status: "ignored", event_type: eventType });
  }

  if (normResult.event === null) {
    logRejectedEvent(resolvedEventId, normResult.rejectionReason ?? "Unknown normalization error", webhookPayload);
    return res.status(400).json({ error: "Payload validation failed", detail: normResult.rejectionReason });
  }

  // ── Step 8: Enqueue the event ───────────────────────────────────────────────
  const enqueued = pushEvent(normResult.event);
  if (!enqueued) {
    // Already in queue (race condition between two concurrent webhook deliveries)
    return res.status(200).json({ status: "duplicate_in_queue", event_id: resolvedEventId });
  }

  // ── Step 9: Ack to Razorpay immediately, then process asynchronously ─────────
  // We return 200 BEFORE processing so Razorpay doesn't think we timed out.
  res.status(200).json({ status: "accepted", event_id: resolvedEventId });

  // Process in the background (non-blocking)
  setImmediate(() => {
    processEvent(normResult.event!).catch(err => {
      console.error(`[webhook] Processing error for event ${resolvedEventId}:`, err);
    });
  });

  return; // explicit return after res.json() to satisfy TypeScript
});

/**
 * 404 handler for any other routes
 */
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

/**
 * Global error handler — catches any unhandled errors and returns 500
 */
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[webhook] Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// Start the server
app.listen(PORT, () => {
  console.log(`[ingestion] Webhook server running on http://localhost:${PORT}`);
  console.log(`[ingestion] Pipeline mode: ${PIPELINE_MODE}`);
  console.log(`[ingestion] Webhook endpoint: POST http://localhost:${PORT}/webhook`);
});

export { app }; // exported for integration tests
