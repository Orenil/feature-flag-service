import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FeatureFlagClient } from 'feature-flag-sdk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppModule } from '../src/app.module';

function cleanupDb(dbPath: string) {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
}

describe('push-based propagation to connected SDK instances', () => {
  let app: INestApplication;
  let baseUrl: string;
  let dbPath: string;

  beforeAll(async () => {
    dbPath = path.join(os.tmpdir(), `ff-prop-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    process.env.FF_DB_PATH = dbPath;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    await fetch(`${baseUrl}/flags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: 'prop-test',
        name: 'Propagation Test',
        enabled: true,
        rolloutPercentage: 10,
        actor: 'seed',
      }),
    });
  });

  afterAll(async () => {
    await app.close();
    cleanupDb(dbPath);
  });

  it('propagates a flag change to 3 connected SDK instances within a bounded window, and SDK evaluation agrees with the server', async () => {
    const clients = await Promise.all(
      [0, 1, 2].map(async () => {
        const client = new FeatureFlagClient({ baseUrl });
        await client.connect();
        return client;
      }),
    );

    try {
      for (const client of clients) {
        expect(client.getCached('prop-test')?.rolloutPercentage).toBe(10);
      }

      const observedAt = clients.map(
        (client) => new Promise<number>((resolve) => client.once('update', () => resolve(Date.now()))),
      );

      const t0 = Date.now();
      await fetch(`${baseUrl}/flags/prop-test`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rolloutPercentage: 80, actor: 'ops' }),
      });

      const timestamps = await Promise.all(observedAt);
      const latenciesMs = timestamps.map((t) => t - t0);

      // eslint-disable-next-line no-console
      console.log(`[propagation-latency] change -> observed by 3 SDK instances (ms): ${latenciesMs.join(', ')}`);

      for (const [i, client] of clients.entries()) {
        expect(client.getCached('prop-test')?.rolloutPercentage).toBe(80);
        expect(latenciesMs[i]).toBeGreaterThanOrEqual(0);
        expect(latenciesMs[i]).toBeLessThan(2000);
      }

      // Cross-check: the server's evaluation for a given user agrees with
      // the SDK's fully-local evaluation for the same user, since both run
      // the identical deterministic hash.
      const userId = 'cross-check-user-1';
      const serverResult = (await fetch(`${baseUrl}/flags/prop-test/evaluate?userId=${userId}`).then((r) =>
        r.json(),
      )) as { value: boolean; bucket: number };
      const sdkResult = clients[0].evaluate('prop-test', userId);
      const sdkBucket = clients[0].bucketFor('prop-test', userId);
      expect(sdkResult).toBe(serverResult.value);
      expect(sdkBucket).toBe(serverResult.bucket);
    } finally {
      for (const client of clients) client.disconnect();
    }
  });
});
