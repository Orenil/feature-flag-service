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

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} ${body}`.trim());
  }
  return (await res.json()) as T;
}

/** Thin client for the NestJS feature-flag-service REST API. */
export const api = {
  baseUrl: API_BASE,

  listFlags: (): Promise<Flag[]> =>
    fetch(`${API_BASE}/flags`, { cache: 'no-store' }).then((res) => asJson<Flag[]>(res)),

  getAudit: (key: string): Promise<AuditEntry[]> =>
    fetch(`${API_BASE}/flags/${encodeURIComponent(key)}/audit`, { cache: 'no-store' }).then((res) =>
      asJson<AuditEntry[]>(res),
    ),

  rollback: (key: string, auditId: string, actor: string): Promise<Flag> =>
    fetch(`${API_BASE}/flags/${encodeURIComponent(key)}/rollback/${encodeURIComponent(auditId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor }),
    }).then((res) => asJson<Flag>(res)),
};
