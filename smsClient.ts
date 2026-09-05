/**
 * smsClient.ts — The ONE file that sends SMS notifications via Twilio.
 *
 * All notification code imports from here. Swapping providers means changing just this file.
 * Requires env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *
 * If credentials are missing, logs a clear error and does NOT silently pretend to send.
 */

import twilio from "twilio";
import dotenv from "dotenv";

dotenv.config();

const accountSid = process.env.TWILIO_ACCOUNT_SID ?? "";
const authToken = process.env.TWILIO_AUTH_TOKEN ?? "";
const fromNumber = process.env.TWILIO_FROM_NUMBER ?? "";

// Check config at module load time so the error is visible immediately, not buried later
const isTwilioConfigured =
  accountSid.length > 0 &&
  !accountSid.startsWith("ACxxxxxxx") &&
  authToken.length > 0 &&
  fromNumber.length > 0;

if (!isTwilioConfigured) {
  console.warn(
    "[smsClient] WARNING: Twilio credentials are not set or are placeholders in .env. " +
    "SMS messages will fail to send — add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER."
  );
}

// Initialize the real Twilio client. This is the real SDK — not a mock.
const twilioClient = isTwilioConfigured ? twilio(accountSid, authToken) : null;

/**
 * Sends an SMS to a customer's phone number using Twilio.
 *
 * Returns an object with success=true and the Twilio message SID on success.
 * Returns success=false with an error string if Twilio is not configured or the send fails.
 * Does NOT throw — callers should check the success flag.
 */
export async function sendSms(
  toPhoneNumber: string,
  messageText: string
): Promise<{ success: boolean; messageSid?: string; error?: string }> {
  if (!twilioClient) {
    const error = "SMS provider not configured — check .env for Twilio credentials";
    console.error(`[smsClient] ${error}`);
    return { success: false, error };
  }

  try {
    const message = await twilioClient.messages.create({
      body: messageText,
      from: fromNumber,
      to: toPhoneNumber,
    });

    console.log(`[smsClient] SMS sent to ${toPhoneNumber}, SID: ${message.sid}`);
    return { success: true, messageSid: message.sid };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[smsClient] Failed to send SMS to ${toPhoneNumber}: ${error}`);
    return { success: false, error };
  }
}

/**
 * Builds the SMS message text for a payment recovery notification.
 * Keeps messages short (under 160 chars for single SMS) and action-oriented.
 */
export function buildRecoveryMessage(
  customerName: string,
  amountRupees: number,
  reason: "insufficient_funds" | "card_expired_or_invalid" | "checkout_abandoned" | "mandate_cancelled_or_paused" | "generic",
  paymentLink?: string
): string {
  const amount = `₹${amountRupees.toFixed(2)}`;

  switch (reason) {
    case "insufficient_funds":
      return `Hi ${customerName}, your payment of ${amount} failed due to insufficient funds. Please add funds and retry: ${paymentLink ?? ""}`.trim();

    case "card_expired_or_invalid":
      return `Hi ${customerName}, your card on file has expired or is invalid. Please update your payment method to continue your subscription: ${paymentLink ?? ""}`.trim();

    case "checkout_abandoned":
      return `Hi ${customerName}, you left your order of ${amount} incomplete. Complete your purchase here: ${paymentLink ?? ""}`.trim();

    case "mandate_cancelled_or_paused":
      return `Hi ${customerName}, your UPI Autopay mandate was cancelled. Please re-authorize to continue your subscription: ${paymentLink ?? ""}`.trim();

    default:
      return `Hi ${customerName}, your payment of ${amount} could not be processed. Please check your payment details or contact support.`;
  }
}
