/**
 * Every limit is env-driven so the deployment can tighten them without a rebuild.
 * Request-supplied values are clamped to the `max*` ceilings — a caller can ask
 * for less than the default, never for more.
 */

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const config = {
  port: num(process.env.PORT, 3002),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",

  // ── Per-execution ceilings ────────────────────────────────────────────────
  defaultTimeoutMs: num(process.env.QUICKJS_TIMEOUT_MS, 5_000),
  maxTimeoutMs: num(process.env.QUICKJS_MAX_TIMEOUT_MS, 10_000),

  defaultMemoryBytes: num(process.env.QUICKJS_MEMORY_BYTES, 64 * 1024 * 1024),
  maxMemoryBytes: num(process.env.QUICKJS_MAX_MEMORY_BYTES, 128 * 1024 * 1024),

  /**
   * QuickJS aborts with a RangeError once the guest call stack passes this.
   * Cheap insurance against runaway recursion chewing through the memory limit.
   */
  maxStackSizeBytes: num(process.env.QUICKJS_MAX_STACK_BYTES, 1024 * 1024),

  // ── Request ceilings ──────────────────────────────────────────────────────
  maxCodeBytes: num(process.env.QUICKJS_MAX_CODE_BYTES, 65_536),
  maxOutputBytes: num(process.env.QUICKJS_MAX_OUTPUT_BYTES, 256 * 1024),

  /**
   * Guest code runs as a synchronous WASM call, so a CPU-bound script blocks
   * this process's event loop for its whole timeout. Concurrency past a handful
   * buys nothing and just deepens the latency tail — queue instead, and shed
   * load once the queue is full.
   */
  maxConcurrent: num(process.env.QUICKJS_MAX_CONCURRENT, 4),
  maxQueueDepth: num(process.env.QUICKJS_MAX_QUEUE_DEPTH, 16),
  /** How long a request may wait for a slot before it is shed with a 429. */
  queueTimeoutMs: num(process.env.QUICKJS_QUEUE_TIMEOUT_MS, 10_000),

  /**
   * Timers are host functions injected into the guest, so an unbounded number of
   * them is a host-side resource leak. The library caps concurrent live ones.
   */
  maxTimeoutCount: num(process.env.QUICKJS_MAX_TIMEOUT_COUNT, 20),
  maxIntervalCount: num(process.env.QUICKJS_MAX_INTERVAL_COUNT, 10),
} as const;

export const clamp = (value: number, max: number): number =>
  Math.max(1, Math.min(value, max));
