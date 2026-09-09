import variant from "@jitl/quickjs-ng-wasmfile-release-sync";
import { loadQuickJs, type SandboxOptions } from "@sebastianwessel/quickjs";
import { newVariant } from "quickjs-emscripten-core";
import { config } from "../config";
import type { ExecuteResult, ExecuteStatus, Language } from "../types";

export interface RunOptions {
  language: Language;
  timeoutMs: number;
  memoryLimitBytes: number;
  env: Record<string, unknown>;
}

/**
 * How long past the guest's own deadline we wait before giving up on the
 * library's teardown path and answering the caller anyway. The guest loop is
 * already stopped by QuickJS's interrupt handler at `timeoutMs`; this only
 * covers a host-side hang while unwinding.
 */
const HOST_GRACE_MS = 2_000;

const WASM_PAGE_BYTES = 64 * 1024;

/**
 * `ctx.runtime.setMemoryLimit()` is a *logical* ceiling QuickJS checks between
 * allocations — it is not a hard cap on the WASM linear memory backing it.
 * Measured directly: a script doing many small allocations overshoot the
 * configured limit by ~3x before QuickJS notices; a script doing few large
 * ones (e.g. `new Array(1e6).fill(1)` in a loop, which forces a real dense
 * backing store instead of a lazy one) overshot a 64 MB limit to 655 MB+ RSS,
 * because a single realloc can jump the WASM heap far past the threshold
 * before any check runs, and WASM memory never shrinks back once grown.
 *
 * The only thing that actually bounds that is the WASM memory object itself.
 * Every execution already gets a fresh module (see the comment below), so a
 * fresh `WebAssembly.Memory` with an explicit `maximum` costs nothing extra
 * and turns "shouldn't grow past X" into "physically cannot grow past X" —
 * once `memory.grow()` fails, the allocation fails and QuickJS reports a
 * normal, catchable "out of memory" instead of the host ever seeing the
 * runaway growth. Sized above `memoryLimitBytes` so the request's own
 * (per-request-tunable) logical limit is still what a well-behaved overshoot
 * hits first; this is the backstop for the pattern that evades it.
 */
const WASM_MEMORY_CEILING_RATIO = 1.5;
const WASM_INITIAL_PAGES = 256; // 16 MB — enough to boot the module; grows from here.

const wasmMaxPages = (memoryLimitBytes: number): number =>
  Math.ceil((memoryLimitBytes * WASM_MEMORY_CEILING_RATIO) / WASM_PAGE_BYTES);

/** Rough `console.log` formatting — enough to read, never throws. */
const formatArg = (arg: unknown): string => {
  if (typeof arg === "string") return arg;
  if (typeof arg === "bigint") return `${arg}n`;
  if (arg === undefined) return "undefined";
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
};

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

  private push(target: string[], args: unknown[]): void {
    if (this.remaining <= 0) {
      this.truncated = true;
      return;
    }
    const line = `${args.map(formatArg).join(" ")}\n`;
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

  /** Wired into `SandboxOptions.console` so guest logs never touch host stdio. */
  get console(): SandboxOptions["console"] {
    const toOut = (...args: unknown[]) => this.push(this.out, args);
    const toErr = (...args: unknown[]) => this.push(this.err, args);
    return {
      log: toOut,
      info: toOut,
      debug: toOut,
      trace: toOut,
      dir: toOut,
      table: toOut,
      warn: toErr,
      error: toErr,
    };
  }
}

const classify = (
  error: { name: string; message: string },
  isSyntaxError: boolean,
  hitMemoryWatchdog: boolean
): ExecuteStatus => {
  if (isSyntaxError) return "syntax_error";
  // The watchdog below stops the guest via the same interrupt path the
  // library uses for the CPU deadline, so the resulting error is normalized
  // to "ExecutionTimeout" same as a real timeout. The flag disambiguates.
  if (hitMemoryWatchdog) return "out_of_memory";
  if (error.name === "ExecutionTimeout") return "timeout";
  if (/out of memory/i.test(error.message)) return "out_of_memory";
  return "runtime_error";
};

/**
 * Fraction of `executionTimeout` between re-checks of actual memory usage
 * inside the interrupt handler. QuickJS polls the handler on essentially
 * every bytecode dispatch, so checking on every call would mean thousands of
 * `computeMemoryUsage()` calls a second; throttling to this cadence keeps the
 * watchdog's overhead negligible for benign scripts while still catching a
 * runaway within a few tens of milliseconds of crossing the ceiling — far
 * inside the margin QuickJS's own malloc-time check leaves.
 */
const MEMORY_CHECK_INTERVAL_MS = 20;

/**
 * Runs untrusted code in a QuickJS-WASM sandbox and returns a process-like
 * result.
 *
 * A fresh WASM module is built per call rather than shared across requests.
 * It costs well under a millisecond, and it matters: when a guest exhausts its
 * memory limit on a *reused* module, QuickJS trips an assertion while freeing
 * the runtime and emscripten `abort()`s the module for every later caller. Per
 * request, an OOM stays a normal error response.
 */
export async function runQuickJs(
  code: string,
  options: RunOptions
): Promise<ExecuteResult> {
  const startedAt = Date.now();
  const output = new OutputCollector();

  const sandboxOptions: SandboxOptions = {
    executionTimeout: options.timeoutMs,
    memoryLimit: options.memoryLimitBytes,
    maxStackSize: config.maxStackSizeBytes,

    // ── The security posture, stated in one place ───────────────────────────
    // No network: `fetch` is present but throws "fetch has been disabled".
    allowFetch: false,
    // No filesystem: the virtual memfs is never exposed, and every `node:fs`
    // call throws "File access is disabled". The host FS is unreachable either
    // way — the guest only ever sees memfs.
    allowFs: false,
    // `http`, `net`, `child_process`, `worker_threads`, `vm` and `os` are not
    // implemented by the module loader at all, so importing one is an error.
    enableTestUtils: false,

    maxTimeoutCount: config.maxTimeoutCount,
    maxIntervalCount: config.maxIntervalCount,
    console: output.console,
    env: options.env,
    transformTypescript: options.language === "typescript",
  };

  const base = {
    engine: "quickjs" as const,
    language: options.language,
  };

  const timedOut = (): ExecuteResult => ({
    ...base,
    stdout: output.stdout,
    stderr: output.stderr,
    exitCode: 124,
    signal: "SIGKILL",
    error: {
      name: "ExecutionTimeout",
      message: `Execution exceeded the ${options.timeoutMs} ms limit.`,
    },
    meta: {
      status: "timeout",
      timeMs: Date.now() - startedAt,
      truncated: output.truncated || undefined,
    },
  });

  let watchdog: NodeJS.Timeout | undefined;

  const memoryCeilingBytes = Math.floor(
    options.memoryLimitBytes * config.memoryWatchdogRatio
  );
  const rssCeilingBytes = config.hostRssCeilingBytes;
  let hitMemoryWatchdog = false;

  try {
    // See WASM_MEMORY_CEILING_RATIO's comment: hard-cap the linear memory a
    // *fresh* module gets, sized off this request's own memoryLimitBytes.
    const cappedVariant = newVariant(variant, {
      wasmMemory: new WebAssembly.Memory({
        initial: WASM_INITIAL_PAGES,
        maximum: wasmMaxPages(options.memoryLimitBytes),
      }),
    });
    const { runSandboxed } = await loadQuickJs(cappedVariant);

    const execution = runSandboxed(async ({ ctx, evalCode }) => {
      // The library already installs an interrupt handler for the CPU
      // deadline (`sandboxOptions.executionTimeout`); replace it with one
      // that also watches memory, since this is QuickJS's own mechanism for
      // preempting a synchronous guest loop — a host-side timer can't run
      // until a blocking WASM call returns. See the ceilings' doc comments
      // in config.ts for why both a per-request and an absolute check exist.
      const deadline = Date.now() + options.timeoutMs;
      let lastMemoryCheck = 0;
      ctx.runtime.setInterruptHandler(() => {
        const now = Date.now();
        if (now > deadline) return true;
        if (now - lastMemoryCheck < MEMORY_CHECK_INTERVAL_MS) return false;
        lastMemoryCheck = now;
        // A host-level check first: cheap, and catches the case where the
        // guest's own accounting is still under its limit but the WASM
        // heap's real footprint is heading somewhere the container won't
        // survive.
        if (process.memoryUsage().rss > rssCeilingBytes) {
          hitMemoryWatchdog = true;
          return true;
        }
        try {
          const handle = ctx.runtime.computeMemoryUsage();
          const usage = ctx.dump(handle) as { memory_used_size?: number };
          handle.dispose();
          if (
            typeof usage.memory_used_size === "number" &&
            usage.memory_used_size > memoryCeilingBytes
          ) {
            hitMemoryWatchdog = true;
            return true;
          }
        } catch {
          // Can't measure — fall through to QuickJS's own malloc-time limit.
        }
        return false;
      });

      // The library injects a synthetic `process` (just `{ env, cwd }`, for
      // scripts that expect Node-style access) alongside the documented
      // `env` global this app actually exposes data through. It leaks no
      // host data — `process.env` is the same object as `env` — but its mere
      // presence lets guest code detect it's inside this particular sandbox,
      // which a "no host globals" boundary shouldn't hand out. Strip it
      // before the guest's own code runs; `env` stays.
      const stripped = ctx.evalCode("delete globalThis.process;", "/src/bootstrap.js");
      if (stripped.error) {
        stripped.error.dispose();
      } else {
        stripped.value.dispose();
      }

      const evaluated = await evalCode(code, `/src/index.${options.language === "typescript" ? "ts" : "js"}`);

      // Read while the runtime is still alive; it is gone after runSandboxed.
      let memoryKb: number | undefined;
      try {
        const handle = ctx.runtime.computeMemoryUsage();
        const usage = ctx.dump(handle) as { memory_used_size?: number };
        handle.dispose();
        if (typeof usage.memory_used_size === "number") {
          memoryKb = Math.round(usage.memory_used_size / 1024);
        }
      } catch {
        // A runtime that just ran out of memory cannot report on itself.
      }

      return { evaluated, memoryKb };
    }, sandboxOptions);

    // The guest deadline is enforced inside QuickJS; this only bounds a host
    // hang during teardown, so the request always gets an answer.
    const guard = new Promise<null>(resolve => {
      watchdog = setTimeout(() => resolve(null), options.timeoutMs + HOST_GRACE_MS);
    });

    const settled = await Promise.race([execution, guard]);
    if (settled === null) {
      console.warn("[quickjs] host watchdog fired; sandbox abandoned");
      return timedOut();
    }

    const { evaluated, memoryKb } = settled;

    if (evaluated.ok) {
      return {
        ...base,
        stdout: output.stdout,
        stderr: output.stderr,
        exitCode: 0,
        signal: null,
        result: evaluated.data,
        meta: {
          status: "success",
          timeMs: Date.now() - startedAt,
          memoryKb,
          truncated: output.truncated || undefined,
        },
      };
    }

    const status = classify(
      evaluated.error,
      evaluated.isSyntaxError === true,
      hitMemoryWatchdog
    );
    return {
      ...base,
      stdout: output.stdout,
      stderr: output.stderr,
      exitCode: status === "timeout" ? 124 : 1,
      signal: status === "timeout" ? "SIGKILL" : null,
      error: hitMemoryWatchdog
        ? {
            name: "OutOfMemory",
            message: `Execution exceeded its memory budget (~${Math.round(memoryCeilingBytes / 1024 / 1024)} MB).`,
          }
        : {
            name: evaluated.error.name,
            // The library appends the *host* stack after a "Host:" marker. That is
            // our internals, not the user's code — cut it off at the boundary.
            message: evaluated.error.message,
            stack: evaluated.error.stack?.split("\nHost:")[0],
          },
      meta: {
        status,
        timeMs: Date.now() - startedAt,
        // A runtime that hit its ceiling reports nonsense here (gigabytes
        // against an 8 MB limit), so the figure is dropped rather than shown.
        memoryKb: status === "out_of_memory" ? undefined : memoryKb,
        truncated: output.truncated || undefined,
      },
    };
  } catch (err: unknown) {
    // Reached when the WASM module itself gives up rather than returning an
    // error. The common trigger is a script interrupted at its deadline while
    // objects are still live: QuickJS trips `list_empty(&rt->gc_obj_list)` in
    // JS_FreeRuntime and emscripten `abort()`s the whole module. Because the
    // module is built per request, the damage stops here — the next caller gets
    // a clean one — but a shared module would stay dead for every later run.
    const message =
      err instanceof Error ? err.message : "QuickJS sandbox failed";

    // The memory watchdog interrupts execution the same way a deadline does,
    // so it can land on this same teardown abort. Report it as the memory
    // cap it actually was rather than falling through to the timeout guess
    // below, which keys off elapsed time and won't have tripped yet.
    if (hitMemoryWatchdog) {
      console.warn("[quickjs] sandbox aborted while unwinding a memory watchdog trip:", message);
      return {
        ...base,
        stdout: output.stdout,
        stderr: output.stderr,
        exitCode: 1,
        signal: null,
        error: {
          name: "OutOfMemory",
          message: `Execution exceeded its memory budget (~${Math.round(memoryCeilingBytes / 1024 / 1024)} MB).`,
        },
        meta: {
          status: "out_of_memory",
          timeMs: Date.now() - startedAt,
          truncated: output.truncated || undefined,
        },
      };
    }

    // An abort on that teardown path is a timeout as far as the caller is
    // concerned, so report it as one instead of an opaque internal error.
    if (Date.now() - startedAt >= options.timeoutMs) {
      console.warn("[quickjs] sandbox aborted while unwinding a timeout:", message);
      return timedOut();
    }

    console.error("[quickjs] sandbox failure:", message);
    return {
      ...base,
      stdout: output.stdout,
      stderr: output.stderr,
      exitCode: 1,
      signal: null,
      error: { name: "SandboxError", message },
      meta: {
        status: "internal_error",
        timeMs: Date.now() - startedAt,
        truncated: output.truncated || undefined,
      },
    };
  } finally {
    if (watchdog) clearTimeout(watchdog);
  }
}
