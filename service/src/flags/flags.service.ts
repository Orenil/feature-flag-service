import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../db/database.service';
import { bucketFor, isInRollout } from '../hash/rollout-hash';
import { FlagsGateway } from './flags.gateway';
import { AuditAction, AuditEntry, EvaluationResult, Flag } from './flags.types';

interface FlagRow {
  key: string;
  name: string;
  description: string;
  enabled: number;
  rollout_percentage: number;
  created_at: string;
  updated_at: string;
}

interface AuditRow {
  id: string;
  flag_key: string;
  action: string;
  actor: string;
  previous_state: string | null;
  new_state: string;
  rollback_of: string | null;
  created_at: string;
}

function rowToFlag(row: FlagRow): Flag {
  return {
    key: row.key,
    name: row.name,
    description: row.description,
    enabled: !!row.enabled,
    rolloutPercentage: row.rollout_percentage,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToAudit(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    flagKey: row.flag_key,
    action: row.action as AuditAction,
    actor: row.actor,
    previousState: row.previous_state ? (JSON.parse(row.previous_state) as Flag) : null,
    newState: JSON.parse(row.new_state) as Flag,
    rollbackOf: row.rollback_of,
    createdAt: row.created_at,
  };
}

function validatePercentage(value: number) {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new BadRequestException('rolloutPercentage must be a number between 0 and 100');
  }
}

export interface CreateFlagInput {
  key: string;
  name: string;
  description?: string;
  enabled?: boolean;
  rolloutPercentage?: number;
}

export interface UpdateFlagInput {
  name?: string;
  description?: string;
  enabled?: boolean;
  rolloutPercentage?: number;
}

/**
 * Core domain logic: flag CRUD, deterministic evaluation, and the
 * immutable audit log with rollback. Every mutation writes exactly one new
 * audit_log row (never edits an old one) and then pushes the resulting
 * flag state to connected SDKs over the websocket gateway.
 */
@Injectable()
export class FlagsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly gateway: FlagsGateway,
  ) {}

  listFlags(): Flag[] {
    const rows = this.db.db.prepare('SELECT * FROM flags ORDER BY key').all() as FlagRow[];
    return rows.map(rowToFlag);
  }

  getFlag(key: string): Flag {
    const row = this.db.db.prepare('SELECT * FROM flags WHERE key = ?').get(key) as FlagRow | undefined;
    if (!row) throw new NotFoundException(`flag '${key}' not found`);
    return rowToFlag(row);
  }

  createFlag(input: CreateFlagInput, actor: string): Flag {
    if (!input.key || !input.name) {
      throw new BadRequestException('key and name are required');
    }
    const existing = this.db.db.prepare('SELECT key FROM flags WHERE key = ?').get(input.key);
    if (existing) throw new BadRequestException(`flag '${input.key}' already exists`);
    validatePercentage(input.rolloutPercentage ?? 0);

    const now = new Date().toISOString();
    const flag: Flag = {
      key: input.key,
      name: input.name,
      description: input.description ?? '',
      enabled: input.enabled ?? false,
      rolloutPercentage: input.rolloutPercentage ?? 0,
      createdAt: now,
      updatedAt: now,
    };

    this.db.db
      .prepare(
        `INSERT INTO flags (key, name, description, enabled, rollout_percentage, created_at, updated_at)
         VALUES (@key, @name, @description, @enabled, @rolloutPercentage, @createdAt, @updatedAt)`,
      )
      .run({ ...flag, enabled: flag.enabled ? 1 : 0 });

    this.writeAudit('create', flag.key, actor, null, flag, null);
    this.gateway.broadcastFlagChanged(flag);
    return flag;
  }

  updateFlag(key: string, patch: UpdateFlagInput, actor: string): Flag {
    const current = this.getFlag(key);
    if (patch.rolloutPercentage !== undefined) validatePercentage(patch.rolloutPercentage);

    const updated: Flag = {
      ...current,
      ...patch,
      key,
      updatedAt: new Date().toISOString(),
    };

    this.db.db
      .prepare(
        `UPDATE flags SET name=@name, description=@description, enabled=@enabled,
         rollout_percentage=@rolloutPercentage, updated_at=@updatedAt WHERE key=@key`,
      )
      .run({ ...updated, enabled: updated.enabled ? 1 : 0 });

    this.writeAudit('update', key, actor, current, updated, null);
    this.gateway.broadcastFlagChanged(updated);
    return updated;
  }

  getAuditLog(key?: string): AuditEntry[] {
    const rows = key
      ? (this.db.db
          .prepare('SELECT * FROM audit_log WHERE flag_key = ? ORDER BY created_at DESC, rowid DESC')
          .all(key) as AuditRow[])
      : (this.db.db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC, rowid DESC').all() as AuditRow[]);
    return rows.map(rowToAudit);
  }

  /**
   * Rollback never mutates history. It reads the target audit entry's
   * `new_state` snapshot, writes it back as the flags table's current row,
   * and appends a *new* audit_log entry (action='rollback', rollback_of =
   * the entry being restored) capturing what the state was immediately
   * before the rollback. The original entries stay untouched forever.
   */
  rollback(key: string, auditId: string, actor: string): Flag {
    const target = this.db.db
      .prepare('SELECT * FROM audit_log WHERE id = ? AND flag_key = ?')
      .get(auditId, key) as AuditRow | undefined;
    if (!target) throw new NotFoundException(`audit entry '${auditId}' not found for flag '${key}'`);

    const current = this.getFlag(key);
    const restoredState = JSON.parse(target.new_state) as Flag;
    const restored: Flag = {
      ...restoredState,
      key,
      updatedAt: new Date().toISOString(),
    };

    this.db.db
      .prepare(
        `UPDATE flags SET name=@name, description=@description, enabled=@enabled,
         rollout_percentage=@rolloutPercentage, updated_at=@updatedAt WHERE key=@key`,
      )
      .run({ ...restored, enabled: restored.enabled ? 1 : 0 });

    this.writeAudit('rollback', key, actor, current, restored, auditId);
    this.gateway.broadcastFlagChanged(restored);
    return restored;
  }

  /**
   * Deterministic per-user evaluation. `defaultValue` is only used when the
   * flag doesn't exist at all -- this mirrors the SDK's own fail-safe
   * contract (serve the default only when there's nothing cached yet).
   */
  evaluate(key: string, userId: string, defaultValue = false): EvaluationResult {
    const row = this.db.db.prepare('SELECT * FROM flags WHERE key = ?').get(key) as FlagRow | undefined;
    if (!row) return { value: defaultValue, bucket: -1, flagFound: false };

    const flag = rowToFlag(row);
    const bucket = bucketFor(flag.key, userId);
    if (!flag.enabled) return { value: false, bucket, flagFound: true };

    return { value: isInRollout(flag.key, userId, flag.rolloutPercentage), bucket, flagFound: true };
  }

  private writeAudit(
    action: AuditAction,
    flagKey: string,
    actor: string,
    previous: Flag | null,
    next: Flag,
    rollbackOf: string | null,
  ) {
    this.db.db
      .prepare(
        `INSERT INTO audit_log (id, flag_key, action, actor, previous_state, new_state, rollback_of, created_at)
         VALUES (@id, @flagKey, @action, @actor, @previousState, @newState, @rollbackOf, @createdAt)`,
      )
      .run({
        id: randomUUID(),
        flagKey,
        action,
        actor,
        previousState: previous ? JSON.stringify(previous) : null,
        newState: JSON.stringify(next),
        rollbackOf,
        createdAt: new Date().toISOString(),
      });
  }
}
