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
  port: num(process.env.PORT, 3003),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",

  // ── Per-execution ceilings ────────────────────────────────────────────────
  defaultTimeoutMs: num(process.env.ISOLATEDVM_TIMEOUT_MS, 5_000),
  maxTimeoutMs: num(process.env.ISOLATEDVM_MAX_TIMEOUT_MS, 10_000),

  /**
   * V8 refuses to build an isolate under 8 MB, and a heap that small dies during
   * bootstrap rather than during the user's code — so that is the floor here too.
   */
  minMemoryBytes: 8 * 1024 * 1024,
  defaultMemoryBytes: num(process.env.ISOLATEDVM_MEMORY_BYTES, 64 * 1024 * 1024),
  maxMemoryBytes: num(process.env.ISOLATEDVM_MAX_MEMORY_BYTES, 128 * 1024 * 1024),

  // ── Request ceilings ──────────────────────────────────────────────────────
  maxCodeBytes: num(process.env.ISOLATEDVM_MAX_CODE_BYTES, 65_536),
  maxOutputBytes: num(process.env.ISOLATEDVM_MAX_OUTPUT_BYTES, 256 * 1024),

  /**
   * Unlike the QuickJS-WASM sandbox, an isolate evaluates on its own thread, so
   * a CPU-bound script does NOT pin this process's event loop. Concurrency is
   * therefore bounded by cores and by heap (`maxConcurrent * maxMemoryBytes` is
   * the worst case this container must survive), not by the event loop.
   */
  maxConcurrent: num(process.env.ISOLATEDVM_MAX_CONCURRENT, 8),
  maxQueueDepth: num(process.env.ISOLATEDVM_MAX_QUEUE_DEPTH, 32),
  /** How long a request may wait for a slot before it is shed with a 429. */
  queueTimeoutMs: num(process.env.ISOLATEDVM_QUEUE_TIMEOUT_MS, 10_000),
} as const;

export const clamp = (value: number, max: number, min = 1): number =>
  Math.max(min, Math.min(value, max));
