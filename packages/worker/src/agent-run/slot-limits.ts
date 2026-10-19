/**
 * The most slots one box may run (#205). Bounds WORKER_BOX_SLOTS, the engine caps
 * that must equal it (#372) and the slot dir names a reclaim will trust.
 * A dependency-free module on purpose: config.ts and run-namespace.ts read it,
 * and suites that mock ./box-lock (spawning, fs) must not lose the constant.
 */
export const BOX_SLOTS_MAX = 16;
