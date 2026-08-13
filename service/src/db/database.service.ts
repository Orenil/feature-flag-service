import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

/**
 * SQLite-backed storage for flag definitions + the append-only audit log.
 *
 * This stands in for Postgres in the real deployment target: `flags` is the
 * current-state table (one row per flag, like a materialized view) and
 * `audit_log` is an immutable, insert-only history of every change,
 * including rollbacks. Swapping to Postgres means replacing this file with
 * a `pg` pool and translating the two CREATE TABLE statements below --
 * the schema is already ANSI-ish SQL, only `INTEGER` booleans and
 * `TEXT` timestamps would become `BOOLEAN`/`TIMESTAMPTZ`.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  public readonly db: Database.Database;

  constructor() {
    const dbPath = process.env.FF_DB_PATH ?? path.join(__dirname, '..', '..', 'data', 'flags.sqlite');

    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS flags (
        key                 TEXT PRIMARY KEY,
        name                TEXT NOT NULL,
        description         TEXT NOT NULL DEFAULT '',
        enabled             INTEGER NOT NULL DEFAULT 0,
        rollout_percentage  INTEGER NOT NULL DEFAULT 0,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id              TEXT PRIMARY KEY,
        flag_key        TEXT NOT NULL,
        action          TEXT NOT NULL,
        actor           TEXT NOT NULL,
        previous_state  TEXT,
        new_state       TEXT NOT NULL,
        rollback_of     TEXT,
        created_at      TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_flag_key ON audit_log (flag_key);
    `);
  }

  onModuleDestroy() {
    this.db.close();
  }
}
