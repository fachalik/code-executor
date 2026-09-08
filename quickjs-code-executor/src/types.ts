export type Language = "javascript" | "typescript";

export type Engine = "quickjs";

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
   * Injected into the guest as the global `env` object.
   * This is how the "Execute Code" node hands input data to user code:
   *   `const { applicant } = env`
   */
  env?: Record<string, unknown>;
  /** Clamped to QUICKJS_MAX_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Clamped to QUICKJS_MAX_MEMORY_BYTES. */
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
   * The module's default export, serialized back to the host.
   *   `export default { score: 720 }`  ->  `result: { score: 720 }`
   * `undefined` when the code exports nothing.
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
    /** True when stdout/stderr hit QUICKJS_MAX_OUTPUT_BYTES and was cut short. */
    truncated?: boolean;
  };
}
