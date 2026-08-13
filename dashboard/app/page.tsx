'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, AuditEntry, Flag } from './lib/api';

export default function DashboardPage() {
  const [flags, setFlags] = useState<Flag[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actor, setActor] = useState('admin');
  const [rollingBack, setRollingBack] = useState<string | null>(null);

  const loadFlags = useCallback(async () => {
    try {
      const data = await api.listFlags();
      setFlags(data);
      setError(null);
      setSelectedKey((current) => current ?? (data.length > 0 ? data[0].key : null));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reach feature-flag-service.');
    }
  }, []);

  const loadAudit = useCallback(async (key: string) => {
    setLoadingAudit(true);
    try {
      setAudit(await api.getAudit(key));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load audit history.');
    } finally {
      setLoadingAudit(false);
    }
  }, []);

  useEffect(() => {
    loadFlags();
  }, [loadFlags]);

  useEffect(() => {
    if (selectedKey) loadAudit(selectedKey);
  }, [selectedKey, loadAudit]);

  async function handleRollback(entry: AuditEntry) {
    if (!selectedKey) return;
    setRollingBack(entry.id);
    try {
      await api.rollback(selectedKey, entry.id, actor.trim() || 'admin');
      await Promise.all([loadFlags(), loadAudit(selectedKey)]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Rollback failed.');
    } finally {
      setRollingBack(null);
    }
  }

  const selectedFlag = flags.find((f) => f.key === selectedKey) ?? null;

  return (
    <main className="page">
      <header className="header">
        <h1>Feature Flags</h1>
        <p className="subtitle">connected to {api.baseUrl}</p>
      </header>

      {error && <div className="banner error">{error}</div>}

      <div className="layout">
        <section className="panel flag-list">
          <h2>Flags</h2>
          <ul>
            {flags.map((flag) => (
              <li key={flag.key}>
                <button
                  className={flag.key === selectedKey ? 'flag-button active' : 'flag-button'}
                  onClick={() => setSelectedKey(flag.key)}
                >
                  <span className={`dot ${flag.enabled ? 'on' : 'off'}`} aria-hidden />
                  <span className="flag-name">{flag.name}</span>
                  <span className="flag-pct">{flag.rolloutPercentage}%</span>
                </button>
              </li>
            ))}
            {flags.length === 0 && !error && <li className="empty">No flags yet.</li>}
          </ul>
        </section>

        <section className="panel detail">
          {selectedFlag ? (
            <>
              <h2>{selectedFlag.name}</h2>
              <p className="flag-key">{selectedFlag.key}</p>
              <p className="description">{selectedFlag.description || <em>No description</em>}</p>

              <dl className="meta">
                <dt>Enabled</dt>
                <dd>{selectedFlag.enabled ? 'yes' : 'no'}</dd>
                <dt>Rollout</dt>
                <dd>{selectedFlag.rolloutPercentage}%</dd>
                <dt>Last updated</dt>
                <dd>{new Date(selectedFlag.updatedAt).toLocaleString()}</dd>
              </dl>

              <div className="actor-row">
                <label htmlFor="actor">Acting as</label>
                <input id="actor" value={actor} onChange={(e) => setActor(e.target.value)} />
              </div>

              <h3>Audit history</h3>
              {loadingAudit ? (
                <p>Loading…</p>
              ) : (
                <table className="audit-table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Action</th>
                      <th>Actor</th>
                      <th>Resulting state</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.map((entry, i) => (
                      <tr key={entry.id} className={i === 0 ? 'current' : undefined}>
                        <td>{new Date(entry.createdAt).toLocaleString()}</td>
                        <td>
                          {entry.action}
                          {entry.rollbackOf ? ` (of ${entry.rollbackOf.slice(0, 8)})` : ''}
                        </td>
                        <td>{entry.actor}</td>
                        <td>
                          {entry.newState.enabled ? 'on' : 'off'} · {entry.newState.rolloutPercentage}%
                        </td>
                        <td>
                          {i === 0 ? (
                            <span className="badge">current</span>
                          ) : (
                            <button
                              className="rollback-button"
                              disabled={rollingBack === entry.id}
                              onClick={() => handleRollback(entry)}
                            >
                              {rollingBack === entry.id ? 'Rolling back…' : 'Roll back to this'}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {audit.length === 0 && (
                      <tr>
                        <td colSpan={5} className="empty">
                          No audit entries yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </>
          ) : (
            <p>Select a flag to see its history.</p>
          )}
        </section>
      </div>
    </main>
  );
}
