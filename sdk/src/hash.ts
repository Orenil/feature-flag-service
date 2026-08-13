/**
 * Deterministic rollout bucketing -- intentionally identical to
 * service/src/hash/rollout-hash.ts. The SDK evaluates locally against its
 * own cache, so it must compute the exact same bucket the service would;
 * duplicating this ~15-line pure function is cheaper and less fragile than
 * sharing a package for one algorithm both sides must never disagree on.
 * (The audit/rollback e2e test cross-checks server-side and SDK-side
 * evaluation results agree.)
 */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function fnv1a32(input: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

export function bucketFor(flagKey: string, userId: string): number {
  return fnv1a32(`${flagKey}:${userId}`) % 100;
}

export function isInRollout(flagKey: string, userId: string, rolloutPercentage: number): boolean {
  if (rolloutPercentage <= 0) return false;
  if (rolloutPercentage >= 100) return true;
  return bucketFor(flagKey, userId) < rolloutPercentage;
}
