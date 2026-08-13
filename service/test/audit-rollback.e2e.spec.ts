import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { AppModule } from '../src/app.module';

function cleanupDb(dbPath: string) {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
}

describe('audit log + rollback correctness', () => {
  let app: INestApplication;
  let dbPath: string;

  beforeAll(async () => {
    dbPath = path.join(os.tmpdir(), `ff-audit-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    process.env.FF_DB_PATH = dbPath;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    cleanupDb(dbPath);
  });

  it('writes one immutable audit entry per change and supports non-destructive rollback', async () => {
    const http = app.getHttpServer();

    const created = await request(http)
      .post('/flags')
      .send({ key: 'checkout-v2', name: 'Checkout v2', enabled: false, rolloutPercentage: 0, actor: 'alice' })
      .expect(201);
    expect(created.body).toMatchObject({ enabled: false, rolloutPercentage: 0 });

    const afterFirstUpdate = await request(http)
      .patch('/flags/checkout-v2')
      .send({ enabled: true, rolloutPercentage: 25, actor: 'bob' })
      .expect(200);
    expect(afterFirstUpdate.body).toMatchObject({ enabled: true, rolloutPercentage: 25 });

    const afterSecondUpdate = await request(http)
      .patch('/flags/checkout-v2')
      .send({ rolloutPercentage: 100, actor: 'carol' })
      .expect(200);
    expect(afterSecondUpdate.body.rolloutPercentage).toBe(100);

    const auditBefore = await request(http).get('/flags/checkout-v2/audit').expect(200);
    expect(auditBefore.body).toHaveLength(3);
    expect(auditBefore.body.map((e: any) => e.action)).toEqual(['update', 'update', 'create']);

    const firstUpdateEntry = auditBefore.body.find((e: any) => e.newState.rolloutPercentage === 25);
    expect(firstUpdateEntry).toBeTruthy();
    expect(firstUpdateEntry.previousState.rolloutPercentage).toBe(0);

    const rolledBack = await request(http)
      .post(`/flags/checkout-v2/rollback/${firstUpdateEntry.id}`)
      .send({ actor: 'dana' })
      .expect(201);
    expect(rolledBack.body).toMatchObject({ enabled: true, rolloutPercentage: 25 });

    const auditAfter = await request(http).get('/flags/checkout-v2/audit').expect(200);
    expect(auditAfter.body).toHaveLength(4);
    expect(auditAfter.body[0]).toMatchObject({ action: 'rollback', rollbackOf: firstUpdateEntry.id });
    expect(auditAfter.body[0].newState.rolloutPercentage).toBe(25);

    // The three pre-existing entries are byte-for-byte unchanged -- rollback
    // only appends, it never edits or removes history.
    expect(auditAfter.body.slice(1)).toEqual(auditBefore.body);

    const current = await request(http).get('/flags/checkout-v2').expect(200);
    expect(current.body.rolloutPercentage).toBe(25);
    expect(current.body.enabled).toBe(true);

    const allAudit = await request(http).get('/audit').expect(200);
    expect(allAudit.body.length).toBeGreaterThanOrEqual(4);
  });

  it('rejects an out-of-range rollout percentage and an unknown flag lookup', async () => {
    const http = app.getHttpServer();
    await request(http)
      .post('/flags')
      .send({ key: 'bad-flag', name: 'Bad', rolloutPercentage: 150, actor: 'eve' })
      .expect(400);
    await request(http).get('/flags/does-not-exist').expect(404);
  });
});
