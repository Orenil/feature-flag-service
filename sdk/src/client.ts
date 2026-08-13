import { EventEmitter } from 'events';
import { io, Socket } from 'socket.io-client';
import { bucketFor, isInRollout } from './hash';

export interface Flag {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  rolloutPercentage: number;
  createdAt: string;
  updatedAt: string;
}

export interface FeatureFlagClientOptions {
  /** Base URL of the feature-flag-service, e.g. http://localhost:3000 */
  baseUrl: string;
  /** Returned by evaluate() when a flag has never been cached (cold start, no connectivity yet). */
  defaultValue?: boolean;
  /** Override fetch (mainly for tests); defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Feature flag client SDK.
 *
 * Design: on connect() it does one REST pull of every flag to warm the
 * local cache, then opens a socket.io connection and receives full flag
 * payloads pushed the instant they change (`flag:updated`) -- no polling.
 * `evaluate()` never makes a network call; it reads the in-memory cache and
 * runs the same deterministic hash the service uses, which is what gives
 * sub-millisecond evaluation latency.
 *
 * Fail-safe contract: the cache is only ever written on a successful sync
 * or a pushed update, so if the service becomes unreachable the last
 * known-good values simply keep being served. `defaultValue` is used
 * exclusively for keys that have *never* been cached (nothing to fall back
 * to yet) -- not as a response to disconnects.
 */
export class FeatureFlagClient extends EventEmitter {
  private readonly cache = new Map<string, Flag>();
  private socket: Socket | null = null;
  private connected = false;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: FeatureFlagClientOptions) {
    super();
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Warms the cache via REST, then opens the push-invalidation socket. */
  async connect(): Promise<void> {
    await this.fullSync();

    this.socket = io(this.options.baseUrl, {
      reconnection: true,
      reconnectionDelay: 150,
      reconnectionDelayMax: 1000,
      transports: ['websocket'],
    });

    this.socket.on('connect', () => {
      this.connected = true;
      // Close any gap that opened up while disconnected.
      this.fullSync().catch(() => undefined);
      this.emit('connect');
    });

    this.socket.on('disconnect', () => {
      this.connected = false;
      this.emit('disconnect');
    });

    this.socket.on('flag:updated', (flag: Flag) => {
      this.cache.set(flag.key, flag);
      this.emit('update', flag);
    });

    await new Promise<void>((resolve) => {
      if (this.connected) return resolve();
      this.socket!.once('connect', () => resolve());
      // Don't hang forever if the service is down at startup: the SDK
      // should still be usable (fail-safe / default values).
      setTimeout(resolve, 2000);
    });
  }

  private async fullSync(): Promise<void> {
    try {
      const res = await this.fetchImpl(`${this.options.baseUrl}/flags`);
      if (!res.ok) return;
      const flags = (await res.json()) as Flag[];
      for (const flag of flags) this.cache.set(flag.key, flag);
      this.emit('sync', flags);
    } catch {
      // Service unreachable at sync time: keep whatever is already cached.
      this.emit('sync-failed');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  getCached(key: string): Flag | undefined {
    return this.cache.get(key);
  }

  /** Fully local, synchronous evaluation. No network call. */
  evaluate(flagKey: string, userId: string, defaultValueOverride?: boolean): boolean {
    const flag = this.cache.get(flagKey);
    if (!flag) return defaultValueOverride ?? this.options.defaultValue ?? false;
    if (!flag.enabled) return false;
    return isInRollout(flag.key, userId, flag.rolloutPercentage);
  }

  /** Same bucket the service would compute; exposed for tests/debugging. */
  bucketFor(flagKey: string, userId: string): number {
    return bucketFor(flagKey, userId);
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
    this.connected = false;
  }
}
