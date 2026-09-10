# Code Executor Engines — In-Depth Comparison

Piston · Judge0 · isolated-vm · QuickJS-WASM

> Scope: this document compares the four execution engines wired into this repo as
> back-ends for running **untrusted, user-supplied code**. It answers six
> questions raised in review:
>
> 1. Which real open-source projects use each engine?
> 2. How actively is each one maintained?
> 3. What security incidents / CVEs has each had?
> 4. Can resource usage be configured per engine?
> 5. How many services must you deploy for each?
> 6. A single side-by-side table across every relevant axis.
>
> Data collected **September 2026**. Version numbers, star counts and release
> cadence drift — re-check the linked sources before quoting them.

---

## TL;DR (ringkas)

| Kalau kamu butuh… | Pakai |
|---|---|
| Jalanin **banyak bahasa** (Python, C++, Java, Go, …), kode "script biasa" | **Piston** |
| Sama seperti Piston, **plus metering CPU/memori per run** yang diukur kernel, dan kamu OK ngurus 4 service | **Judge0** |
| Cuma **JS/TS**, untung ke *audit story* (target serang kecil, deterministik), throughput sedang | **QuickJS-WASM** |
| Cuma **JS/TS**, butuh **kecepatan mendekati Node**, throughput tinggi | **isolated-vm** |

Poin penting:

- **Piston** dan **Judge0** = *proses OS sungguhan di dalam container* → multi-bahasa,
  isolasi kuat (namespaces/cgroups), tapi startup mahal (ratusan ms) dan Judge0
  butuh Postgres + Redis + worker.
- **isolated-vm** dan **QuickJS** = *library in-process* → **nol service tambahan**,
  startup murah, tapi JS/TS-only dan batas isolasinya adalah V8/WASM di dalam
  proses Node kamu.
- **isolated-vm** cepat (JIT nyala) tapi *sandbox escape = escape ke host process*.
  **QuickJS** menghapus kelas bug itu (tidak ada JIT, tidak ada machine code) —
  bayarannya kecepatan dan single-thread.
- **Judge0** punya rekam jejak CVE terburuk (2024: full host takeover, ada modul
  Metasploit). **isolated-vm** kena type-confusion serius Agustus 2026 (fixed).
  **QuickJS-ng** rutin kena memory-safety CVE dari fuzzing — tapi di dalam WASM
  dampaknya terkurung.

---

## 1. The four engines at a glance

| | **Piston** | **Judge0** | **isolated-vm** | **QuickJS-WASM** |
|---|---|---|---|---|
| What it is | Self-hosted HTTP code-runner daemon | Self-hosted code-execution *system* (API + workers + DB + queue) | Node.js native addon: real V8 isolates | WASM build of the QuickJS interpreter, driven from JS |
| Runs in this repo as | Its own container (`ghcr.io/engineer-man/piston`) | External compose stack, reached over HTTP | `isolated-vm-code-executor` micro-service (design choice) | `quickjs-code-executor` micro-service (design choice) |
| Package / image | `engineer-man/piston` (MIT) | `judge0/judge0` (GPL-3.0) | `isolated-vm` npm `^5.0.1` here / `7.0.1` latest (ISC) | `@jitl/quickjs-ng-wasmfile-release-sync` + `@sebastianwessel/quickjs` `^3.1.0` (MIT) |
| Isolation primitive | `isolate`/nsjail: Linux namespaces, chroot, cgroups, unprivileged users | `isolate`: chroot, cgroups CPU/mem caps, network off | One V8 `Isolate` per request — separate heap & context | QuickJS interpreter inside a WASM linear-memory sandbox |
| Languages | 60+ | 90+ | JavaScript / TypeScript only | JavaScript / TypeScript only |
| Executes machine code (JIT)? | Yes (real interpreters/compilers) | Yes | **Yes** — V8 JIT is on | **No** — pure bytecode interpreter |
| Needs a privileged/OS sandbox? | Yes — container must be `privileged` | Yes — workers need cgroup access | No (but you should still containerize) | No |

---

## 2. Aspect-by-aspect

### 2.1 Environment isolation

| Engine | Boundary | What crosses it | Residual risk |
|---|---|---|---|
| **Piston** | OS process in namespaces + chroot + cgroups, no network namespace route | stdin/argv in, stdout/stderr out | Kernel/container-runtime escape; **requires `privileged: true`** which widens host exposure if the daemon itself is compromised; historically shipped with networking *enabled* by default in some setups |
| **Judge0** | `isolate` per submission: chroot, cgroups, `enable_network:false` | Source + stdin in, stdout/stderr + kernel-metered CPU/RSS out | Same class as Piston, plus a larger attack surface (Rails API, Postgres, Redis, worker IPC). The 2024 CVEs were escapes *out of `isolate`* into the host |
| **isolated-vm** | V8 `Isolate` — distinct heap, no shared prototype chain; values cross as **structured clones** | Whatever you inject (`console`, `env`) in; a copied return value out | **The boundary is V8 with JIT running.** A V8 sandbox-escape, or a bug in the C++ marshalling glue, is code execution in the *host Node process*. No OS layer unless you add one |
| **QuickJS-WASM** | WASM sandbox: guest heap is a linear `ArrayBuffer`, no host pointers; interpreter emits **no machine code** | Values marshalled across the WASM ABI | The WASM boundary is enforced by V8/the WASM runtime *inside* the executor process. A memory-safety bug in QuickJS stays inside the linear memory unless chained with a WASM-runtime escape |

**Ordering (smallest trusted computing base first):** QuickJS-WASM < isolated-vm < Piston ≈ Judge0 for *code-gen surface*; but Piston/Judge0 add a real OS/kernel boundary that the two libraries do not have on their own.

### 2.2 Throughput & performance

Numbers below are from this repo's own load test (`bench/REPORT-santai.md`,
`bench/results/k6/`) — 10 virtual users, 20 s, Docker Desktop on macOS. Treat the
**ordering** as the signal, not the absolute ms (a Linux host with cgroup v1
changes them, especially for Judge0).

| Engine | Trivial script (startup cost) | CPU-heavy (3M sqrt) | Shape |
|---|--:|--:|---|
| **isolated-vm** | ~7 ms/run · ~1 490 rps | ~20 ms | Warm engine, cheap per-request isolate. Fastest by a wide margin. Isolate runs on its own thread |
| **QuickJS-WASM** | ~87 ms/run · ~115 rps | ~2 670 ms | OK for light/occasional work; **collapses under CPU load** — no JIT and one event-loop lane, so a heavy script blocks everyone behind it |
| **Piston** | ~686 ms/run · ~14 rps | ~771 ms | Spawns a fresh OS process per run — a hard ~0.6 s floor. The compute itself is native-fast |
| **Judge0** | ~1 025 ms/run · ~5 rps | — | Slowest; adds queue + DB round-trips. On the test host it was **non-functional** (bundled `isolate` 1.8.1 needs cgroup v1; Docker Desktop is cgroup v2) |

Scaling model:

- **isolated-vm** — vertical: more CPU cores + higher `maxConcurrent`, bounded by `maxConcurrent × memoryLimit` fitting RAM.
- **QuickJS** — needs horizontal fan-out (more processes/replicas) because one CPU-bound script pins a lane for its whole timeout.
- **Piston** — horizontal: more Piston replicas; each run is independent.
- **Judge0** — horizontal by design: add worker containers draining the same Redis queue.

### 2.3 Multi-language support

| Engine | Languages | How new languages are added |
|---|---|---|
| **Piston** | **60+** (Python, JS/TS, Java, C/C++, C#, Go, Rust, Ruby, PHP, Bash, Kotlin, Swift, Haskell, … incl. esoteric) | Install runtime packages via the daemon's HTTP package API; each is a versioned tarball on a volume |
| **Judge0** | **90+** (superset of Piston's mainstream set; multiple pinned versions per language) | Language IDs are baked into the image build; **IDs are per-deployment**, confirm via `GET /languages` |
| **isolated-vm** | **JS + TS** (TS is transpiled, types erased not checked) | Not applicable — it is a V8 isolate |
| **QuickJS-WASM** | **JS + TS** (TS transpiled). QuickJS targets ES2023; `@sebastianwessel/quickjs` adds a Node-ish stdlib shim | Not applicable |

If you need anything other than JavaScript/TypeScript, the choice is **Piston or Judge0**.

### 2.4 Resource configuration (Q4 — *yes, all four are configurable*)

| Engine | CPU / time | Memory | Processes / FDs / output | Network | Enforced by |
|---|---|---|---|---|---|
| **Piston** | `run_timeout`, `compile_timeout` (wall ms); `run_cpu_time`, `compile_cpu_time` (ms) per request. Daemon ceilings: `PISTON_RUN_TIMEOUT`, `PISTON_COMPILE_TIMEOUT`, `PISTON_RUN_CPU_TIME` | `run_memory_limit`, `compile_memory_limit` (bytes, `-1`=unlimited) per request; `PISTON_*_MEMORY_LIMIT` ceilings | `max_process_count` (def 256, anti fork-bomb), `max_open_files` (2048), `output_max_size` (1024 B default) | `PISTON_DISABLE_NETWORKING` (keep `"true"`) | cgroups + nsjail; requests above the ceiling are **rejected** |
| **Judge0** | `cpu_time_limit`, `cpu_extra_time`, `wall_time_limit` (s) per submission; server caps `MAX_CPU_TIME_LIMIT`, `MAX_WALL_TIME_LIMIT` | `memory_limit` (KB), `stack_limit` (KB); server cap `MAX_MEMORY_LIMIT` | `max_processes_and_or_threads`, `max_file_size`, `number_of_runs`, per-process time/mem toggles | `enable_network` (bool), gated by `ALLOW_ENABLE_NETWORK` | `isolate` + cgroups. **Kernel meters actual CPU time and peak RSS** and returns them per run (unique among the four) |
| **isolated-vm** | `timeout` (ms) on `eval`/`run`/`apply`. `isolate.cpuTime` / `isolate.wallTime` (ns) are **readable**, not caps — you build the watchdog. No built-in wall-clock deadline beyond `timeout` | `new ivm.Isolate({ memoryLimit })` in MB (default 128, min 8); `getHeapStatistics()`; `onCatastrophicError` | No fs/net/process exist to limit — an isolate starts empty. Concurrency + hard CPU/RSS caps are **your** job (cgroups/container + an admission queue) | None exists in-isolate | V8 interrupt at the deadline; everything else is app-level. This repo adds `deploy.resources` limits + a concurrency gate |
| **QuickJS-WASM** | `setInterruptHandler(cb)` — called on a cycle budget, implement timeout there. `@sebastianwessel/quickjs`: `executionTimeout` (s), `maxIntervalCount` | `runtime.setMemoryLimit(bytes)` (`-1`=off), `setMaxStackSize(bytes)` (`0`=off); `computeMemoryUsage()`. Wrapper: `memoryLimit`, `maxStackSize` | Capability toggles: `allowFetch`, `allowFs`, `env`, `mountFs`; timer caps | No socket API; `fetch` stubbed off by default | All enforced **inside WASM** — deterministic and independent of host load. Still containerize for host CPU-share fairness |

Bottom line: every engine can cap time and memory. Only **Judge0** *reports* real
consumption back. Only **QuickJS** enforces limits deterministically regardless of
host contention. **isolated-vm** gives you the fewest built-in knobs — `timeout` +
`memoryLimit` and you assemble the rest.

### 2.5 Past vulnerabilities (Q3)

| Engine | Notable incidents | Severity / status |
|---|---|---|
| **Judge0** | **CVE-2024-28185** (CVSS **10.0**) — symlink in the sandbox dir → `run_script` written outside the box → sandbox escape. **CVE-2024-28189** — bypass of the 28185 patch via `chown` on a symlink. **CVE-2024-29021** (CVSS **9.1**) — SSRF via unsafe default config → reach internal Postgres → alter column types → command injection → RCE on the host. GitHub advisories `GHSA-3xpw-36v7-2cmg`, `GHSA-q7vg-26pg-v5hr`. A **Metasploit module** exists (rapid7 PR #19584) | All fixed in **1.13.1**. This is the worst record of the four: chained to **full host takeover** (DB, internal network, web server) and weaponized. Pre-1.13.1 deployments are actively targeted |
| **isolated-vm** | **GHSA-864f-rcv7-6rh4** (disclosed **8 Aug 2026**, CVE pending) — type confusion in `ExternalCopy`'s `transferList` handling: the list is validated then re-read without re-validation, so a getter returning different values lets an invalid object be dereferenced as an `ArrayBuffer` → **host-process memory corruption → potential RCE**. Reported by Endor Labs (Cristian-Alexandru Staicu) | Affects **all ≤ 7.0.0**; fixed in **6.2.0** and **7.0.1**. Maintainer's framing: "the V8 Isolate boundary held" — the bug is in the C++ marshalling glue, not the isolation primitive. **This repo pins `^5.0.1` → vulnerable; bump to ≥ 7.0.1** |
| **QuickJS-WASM** (quickjs-ng) | Steady flow of fuzzer-found memory-safety bugs: **CVE-2024-13903** (stack overflow in `JS_GetRuntime`, ≤ 0.8.0 → 0.9.0); `JS_ReadBigInt` / `JS_ReadString` heap overflows (≤ 0.9.0); **CVE-2025-12745** (over-read in `js_array_buffer_slice`); **CVE-2026-0822** & **CVE-2026-1145** (heap overflow in `js_typed_array_sort` / `js_typed_array_constructor_ta`, ≤ 0.11.0) | Individually medium/high in native builds. **Compiled to WASM the blast radius is the guest's linear memory** — a crash or corruption inside the sandbox, not host RCE, unless chained with a V8/WASM-runtime escape. Keep the WASM build current anyway |
| **Piston** | No assigned CVEs found. Real-world incidents are **misconfiguration**, not code bugs: (a) `PISTON_DISABLE_NETWORKING` left off → sandboxed code reaches the host network (caught in this repo's own review, `bench/REPORT.md` §3.4); (b) the `privileged: true` requirement means a daemon compromise is close to host root. Small maintainer team → limited formal audit history | Cleanest CVE record, but the smallest audited surface and a structurally privileged container |

### 2.6 Maintenance activity (Q2)

| Engine | Repo | Cadence (as of Sep 2026) | Read |
|---|---|---|---|
| **Piston** | `engineer-man/piston` · ~2.8k ★ · ~1 300 commits · MIT | Rolling `master`, no formal release tags in a long while; steady but **low-volume**; effectively one primary maintainer (EngineerMan) + community PRs. Public API at emkc.org was **closed to open signups Feb 2026** | Alive but bus-factor 1. Fine self-hosted; don't depend on the hosted API |
| **Judge0** | `judge0/judge0` · thousands of ★ · GPL-3.0 | **Slow.** 1.13.1 (the security release) landed 2024; long gaps between releases. Commercial offering (Judge0 IDE / hosted / enterprise) is where the attention goes. Repo now marketed "for humans and AI" | Maintained but sluggish — a 10.0 CVE still took a patch-bypass round. Budget for self-managed patching |
| **isolated-vm** | `laverdet/isolated-vm` · ~700 commits · ISC · ~720k downloads/week | Single expert maintainer (Marcel Laverdet). Not fast-moving, but **security response is prompt and professional** (Aug 2026 fix shipped quickly on two release lines). Long-standing blunt "this is hard, be careful" warning in the README | Healthy for its model. The risk is bus-factor and the maintainer's own stated caution about untrusted code |
| **QuickJS-WASM** | Engine: `quickjs-ng/quickjs` (active fork, frequent releases, ~0.11.x, absorbed Bellard's upstream). Bindings: `justjake/quickjs-emscripten` (tracks quickjs-ng closely — vendored build updated Sep 2026). Wrapper: `sebastianwessel/quickjs` (`^3.1.0`, active, smaller) | **Most actively developed engine of the four.** quickjs-ng ships regularly and folds in fuzzing fixes fast | Best-maintained core; note you depend on a **3-layer stack** (engine → emscripten bindings → wrapper), each with its own release pace |

### 2.7 Community & ecosystem

| Engine | Signals |
|---|---|
| **Piston** | Popular in the Discord-bot / learn-to-code niche. Client wrappers: `pistonpy`, `aio-piston` (Python), `pistones` (Rust), plus Go/Java wrappers. Docs are a single README — adequate, not deep |
| **Judge0** | Largest install base for "online judge" use — competitive-programming sites, university auto-graders, coding-interview platforms, LeetCode-style clones. Good hosted docs (`ce.judge0.com`), OpenAPI spec, official Python SDK. Big Stack Overflow / GitHub-issues footprint |
| **isolated-vm** | The **de-facto answer** after `vm2` was deprecated (vm2's maintainers pointed here). Huge transitive dependent tree. Tutorials (LogRocket "LeetCode-style evaluator"), lots of blog coverage. Support = GitHub issues + the README |
| **QuickJS-WASM** | Growing fast in the **LLM-agent / edge-compute / plugin-sandbox** space (deterministic, no native deps, runs in browsers and workers). `quickjs-emscripten` is widely embedded (see §2.8). Docs: quickjs-ng wiki + `quickjs-emscripten` API docs + `@sebastianwessel/quickjs` doc site — decent across the stack |

### 2.8 Open-source projects using each (Q1)

**Piston**
- [`engineer-man/piston-bot`](https://github.com/engineer-man/piston-bot) — the "I Run Code" Discord bot (4 100+ servers), the reference consumer.
- Public API [`emkc.org/api/v2/piston`](https://emkc.org/run) — backed countless small coding tools and bots (signups now gated).
- Wrappers: [`pistonpy`](https://pypi.org/project/pistonpy/), [`aio-piston`](https://pypi.org/project/aio-piston/), [`pistones`](https://crates.io/crates/pistones), [`ragrag/piston-batch`](https://github.com/ragrag/piston-batch), [`korarit/piston-for-coding-web-project`](https://github.com/korarit/piston-for-coding-web-project).

**Judge0**
- [Judge0 IDE](https://ide.judge0.com) — official reference web client.
- Cited in the repo's own "used by" list: **Codeforces**, **Alibaba ModelScope**, **OpenLearning**; one-click deploys on **Hostinger** / **Railway**.
- The default execution backend for a large population of GitHub "online judge" / "leetcode clone" / candidate-assessment projects, and for university auto-graders (40+ academic citations).
- Increasingly used as the code-interpreter backend for LLM-agent projects.

**isolated-vm**
- **Screeps** — MMO that runs player-supplied JS for days at a time (the original driving use case).
- **Algolia Crawler** — runs user-provided extraction functions.
- **Fly.io** (early edge compute), **TripAdvisor** (React SSR) — from the project README.
- Endor Labs' disclosure names downstream dependents (directly or transitively): **n8n**, **Activepieces**, **Budibase**, **Directus**, **Rocket.Chat**, **Mastra**, **Sim.ai**. Note: **n8n 2.0** moved Code-node execution to "task runners" (process isolation + VM contexts + AST checks), so that dependency story is shifting.
- The standard recommendation to migrate off the deprecated `vm2`.

**QuickJS-WASM**
- [`justjake/quickjs-emscripten`](https://github.com/justjake/quickjs-emscripten) — the widely embedded binding layer (this repo uses the `@jitl/quickjs-ng-*` variant packages).
- [`@tootallnate/quickjs-emscripten`](https://www.npmjs.com/package/@tootallnate/quickjs-emscripten) powers **PAC-file evaluation** in the `pac-proxy-agent` / `get-uri` ecosystem — shipped transitively at massive scale in Node tooling.
- [`sebastianwessel/quickjs`](https://github.com/sebastianwessel/quickjs) — the higher-level TS runtime this repo builds on; markets itself for LLM code-gen/execution and educational sandboxes.
- Forks/consumers: [`@langtail/quickjs`](https://www.npmjs.com/package/@langtail/quickjs), [`@mtvproject/quickjs-emscripten`](https://www.npmjs.com/package/@mtvproject/quickjs-emscripten), [`traviscooper/quickjs-wasm-runtime`](https://github.com/traviscooper/quickjs-wasm-runtime).
- The QuickJS engine itself underpins `txiki.js` and many embedded/edge runtimes.

### 2.9 Integration complexity

| Engine | Effort to integrate | Notes |
|---|---|---|
| **isolated-vm** | **Lowest to call, highest to get right.** `npm i`, wrap in ~50 lines. But it's a native addon (needs prebuilt binary or `python3`+`make`+`g++`), and *you* must build the deadline watchdog, heap-cap policy, admission control and "never leak an ivm object to the guest" discipline | A misuse is a silent hole, not an error |
| **QuickJS-WASM** | **Low.** Pure-JS dependency, no native build, runs anywhere V8 runs. `@sebastianwessel/quickjs` gives a batteries-included `runSandboxed()` API. Main work is deciding which capabilities to enable | Safe defaults; hard to misuse into a host escape |
| **Piston** | **Low-medium.** Run one container, POST JSON to `/api/v2/execute`. Extra step: install language runtimes into a volume after first boot. Needs `privileged: true` | Stateless, simple contract |
| **Judge0** | **Highest.** Stand up 4 services, init Postgres, match language IDs per deployment, keep submission limits under `config_info` ceilings, and **lock down auth + bind to loopback** (unauthenticated `0.0.0.0:2358` was found live in this repo's review). cgroup-v1 host required for the bundled `isolate` | Most moving parts, most footguns |

### 2.10 Documentation

| Engine | Quality |
|---|---|
| **Judge0** | Best formal docs — hosted site, OpenAPI, SDK, config reference. |
| **QuickJS stack** | Good but spread over three projects (engine wiki, `quickjs-emscripten` API docs, `@sebastianwessel/quickjs` doc site). |
| **isolated-vm** | One long, honest README with a strong security section. Complete for the API; you infer the architecture patterns. |
| **Piston** | One README. Covers the API and sandboxing model; thin on operations and tuning. |

---

## 3. Deployment: how many services to spin up (Q5)

Counting **long-running services you operate**, excluding your own application and
the frontend.

| Engine | Mandatory services | Detail | Scale-out |
|---|--:|---|---|
| **Piston** | **1** | One `piston` container (`privileged: true`). Language runtimes live on a volume — no DB, no queue, no broker. Stateless | Add more identical Piston replicas behind a load balancer |
| **Judge0** | **4** | ① API server (Rails) · ② ≥1 worker (drains the queue, does the sandboxing) · ③ PostgreSQL · ④ Redis. Ships as its own compose stack, **not** managed by this repo | Add worker containers on the same Redis queue; Postgres/Redis can be managed services |
| **isolated-vm** | **0** | It's an in-process library — it runs **inside your Node process**. This repo wraps it in **1** micro-service (`isolated-vm-code-executor`) *by choice*, to bound blast radius and centralise the concurrency gate. Optionally + a container / gVisor for an OS layer | Replicate the wrapper service (or your app) horizontally |
| **QuickJS-WASM** | **0** | Same — in-process WASM library, no native deps. This repo wraps it in **1** micro-service (`quickjs-code-executor`) *by choice*. Optionally + a container | Replicate the wrapper service; needs more replicas than isolated-vm under CPU load (single-lane) |

This repo's `docker-compose.yml` (excluding Judge0) runs **5** containers:
`frontend`, `backend`, `piston`, `quickjs`, `isolated-vm`. Bringing up Judge0 too
adds its separate **4**-container stack, for **9** total.

Rule of thumb:

- **Sandbox libraries (isolated-vm, QuickJS): 0 extra infra.** Embed, or run one thin wrapper service.
- **Piston: 1 box.** Self-contained.
- **Judge0: a small distributed system.** Only worth it when you specifically need its kernel-metered CPU/RSS numbers or its 90-language breadth at scale.

---

## 4. Master comparison table

| Aspect | **Piston** | **Judge0** | **isolated-vm** | **QuickJS-WASM** |
|---|---|---|---|---|
| Model | OS process in container | Distributed system (API+worker+DB+queue) | In-process V8 isolate (native addon) | In-process WASM interpreter |
| Languages | 60+ | 90+ | JS / TS | JS / TS |
| Throughput — trivial | Low (~14 rps, ~0.6 s floor) | Lowest (~5 rps) | **Highest (~1 490 rps, ~7 ms)** | Medium (~115 rps) |
| Throughput — CPU-bound | Native-fast compute | Native-fast (when working) | **~20 ms** | **Collapses (~2.7 s, blocks the lane)** |
| Concurrency model | Horizontal (replicas) | Horizontal (workers on Redis queue) | Vertical (threads, `maxConcurrent × mem`) | Horizontal only (single lane per proc) |
| Startup cost per run | High (fork OS process) | Highest (queue + DB) | Very low (new isolate) | Low–medium (new WASM context) |
| Isolation boundary | Namespaces + chroot + cgroups (+ privileged host) | `isolate` + cgroups + separate API/DB | V8 Isolate (JIT **on**) — clone-only marshalling | WASM linear memory — **no machine code emitted** |
| OS/kernel boundary included? | **Yes** | **Yes** | No (add your own) | No (add your own) |
| Sandbox-escape blast radius | Container → host (privileged) | Container/`isolate` → host + DB + internal net | **Host Node process (RCE)** | Guest linear memory (contained) |
| Resource limits configurable? | Yes — time, CPU, mem, procs, FDs, output, network | Yes — time, CPU, mem, stack, procs, files, network | Yes — `timeout` + `memoryLimit`; rest is app-level | Yes — memory, stack, interrupt/timeout, capabilities |
| Reports actual usage? | No | **Yes — kernel-metered CPU time + peak RSS** | Partial (`cpuTime`/`wallTime` ns, read-only) | Partial (`computeMemoryUsage`) |
| Deterministic limit enforcement? | cgroups (host-dependent) | cgroups (host-dependent) | V8 interrupt (host-dependent) | **Yes — enforced inside WASM** |
| Multi-lingual support | **Excellent** | **Excellent** | None (JS/TS) | None (JS/TS) |
| Flexibility (stdlib, modules, fs, net) | Full real runtime | Full real runtime | Empty isolate — you inject everything | Configurable capabilities (`allowFs`, `allowFetch`, virtual fs) |
| Integration complexity | Low–medium | **High** (4 services, per-deploy language IDs, auth) | Low to call / high to harden (native build, DIY watchdog) | **Low** (pure JS, safe defaults) |
| Services to deploy | **1** | **4** | **0** (repo adds 1 wrapper) | **0** (repo adds 1 wrapper) |
| Documentation | README only | **Best** (site + OpenAPI + SDK) | One thorough README | Good, spread over 3 projects |
| Community / adoption | Discord bots, learn-to-code | **Largest** for online-judge use | de-facto `vm2` successor; huge dependent tree | Fast-growing in LLM-agent / edge / plugin sandboxes |
| Maintenance cadence | Low, bus-factor 1 | **Slow** releases; commercial focus | Low volume, **fast security response** | **Most active core** (quickjs-ng); 3-layer stack |
| Past vulnerabilities | No CVEs; misconfig risks (network on, privileged) | **CVE-2024-28185 (10.0), -28189, -29021 (9.1)** → host takeover; Metasploit module. Fixed 1.13.1 | **GHSA-864f-rcv7-6rh4** (Aug 2026) type confusion → host RCE. Fixed 6.2.0 / 7.0.1 (**repo pins ^5.0.1 → vulnerable**) | Recurring quickjs-ng memory-safety CVEs (2024-2026); contained by WASM |
| License | MIT | GPL-3.0 | ISC | MIT |
| Best fit | Multi-language script running, self-contained | Multi-language + kernel metering, at scale, with ops budget | Hot JS/TS rules needing near-Node speed & high throughput | Untrusted JS/TS rules where audit story & determinism beat raw speed |

---

## 5. Recommendations

- **Default for this project's "run arbitrary code" playground:** keep **Piston** as
  the general multi-language engine and **QuickJS-WASM** as the default for the
  untrusted-rules path. That pair needs **1** operated service (Piston) plus an
  in-process library, has no host-RCE escape class, and no CVE has meant host
  takeover.
- **Add isolated-vm** only where JS/TS rule evaluation is hot enough that QuickJS's
  interpreter speed is the bottleneck — and then: bump to **≥ 7.0.1**, never hand a
  live `ivm.*` object to guest code, keep it behind the concurrency gate, and keep
  the OS container layer.
- **Reach for Judge0** only when you specifically need kernel-metered CPU/RSS per
  run or its language breadth at scale, *and* can run the 4-service stack on a
  cgroup-v1 host with auth enabled and the port on loopback. Never run < 1.13.1.
- **Immediate action items in this repo:**
  1. `isolated-vm-code-executor` pins `isolated-vm@^5.0.1` — upgrade to `^7.0.1`
     (GHSA-864f-rcv7-6rh4).
  2. Refresh the `@jitl/quickjs-ng-*` WASM build to pull in quickjs-ng ≥ 0.12
     (past CVE-2026-0822 / -1145).
  3. Keep `PISTON_DISABLE_NETWORKING: "true"` and Judge0 auth on / port on
     loopback — both were found misconfigured in `bench/REPORT.md`.

---

## Sources

- Piston — [github.com/engineer-man/piston](https://github.com/engineer-man/piston) · [readme](https://github.com/engineer-man/piston/blob/master/readme.md) · [piston-bot](https://github.com/engineer-man/piston-bot)
- Judge0 — [github.com/judge0/judge0](https://github.com/judge0/judge0) · [ce.judge0.com/configuration](https://ce.judge0.com/configuration/) · advisories [GHSA-3xpw-36v7-2cmg](https://github.com/judge0/judge0/security/advisories/GHSA-3xpw-36v7-2cmg), [GHSA-q7vg-26pg-v5hr](https://github.com/judge0/judge0/security/advisories/GHSA-q7vg-26pg-v5hr) · [SecurityWeek write-up](https://www.securityweek.com/critical-vulnerabilities-in-judge0-lead-to-sandbox-escape-host-takeover/) · [The Hacker News](https://thehackernews.com/2024/04/sandbox-escape-vulnerabilities-in.html) · [tantosec analysis](https://tantosec.com/blog/judge0/) · [Metasploit PR #19584](https://github.com/rapid7/metasploit-framework/pull/19584) · [NVD CVE-2024-28189](https://nvd.nist.gov/vuln/detail/CVE-2024-28189)
- isolated-vm — [github.com/laverdet/isolated-vm](https://github.com/laverdet/isolated-vm) · [npm](https://www.npmjs.com/package/isolated-vm) · [Snyk](https://security.snyk.io/package/npm/isolated-vm) · [Endor Labs disclosure (GHSA-864f-rcv7-6rh4)](https://www.endorlabs.com/learn/ghsa-864f-rcv7-6rh4-critical-type-confusion-vulnerability-in-isolated-vm) · [The Hacker News, Aug 2026](https://thehackernews.com/2026/08/isolated-vm-flaw-lets-sandboxed.html) · [DevOps.com](https://devops.com/critical-flaw-in-isolated-vm-can-lead-to-sandbox-escape-rce-threat/) · [LogRocket tutorial](https://blog.logrocket.com/building-leetcode-style-code-evaluator-isolated-vm/) · [Screeps forum](https://screeps.com/forum/topic/2073/ptr-changelog-2018-01-18-isolated-vm)
- QuickJS — [quickjs-ng/quickjs](https://github.com/quickjs-ng/quickjs) · [v0.9.0 release](https://github.com/quickjs-ng/quickjs/releases/tag/v0.9.0) · [justjake/quickjs-emscripten](https://github.com/justjake/quickjs-emscripten) · [runtime API / resource limits doc](https://github.com/justjake/quickjs-emscripten/blob/main/doc/quickjs-emscripten-core/classes/QuickJSRuntime.md) · [sebastianwessel/quickjs](https://github.com/sebastianwessel/quickjs) · [@sebastianwessel/quickjs on npm](https://www.npmjs.com/package/@sebastianwessel/quickjs) · CVEs: [CVE-2024-13903](https://www.cvedetails.com/cve/CVE-2024-13903/), [CVE-2026-1145](https://www.sentinelone.com/vulnerability-database/cve-2026-1145/), [CVE-2026-0822](https://www.sentinelone.com/vulnerability-database/cve-2026-0822/)
- n8n task runners — [docs.n8n.io task runners](https://docs.n8n.io/hosting/configuration/task-runners/) · [v2.0 breaking changes](https://docs.n8n.io/release-notes/v20-breaking-changes)
- This repo — `README.md`, `docker-compose.yml`, `bench/REPORT.md`, `bench/REPORT-santai.md`, `bench/results/k6/`
