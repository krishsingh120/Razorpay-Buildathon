/**
 * generateTestWebhookPayload.ts — Test helper script for manual end-to-end testing.
 *
 * Creates a JSON file containing a realistic Razorpay webhook payload that you can
 * curl at your /webhook endpoint to test the full pipeline without real credentials.
 *
 * This is a TEST HELPER, not a mock API. The razorpayClient.ts code stays real.
 *
 * Usage:
 *   ts-node generateTestWebhookPayload.ts
 *   # Then send it:
 *   curl -X POST http://localhost:3000/webhook \
 *     -H "Content-Type: application/json" \
 *     -H "x-razorpay-event-id: evt_test_manual_001" \
 *     -H "x-razorpay-signature: dummy_sig_for_test" \
 *     -d @test-webhook-payload.json
 *
 * NOTE: The signature header is intentionally a dummy — the server will skip
 * signature verification if RAZORPAY_WEBHOOK_SECRET is not configured in .env.
 */

import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";

// Generate a realistic payment.failed webhook payload
const eventId = `evt_test_manual_${uuidv4().replace(/-/g, "").slice(0, 12)}`;
const paymentId = `pay_test_${uuidv4().replace(/-/g, "").slice(0, 14)}`;
const subscriptionId = `sub_test_${uuidv4().replace(/-/g, "").slice(0, 14)}`;
const customerId = `cust_test_${uuidv4().replace(/-/g, "").slice(0, 12)}`;
const now = Math.floor(Date.now() / 1000);

const webhookPayload = {
  entity: "event",
  account_id: "acc_test_buildathon",
  event: "payment.failed",
  contains: ["payment", "subscription"],
  payload: {
    payment: {
      entity: {
        id: paymentId,
        entity: "payment",
        amount: 49900,          // ₹499 in paise
        currency: "INR",
        status: "failed",
        order_id: `order_test_${uuidv4().replace(/-/g, "").slice(0, 14)}`,
        invoice_id: null,
        subscription_id: subscriptionId,
        international: false,
        method: "card",
        amount_refunded: 0,
        captured: false,
        description: "Monthly Pro subscription payment",
        card_id: `card_test_${uuidv4().replace(/-/g, "").slice(0, 14)}`,
        bank: "HDFC",
        wallet: null,
        vpa: null,
        email: "testuser@example.com",
        contact: "+919876543210",
        customer_id: customerId,
        token_id: `token_test_${uuidv4().replace(/-/g, "").slice(0, 14)}`,
        notes: {
          attempt_count: "1",
        },
        // This error profile should be classified as "insufficient_funds" by the LLM
        error_code: "BAD_REQUEST_ERROR",
        error_description: "Your payment failed due to insufficient funds in your account.",
        error_source: "bank",
        error_step: "payment_authorization",
        error_reason: "payment_failed",
        created_at: now,
      },
    },
    subscription: {
      entity: {
        id: subscriptionId,
        entity: "subscription",
        plan_id: `plan_test_${uuidv4().replace(/-/g, "").slice(0, 14)}`,
        status: "halted",
        current_start: now - 2592000,
        current_end: now,
        charge_at: now,
        customer_id: customerId,
        total_count: 12,
        paid_count: 3,
        remaining_count: 9,
      },
    },
  },
  created_at: now,
};

// Save to file
const outputPath = path.join(__dirname, "test-webhook-payload.json");
fs.writeFileSync(outputPath, JSON.stringify(webhookPayload, null, 2));

console.log(`\n✅ Test webhook payload written to: ${outputPath}`);
console.log(`\n📋 Event ID: ${eventId}`);
console.log(`   Payment ID: ${paymentId}`);
console.log(`   Amount: ₹${(49900 / 100).toFixed(2)}`);
console.log(`   Error: insufficient_funds (BAD_REQUEST_ERROR from bank)`);
console.log(`\n🚀 To test the full pipeline, run:`);
console.log(`   1. Start ingestion server:  npm run dev:ingestion`);
console.log(`   2. Start diagnosis service: cd diagnosis && uvicorn main:app --reload --port 8000`);
console.log(`   3. Send the webhook:`);
console.log(`      curl -X POST http://localhost:3000/webhook \\`);
console.log(`        -H "Content-Type: application/json" \\`);
console.log(`        -H "x-razorpay-event-id: ${eventId}" \\`);
console.log(`        -H "x-razorpay-signature: dummy_sig_for_test" \\`);
console.log(`        -d @test-webhook-payload.json`);
console.log(`\n   4. View the audit report:  ts-node audit/generateReport.ts\n`);
