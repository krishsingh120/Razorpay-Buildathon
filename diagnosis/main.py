"""
diagnosis/main.py — FastAPI diagnosis service.

Exposes POST /diagnose which accepts a FailureEvent and returns a DiagnosisResult.
The LLM classification is read-only and advisory — it cannot call any external APIs.

Run with: uvicorn main:app --reload --port 8000
"""

import os
import logging
from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from models import FailureEventInput, DiagnosisResponse, DiagnosisCategory
from diagnoseLLM import diagnose_failure

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Razorpay AI Revenue Recovery — Diagnosis Service",
    description="Classifies payment failures into root-cause categories using an LLM.",
    version="1.0.0",
)


@app.get("/health")
def health_check():
    """Health check endpoint — confirms the service is running."""
    return {"status": "ok", "service": "diagnosis"}


@app.post("/diagnose", response_model=DiagnosisResponse)
async def diagnose_event(event: FailureEventInput) -> DiagnosisResponse:
    """
    Classifies a payment failure event into a root-cause category.

    The LLM receives only structured error fields — no raw customer PII.
    If the LLM returns invalid output, we automatically fall back to
    unknown_low_confidence (which the policy engine then routes to ESCALATE_HUMAN).

    Returns:
        DiagnosisResponse with category, confidence, evidence, and fallback_used flag.
    """
    logger.info(f"[/diagnose] Received event_id={event.event_id} entity_type={event.entity_type}")

    # Special handling: checkout_abandoned events are pre-classified
    # (we know the category without needing an LLM call)
    if event.entity_type == "checkout_abandoned" or event.error_reason == "checkout_abandoned":
        logger.info(f"[/diagnose] Pre-classifying checkout_abandoned for event {event.event_id}")
        return DiagnosisResponse(
            event_id=event.event_id,
            category=DiagnosisCategory.checkout_abandoned,
            confidence=0.95,
            evidence="entity_type=checkout_abandoned — no LLM needed for this category",
            fallback_used=False,
        )

    # Call the LLM classifier
    output, fallback_used = diagnose_failure(event)

    if fallback_used:
        logger.warning(f"[/diagnose] Fallback used for event {event.event_id}")

    return DiagnosisResponse(
        event_id=event.event_id,
        category=output.category,
        confidence=output.confidence,
        evidence=output.evidence,
        fallback_used=fallback_used,
    )


@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    """
    Global error handler — ensures we never return a 500 that breaks the pipeline.
    On unexpected errors, we return a valid DiagnosisResponse with unknown_low_confidence.
    """
    logger.error(f"[/diagnose] Unhandled exception: {exc}")
    # Extract event_id from request if possible
    return JSONResponse(
        status_code=200,  # Return 200 so the executor doesn't think the service is down
        content={
            "event_id": "unknown",
            "category": "unknown_low_confidence",
            "confidence": 0.0,
            "evidence": f"Service error: {str(exc)}",
            "fallback_used": True,
        }
    )
