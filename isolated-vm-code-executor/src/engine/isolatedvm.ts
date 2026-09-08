import ivm from "isolated-vm";
import ts from "typescript";
import { config } from "../config";
import type { ExecuteResult, ExecuteStatus, Language } from "../types";

export interface RunOptions {
  language: Language;
  timeoutMs: number;
  memoryLimitBytes: number;
  env: Record<string, unknown>;
}

/**
 * How long past the guest's own deadline we wait before disposing the isolate
 * ourselves. V8's `timeout` option interrupts *synchronous* execution, but a
 * module that parks on a pending promise (`await new Promise(() => {})`) never
 * reaches an interrupt point, so `evaluate()` would hang forever. Disposing the
 * isolate is the only way out of that, and it rejects the pending call.
 */
const HOST_GRACE_MS = 2_000;

/**
 * Installed inside the isolate before the user's module runs.
 *
 * The isolate starts with a bare V8 global: no `console`, no timers, no
 * `require`, no `fetch`. Anything the guest gets, it gets here. `_hostWrite` is
 * captured into a closure and then deleted from the global so the guest cannot
 * reach the host callback directly and feed it non-string arguments.
 *
 * Formatting happens in here rather than on the host on purpose — an
 * `ivm.Callback` copies its arguments across the boundary, and an arbitrary
 * `console.log(someObject)` would either throw on a non-transferable value or
 * copy an unbounded graph. Strings cross cheaply and predictably.
 */
const BOOTSTRAP = `
(function (write) {
  'use strict';
  delete globalThis._hostWrite;

  const seen = new WeakSet();
  const format = (value, depth) => {
    if (typeof value === 'string') return depth === 0 ? value : JSON.stringify(value);
    if (typeof value === 'bigint') return value + 'n';
    if (typeof value === 'function') return '[Function: ' + (value.name || 'anonymous') + ']';
    if (typeof value === 'symbol') return value.toString();
    if (value === null || value === undefined) return String(value);
    if (value instanceof Error) return value.stack || (value.name + ': ' + value.message);
    if (typeof value !== 'object') return String(value);
    if (seen.has(value)) return '[Circular]';
    if (depth > 4) return Array.isArray(value) ? '[Array]' : '[Object]';

    seen.add(value);
    try {
      if (Array.isArray(value)) {
        return '[ ' + value.map(function (v) { return format(v, depth + 1); }).join(', ') + ' ]';
      }
      if (value instanceof Map) return 'Map(' + value.size + ')';
      if (value instanceof Set) return 'Set(' + value.size + ')';
      const body = Object.keys(value)
        .map(function (k) { return k + ': ' + format(value[k], depth + 1); })
        .join(', ');
      return body ? '{ ' + body + ' }' : '{}';
    } finally {
      seen.delete(value);
    }
  };

  const stream = function (name) {
    return function () {
      const args = Array.prototype.slice.call(arguments);
      write(name, args.map(function (a) { return format(a, 0); }).join(' ') + '\\n');
    };
  };

  const out = stream('out');
  const err = stream('err');

  globalThis.console = Object.freeze({
    log: out, info: out, debug: out, trace: out, dir: out, table: out,
    warn: err, error: err,
  });
})(globalThis._hostWrite);
`;

/** Transpile TS -> JS. Types are erased, never checked. */
function transpile(code: string): string {
  const { outputText, diagnostics } = ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      // ESNext keeps `export default` intact — the module form isolated-vm
      // compiles, and the shape the caller reads its result back from.
      module: ts.ModuleKind.ESNext,
      isolatedModules: true,
    },
    reportDiagnostics: true,
  });

  const fatal = diagnostics?.[0];
  if (fatal) {
    const message = ts.flattenDiagnosticMessageText(fatal.messageText, " ");
    const error = new Error(message);
    error.name = "SyntaxError";
    throw error;
  }
  return outputText;
}

/**
 * stdout and stderr share one byte budget so a script cannot blow up host
 * memory by writing to both. Once the budget is gone, further writes are
 * dropped and `truncated` is latched.
 */
class OutputCollector {
  private readonly out: string[] = [];
  private readonly err: string[] = [];
  private remaining = config.maxOutputBytes;
  truncated = false;

  write(stream: string, line: string): void {
    if (this.remaining <= 0) {
      this.truncated = true;
      return;
    }
    const target = stream === "err" ? this.err : this.out;
    const size = Buffer.byteLength(line);
    if (size > this.remaining) {
      target.push(`${line.slice(0, this.remaining)}\n...[output truncated]\n`);
      this.remaining = 0;
      this.truncated = true;
      return;
    }
    target.push(line);
    this.remaining -= size;
  }

  get stdout(): string {
    return this.out.join("");
  }

  get stderr(): string {
    return this.err.join("");
  }
}

const isTimeout = (message: string): boolean =>
  /script execution timed out|execution timed out/i.test(message);

const isOutOfMemory = (message: string): boolean =>
  /memory limit|out of memory|heap out of memory|array buffer allocation failed/i.test(
    message,
  );

const classify = (name: string, message: string): ExecuteStatus => {
  if (isTimeout(message)) return "timeout";
  if (isOutOfMemory(message)) return "out_of_memory";
  if (name === "SyntaxError") return "syntax_error";
  return "runtime_error";
};

/**
 * An error thrown inside the isolate carries the host's frames after the
 * `<isolated-vm boundary>` marker — our own file paths, which are our internals
 * and not the user's code. Cut the stack off at the boundary.
 */
const trimStack = (stack: string | undefined): string | undefined => {
  if (!stack) return undefined;
  const trimmed = stack.split(/\n\s*at \(<isolated-vm boundary>\)/)[0];
  return trimmed.trimEnd() || undefined;
};

/** Isolate errors arrive as plain objects across the boundary as often as Errors. */
function describe(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return {
      name: err.name || "Error",
      message: err.message,
      stack: trimStack(err.stack),
    };
  }
  if (err && typeof err === "object") {
    const e = err as { name?: unknown; message?: unknown; stack?: unknown };
    return {
      name: typeof e.name === "string" ? e.name : "Error",
      message: typeof e.message === "string" ? e.message : String(err),
      stack: trimStack(typeof e.stack === "string" ? e.stack : undefined),
    };
  }
  return { name: "Error", message: String(err) };
}

/** Heap and CPU figures, read while the isolate is still alive. */
function usage(isolate: ivm.Isolate | undefined): {
  memoryKb?: number;
  cpuMs?: number;
} {
  if (!isolate || isolate.isDisposed) return {};
  try {
    const stats = isolate.getHeapStatisticsSync();
    return {
      memoryKb: Math.round(Number(stats.used_heap_size) / 1024),
      // `cpuTime` is nanoseconds, as a bigint.
      cpuMs: Math.round(Number(isolate.cpuTime) / 1e6),
    };
  } catch {
    return {};
  }
}

/**
 * Runs untrusted code in a fresh V8 isolate and returns a process-like result.
 *
 * One isolate per request, always disposed. An isolate is a complete V8 heap of
 * its own with no reference to this process's globals, so there is nothing to
 * reset between runs and nothing a previous script can leave behind for the next
 * one. It also means a script that exhausts its heap kills only its own isolate.
 */
export async function runIsolatedVm(
  code: string,
  options: RunOptions,
): Promise<ExecuteResult> {
  const startedAt = Date.now();
  const output = new OutputCollector();

  const base = {
    engine: "isolated-vm" as const,
    language: options.language,
  };

  const finish = (
    status: ExecuteStatus,
    extra: Partial<ExecuteResult> = {},
    meta: Partial<ExecuteResult["meta"]> = {},
  ): ExecuteResult => ({
    ...base,
    stdout: output.stdout,
    stderr: output.stderr,
    exitCode: status === "success" ? 0 : status === "timeout" ? 124 : 1,
    signal: status === "timeout" ? "SIGKILL" : null,
    ...extra,
    meta: {
      status,
      timeMs: Date.now() - startedAt,
      truncated: output.truncated || undefined,
      ...meta,
    },
  });

  // ── Transpile before spending an isolate on code that cannot parse ────────
  let source = code;
  if (options.language === "typescript") {
    try {
      source = transpile(code);
    } catch (err: unknown) {
      return finish("syntax_error", { error: describe(err) });
    }
  }

  let isolate: ivm.Isolate | undefined;
  let watchdog: NodeJS.Timeout | undefined;
  let disposedByWatchdog = false;

  try {
    isolate = new ivm.Isolate({
      // isolated-vm takes megabytes. The floor is V8's, not ours.
      memoryLimit: Math.max(
        8,
        Math.round(options.memoryLimitBytes / 1024 / 1024),
      ),
    });

    // Last line of defence: a module that never yields cannot be interrupted,
    // so tear the whole isolate down and let `evaluate()` reject.
    watchdog = setTimeout(() => {
      disposedByWatchdog = true;
      try {
        if (isolate && !isolate.isDisposed) isolate.dispose();
      } catch {
        // Racing a normal completion; the result path already has its answer.
      }
    }, options.timeoutMs + HOST_GRACE_MS);

    const context = await isolate.createContext();
    const jail = context.global;

    // V8 hands a context a global object that does not reference itself.
    await jail.set("globalThis", jail.derefInto());
    await jail.set(
      "_hostWrite",
      new ivm.Callback((stream: string, line: string) =>
        output.write(String(stream), String(line)),
      ),
    );
    // The caller's input, deep-copied in. `release: true` frees the host-side
    // copy as soon as it lands — the isolate owns its own copy from then on.
    await jail.set(
      "env",
      new ivm.ExternalCopy(options.env).copyInto({ release: true }),
    );
    await context.eval(BOOTSTRAP, { timeout: 1_000 });

    // ── The user's module ──────────────────────────────────────────────────
    const filename = options.language === "typescript" ? "main.ts" : "main.js";
    const module = await isolate.compileModule(source, { filename });

    // No resolver: there is nothing to import. `node:fs`, `http` and friends do
    // not exist in an isolate at all, so this only has to refuse politely.
    await module.instantiate(context, (specifier) => {
      throw new Error(
        `Cannot import "${specifier}": this sandbox has no module resolver.`,
      );
    });

    // `promise: true` matters: without it, a module whose top-level `await`
    // never settles resolves here immediately and reports a bogus success. With
    // it, evaluation is awaited to completion — and a hang falls to the watchdog.
    await module.evaluate({ timeout: options.timeoutMs, promise: true });

    // ── Read the result while the isolate is still alive ───────────────────
    let result: unknown;
    try {
      result = await module.namespace.get("default", { copy: true });
    } catch (err: unknown) {
      // A module still parked on an unsettled top-level `await` never finished
      // initialising its exports, and V8 reports the binding as missing rather
      // than as `undefined` (which is what a module with no default export
      // gives). Nothing in this isolate can ever settle that promise — there
      // are no timers, no I/O, nothing to wake it — so `evaluate()` returns as
      // soon as the microtask queue drains and the run is stuck, not finished.
      if (describe(err).name === "ReferenceError") {
        return finish(
          "runtime_error",
          {
            error: {
              name: "UnsettledTopLevelAwait",
              message:
                "The module is still awaiting a promise that can never settle. " +
                "This sandbox has no timers, no I/O and no network, so only an " +
                "already-resolvable promise can be awaited at the top level.",
            },
          },
          usage(isolate),
        );
      }
      // Otherwise: a default export holding a function, a class, or anything
      // else V8 cannot structured-clone. The run succeeded; the value does not
      // survive the boundary.
      result = undefined;
    }

    return finish("success", { result }, usage(isolate));
  } catch (err: unknown) {
    const info = describe(err);

    // A watchdog dispose surfaces as "Isolate is disposed" — which reads as an
    // internal fault but is really the deadline, so report it as one.
    if (disposedByWatchdog) {
      console.warn("[isolated-vm] host watchdog fired; isolate disposed");
      return finish("timeout", {
        error: {
          name: "ExecutionTimeout",
          message: `Execution exceeded the ${options.timeoutMs} ms limit.`,
        },
      });
    }

    const status = classify(info.name, info.message);
    if (status === "timeout") {
      return finish("timeout", {
        error: {
          name: "ExecutionTimeout",
          message: `Execution exceeded the ${options.timeoutMs} ms limit.`,
          stack: info.stack,
        },
      });
    }

    return finish(
      status,
      { error: info },
      // A heap that just hit its ceiling reports nothing trustworthy about
      // itself, so the figure is dropped rather than shown.
      status === "out_of_memory" ? {} : usage(isolate),
    );
  } finally {
    if (watchdog) clearTimeout(watchdog);
    try {
      if (isolate && !isolate.isDisposed) isolate.dispose();
    } catch {
      // Already gone.
    }
  }
}
