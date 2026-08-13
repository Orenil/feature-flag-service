import { bucketFor, fnv1a32, isInRollout } from '../src/hash';

describe('rollout hash', () => {
  it('always returns a bucket in [0, 99]', () => {
    for (let i = 0; i < 500; i++) {
      const bucket = bucketFor(`flag-${i % 7}`, `user-${i}`);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThanOrEqual(99);
    }
  });

  it('is deterministic: repeated calls for the same (flag, user) pair always agree', () => {
    const pairs: Array<[string, string]> = [
      ['checkout-v2', 'user-1'],
      ['dark-mode', 'user-99'],
      ['x', 'y'],
    ];
    for (const [flagKey, userId] of pairs) {
      const first = bucketFor(flagKey, userId);
      for (let i = 0; i < 25; i++) {
        expect(bucketFor(flagKey, userId)).toBe(first);
      }
    }
  });

  it('spreads users across the bucket space rather than collapsing to one value', () => {
    const buckets = new Set<number>();
    for (let i = 0; i < 1000; i++) buckets.add(bucketFor('spread-check', `user-${i}`));
    expect(buckets.size).toBeGreaterThan(50);
  });

  it('respects rollout percentage boundaries', () => {
    expect(isInRollout('f', 'u', 0)).toBe(false);
    expect(isInRollout('f', 'u', -5)).toBe(false);
    expect(isInRollout('f', 'u', 100)).toBe(true);
    expect(isInRollout('f', 'u', 150)).toBe(true);
  });

  it('agrees with the bucket boundary: in rollout iff bucket < percentage', () => {
    for (let i = 0; i < 200; i++) {
      const userId = `user-${i}`;
      const bucket = bucketFor('boundary-check', userId);
      const pct = 37;
      expect(isInRollout('boundary-check', userId, pct)).toBe(bucket < pct);
    }
  });

  it('different inputs produce different raw hashes (sanity check)', () => {
    expect(fnv1a32('a')).not.toBe(fnv1a32('b'));
    expect(fnv1a32('flag:user-1')).not.toBe(fnv1a32('flag:user-2'));
  });
});
