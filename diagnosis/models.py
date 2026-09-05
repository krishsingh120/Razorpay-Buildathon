"""
diagnosis/models.py — Pydantic v2 schemas for the diagnosis service.

All request/response bodies are validated against these models.
The LLM output is also validated here — if it doesn't match DiagnosisOutput,
we auto-classify as unknown_low_confidence (Failure Case 2).
"""

from pydantic import BaseModel, Field, field_validator
from typing import Optional, Literal
from enum import Enum


# All allowed diagnosis categories — must exactly match the TypeScript DiagnosisCategory type
class DiagnosisCategory(str, Enum):
    insufficient_funds = "insufficient_funds"
    card_expired_or_invalid = "card_expired_or_invalid"
    authentication_failed = "authentication_failed"
    bank_or_network_timeout = "bank_or_network_timeout"
    risk_hold = "risk_hold"
    mandate_cancelled_or_paused = "mandate_cancelled_or_paused"
    checkout_abandoned = "checkout_abandoned"
    unknown_low_confidence = "unknown_low_confidence"


class FailureEventInput(BaseModel):
    """
    The FailureEvent sent from Node.js executor to this service.
    We only accept structured error fields — no raw customer PII beyond what's needed.
    """
    event_id: str
    entity_type: Literal["payment", "subscription", "order", "checkout_abandoned"]
    entity_id: str
    amount: int                           # in paise
    currency: str = "INR"
    error_code: Optional[str] = None
    error_source: Optional[str] = None   # "bank", "customer", "business", "network"
    error_step: Optional[str] = None     # "payment_authentication", "payment_authorization"
    error_reason: Optional[str] = None
    error_description: Optional[str] = None
    attempt_count: int = 1
    subscription_id: Optional[str] = None
    customer_id: Optional[str] = None
    customer_email: Optional[str] = None  # included for context but not passed to LLM
    customer_phone: Optional[str] = None  # included for context but not passed to LLM
    payment_method: Literal["card", "upi", "netbanking", "wallet", "unknown"] = "unknown"
    is_test_mode: bool = True
    created_at: str


class DiagnosisOutput(BaseModel):
    """
    The STRICT typed output the LLM must produce.
    Validated with Pydantic — any deviation triggers the fallback.

    The confidence field must be between 0 and 1.
    The category must be one of the fixed DiagnosisCategory enum values.
    """
    category: DiagnosisCategory
    confidence: float = Field(ge=0.0, le=1.0)
    evidence: str = Field(min_length=1, max_length=500)

    @field_validator("confidence")
    @classmethod
    def round_confidence(cls, v: float) -> float:
        # Round to 2 decimal places for clean output
        return round(v, 2)


class DiagnosisResponse(BaseModel):
    """
    The full response this service returns to the Node.js executor.
    """
    event_id: str
    category: DiagnosisCategory
    confidence: float
    evidence: str
    fallback_used: bool = False  # true if the LLM output was invalid and we used the fallback
