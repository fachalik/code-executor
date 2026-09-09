# code-executor

Sandboxed code execution playground.

**Stack:** React + Monaco Editor + shadcn/ui · Express + TypeScript · four
interchangeable execution engines

| Engine | Isolation | Languages | Use it for |
|--------|-----------|-----------|------------|
| **Piston** | nsjail container, real interpreters | JavaScript, Python | Anything needing a full runtime. |
| **Judge0** | `isolate` sandbox, real compilers | JavaScript, TypeScript, Python | The same, when you want per-run CPU time and peak memory metered by the kernel. |
| **QuickJS** | QuickJS-WASM, in-process, no JIT | JavaScript, TypeScript | Untrusted rules and transforms where the audit story matters more than raw speed. |
| **isolated-vm** | A real V8 isolate per request, JIT on | JavaScript, TypeScript | The same untrusted rules, when they are hot enough that interpreter speed hurts. |

Piston and Judge0 both run a plain script and give you back its stdout. The two
sandboxes share a different contract — input on the global `env`, output as
`export default` — so the same snippet runs on either. They differ only in what
enforces the boundary and how fast it goes.

Pick per request with `platform` on `POST /api/execute`. The playground has an
engine selector in its topbar; the language list, starter code and Monaco
globals all follow the selected engine.

---

## Quick start

```bash
docker compose up --build
```

| Service  | URL                   |
|----------|-----------------------|
| Frontend | http://localhost:5173 |
| Backend  | http://localhost:3001 |
| Piston   | http://localhost:2000 |
| Judge0   | http://localhost:2358 — see below, runs as its own stack |
| QuickJS  | internal only — see below |
| isolated-vm | internal only — see below |

Neither sandbox service publishes a port. Both run on an internal docker network
with no gateway, which is what makes "the sandbox cannot reach the network" a
property you can check from outside rather than a claim in a config file. Reach
them through the backend, or directly with:

```bash
docker compose exec quickjs     wget -qO- localhost:3002/health
docker compose exec isolated-vm wget -qO- localhost:3003/health
```

### Install language runtimes into Piston

Piston ships empty — install runtimes after first boot:

```bash
docker compose exec piston ppman install javascript
docker compose exec piston ppman install python
docker compose exec piston ppman install typescript
```

Verify what's installed (this is the config the backend targets):

```bash
curl -s http://localhost:2000/api/v2/runtimes | jq .
```

```json
[
  { "language": "javascript", "version": "20.11.1", "runtime": "node",
    "aliases": ["node-javascript", "node-js", "javascript", "js"] },
  { "language": "python", "version": "3.12.0",
    "aliases": ["py", "py3", "python3", "python3.12"] },
  { "language": "typescript", "version": "5.0.3",
    "aliases": ["ts", "node-ts", "tsc", "typescript5", "ts5"] }
]
```

The versions in [backend/src/engines/piston.ts](backend/src/engines/piston.ts) are pinned to
match. If you install different versions, update `PISTON_LANG` there.

### Run Judge0 alongside

Judge0 ships its own compose stack (server, workers, postgres, redis) and is
**not** managed by this project's `docker-compose.yml`. Bring it up separately
from a [Judge0 CE release](https://github.com/judge0/judge0/releases):

```bash
cd judge0-v1.13.1
docker compose up -d db redis
sleep 10                      # let postgres finish its first-boot init
docker compose up -d
curl -s http://localhost:2358/about | jq .
```

The backend reaches it at `JUDGE0_URL` (default `http://localhost:2358`; the
compose file points the container at `http://host.docker.internal:2358`).

Judge0's language ids are **per-deployment**, not a stable part of the API.
Confirm them before trusting the map in
[backend/src/engines/judge0.ts](backend/src/engines/judge0.ts):

```bash
curl -s http://localhost:2358/languages | jq '.[] | select(.name | test("Node|TypeScript|Python 3"))'
```

```json
{ "id": 63, "name": "JavaScript (Node.js 12.14.0)" }
{ "id": 74, "name": "TypeScript (3.7.4)" }
{ "id": 71, "name": "Python (3.8.1)" }
```

These are old runtimes — Node 12 has no `?.` or `??`, and Python 3.8 has no
`match`. The starter code in the playground stays inside what they support.

The limits the backend asks for must sit under Judge0's own ceilings, which you
can read off `curl -s http://localhost:2358/config_info | jq .` — a submission
above `max_cpu_time_limit`, `max_wall_time_limit` or `max_memory_limit` is
rejected outright.

> **cgroup v2 hosts (incl. Docker Desktop on macOS).** Judge0 1.13.1 bundles
> `isolate` 1.8.1, which only speaks cgroup **v1**. On a unified-hierarchy host
> the API answers fine but every submission comes back
> `status: Internal Error` with
> `No such file or directory @ rb_sysopen - /box/script.*`. Confirm with:
>
> ```bash
> docker exec <judge0-workers> sh -lc 'isolate --cg -b 0 --cleanup; isolate --cg -b 0 --init'
> # Failed to create control group /sys/fs/cgroup/memory/box-0/: No such file or directory
> ```
>
> The controllers cannot be mounted from inside the container either — the fix
> is on the host: boot the docker VM with `systemd.unified_cgroup_hierarchy=0`,
> or run Judge0 on a cgroup v1 Linux host. The engine here handles this
> cleanly, surfacing Judge0's own message as `stderr` rather than a silent
> empty result.

---

## Local development

```bash
# QuickJS executor
cd quickjs-code-executor
npm install
npm run dev   # :3002

# isolated-vm executor (separate terminal)
cd isolated-vm-code-executor
npm install   # native addon — prebuilt binary, or needs python3 + make + g++
npm run dev   # :3003

# Backend (separate terminal)
cd backend
npm install
PISTON_URL=http://localhost:2000 \
JUDGE0_URL=http://localhost:2358 \
QUICKJS_URL=http://localhost:3002 \
ISOLATEDVM_URL=http://localhost:3003 \
npm run dev   # :3001

# Frontend (separate terminal)
cd frontend
npm install
npm run dev   # :5173 — proxies /api → :3001
```

---

## Security model

The four engines defend themselves differently, so they are gated differently.

### Piston

| Layer | Mechanism |
|-------|-----------|
| **Backend sanitizer** | Regex pre-flight rejects `fetch()`, `require(pkg)`, `import pkg`, `XMLHttpRequest`, `child_process`, etc. |
| **Piston runtime** | nsjail — network interface disabled, separate PID/mount namespace, ephemeral `/piston/jobs/<id>` dir |

> `require()` for built-in Node modules (`path`, `os`, `crypto`, etc.) is allowed —
> the sanitizer only blocks third-party package imports (patterns without `./` or `/`).

### Judge0

Gated exactly like Piston, and for the same reason: real compilers, real module
systems, so the regex pre-flight still earns its place.

| Layer | Mechanism |
|-------|-----------|
| **Backend sanitizer** | The same regex pre-flight as Piston |
| **Judge0 runtime** | `isolate` — per-submission chroot, cgroup CPU/memory caps, networking off (`enable_network: false`) |
| **Metering** | The kernel reports CPU time and peak RSS per run; both come back in `meta` |

### QuickJS

**The sanitizer does not run.** Not an oversight — the sandbox is the boundary.
There is no network, no filesystem and no `http`/`net`/`child_process` module to
import, so pattern-matching the source would only reject working code: the very
first rule would block `import { join } from 'path'`, which QuickJS supports.

| Layer | Mechanism |
|-------|-----------|
| **Interpreter** | QuickJS has no JIT — no runtime code generation to corrupt |
| **WASM** | Guest heap is a linear `ArrayBuffer`; no host pointers |
| **Capabilities** | `allowFetch: false`, `allowFs: false` — both throw when called |
| **Module loader** | `http`, `net`, `child_process`, `vm`, `worker_threads` are not implemented |
| **Limits** | Per-execution timeout (interrupt-driven), memory ceiling, stack ceiling, timer caps |
| **Container** | Internal network with no gateway, read-only rootfs, all caps dropped, non-root |

The residual risk is that the WASM boundary is enforced by V8 inside the
executor process — see
[quickjs-code-executor/README.md](quickjs-code-executor/README.md) for the full
model, the per-request-module rationale, and measured overhead.

### isolated-vm

**The sanitizer does not run here either**, and for a stronger reason than on
QuickJS: a V8 isolate starts completely empty. No `require`, no `process`, no
`fetch`, no timers, no module resolver. `console` and `env` exist only because
the service injects them.

| Layer | Mechanism |
|-------|-----------|
| **Isolate** | Separate V8 heap and context, one per request, always disposed |
| **Boundary** | Values cross as structured clones — no shared object graph to walk back into the host |
| **Globals** | Only `console` and `env`; the module resolver refuses every specifier |
| **Limits** | V8 interrupt at the deadline, host watchdog behind it, heap ceiling, admission control |
| **Container** | Internal network with no gateway, read-only rootfs, all caps dropped, non-root |

The honest caveat is the inverse of QuickJS's: the boundary here **is** V8, with
its JIT running, so a V8 sandbox escape is an escape into the executor process.
That is the class QuickJS-WASM removes by never emitting machine code. You are
trading it for Node-speed execution. See
[isolated-vm-code-executor/README.md](isolated-vm-code-executor/README.md) for
the full comparison.

---

## Project structure

```
code-executor/
├── docker-compose.yml          # Piston + QuickJS + isolated-vm + backend + frontend
│                               # (Judge0 runs as its own separate stack)
├── backend/
│   ├── src/
│   │   ├── index.ts
│   │   ├── types.ts
│   │   ├── routes/execute.ts   # POST /api/execute — picks the engine
│   │   ├── engines/
│   │   │   ├── piston.ts
│   │   │   ├── judge0.ts       # HTTP client for an external Judge0 CE
│   │   │   ├── quickjs.ts      # HTTP client for the executor service
│   │   │   └── isolatedvm.ts   # HTTP client for the executor service
│   │   └── middleware/
│   │       └── sanitize.ts     # pre-flight checks (Piston + Judge0)
│   └── Dockerfile
├── quickjs-code-executor/      # standalone QuickJS-WASM service
│   ├── src/
│   │   ├── index.ts
│   │   ├── config.ts           # env-driven limits
│   │   ├── queue.ts            # concurrency gate + load shedding
│   │   ├── engine/quickjs.ts   # the sandbox
│   │   └── routes/execute.ts
│   └── Dockerfile
├── isolated-vm-code-executor/  # standalone V8-isolate service
│   ├── src/
│   │   ├── index.ts
│   │   ├── config.ts           # env-driven limits
│   │   ├── queue.ts            # concurrency gate + load shedding
│   │   ├── engine/isolatedvm.ts # the sandbox
│   │   └── routes/execute.ts
│   └── Dockerfile              # Debian — isolated-vm is a native addon
└── frontend/
    ├── src/
    │   ├── App.tsx
    │   ├── components/
    │   │   ├── CodeEditor.tsx  # Monaco wrapper
    │   │   ├── OutputPanel.tsx
    │   │   └── ui/             # shadcn components
    │   ├── hooks/useExecutor.ts
    │   └── types/index.ts      # Language configs + default code
    └── Dockerfile
```

## API

### `POST /api/execute`

`platform` is required and selects the engine.

```json
{
  "code":     "console.log('hello')",
  "language": "javascript",
  "platform": "piston"
}
```

**Response (success)**
```json
{
  "ok":       true,
  "stdout":   "hello\n",
  "stderr":   "",
  "exitCode": 0,
  "signal":   null,
  "engine":   "piston",
  "language": "javascript"
}
```

**Response (blocked — Piston and Judge0 only)**
```json
{
  "error":   "Blocked pattern detected: \"fetch()\"",
  "hint":    "Network access is disabled. Remove fetch() calls.",
  "blocked": "fetch()"
}
```

#### `platform: "judge0"`

Same request shape as Piston — no `env`, no `result`. What it adds is `meta`:

```json
{
  "ok":       true,
  "stdout":   "hello\n",
  "stderr":   "",
  "exitCode": 0,
  "signal":   null,
  "engine":   "judge0",
  "language": "python",
  "meta":     { "status": "success", "timeMs": 43, "memoryKb": 8192 }
}
```

`timeMs` is kernel-measured CPU time and `memoryKb` is peak RSS, so unlike
Piston this engine can tell you what a run actually cost.

Judge0's status ids are folded into the same `meta.status` vocabulary the
sandboxes use — Accepted → `success`, Compilation Error → `syntax_error`, Time
Limit Exceeded → `timeout`, the SIGSEGV/SIGABRT/NZEC family → `runtime_error`,
Internal Error → `internal_error`. A failed run answers `200` with `ok: false`,
an `error` object naming Judge0's own status, and `stderr` carrying the compile
output or traceback:

```json
{
  "ok":       false,
  "stdout":   "",
  "stderr":   "main.ts(2,7): error TS2322: Type 'string' is not assignable to type 'number'.",
  "exitCode": 1,
  "signal":   null,
  "engine":   "judge0",
  "language": "typescript",
  "meta":     { "status": "syntax_error" },
  "error":    { "name": "Compilation Error", "message": "main.ts(2,7): error TS2322: ..." }
}
```

Output over 64 KB is clipped, with `meta.truncated: true`.

#### `platform: "quickjs"` and `platform: "isolated-vm"`

Both take an extra `env` object, handed to the code as the global `env`, and
return the module's `export default` as `result`:

```json
{
  "code":     "const { applicant } = env; export default { score: applicant.income / 1000 }",
  "language": "javascript",
  "platform": "quickjs",
  "env":      { "applicant": { "income": 95000 } }
}
```

```json
{
  "ok":       true,
  "stdout":   "",
  "stderr":   "",
  "exitCode": 0,
  "signal":   null,
  "engine":   "quickjs",
  "language": "javascript",
  "result":   { "score": 95 },
  "meta":     { "status": "success", "timeMs": 20, "memoryKb": 154 }
}
```

`platform: "isolated-vm"` answers the same shape with `engine: "isolated-vm"`,
plus `meta.cpuMs` — the CPU time actually burned inside the isolate, which is
usually well below `timeMs`.

Code that throws, times out or exhausts memory still answers `200` with
`ok: false` and a `meta.status` of `runtime_error`, `syntax_error`, `timeout` or
`out_of_memory` — branch on `ok`, not on the HTTP status.

### `GET /api/languages`

```json
{
  "engine": "piston",
  "languages": ["javascript", "python"],
  "platforms": {
    "piston":      ["javascript", "python"],
    "judge0":      ["javascript", "typescript", "python"],
    "quickjs":     ["javascript", "typescript"],
    "isolated-vm": ["javascript", "typescript"]
  }
}
```

Piston: `javascript` (Node 20.11.1) · `python` (3.12.0).
Judge0: `javascript` (Node 12.14.0) · `typescript` (3.7.4) · `python` (3.8.1).
QuickJS and isolated-vm: `javascript` · `typescript` (transpiled, types erased
not checked).
