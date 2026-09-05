"""
diagnosis/diagnoseLLM.py — LLM-based failure classifier using Google Gemini.

Uses the new `google-genai` SDK (google.genai) which works with the new
AQ. API key format from Google AI Studio.

The LLM receives ONLY structured error fields (no raw customer PII).
It must return one of the fixed DiagnosisCategory values.

The LLM is READ-ONLY and ADVISORY:
- It cannot call any APIs
- It cannot write to any database
- Its output is validated with Pydantic before being trusted
- If output is invalid, we fall back to unknown_low_confidence automatically
"""

import os
import json
import logging

from groq import Groq
from pydantic import ValidationError

from models import FailureEventInput, DiagnosisOutput, DiagnosisCategory

logger = logging.getLogger(__name__)

# ── Gemini setup ───────────────────────────────────────────────────────────────

_api_key = os.environ.get("GROQ_API_KEY", "")
if not _api_key:
    logger.warning(
        "[diagnoseLLM] GROQ_API_KEY is not set. "
        "All LLM calls will fail until a real key is added to .env"
    )

# Lazy client — created on first use so tests can import this module without a real API key
_client = None

def _get_client():
    """Returns the Groq client, creating it if needed (lazy initialization)."""
    global _client
    if _client is None:
        if not _api_key:
            raise ValueError(
                "GROQ_API_KEY is not set. Add it to .env before calling the diagnosis service."
            )
        _client = Groq(api_key=_api_key)
    return _client

MODEL_NAME = "groq/compound"

# ── Prompt templates ───────────────────────────────────────────────────────────

# The fixed list of categories the LLM must choose from
VALID_CATEGORIES = [cat.value for cat in DiagnosisCategory]

SYSTEM_PROMPT = """You are a payment failure diagnosis assistant for Razorpay, a payment gateway.

Your job is to analyze structured payment failure data and classify the root cause into EXACTLY ONE of these categories:
- insufficient_funds: Card declined because the customer doesn't have enough balance
- card_expired_or_invalid: Card is expired, wrong CVV, wrong expiry date, or card blocked
- authentication_failed: OTP was wrong, 3DS authentication failed, or customer didn't complete authentication
- bank_or_network_timeout: The bank or payment network timed out — a transient infrastructure issue
- risk_hold: Razorpay or the bank flagged this payment as potentially fraudulent
- mandate_cancelled_or_paused: UPI Autopay mandate was cancelled, paused, or revoked by the customer
- checkout_abandoned: Customer started checkout but left before completing payment
- unknown_low_confidence: You cannot confidently determine the cause from the available data

You MUST return a JSON object with exactly these three fields:
{
  "category": "<one of the categories above>",
  "confidence": <float between 0.0 and 1.0>,
  "evidence": "<short explanation of which fields led to this classification>"
}

Rules:
- You CANNOT invent new categories
- You CANNOT return anything outside this JSON structure
- If you are unsure, use unknown_low_confidence with a low confidence score
- Never guess at a category with confidence > 0.7 unless the error fields clearly indicate it
- The evidence field must reference the specific error_code, error_source, error_step, or error_reason values you used
"""


def build_llm_prompt(event: FailureEventInput) -> str:
    """
    Builds the user-facing prompt from a FailureEvent.
    Only includes structured error fields — NEVER raw customer PII.
    """
    context = {
        "entity_type": event.entity_type,
        "payment_method": event.payment_method,
        "amount_rupees": round(event.amount / 100, 2),
        "error_code": event.error_code,
        "error_source": event.error_source,
        "error_step": event.error_step,
        "error_reason": event.error_reason,
        "error_description": event.error_description,
        "attempt_count": event.attempt_count,
        "has_subscription": event.subscription_id is not None,
    }
    return f"""Analyze this payment failure and classify its root cause:

{json.dumps(context, indent=2)}

Return a JSON object with category, confidence, and evidence fields only."""


# ── Core functions ─────────────────────────────────────────────────────────────

def get_fallback_diagnosis(event_id: str, reason: str) -> DiagnosisOutput:
    """
    Returns the safe fallback when LLM output is invalid or the API call fails.
    Always sets unknown_low_confidence with confidence 0.0.
    """
    logger.warning(f"[diagnoseLLM] Using fallback for event {event_id}: {reason}")
    return DiagnosisOutput(
        category=DiagnosisCategory.unknown_low_confidence,
        confidence=0.0,
        evidence=f"Fallback used due to: {reason[:200]}",
    )


def diagnose_failure(event: FailureEventInput) -> tuple[DiagnosisOutput, bool]:
    """
    Calls the Groq LLM to classify the failure event.

    Returns a tuple of (DiagnosisOutput, fallback_used: bool).
    - fallback_used=True means the LLM output was invalid and we used the safe default.

    This function NEVER raises — all errors trigger the fallback.
    """
    try:
        prompt = build_llm_prompt(event)
        logger.info(f"[diagnoseLLM] Calling Groq ({MODEL_NAME}) for event {event.event_id}")

        client = _get_client()
        response = client.chat.completions.create(
            model=MODEL_NAME,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": prompt}
            ],
            response_format={"type": "json_object"},
            temperature=0.1,
            max_tokens=1024,
        )
        raw_text = response.choices[0].message.content.strip()
        logger.debug(f"[diagnoseLLM] Raw LLM response: {raw_text}")

        # ── Step 1: Parse as JSON ──────────────────────────────────────────────
        try:
            parsed_json = json.loads(raw_text)
        except json.JSONDecodeError as e:
            return get_fallback_diagnosis(event.event_id, f"LLM returned non-JSON: {e}"), True

        # ── Step 2: Validate against our strict Pydantic schema ───────────────
        try:
            output = DiagnosisOutput.model_validate(parsed_json)
        except ValidationError as e:
            return get_fallback_diagnosis(event.event_id, f"LLM output failed schema validation: {e}"), True

        logger.info(
            f"[diagnoseLLM] Classified event {event.event_id}: "
            f"category={output.category} confidence={output.confidence}"
        )
        return output, False

    except Exception as e:
        return get_fallback_diagnosis(event.event_id, f"Unexpected error: {e}"), True
