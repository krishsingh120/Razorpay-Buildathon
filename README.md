# Razorpay AI Revenue Recovery Agent

> **Razorpay AI Buildathon · Track: AI Revenue Recovery**

An intelligent payment failure recovery system that diagnoses root causes using an LLM, applies deterministic safety rules, executes bounded recovery actions, and maintains a full audit trail with recovery metrics.

---

## Problem Statement

Merchants on Razorpay lose **recoverable revenue** because payment failures (subscription charges, checkout drop-offs) are handled with blind, one-size-fits-all retries. A failed payment due to *insufficient funds* needs a very different recovery action than one due to a *network timeout* or a *suspected fraud hold*.

This agent:
1. **Ingests** failure events from Razorpay webhooks
2. **Diagnoses** the root cause using a Gemini LLM (read-only, advisory)
3. **Decides** a bounded recovery action using deterministic policy rules (NO LLM here)
4. **Executes** the action with full idempotency guarantees
5. **Reports** recovered revenue with a complete audit trail

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        RAZORPAY WEBHOOK                                  │
│                    (payment.failed, subscription.*)                      │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ POST /webhook
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     1. INGESTION LAYER (Node.js + TS)                   │
│  ① Verify HMAC SHA256 signature  ② Deduplicate on x-razorpay-event-id  │
│  ③ Validate mode (test vs live)  ④ Normalize → FailureEvent schema      │
│  ⑤ Push to in-memory queue       ⑥ ACK 200 to Razorpay                 │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ async
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                  2. DIAGNOSIS SERVICE (Python FastAPI)                   │
│  POST /diagnose → Gemini LLM (read-only, advisory)                      │
│  → One of 8 fixed categories + confidence score + evidence string       │
│  → Pydantic v2 validation; invalid output → unknown_low_confidence      │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ DiagnosisResult
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                3. POLICY ENGINE (Node.js, deterministic)                │
│  Pure if/else rules — NO LLM calls                                      │
│  Hard rules: retry caps, confidence floor, risk_hold block, eco floor   │
│  → ONE of: RETRY_SCHEDULED | NOTIFY_CUSTOMER | ESCALATE_HUMAN | NO_ACTION│
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ PolicyDecision
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        4. EXECUTOR (Node.js)                            │
│  ① Write PENDING idempotency record (blocks duplicates via UNIQUE key)  │
│  ② Execute action (Razorpay retry API / Twilio SMS / ops queue write)  │
│  ③ Update audit record → SUCCESS or FAILED                              │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                5. AUDIT + METRICS STORE (SQLite)                        │
│  audit_records | ops_queue | rejected_events                            │
│  → generateReport.ts prints full recovery metrics                       │
└─────────────────────────────────────────────────────────────────────────┘
```

### Key Files

| File | Purpose |
|------|---------|
| `razorpayClient.ts` | **ONE file** for all Razorpay SDK calls — swap credentials here |
| `smsClient.ts` | **ONE file** for all Twilio SMS calls |
| `policy/policyEngine.ts` | All hard safety rules — deterministic, no LLM |
| `ingestion/server.ts` | Express webhook server |
| `diagnosis/main.py` | FastAPI diagnosis service |
| `executor/executeAction.ts` | Orchestrates diagnosis → policy → action |
| `audit/database.ts` | SQLite schema setup |
| `generateTestWebhookPayload.ts` | Test helper — generates curl-able webhook JSON |

---

## Setup

### Prerequisites
- Node.js 18+
- Python 3.11+
- npm

### 1. Install Node.js dependencies
```bash
npm install
```

### 2. Install Python dependencies
```bash
cd diagnosis
pip install -r requirements.txt
cd ..
```

### 3. Configure environment
```bash
cp .env.example .env
# Edit .env and add your real credentials:
#   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET
#   GOOGLE_API_KEY (for Gemini LLM)
#   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
```

---

## Running the Demo End to End

### Option A: Full live demo (all services)

**Terminal 1 — Diagnosis service:**
```bash
cd diagnosis
uvicorn main:app --reload --port 8000
```

**Terminal 2 — Ingestion server:**
```bash
npm run dev:ingestion
```

**Terminal 3 — Send a test webhook:**
```bash
ts-node generateTestWebhookPayload.ts
# Follow the curl command printed by the script
```

**Terminal 3 (continued) — Or run the full synthetic batch:**
```bash
npm run run:batch
```

### Option B: Run tests only (no services needed)

```bash
# Policy engine unit tests (100% rule coverage)
npm run test:policy

# Integration tests (duplicate webhook + race condition)
npm run test:integration

# All tests
npm test
```

### Option C: Python diagnosis tests
```bash
cd diagnosis
python -m pytest test_diagnosis.py -v
```

---

## Viewing the Audit Report

After running the batch (or sending real webhooks):
```bash
ts-node audit/generateReport.ts
```

Sample output:
```
======================================================================
        RAZORPAY AI REVENUE RECOVERY — BATCH REPORT
======================================================================

📊 SUMMARY
Total events processed  : 61
Total amount at risk    : ₹18,450.00
Total amount recovered  : ₹6,230.00
Recovery rate           : 33.78%
Successful recoveries   : 14
Duplicates prevented    : 1  ← idempotency working ✓
```

---

## Reconciliation (Failure Case 5)

If the executor crashes mid-execution, run this on restart to clean up stuck records:
```bash
npm run reconcile
```

---

## Known Limitations

| Area | Status | Notes |
|------|--------|-------|
| Razorpay API calls | Real SDK, untested end-to-end | Keys not available yet; add to `.env` to activate |
| Twilio SMS | Real SDK, untested end-to-end | Keys not available yet; add to `.env` to activate |
| Gemini LLM | Real API, requires `GOOGLE_API_KEY` | Falls back to `unknown_low_confidence` if key missing |
| Queue | In-memory | Resets on server restart; use Redis for production |
| Database | SQLite | Good for prototype; use PostgreSQL for production |
| Retry scheduling | Synchronous | Real retries would use a job queue (Bull/BullMQ) with time-delay |
| UPI peak-hour scheduling | Uses 12h proxy | Production would compute exact next off-peak slot |
| attempt_count | Defaults to 1 | Production would look up real attempt history from Razorpay subscription API |

---

## Folder Structure

```
/
├── shared/                  # Shared TypeScript types
├── ingestion/               # Express webhook server
├── diagnosis/               # Python FastAPI + Gemini LLM classifier
├── policy/                  # Deterministic policy engine
├── executor/                # Action executor + reconciliation
├── audit/                   # SQLite schema + report generator
├── synthetic-data/          # 60+ event generator + batch runner
├── tests/                   # Unit + integration tests
├── razorpayClient.ts        # All Razorpay SDK calls (one file)
├── smsClient.ts             # All Twilio SMS calls (one file)
├── generateTestWebhookPayload.ts  # Test helper
├── .env.example
├── README.md
└── DECISIONS.md             # How each failure case is handled
```
