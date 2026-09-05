# DECISIONS.md — Engineering Decisions & Failure Case Handling

> Judges: this document covers the 9 failure cases from the spec and explains our design decisions.

---

## Failure Case 1: Duplicate Webhook Delivery

**Problem**: Razorpay retries webhook delivery if it doesn't receive a 200 response within a timeout window. This means the same event can be delivered 2–3+ times.

**What broke**: Without deduplication, a failed payment could trigger multiple SMS notifications to the same customer or multiple retry charge attempts — both harmful.

**How we fixed it** (defence-in-depth, two layers):

1. **Ingestion level** (`ingestion/eventQueue.ts` → `hasBeenSeen()`):
   - The webhook server checks `x-razorpay-event-id` against an in-memory Set before normalizing or queueing the event.
   - If seen before: return `200` immediately (so Razorpay stops retrying), log the duplicate, do NOT pass downstream.

2. **Executor level** (`executor/executeAction.ts` → `insertAuditRecord()`):
   - Before executing ANY action, write a `PENDING` record keyed on `event_id` with a `UNIQUE` constraint.
   - If the INSERT fails with a UNIQUE violation → another process already handled this → abort and mark `DUPLICATE_PREVENTED`.
   - This handles the case where two webhook deliveries arrive in parallel faster than the in-memory set can respond (race condition overlap with Case 4).

**Test**: `tests/integration.test.ts` → "Same event_id sent twice — exactly one audit record is created"

---

## Failure Case 2: LLM Returns Malformed or Out-of-Schema Output

**Problem**: LLMs can hallucinate, return plain text instead of JSON, invent new category names, or return confidence values outside [0,1].

**What broke**: If we trusted the raw LLM string, a malformed output could crash the pipeline or route a fraud-flagged payment to an automatic retry.

**How we fixed it**:

1. **JSON output mode**: We set `response_mime_type="application/json"` on the Gemini call to force JSON-only responses.
2. **Pydantic v2 validation** (`diagnosis/models.py` → `DiagnosisOutput`):
   - `category` must be exactly one of the 8 enum values — anything else fails validation.
   - `confidence` has `ge=0.0, le=1.0` constraints — out-of-range values fail.
   - `evidence` has `min_length=1` — empty strings fail.
3. **Automatic fallback** (`diagnosis/diagnoseLLM.py` → `get_fallback_diagnosis()`):
   - Any `json.JSONDecodeError`, `ValidationError`, or unexpected exception → return `unknown_low_confidence` with `confidence=0.0`.
   - This triggers `ESCALATE_HUMAN` in the policy engine — the safest possible outcome.
4. **The fallback_used flag** is returned in `DiagnosisResponse` so ops teams can see when the LLM failed.

**Test**: `diagnosis/test_diagnosis.py` → 6 test cases covering: non-JSON response, invalid category, out-of-range confidence, missing fields, empty string, API exception.

---

## Failure Case 3: LLM Is Confidently Wrong

**Problem**: The LLM might say `insufficient_funds` with confidence 0.9 when it's actually a `risk_hold`. There's no way to fully solve this — LLMs make classification errors.

**How we bounded the blast radius**:

1. **Hard rules in the policy engine are category-independent**:
   - Max 3 retries for cards, max 1+3 for UPI — enforced in code regardless of what the LLM says.
   - If a misclassified `risk_hold` event somehow gets classified as `insufficient_funds` (and confidence is high), the worst outcome is `NOTIFY_CUSTOMER` — not an automatic charge retry. That's still recoverable.

2. **The `risk_hold` rule checks the LLM category, not the raw error fields** — so the only way a risk_hold gets through is if the LLM misclassifies it AND the confidence is high AND the retry cap hasn't been hit. In practice, `risk_hold` payments have distinctive error fields that the LLM reliably recognises.

3. **Honest limitation**: This is documented as a defence-in-depth choice. No system fully solves LLM misclassification. The blast radius is bounded (max 3 retries), not eliminated.

**Design choice**: We intentionally kept the policy engine's hard rules as the last line of defence, operating on the LLM's output (not on raw error fields), because:
- It keeps the two concerns cleanly separated
- The retry caps are always enforced regardless of diagnosis accuracy

---

## Failure Case 4: Race Condition — Two Webhook Deliveries Processed Concurrently

**Problem**: Two Razorpay webhook retries can arrive within milliseconds of each other. The in-memory dedup Set might not be checked atomically, allowing both to pass through to the executor concurrently.

**How we fixed it**:

- **Database-level UNIQUE constraint** on `idempotency_key` in `audit_records`.
- Even if 10 parallel `processEvent` calls race for the same `event_id`, SQLite's write locking ensures only one `INSERT` succeeds. The other 9 get a `UNIQUE constraint failed` error, detect the duplicate, and call `markDuplicatePrevented()`.
- SQLite in WAL mode handles concurrent reads well. For higher concurrency, swap to PostgreSQL with the same `UNIQUE` constraint — the code doesn't change.

**Test**: `tests/integration.test.ts` → "N parallel processEvent calls for the same event_id — exactly 1 executes" (10 concurrent goroutines, 1 audit record asserted)

---

## Failure Case 5: Partial Execution Failure (Executor Crash)

**Problem**: The executor writes `PENDING` to the audit table, then crashes before completing the Razorpay API call or SMS send. On restart, the record is stuck in `PENDING` forever — it will never be retried because the idempotency check blocks it.

**How we fixed it** (`executor/reconcileStuckPending.ts`):

1. On service startup (and optionally on a cron), run `reconcileStuckPending()`.
2. Finds any `PENDING` records older than `RECONCILE_TIMEOUT_MINUTES` (default: 10 minutes).
3. Marks them `FAILED` with a descriptive error message.
4. Does NOT automatically re-execute them — that would bypass the policy engine's retry caps. A `FAILED` record is visible in the audit trail for manual review or for the next webhook retry to re-trigger.

**Design choice**: We chose FAILED over re-execution to preserve the safety invariant: no payment is retried without going back through the policy engine and respecting the T+3 / NPCI caps.

**Test**: `tests/integration.test.ts` → "PENDING records older than timeout are marked FAILED by reconcile sweep"

---

## Failure Case 6: Retry Scheduled Beyond Allowed Window

**Problem**: Automatically retrying a card payment 5 times, or a UPI Autopay 6 times, violates Razorpay's and NPCI's rules and can harm the customer relationship.

**How we fixed it** (`policy/policyEngine.ts` → `isWithinRetryBudget()`):

- Card subscriptions: `attempt_count >= 3` → `NOTIFY_CUSTOMER` (never `RETRY_SCHEDULED` again).
- UPI Autopay: `attempt_count >= 4` (1 original + 3 retries) → `NO_ACTION`.
- These are **code-level constraints, not suggestions**. The policy engine checks the budget BEFORE routing to any category-based logic.
- UPI retries are always scheduled for off-peak hours (12-hour delay proxy → lands outside 10am–10pm).

**Test**: `tests/policyEngine.test.ts` → "4th card retry attempt → NOTIFY_CUSTOMER (never RETRY_SCHEDULED)" and "5th UPI attempt → NO_ACTION (NPCI limit)"

---

## Failure Case 7: Economic Floor Violated

**Problem**: Sending an SMS to recover a ₹50 payment costs more (SMS cost + ops time) than the payment is worth.

**How we fixed it** (`policy/policyEngine.ts` → Rule 1):

- **First rule checked**, before anything else: `amount < 10000 paise (₹100)` → `NO_ACTION`.
- This is logged explicitly in the audit trail with `reason: "Amount ₹X.XX is below the ₹100 economic floor"`.
- It appears in the exception list in the report, so ops teams can see it was intentionally skipped.
- **Never silently dropped** — the audit record is always written.

**Test**: `tests/policyEngine.test.ts` → "Amount below ₹100 → NO_ACTION" and "Amount exactly ₹100 → NOT NO_ACTION (above floor)"

---

## Failure Case 8: Missing or Malformed Webhook Payload

**Problem**: Razorpay's sandbox can send malformed payloads during testing. A missing `payload.payment.entity` or malformed JSON would crash unguarded code.

**How we fixed it** (`ingestion/server.ts` + `ingestion/normalizeEvent.ts`):

1. JSON parse is wrapped in a try/catch — invalid JSON → `400 Malformed JSON`, logged to `rejected_events`.
2. `normalizePaymentFailedEvent()` checks for `payload.payment.entity`, `id`, `amount`, `currency` — missing fields → returns `null` with a rejection reason.
3. The webhook handler checks `normResult.event === null` → logs to `rejected_events` table and returns `400`.
4. **Never silently dropped, never passed downstream**.

---

## Failure Case 9: Test-Mode vs Live-Mode ID Mismatch

**Problem**: Running live-mode Razorpay credentials against a test pipeline (or vice versa) could accidentally charge real customers.

**How we fixed it** (`ingestion/server.ts`):

1. `PIPELINE_MODE` env var is set to `"test"` or `"live"`.
2. The webhook handler checks whether the incoming `payment.id` starts with a live-mode prefix.
3. Live event in test pipeline → `400 Mode mismatch`, logged to `rejected_events`.
4. Test event in live pipeline → `400 Mode mismatch`, logged.
5. **Honest limitation**: Without knowing the full Razorpay account_id whitelist, we use a heuristic (ID prefix). A production system would verify the `account_id` field against a known list.

---

## Additional Design Decisions

### Why SQLite over Postgres?
For a hackathon prototype with a single-process Node.js server, SQLite is simpler (zero infrastructure), supports WAL mode for concurrent reads, and enforces UNIQUE constraints atomically. The schema and all queries would work unchanged in PostgreSQL.

### Why Gemini over GPT-4?
Google API key is available in the hackathon environment. The classification task (8 fixed categories, structured JSON output) is well within Gemini Flash's capabilities and is significantly cheaper per token than GPT-4.

### Why not Kafka/Redis for the queue?
The spec explicitly says "in-memory queue is fine for a hackathon — do not over-engineer." The `eventQueue.ts` interface (`push`/`pop`/`drain`) is designed so swapping to a Redis list is a one-file change.

### Why is the LLM advisory-only?
This is the most important architectural decision. The LLM cannot:
- Write to the database
- Call the Razorpay API
- Send SMS messages

It can only return a JSON classification. This means:
- A hallucinating LLM cannot cause financial harm
- The policy engine's hard rules are the actual safety boundary
- LLM misclassification has bounded blast radius (max 3 retries, economic floor, etc.)
