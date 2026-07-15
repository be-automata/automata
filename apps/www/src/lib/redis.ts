import { env } from "@terragon/env/apps-www";
import { Redis } from "@upstash/redis";

type SetOptions = { nx?: boolean; xx?: boolean; ex?: number; px?: number };

/**
 * In-memory, single-node stand-in for the Upstash Redis client, used when
 * `REDIS_URL` is unconfigured (self-hosted single-tenant deployments).
 *
 * It implements only the surface this app actually calls
 * (get/set/del/incr/decr/expire/ttl/keys/sadd/srem/smembers/pipeline). Single-node
 * counters are correct for a single box, which is the only topology this fallback
 * targets — it is intentionally not durable or distributed. The point is that a
 * Redis-less deployment fails OPEN (locks always acquire, limiters never trip)
 * instead of bricking the core task lifecycle.
 */
function createInMemoryRedis(): Redis {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const expiries = new Map<string, number>();

  const isExpired = (key: string): boolean => {
    const at = expiries.get(key);
    if (at === undefined) return false;
    if (Date.now() < at) return false;
    store.delete(key);
    sets.delete(key);
    expiries.delete(key);
    return true;
  };

  const rawGet = (key: string): string | undefined => {
    if (isExpired(key)) return undefined;
    return store.get(key);
  };

  const setValue = (key: string, value: unknown, opts?: SetOptions) => {
    isExpired(key);
    const exists = store.has(key);
    if (opts?.nx && exists) return null;
    if (opts?.xx && !exists) return null;
    store.set(key, JSON.stringify(value));
    if (opts?.ex !== undefined) expiries.set(key, Date.now() + opts.ex * 1000);
    else if (opts?.px !== undefined) expiries.set(key, Date.now() + opts.px);
    else expiries.delete(key);
    return "OK" as const;
  };

  const getValue = (key: string) => {
    const raw = rawGet(key);
    if (raw === undefined) return null;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  };

  const changeBy = (key: string, delta: number) => {
    const raw = rawGet(key);
    const current = raw === undefined ? 0 : Number(JSON.parse(raw));
    const next = (Number.isFinite(current) ? current : 0) + delta;
    store.set(key, JSON.stringify(next));
    return next;
  };

  const expire = (key: string, seconds: number) => {
    if (rawGet(key) === undefined && !sets.has(key)) return 0;
    expiries.set(key, Date.now() + seconds * 1000);
    return 1;
  };

  const del = (...keys: string[]) => {
    let removed = 0;
    for (const key of keys) {
      if (store.delete(key) || sets.delete(key)) removed++;
      expiries.delete(key);
    }
    return removed;
  };

  const sadd = (key: string, ...members: unknown[]) => {
    isExpired(key);
    const set = sets.get(key) ?? new Set<string>();
    let added = 0;
    for (const m of members) {
      const v = String(m);
      if (!set.has(v)) {
        set.add(v);
        added++;
      }
    }
    sets.set(key, set);
    return added;
  };

  const srem = (key: string, ...members: unknown[]) => {
    isExpired(key);
    const set = sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const m of members) {
      if (set.delete(String(m))) removed++;
    }
    return removed;
  };

  const smembers = (key: string) => {
    isExpired(key);
    return [...(sets.get(key) ?? [])];
  };

  const ttl = (key: string) => {
    if (rawGet(key) === undefined && !sets.has(key)) return -2;
    const at = expiries.get(key);
    if (at === undefined) return -1;
    return Math.max(0, Math.ceil((at - Date.now()) / 1000));
  };

  const keys = (pattern: string) => {
    const regex = new RegExp(
      "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
    );
    const all = new Set([...store.keys(), ...sets.keys()]);
    return [...all].filter((k) => !isExpired(k) && regex.test(k));
  };

  const pipeline = () => {
    const ops: Array<() => unknown> = [];
    const chain = {
      set: (key: string, value: unknown, opts?: SetOptions) => {
        ops.push(() => setValue(key, value, opts));
        return chain;
      },
      get: (key: string) => {
        ops.push(() => getValue(key));
        return chain;
      },
      incr: (key: string) => {
        ops.push(() => changeBy(key, 1));
        return chain;
      },
      decr: (key: string) => {
        ops.push(() => changeBy(key, -1));
        return chain;
      },
      expire: (key: string, seconds: number) => {
        ops.push(() => expire(key, seconds));
        return chain;
      },
      sadd: (key: string, ...members: unknown[]) => {
        ops.push(() => sadd(key, ...members));
        return chain;
      },
      srem: (key: string, ...members: unknown[]) => {
        ops.push(() => srem(key, ...members));
        return chain;
      },
      del: (...ks: string[]) => {
        ops.push(() => del(...ks));
        return chain;
      },
      exec: async () => ops.map((op) => op()),
    };
    return chain;
  };

  const impl = {
    get: async (key: string) => getValue(key),
    set: async (key: string, value: unknown, opts?: SetOptions) =>
      setValue(key, value, opts),
    del: async (...ks: string[]) => del(...ks),
    incr: async (key: string) => changeBy(key, 1),
    decr: async (key: string) => changeBy(key, -1),
    expire: async (key: string, seconds: number) => expire(key, seconds),
    ttl: async (key: string) => ttl(key),
    keys: async (pattern: string) => keys(pattern),
    sadd: async (key: string, ...members: unknown[]) => sadd(key, ...members),
    srem: async (key: string, ...members: unknown[]) => srem(key, ...members),
    smembers: async (key: string) => smembers(key),
    pipeline,
    multi: pipeline,
  };

  return impl as unknown as Redis;
}

export const redis: Redis = env.REDIS_URL.trim()
  ? new Redis({ url: env.REDIS_URL, token: env.REDIS_TOKEN })
  : createInMemoryRedis();
