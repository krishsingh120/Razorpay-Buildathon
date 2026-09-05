/**
 * audit/database.ts — SQLite database setup for the audit + metrics store.
 *
 * Uses better-sqlite3 (synchronous SQLite) for simplicity — no async driver needed.
 * Creates the database file and all tables on first run if they don't exist.
 *
 * Schema design: one table for all audit records (one row per processed event),
 * one table for the ops escalation queue (human reviewable), and one table for
 * idempotency tracking (prevents duplicate execution).
 */

import Database from "better-sqlite3";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const DB_PATH = process.env.DATABASE_PATH ?? path.join(__dirname, "recovery.db");

// Open (or create) the SQLite database file
let db: Database.Database;

/**
 * Returns the shared database connection, creating it on first call.
 * Using a singleton so all modules share the same connection.
 */
export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    // Enable WAL mode for better concurrent read performance
    db.pragma("journal_mode = WAL");
    // Enforce foreign key constraints
    db.pragma("foreign_keys = ON");
    initializeSchema(db);
  }
  return db;
}

/**
 * Creates all tables if they don't already exist.
 * Safe to call multiple times — all statements use IF NOT EXISTS.
 */
function initializeSchema(database: Database.Database): void {
  // Main audit table: one row per processed failure event
  database.exec(`
    CREATE TABLE IF NOT EXISTS audit_records (
      event_id TEXT PRIMARY KEY,
      diagnosis_category TEXT NOT NULL,
      confidence REAL NOT NULL,
      evidence TEXT NOT NULL,
      policy_decision TEXT NOT NULL,
      policy_reason TEXT NOT NULL,
      action_taken TEXT NOT NULL,
      execution_status TEXT NOT NULL DEFAULT 'PENDING',
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      recovered_flag INTEGER NOT NULL DEFAULT 0,
      recovered_amount INTEGER NOT NULL DEFAULT 0,
      timestamp TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      is_duplicate_prevented INTEGER NOT NULL DEFAULT 0,
      error_detail TEXT
    )
  `);

  // Index for fast reporting queries
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_execution_status ON audit_records(execution_status);
    CREATE INDEX IF NOT EXISTS idx_diagnosis_category ON audit_records(diagnosis_category);
    CREATE INDEX IF NOT EXISTS idx_timestamp ON audit_records(timestamp);
  `);

  // Ops escalation queue: events that need human review
  database.exec(`
    CREATE TABLE IF NOT EXISTS ops_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      diagnosis_category TEXT NOT NULL,
      policy_reason TEXT NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      created_at TEXT NOT NULL,
      reviewed INTEGER NOT NULL DEFAULT 0,
      reviewed_at TEXT,
      reviewer_notes TEXT
    )
  `);

  // Rejected events: malformed payloads or mode mismatches
  database.exec(`
    CREATE TABLE IF NOT EXISTS rejected_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_event_id TEXT,
      rejection_reason TEXT NOT NULL,
      raw_payload TEXT,
      rejected_at TEXT NOT NULL
    )
  `);

  console.log("[database] Schema initialized at:", DB_PATH);
}

/**
 * Closes the database connection cleanly.
 * Call this on process exit to flush WAL and release locks.
 */
export function closeDb(): void {
  if (db) {
    db.close();
  }
}
