export type Language = "javascript" | "typescript";

export type Engine = "isolated-vm";

/** Why an execution ended. Mirrors what the caller needs to branch on. */
export type ExecuteStatus =
  | "success"
  | "runtime_error"
  | "syntax_error"
  | "timeout"
  | "out_of_memory"
  | "internal_error";

export interface ExecuteRequest {
  code: string;
  language?: Language;
  /**
   * Injected into the isolate as the global `env` object.
   * This is how the "Execute Code" node hands input data to user code:
   *   `const { applicant } = env`
   */
  env?: Record<string, unknown>;
  /** Clamped to ISOLATEDVM_MAX_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Clamped to ISOLATEDVM_MAX_MEMORY_BYTES. */
  memoryLimitBytes?: number;
}

export interface ExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: string | null;
  engine: Engine;
  language: Language;
  /**
   * The module's default export, copied back out of the isolate.
   *   `export default { score: 720 }`  ->  `result: { score: 720 }`
   * `undefined` when the code exports nothing, or when the export holds
   * something that cannot cross the isolate boundary (a function, a class).
   */
  result?: unknown;
  /** Present only when the run did not succeed. */
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  meta: {
    status: ExecuteStatus;
    timeMs: number;
    memoryKb?: number;
    /** V8 CPU time actually burned inside the isolate, in ms. */
    cpuMs?: number;
    /** True when stdout/stderr hit ISOLATEDVM_MAX_OUTPUT_BYTES and was cut short. */
    truncated?: boolean;
  };
}
