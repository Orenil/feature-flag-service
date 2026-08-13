export interface Flag {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  rolloutPercentage: number;
  createdAt: string;
  updatedAt: string;
}

export type AuditAction = 'create' | 'update' | 'rollback';

export interface AuditEntry {
  id: string;
  flagKey: string;
  action: AuditAction;
  actor: string;
  previousState: Flag | null;
  newState: Flag;
  rollbackOf: string | null;
  createdAt: string;
}

export interface EvaluationResult {
  value: boolean;
  bucket: number;
  flagFound: boolean;
}
