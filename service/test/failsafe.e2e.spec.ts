import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FeatureFlagClient } from 'feature-flag-sdk';

function cleanupDb(dbPath: string) {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
}

async function waitForHealth(baseUrl: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('service did not become healthy in time');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * This test runs the *compiled* service as a genuinely separate OS process
 * (spawn, not an in-process Nest TestingModule) specifically so it can be
 * SIGKILLed mid-test -- an actual crash, not a graceful shutdown -- while
 * the SDK client (running in the Jest process) keeps evaluating flags.
 */
describe('SDK fail-safe behavior on service outage', () => {
  let child: ChildProcessWithoutNullStreams;
  let baseUrl: string;
  let dbPath: string;
  const port = 3900 + Math.floor(Math.random() * 500);

  beforeAll(async () => {
    dbPath = path.join(os.tmpdir(), `ff-failsafe-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'main.js')], {
      env: { ...process.env, PORT: String(port), FF_DB_PATH: dbPath },
      stdio: 'pipe',
    });
    await waitForHealth(baseUrl);

    await fetch(`${baseUrl}/flags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: 'legacy-checkout',
        name: 'Legacy Checkout',
        enabled: true,
        rolloutPercentage: 50,
        actor: 'seed',
      }),
    });
  });

  afterAll(() => {
    if (!child.killed) child.kill('SIGKILL');
    cleanupDb(dbPath);
  });

  it('keeps serving last-known-good cached values after the service is killed, and only falls back to the configured default for keys that were never cached', async () => {
    const client = new FeatureFlagClient({ baseUrl, defaultValue: false });
    await client.connect();

    expect(client.getCached('legacy-checkout')).toBeTruthy();
    const beforeKill = client.evaluate('legacy-checkout', 'user-1');

    // Real kill, not app.close() -- simulates a crash/outage.
    child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 500));
    await expect(fetch(`${baseUrl}/health`)).rejects.toBeTruthy();

    // Last-known-good cached value keeps being served with no network call.
    const afterKill = client.evaluate('legacy-checkout', 'user-1');
    expect(afterKill).toBe(beforeKill);
    expect(client.isConnected()).toBe(false);

    // A key that was never cached has nothing to fall back on except the
    // client's configured default.
    expect(client.evaluate('never-seen-flag', 'user-1', true)).toBe(true);
    expect(client.evaluate('another-unseen-flag', 'user-1')).toBe(false); // options.defaultValue

    client.disconnect();
  });
});
