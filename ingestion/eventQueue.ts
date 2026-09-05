/**
 * ingestion/eventQueue.ts — Simple in-memory FIFO queue for failure events.
 *
 * Events are pushed here by the webhook handler and consumed by the processing loop.
 * For a hackathon, an in-memory queue is fine. In production, swap this for a Redis
 * list or an SQS queue — the interface (push/pop) stays the same.
 *
 * The queue is module-level state (a plain array), so it persists across requests
 * within the same Node.js process.
 */

import { FailureEvent } from "../shared/types";

// The queue itself — a plain array acting as a FIFO queue
const queue: FailureEvent[] = [];

// Track which event_ids have been seen (for deduplication at ingestion level)
// In production, this would be a Redis SET or a database table.
const seenEventIds = new Set<string>();

/**
 * Pushes a new failure event onto the queue.
 * Returns true if the event was added, false if it was a duplicate (already seen).
 *
 * This is the ingestion-level deduplication check (Failure Case 1).
 * The executor also does its own check — defence in depth.
 */
export function pushEvent(event: FailureEvent): boolean {
  if (seenEventIds.has(event.event_id)) {
    console.log(`[queue] Duplicate event_id ${event.event_id} — dropping (already queued or processed)`);
    return false;
  }

  seenEventIds.add(event.event_id);
  queue.push(event);
  console.log(`[queue] Enqueued event ${event.event_id} (queue size: ${queue.length})`);
  return true;
}

/**
 * Pops the next event from the front of the queue.
 * Returns undefined if the queue is empty.
 */
export function popEvent(): FailureEvent | undefined {
  return queue.shift();
}

/**
 * Returns the current number of events waiting to be processed.
 */
export function queueSize(): number {
  return queue.length;
}

/**
 * Checks if a specific event_id has already been seen.
 * Used by the webhook handler to drop duplicates before even normalizing the payload.
 */
export function hasBeenSeen(eventId: string): boolean {
  return seenEventIds.has(eventId);
}

/**
 * Drains all events from the queue at once.
 * Used by the batch runner to process everything synchronously.
 */
export function drainQueue(): FailureEvent[] {
  const all = [...queue];
  queue.length = 0;
  return all;
}

/**
 * Clears the seen set — ONLY for use in tests to reset state between test cases.
 */
export function resetQueueForTesting(): void {
  queue.length = 0;
  seenEventIds.clear();
}
