import { execFileSync } from 'child_process';
import * as path from 'path';
import { bucketFor } from '../src/hash/rollout-hash';

/**
 * FNV-1a bucketing has no seed and touches no process state, so "restart
 * the service and check the bucket is unchanged" reduces to "run the exact
 * same compiled function in a brand new OS process." That's what the
 * second test below does: it shells out to `node` twice, each a fresh V8
 * isolate with nothing carried over, and requires the *compiled* dist
 * artifact (built by the `pretest` script) rather than re-running the
 * TypeScript source in-process.
 */
describe('deterministic rollout hashing', () => {
  const pairs: Array<[string, string]> = [
    ['new-checkout', 'user-42'],
    ['dark-mode', 'user-7'],
    ['beta-search', 'anonymous-9f3a'],
    ['checkout-v2', 'user-1000000'],
  ];

  it('returns the same bucket for the same (flag, user) pair across many in-process calls', () => {
    for (const [flagKey, userId] of pairs) {
      const first = bucketFor(flagKey, userId);
      for (let i = 0; i < 50; i++) {
        expect(bucketFor(flagKey, userId)).toBe(first);
      }
    }
  });

  it('produces the same bucket after a real process restart (fresh node process, no shared memory)', () => {
    const distHashModule = path.join(__dirname, '..', 'dist', 'hash', 'rollout-hash.js');

    const computeInFreshProcess = (flagKey: string, userId: string): number => {
      const script = `const { bucketFor } = require(${JSON.stringify(distHashModule)}); process.stdout.write(String(bucketFor(${JSON.stringify(flagKey)}, ${JSON.stringify(userId)})));`;
      return Number(execFileSync(process.execPath, ['-e', script]).toString());
    };

    for (const [flagKey, userId] of pairs) {
      const inProcess = bucketFor(flagKey, userId);
      const restart1 = computeInFreshProcess(flagKey, userId);
      const restart2 = computeInFreshProcess(flagKey, userId);
      expect(restart1).toBe(inProcess);
      expect(restart2).toBe(inProcess);
    }
  });
});
