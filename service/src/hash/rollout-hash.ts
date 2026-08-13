/**
 * Deterministic rollout bucketing.
 *
 * Uses FNV-1a (32-bit) over `${flagKey}:${userId}` to produce a stable
 * integer, then reduces it mod 100 to get a bucket in [0, 99]. FNV-1a is a
 * pure function of its input bytes with no seed and no process state, so the
 * same (flagKey, userId) pair always lands in the same bucket -- in this
 * request, in the next request, and after a full process restart. That's
 * what makes rollout deterministic-per-user rather than random-per-request:
 * a user who is "in" a 20% rollout stays in it every time they're evaluated,
 * instead of flapping across requests.
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a 32-bit hash, returned as an unsigned integer. */
export function fnv1a32(input: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/** Stable bucket in [0, 99] for a given flag key + user id. */
export function bucketFor(flagKey: string, userId: string): number {
  return fnv1a32(`${flagKey}:${userId}`) % 100;
}

/**
 * Whether a user falls inside a given rollout percentage for a flag.
 * rolloutPercentage <= 0 means nobody is in; >= 100 means everybody is in.
 */
export function isInRollout(flagKey: string, userId: string, rolloutPercentage: number): boolean {
  if (rolloutPercentage <= 0) return false;
  if (rolloutPercentage >= 100) return true;
  return bucketFor(flagKey, userId) < rolloutPercentage;
}
