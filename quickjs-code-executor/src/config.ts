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

  /**
   * QuickJS's own `memoryLimit` is a malloc-time check that only fires between
   * allocations, not before them — under an allocation-storm pattern (many
   * small objects rather than one big one) it has been measured overshooting
   * the configured limit by ~3x before it throws, and the WASM heap backing
   * it never shrinks back. `engine/quickjs.ts` layers a second check onto the
   * same interrupt callback QuickJS already polls for the CPU timeout, which
   * preempts a runaway guest much closer to the limit — this is the fraction
   * of `memoryLimitBytes` at which that watchdog trips.
   */
  memoryWatchdogRatio: num(process.env.QUICKJS_MEMORY_WATCHDOG_RATIO, 0.85),

  /**
   * Absolute backstop on this process's actual RSS, independent of whatever
   * memoryLimitBytes a request negotiated. Guards the case the two ceilings
   * above miss: the guest's logical usage is still under its limit but the
   * WASM heap's real footprint (fragmentation, a previous run's memory not
   * yet reclaimed) is pushing the container toward its own OOM-kill. Keep
   * this comfortably under the container memory limit in docker-compose.yml.
   */
  hostRssCeilingBytes: num(
    process.env.QUICKJS_HOST_RSS_CEILING_BYTES,
    384 * 1024 * 1024
  ),

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
