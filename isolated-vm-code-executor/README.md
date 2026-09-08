# isolated-vm-code-executor

Sandboxed JavaScript/TypeScript execution service. A real V8 isolate per
request, via [`isolated-vm`](https://github.com/laverdet/isolated-vm), wrapped
in Express.

This is the counterweight to the QuickJS service. Where that one trades speed
for a smaller attack surface, this one keeps full V8 — JIT included — and buys
its isolation from V8's own isolate boundary instead.

---

## Why isolated-vm

- **A separate heap and a separate context.** An `Isolate` is a complete V8
  instance with its own heap, its own GC and no reference to this process's
  globals. It is the same primitive Chrome uses to keep one tab's JS out of
  another's — not a `vm` module `Proxy` trick that a prototype walk can escape.
- **Nothing crosses without being copied.** Values move over the boundary as
  structured clones or explicit `Reference`/`Callback` handles. There is no
  shared object graph for guest code to walk back into the host.
- **No Node bindings at all.** The isolate starts empty: no `require`, no
  `process`, no `fetch`, no `setTimeout`, no module resolver. Everything the
  guest has — just `console` and `env` — is injected on purpose in
  [`src/engine/isolatedvm.ts`](src/engine/isolatedvm.ts).
- **Full speed.** V8's JIT is live inside the isolate, so a hot loop runs at
  Node speed rather than at interpreter speed.

The cost, stated plainly: V8's JIT is exactly the attack surface QuickJS-WASM
removes. A V8 sandbox escape is an escape into *this* process. See
[Security model](#security-model).

---

## Quick start

```bash
npm install
npm run dev          # :3003
```

```bash
curl -s localhost:3003/api/execute -H 'Content-Type: application/json' -d '{
  "code": "const { applicant } = env; console.log(\"scoring\", applicant.name); export default { score: 500 + applicant.income / 1000 }",
  "env":  { "applicant": { "name": "Alice", "income": 95000 } }
}' | jq .
```

```json
{
  "ok": true,
  "engine": "isolated-vm",
  "language": "javascript",
  "stdout": "scoring Alice\n",
  "stderr": "",
  "exitCode": 0,
  "signal": null,
  "result": { "score": 595 },
  "meta": { "status": "success", "timeMs": 2, "memoryKb": 348, "cpuMs": 1 }
}
```

Via docker compose, the service has no published port — it sits on an internal
network and is reached through the backend (`platform: "isolated-vm"`). To poke
it directly:

```bash
docker compose exec isolated-vm wget -qO- localhost:3003/health
```

### `--no-node-snapshot` is not optional

Node 20+ boots from a V8 startup snapshot that `isolated-vm` cannot attach to,
and the process aborts the first time it builds an isolate. Both `npm run dev`
and `npm start` set the flag, as does the Dockerfile's `CMD`. If you launch
`dist/index.js` by hand, pass it yourself:

```bash
node --no-node-snapshot dist/index.js
```

### It is a native addon

`isolated-vm` compiles against V8's headers. Install uses a prebuilt binary
where one exists for your platform and Node version, and falls back to building
— which needs `python3`, `make` and a C++ toolchain. The Dockerfile is Debian
rather than Alpine for that reason: the musl build is not a path worth debugging
for a sandbox.

**With pnpm, the build step must be approved.** pnpm 10 refuses to run a
dependency's `install`/`postinstall` scripts by default, so `isolated-vm` lands
on disk *unbuilt* and the service dies at startup with:

```
Error: Cannot find module './out/isolated_vm'
```

That is the missing `out/isolated_vm.node`, not a bad import. This package.json
already allows it:

```json
"pnpm": { "onlyBuiltDependencies": ["isolated-vm"] }
```

If you hit it anyway — an older lockfile, a fresh clone, a different pnpm
version — force the build:

```bash
pnpm rebuild isolated-vm
```

`npm install` runs the build script without any of this.

---

## The execution contract

Code runs as an **ES module**, the same contract the QuickJS service uses:

| Direction | Mechanism |
|-----------|-----------|
| Input | the global `env` — a structured clone of the request's `env` object |
| Output | `export default` — copied back out as `result` |
| Logs | `console.log`/`.warn`/`.error` → `stdout` / `stderr` |

```js
const { applicant } = env;
console.log('scoring', applicant.name);
export default { score: 720, tier: 'A' };
```

A default export that cannot be structured-cloned (a function, a class, a
`Symbol`) is reported as `result: undefined` — the run still succeeds, the value
just does not survive the boundary.

TypeScript is transpiled with `ts.transpileModule` before it reaches the
isolate. **Types are erased, not checked**: a type error does not fail a run.

---

## Limits

Every limit is env-driven; see [`src/config.ts`](src/config.ts). Request-supplied
values are clamped to the `MAX` ceilings — a caller can ask for less than the
default, never for more.

| Variable | Default | What it bounds |
|----------|---------|----------------|
| `ISOLATEDVM_TIMEOUT_MS` | 5000 | per-execution deadline |
| `ISOLATEDVM_MAX_TIMEOUT_MS` | 10000 | ceiling a request may ask for |
| `ISOLATEDVM_MEMORY_BYTES` | 64 MB | isolate heap |
| `ISOLATEDVM_MAX_MEMORY_BYTES` | 128 MB | ceiling a request may ask for |
| `ISOLATEDVM_MAX_CODE_BYTES` | 64 KB | request body |
| `ISOLATEDVM_MAX_OUTPUT_BYTES` | 256 KB | stdout + stderr, shared budget |
| `ISOLATEDVM_MAX_CONCURRENT` | 8 | isolates running at once |
| `ISOLATEDVM_MAX_QUEUE_DEPTH` | 32 | requests waiting for a slot |
| `ISOLATEDVM_QUEUE_TIMEOUT_MS` | 10000 | how long a request waits before a 429 |

V8 refuses to build an isolate under 8 MB, so that is the floor regardless of
what is asked for.

### Three ways a run is stopped

1. **V8's interrupt.** `evaluate({ timeout })` stops synchronous execution at
   the deadline. This is what catches `while (true) {}`.
2. **The host watchdog.** A module parked on a promise never reaches an
   interrupt point, so 2 s past the deadline the isolate is disposed outright
   and the pending call rejects.
3. **Deadlock detection.** A module whose top-level `await` can never settle
   leaves its exports uninitialised, which V8 reports distinctly from "no
   default export". That is answered as `UnsettledTopLevelAwait` rather than as
   a bogus success — there are no timers and no I/O in here, so nothing could
   ever have woken it.

### Admission control

Unlike the QuickJS-WASM service, an isolate evaluates on its own thread, so a
CPU-bound script does **not** pin this process's event loop. What it does hold
is a thread and up to `MAX_MEMORY_BYTES` of heap for its whole deadline, so
`maxConcurrent × maxMemory` is the worst case the container must survive.
Overflow queues; past `MAX_QUEUE_DEPTH` or `QUEUE_TIMEOUT_MS` it is shed with a
`429`.

---

## Security model

| Layer | Mechanism |
|-------|-----------|
| **Isolate** | Separate V8 heap and context; no reference to host globals |
| **Boundary** | Values cross as structured clones; no shared object graph |
| **Globals** | Only `console` and `env` are injected — no `require`, `process`, `fetch`, timers |
| **Modules** | The resolver refuses every specifier; `node:fs`, `http` etc. do not exist in an isolate |
| **Limits** | Per-execution deadline, heap ceiling, output ceiling, admission control |
| **Container** | Internal network with no gateway, read-only rootfs, all caps dropped, non-root |

One isolate is built per request and always disposed. That is not just hygiene:
it means a script that exhausts its heap kills only its own isolate, and nothing
a previous script left behind can reach the next one.

**The honest caveat.** The isolation boundary here is V8 itself, with its JIT
running. A V8 sandbox escape — the bug class most browser exploits are built on
— is an escape into this Node process. QuickJS-WASM removes that class outright
by never emitting machine code; this service trades it back for speed and for
full modern-JS support.

Pick accordingly:

| | isolated-vm | QuickJS-WASM |
|---|---|---|
| Speed | Node speed, JIT on | interpreted, ~10-100× slower on hot loops |
| JS support | whatever V8 supports | ES2023-ish, no JIT-only features |
| Escape surface | V8 + JIT | WASM boundary (enforced by V8, but no codegen) |
| Startup | ~1 ms per isolate | ~1 ms per module |

Neither is a substitute for a container boundary if the threat model includes a
determined attacker. Both sit on an internal docker network with no gateway so
that an escape still has nowhere to go.

---

## API

### `POST /api/execute`

```json
{
  "code": "export default 1 + 1",
  "language": "javascript",
  "env": {},
  "timeoutMs": 5000,
  "memoryLimitBytes": 67108864
}
```

`language` is `javascript` (default) or `typescript`. `timeoutMs` and
`memoryLimitBytes` are optional and clamped.

Code that throws, times out or exhausts memory still answers `200` with
`ok: false` — branch on `ok`, not on the HTTP status:

| `meta.status` | `exitCode` | When |
|---------------|-----------|------|
| `success` | 0 | ran to completion |
| `runtime_error` | 1 | threw, or an unsettled top-level `await` |
| `syntax_error` | 1 | failed to parse or transpile |
| `timeout` | 124 | hit the deadline (`signal: "SIGKILL"`) |
| `out_of_memory` | 1 | exhausted the isolate heap |
| `internal_error` | 1 | the service itself failed |

A `429` means the queue is full or the wait timed out. A `400` means the request
was rejected before any isolate was built.

Stack traces are trimmed at the `<isolated-vm boundary>` marker, so a caller
sees only frames from their own code — never this service's file paths.

### `GET /api/languages`

```json
{ "languages": ["javascript", "typescript"], "engine": "isolated-vm" }
```

### `GET /health`

```json
{ "ok": true, "engine": "isolated-vm", "active": 0, "queued": 0 }
```
