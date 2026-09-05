/**
 * razorpayClient.ts — The ONE file that talks to the Razorpay API.
 *
 * All other files import from here. Never call the Razorpay SDK directly elsewhere.
 * This means swapping test credentials for live credentials is a zero-code-change operation.
 *
 * Requires env vars: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET
 */

import Razorpay from "razorpay";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

// Validate that required env vars are present at startup — fail fast, fail loud.
if (!process.env.RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID.startsWith("rzp_test_XXXX")) {
  console.warn(
    "[razorpayClient] WARNING: RAZORPAY_KEY_ID is not set or is a placeholder. " +
    "All Razorpay API calls will fail until real credentials are added to .env"
  );
}

// Initialize the Razorpay SDK client. This is the real SDK — not a mock.
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID ?? "",
  key_secret: process.env.RAZORPAY_KEY_SECRET ?? "",
});

/**
 * Verifies a Razorpay webhook signature using HMAC SHA256.
 * Razorpay signs every webhook payload with your webhook secret.
 * Returns true if the signature is valid, false otherwise.
 *
 * See: https://razorpay.com/docs/webhooks/validate-test/#validate-webhooks
 */
export function verifyWebhookSignature(
  rawBody: string,
  razorpaySignature: string,
  webhookSecret: string
): boolean {
  const expectedSignature = crypto
    .createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("hex");

  // Use timingSafeEqual to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature, "hex"),
      Buffer.from(razorpaySignature, "hex")
    );
  } catch {
    // timingSafeEqual throws if buffers are different lengths — that means invalid sig
    return false;
  }
}

/**
 * Fetches the full details of a payment from Razorpay by its payment ID.
 * Useful for enriching a webhook event with additional context before diagnosis.
 *
 * Returns the payment entity object or throws on API error.
 */
export async function getPaymentDetails(paymentId: string): Promise<Record<string, unknown>> {
  const payment = await razorpay.payments.fetch(paymentId);
  return payment as unknown as Record<string, unknown>;
}

/**
 * Fetches subscription details from Razorpay.
 * Used to check the subscription's current status before scheduling a retry charge.
 */
export async function getSubscriptionDetails(subscriptionId: string): Promise<Record<string, unknown>> {
  const subscription = await razorpay.subscriptions.fetch(subscriptionId);
  return subscription as unknown as Record<string, unknown>;
}

/**
 * Triggers a retry charge for a subscription.
 * In Razorpay, this is done by calling the "charge" endpoint on a subscription.
 *
 * IMPORTANT: This will attempt a real charge if real credentials are configured.
 * In the hackathon build, .env contains placeholder keys, so this call will fail
 * gracefully with a Razorpay auth error — never silently succeeding.
 *
 * Returns the new payment entity created by the retry charge.
 */
export async function retrySubscriptionCharge(
  subscriptionId: string,
  amountPaise: number,
  currency: string = "INR"
): Promise<Record<string, unknown>> {
  // Razorpay's charge API for subscriptions: creates a new charge attempt
  const chargeResult = await razorpay.subscriptions.createAddon(subscriptionId, {
    item: {
      name: "Recovery retry charge",
      amount: amountPaise,
      currency,
    },
    quantity: 1,
  });
  return chargeResult as unknown as Record<string, unknown>;
}

/**
 * Creates a new payment link to send to a customer (used for checkout recovery).
 * The link can be sent via SMS/email so the customer can complete their payment.
 *
 * Returns the payment link object including the short_url field.
 */
export async function createPaymentLink(
  amountPaise: number,
  currency: string,
  customerName: string,
  customerEmail: string,
  customerPhone: string,
  description: string
): Promise<Record<string, unknown>> {
  const link = await razorpay.paymentLink.create({
    amount: amountPaise,
    currency,
    description,
    customer: {
      name: customerName,
      email: customerEmail,
      contact: customerPhone,
    },
    notify: {
      sms: true,
      email: true,
    },
    reminder_enable: true,
  });
  return link as unknown as Record<string, unknown>;
}
