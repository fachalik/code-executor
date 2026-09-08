# quickjs-code-executor

Sandboxed JavaScript/TypeScript execution service. QuickJS compiled to
WebAssembly, wrapped in Express.

This is Opsi 3 minus gVisor: the isolation comes from the WASM boundary and the
interpreter's own limits, not from a container runtime. `runsc` can be layered
underneath later without changing a line of this service.

---

## Why QuickJS-WASM

- **No JIT.** QuickJS interprets; it never emits machine code at runtime, which
  removes the JIT-bug class that most V8 sandbox escapes are built on.
- **Linear memory.** The guest heap is a WASM `ArrayBuffer`. Reaching host
  memory means breaking the WASM boundary itself, not just the JS engine.
- **No host bindings unless we add them.** The engine ships with no I/O at all.
  `fetch`, timers and `console` exist only because this service injects them,
  and network and filesystem are left switched off.

---

## Quick start

```bash
npm install
npm run dev          # :3002
```

```bash
curl -s localhost:3002/api/execute -H 'Content-Type: application/json' -d '{
  "code": "const { applicant } = env; console.log(\"scoring\", applicant.name); export default { score: 500 + applicant.income / 1000 }",
  "env":  { "applicant": { "name": "Alice", "income": 95000 } }
}' | jq .
```

```json
{
  "ok": true,
  "engine": "quickjs",
  "language": "javascript",
  "stdout": "scoring Alice\n",
  "stderr": "",
  "exitCode": 0,
  "signal": null,
  "result": { "score": 595 },
  "meta": { "status": "success", "timeMs": 20, "memoryKb": 154 }
}
```

Via docker compose, the service has no published port — it sits on an internal
network and is reached through the backend (`platform: "quickjs"`). To poke it
directly:

```bash
docker compose exec quickjs wget -qO- localhost:3002/health
```

---

## API

### `POST /api/execute`

| Field              | Type     | Default        | Notes                                        |
|--------------------|----------|----------------|----------------------------------------------|
| `code`             | string   | —              | Required. ES2023 module; `export default` is the return value. |
| `language`         | string   | `javascript`   | `javascript` or `typescript`.                |
| `env`              | object   | `{}`           | Exposed to the code as the global `env`.     |
| `timeoutMs`        | number   | `5000`         | Clamped to `QUICKJS_MAX_TIMEOUT_MS`.         |
| `memoryLimitBytes` | number   | `67108864`     | Clamped to `QUICKJS_MAX_MEMORY_BYTES`.       |

**A completed execution always answers `200`,** whether the code succeeded or
threw. Branch on `ok` / `meta.status`, not on the HTTP status — `4xx`/`5xx` mean
the request never ran.

| `meta.status`    | `ok`  | `exitCode` | Meaning                                  |
|------------------|-------|-----------|------------------------------------------|
| `success`        | true  | 0         | Ran to completion.                        |
| `runtime_error`  | false | 1         | Threw. `error.stack` points into the code.|
| `syntax_error`   | false | 1         | Did not parse, or imported a module that does not exist in the sandbox. |
| `timeout`        | false | 124       | Hit the deadline. `signal: "SIGKILL"`.    |
| `out_of_memory`  | false | 1         | Hit the memory ceiling.                   |
| `internal_error` | false | 1         | The sandbox itself failed. Should not happen; it is logged when it does. |

Non-200: `400` invalid request · `429` executor saturated · `500` unexpected.

### `GET /api/languages` · `GET /health`

`/health` reports live `active` and `queued` counts.

---

## Writing code for the sandbox

Code is evaluated as an **ES module**. The default export comes back as
`result`; anything logged lands in `stdout`/`stderr`.

```js
import { join } from 'path'          // bare specifiers work for built-ins

const { applicant } = env             // input arrives on the `env` global
console.log('checking', applicant.id) // -> stdout
console.error('suspicious')           // -> stderr

export default { approved: applicant.score > 700 }
```

`await` at top level is supported. TypeScript is transpiled before evaluation
(types are erased, not checked — a type error will not fail the run).

**Available:** `path`, `util`, `assert`, `buffer`, `url`, `events`,
`querystring`, `string_decoder`, plus the standard globals — `Buffer`, `URL`,
`TextEncoder`, `performance`, timers.

**Not available:** `http`, `net`, `child_process`, `worker_threads`, `vm`,
`crypto`, `os`, `zlib`, `stream`. Importing one is a module-resolution error.
`fetch` exists but always throws, and every `node:fs` call throws
`File access is disabled`.

---

## Security model

| Layer | What it stops |
|-------|---------------|
| **QuickJS interpreter** | No JIT — no runtime code generation to corrupt. |
| **WASM linear memory** | Guest heap is an `ArrayBuffer`; no host pointers. |
| **`allowFetch: false`** | `fetch` throws instead of opening a socket. |
| **`allowFs: false`** | Every `fs` call throws. The guest only ever sees an in-memory memfs — the host filesystem is not merely denied, it is not mapped. |
| **Module loader** | `http` / `net` / `child_process` / `vm` are not implemented, so there is nothing to import. |
| **`executionTimeout`** | QuickJS interrupt handler stops the interpreter mid-loop, so `while(true){}` ends at the deadline. |
| **`memoryLimit`** | Allocation past the ceiling raises `out of memory` in the guest. |
| **`maxStackSize`** | Runaway recursion hits a stack limit rather than the memory limit. |
| **Timer caps** | Bounds the host-side timers guest code can hold open at once. |
| **Container** | Internal network with no gateway, read-only rootfs, all capabilities dropped, non-root user. |

Verified by hand against the running service — network, filesystem,
`child_process`, timeout, OOM and stack limits each fail closed.

### What this does *not* give you

The WASM boundary is enforced by the **host's** WASM engine — V8, inside this
Node process. A V8 WASM escape defeats it. That is the gap gVisor was meant to
cover, and dropping it is the trade being made here: keep this service patched,
and treat the container limits above as the outer wall.

---

## Operational notes

### A fresh WASM module per execution

The library's own guidance is to load the module once and reuse it. This service
deliberately does not, because a shared module does not survive its guests:

- A guest interrupted at its deadline with objects still live trips
  `list_empty(&rt->gc_obj_list)` in `JS_FreeRuntime`, and emscripten `abort()`s.
- The same happens when a guest exhausts its memory limit.

An `abort()` kills the **module**, not just that run — on a shared module every
later request fails until the process restarts. Rebuilding per request measured
at ~0.6 ms against a ~4.8 ms baseline run, so the isolation is close to free,
and both failures become ordinary error responses. The engine also catches the
abort, so even an unanticipated one costs a single request.

### One script blocks the event loop

`ctx.evalCode` is a synchronous WASM call. While CPU-bound guest code runs, this
process serves nothing else — the interrupt handler ends the script at its
deadline, but does not yield during it. Hence `maxConcurrent`, the bounded
queue, and the queue wait timeout: a request that cannot start within
`QUICKJS_QUEUE_TIMEOUT_MS` is shed with a `429` instead of answering long after
the caller gave up. **Scale with replicas, not with `maxConcurrent`.**

### Performance

Roughly **50× slower than bare V8** on an arithmetic-heavy scoring loop
(~4.8 ms vs ~0.1 ms for 2 000 scored applicants), consistent with the 10–50×
range in the design notes. Total request cost was 20–35 ms end to end, which is
noise next to a typical workflow step. TypeScript adds ~150 ms for the transpile
on a cold `typescript` import.

Worth re-measuring against real scoring code before committing to it.

---

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `PORT` | `3002` | Listen port. |
| `CORS_ORIGIN` | `*` | CORS allowlist. |
| `QUICKJS_TIMEOUT_MS` | `5000` | Default execution deadline. |
| `QUICKJS_MAX_TIMEOUT_MS` | `10000` | Ceiling for a caller-supplied `timeoutMs`. |
| `QUICKJS_MEMORY_BYTES` | `67108864` | Default memory limit (64 MB). |
| `QUICKJS_MAX_MEMORY_BYTES` | `134217728` | Ceiling for `memoryLimitBytes` (128 MB). |
| `QUICKJS_MAX_STACK_BYTES` | `1048576` | Guest call-stack ceiling. |
| `QUICKJS_MAX_CODE_BYTES` | `65536` | Largest accepted script. |
| `QUICKJS_MAX_OUTPUT_BYTES` | `262144` | Shared stdout+stderr budget; overflow sets `meta.truncated`. |
| `QUICKJS_MAX_CONCURRENT` | `4` | Concurrent executions. |
| `QUICKJS_MAX_QUEUE_DEPTH` | `16` | Queued executions before shedding. |
| `QUICKJS_QUEUE_TIMEOUT_MS` | `10000` | Longest wait for a slot before a `429`. |
| `QUICKJS_MAX_TIMEOUT_COUNT` | `20` | Concurrent `setTimeout`s a guest may hold. |
| `QUICKJS_MAX_INTERVAL_COUNT` | `10` | Concurrent `setInterval`s a guest may hold. |

---

## Layout

```
quickjs-code-executor/
├── src/
│   ├── index.ts           # express bootstrap + WASM warm-up
│   ├── config.ts          # env-driven limits
│   ├── queue.ts           # concurrency gate + load shedding
│   ├── types.ts
│   ├── engine/quickjs.ts  # the sandbox itself
│   └── routes/execute.ts  # POST /api/execute
└── Dockerfile
```
