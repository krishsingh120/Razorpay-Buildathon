"""
diagnosis/test_diagnosis.py — Tests for the diagnosis service.

Covers Failure Case 2: LLM returns malformed or out-of-schema output.
Run with: python -m pytest test_diagnosis.py -v  (from the diagnosis/ directory)
"""

import pytest
import json
from unittest.mock import patch, MagicMock
from pydantic import ValidationError

from models import FailureEventInput, DiagnosisOutput, DiagnosisCategory
from diagnoseLLM import diagnose_failure, get_fallback_diagnosis


def make_test_event(**overrides) -> FailureEventInput:
    """Helper to create a FailureEventInput for tests."""
    defaults = {
        "event_id": "evt_test_001",
        "entity_type": "payment",
        "entity_id": "pay_test_001",
        "amount": 50000,
        "currency": "INR",
        "error_code": "BAD_REQUEST_ERROR",
        "error_source": "bank",
        "error_step": "payment_authorization",
        "error_reason": "payment_failed",
        "error_description": "Your payment failed",
        "attempt_count": 1,
        "payment_method": "card",
        "is_test_mode": True,
        "created_at": "2026-09-01T10:00:00Z",
    }
    defaults.update(overrides)
    return FailureEventInput(**defaults)


def _make_mock_client(response_text: str) -> MagicMock:
    """
    Creates a mock Gemini client whose generate_content returns the given text.
    Use with: patch("diagnoseLLM._get_client", return_value=_make_mock_client(...))
    """
    mock_response = MagicMock()
    mock_response.text = response_text
    mock_client = MagicMock()
    mock_client.models.generate_content.return_value = mock_response
    return mock_client


def _make_mock_client_raising(exc: Exception) -> MagicMock:
    """Creates a mock Gemini client that raises an exception on generate_content."""
    mock_client = MagicMock()
    mock_client.models.generate_content.side_effect = exc
    return mock_client


# ── Failure Case 2: LLM returns malformed or out-of-schema output ─────────────

class TestLLMMalformedOutput:
    """Tests that malformed LLM output always falls back to unknown_low_confidence."""

    def test_llm_returns_plain_text_not_json(self):
        """LLM returns plain text instead of JSON → fallback."""
        event = make_test_event()
        with patch("diagnoseLLM._get_client", return_value=_make_mock_client(
            "Sorry, I cannot determine the cause of this payment failure."
        )):
            output, fallback_used = diagnose_failure(event)

        assert fallback_used is True
        assert output.category == DiagnosisCategory.unknown_low_confidence
        assert output.confidence == 0.0

    def test_llm_returns_invalid_category(self):
        """LLM invents a new category → fallback."""
        event = make_test_event()
        with patch("diagnoseLLM._get_client", return_value=_make_mock_client(json.dumps({
            "category": "payment_gateway_error",  # not in our allowed list
            "confidence": 0.85,
            "evidence": "error_code=GATEWAY_ERROR",
        }))):
            output, fallback_used = diagnose_failure(event)

        assert fallback_used is True
        assert output.category == DiagnosisCategory.unknown_low_confidence

    def test_llm_returns_confidence_out_of_range(self):
        """LLM returns confidence > 1.0 → Pydantic validation fails → fallback."""
        event = make_test_event()
        with patch("diagnoseLLM._get_client", return_value=_make_mock_client(json.dumps({
            "category": "insufficient_funds",
            "confidence": 1.5,  # invalid: must be <= 1.0
            "evidence": "error_reason=payment_failed",
        }))):
            output, fallback_used = diagnose_failure(event)

        assert fallback_used is True
        assert output.category == DiagnosisCategory.unknown_low_confidence

    def test_llm_returns_missing_required_fields(self):
        """LLM omits required fields → Pydantic validation fails → fallback."""
        event = make_test_event()
        with patch("diagnoseLLM._get_client", return_value=_make_mock_client(json.dumps({
            "category": "bank_or_network_timeout",
            # Missing confidence and evidence
        }))):
            output, fallback_used = diagnose_failure(event)

        assert fallback_used is True
        assert output.category == DiagnosisCategory.unknown_low_confidence

    def test_llm_returns_empty_string(self):
        """LLM returns empty string → fallback."""
        event = make_test_event()
        with patch("diagnoseLLM._get_client", return_value=_make_mock_client("")):
            output, fallback_used = diagnose_failure(event)

        assert fallback_used is True
        assert output.category == DiagnosisCategory.unknown_low_confidence

    def test_llm_api_throws_exception(self):
        """LLM API call throws (e.g. network error) → fallback."""
        event = make_test_event()
        with patch("diagnoseLLM._get_client", return_value=_make_mock_client_raising(
            Exception("API rate limit exceeded")
        )):
            output, fallback_used = diagnose_failure(event)

        assert fallback_used is True
        assert output.category == DiagnosisCategory.unknown_low_confidence
        assert "rate limit" in output.evidence.lower() or "unexpected error" in output.evidence.lower()

    def test_valid_llm_output_is_accepted(self):
        """Valid LLM output passes validation and is returned as-is."""
        event = make_test_event()
        with patch("diagnoseLLM._get_client", return_value=_make_mock_client(json.dumps({
            "category": "insufficient_funds",
            "confidence": 0.92,
            "evidence": "error_code=BAD_REQUEST_ERROR, error_reason=payment_failed, error_source=bank",
        }))):
            output, fallback_used = diagnose_failure(event)

        assert fallback_used is False
        assert output.category == DiagnosisCategory.insufficient_funds
        assert output.confidence == 0.92


# ── Pydantic model validation ─────────────────────────────────────────────────

class TestPydanticModels:
    """Tests that Pydantic models reject invalid data correctly."""

    def test_diagnosis_output_rejects_invalid_category(self):
        with pytest.raises(ValidationError):
            DiagnosisOutput(category="made_up_category", confidence=0.8, evidence="some evidence")

    def test_diagnosis_output_rejects_confidence_above_1(self):
        with pytest.raises(ValidationError):
            DiagnosisOutput(category=DiagnosisCategory.insufficient_funds, confidence=1.1, evidence="some evidence")

    def test_diagnosis_output_rejects_confidence_below_0(self):
        with pytest.raises(ValidationError):
            DiagnosisOutput(category=DiagnosisCategory.risk_hold, confidence=-0.1, evidence="some evidence")

    def test_diagnosis_output_rejects_empty_evidence(self):
        with pytest.raises(ValidationError):
            DiagnosisOutput(category=DiagnosisCategory.authentication_failed, confidence=0.7, evidence="")

    def test_failure_event_input_valid(self):
        event = make_test_event()
        assert event.event_id == "evt_test_001"
        assert event.amount == 50000
