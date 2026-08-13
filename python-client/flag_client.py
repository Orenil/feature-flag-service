"""
Minimal Python client for feature-flag-service.

Illustrative/optional: demonstrates that the deterministic rollout algorithm
and the REST contract are trivial to reimplement in a second language,
which is the whole point of the "polyglot SDK" claim. It is intentionally
not feature-complete (no push-based invalidation over the websocket channel
-- a Python client would use `python-socketio` for that in a real build;
left out here to keep this illustrative rather than a second full SDK).

Usage:
    from flag_client import FeatureFlagClient

    client = FeatureFlagClient("http://localhost:3000")
    client.sync()  # REST pull of current flag state
    is_enabled = client.evaluate("checkout-v2", user_id="user-42", default=False)

Run standalone against a running service:
    python3 flag_client.py http://localhost:3000 checkout-v2 user-42
"""

from __future__ import annotations

import sys
import urllib.request
import json
from typing import Optional

FNV_OFFSET_BASIS = 0x811C9DC5
FNV_PRIME = 0x01000193
MASK_32 = 0xFFFFFFFF


def fnv1a32(text: str) -> int:
    """Same FNV-1a 32-bit hash as the TypeScript service/SDK. Pure, no seed."""
    h = FNV_OFFSET_BASIS
    for byte in text.encode("utf-8"):
        h ^= byte
        h = (h * FNV_PRIME) & MASK_32
    return h


def bucket_for(flag_key: str, user_id: str) -> int:
    return fnv1a32(f"{flag_key}:{user_id}") % 100


def is_in_rollout(flag_key: str, user_id: str, rollout_percentage: float) -> bool:
    if rollout_percentage <= 0:
        return False
    if rollout_percentage >= 100:
        return True
    return bucket_for(flag_key, user_id) < rollout_percentage


class FeatureFlagClient:
    """REST-polling client: no local cache invalidation stream, just a
    warm-cache-on-sync + locally computed deterministic evaluation, matching
    the same fail-safe contract as the TypeScript SDK (stale cache beats no
    cache; a configured default is used only when nothing is cached yet)."""

    def __init__(self, base_url: str, default_value: bool = False, timeout: float = 3.0):
        self.base_url = base_url.rstrip("/")
        self.default_value = default_value
        self.timeout = timeout
        self._cache: dict[str, dict] = {}

    def sync(self) -> None:
        """Pull the full flag list. Failures leave the existing cache untouched."""
        try:
            with urllib.request.urlopen(f"{self.base_url}/flags", timeout=self.timeout) as resp:
                flags = json.loads(resp.read().decode("utf-8"))
            for flag in flags:
                self._cache[flag["key"]] = flag
        except Exception:
            # Service unreachable: fail-safe, keep whatever is already cached.
            pass

    def evaluate(self, flag_key: str, user_id: str, default: Optional[bool] = None) -> bool:
        flag = self._cache.get(flag_key)
        if flag is None:
            return self.default_value if default is None else default
        if not flag["enabled"]:
            return False
        return is_in_rollout(flag_key, user_id, flag["rolloutPercentage"])


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("usage: python3 flag_client.py <base_url> <flag_key> <user_id>")
        sys.exit(1)

    base_url, flag_key, user_id = sys.argv[1], sys.argv[2], sys.argv[3]
    client = FeatureFlagClient(base_url)
    client.sync()
    result = client.evaluate(flag_key, user_id)
    bucket = bucket_for(flag_key, user_id)
    print(f"flag={flag_key} user={user_id} bucket={bucket} value={result}")
