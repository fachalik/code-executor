export type Language = "javascript" | "typescript" | "python";

export type Engine = "piston" | "quickjs" | "isolated-vm";

export interface ExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: string | null;
  engine: Engine;
  language: Language;
  /** Sandbox engines only: the module's default export, handed back to the caller. */
  result?: unknown;
  /** Sandbox engines only: present when the run did not succeed. */
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  meta?: {
    status?: string;
    timeMs?: number;
    memoryKb?: number;
    /** isolated-vm only: V8 CPU time burned inside the isolate. */
    cpuMs?: number;
    truncated?: boolean;
  };
}

export interface ExecuteRequest {
  code: string;
  language?: Language;
  platform?: "piston" | "quickjs" | "isolated-vm";
  /** Sandbox engines only: exposed to the code as the global `env` object. */
  env?: Record<string, unknown>;
}
