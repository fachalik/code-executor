# Code-Executor — Load & Security Test Report

_Test date: 2026-09-09 · Host: macOS / Apple Silicon (arm64), Docker Desktop, cgroup v2_
_All services built from this repo's working tree. Load via k6 (containerised); security via a Node corpus with per-case expected verdicts._

---

## TL;DR

- **Performance ranking (JS, warm):** isolated-vm ≫ Piston ≈ Judge0-overhead ≫ QuickJS-on-CPU.
  isolated-vm serves a trivial run in **~7 ms @ ~1500 rps**; QuickJS in **~87 ms @ ~115 rps**;
  Piston in **~686 ms @ ~14 rps** (real process spawn).
- **QuickJS falls off a cliff on CPU-bound code** (~2.7 s, 3.5 rps) — no JIT, and it pins one
  event loop, so pathological input causes head-of-line blocking (30 s tails under load).
  isolated-vm runs the same CPU work in ~20 ms because it JITs on its own thread.
- **Isolation:** isolated-vm is the strongest — every escape contained, every DoS capped
  **in-process and gracefully**. QuickJS contains all escapes too, but a memory bomb
  **OOM-kills and restarts its container** rather than returning a clean error.
- **🔴 Highest-severity finding — Piston network egress is OPEN.** With
  `PISTON_DISABLE_NETWORKING: "false"` (current working tree), sandboxed JS *and* Python
  reached `backend:3001` over the docker network. The sandbox is not network-isolated.
- **🔴 The sanitizer does not cover Python** and is trivially bypassed in JS — it is a
  speed-bump, not a boundary. Only Piston's nsjail (when networking is on) actually contains.
- **🟠 No rate limiting / no auth** on the backend or on Judge0. One unauthenticated client
  saturates every engine.
- Judge0 **cannot execute at all on this host** (cgroup v2) — documented, confirmed.

---

## 1. Scope & method

| Engine | Boundary | Tested |
|---|---|---|
| Piston | nsjail container, `privileged: true`, real Node/Python | full |
| Judge0 | `isolate`, external stack | API/reachability only — execution broken on cgroup v2 |
| QuickJS | QuickJS-WASM, in-process, no JIT | full |
| isolated-vm | one V8 isolate per request, JIT on | full |

- **Load:** grafana/k6 in a container on the compose networks. Each engine hit both **through
  the backend** (`:3001`, realistic path) and, for the two sandboxes, **directly on
  `sandbox-net`** to separate proxy overhead from engine cost.
- **Workloads:** `hello` (fixed per-run overhead), `cpu` (~3M `Math.sqrt`), `payload`
  (large `env` + large output), `pathological` (`while(true){}`), and a 50-VU **saturation** ramp.
- **Security:** 27 graded cases + 2 info-only — sandbox-escape attempts, DoS/limit
  enforcement, sanitizer-bypass, and API-layer checks. Each case has an expected verdict;
  output is a pass/fail diff.

### Setup defects found (stack would not build/run as shipped)
1. **Missing `.dockerignore` in `backend/` and `frontend/`** → host `node_modules` copied into
   build context, image build fails (`cannot replace to directory …/@types/cors with file`).
2. **`PISTON_LOG_LEVEL: warn`** invalid (must be uppercase) → Piston crash-loops.
3. **README runtime-install is stale** — this Piston image has no `ppman`; runtimes install via
   `POST /api/v2/packages`, and JavaScript is the **`node`** package, not `javascript`.

---

## 2. Load results

### 2.1 Latency & throughput (via backend, 10 VUs, 20 s)

| Engine | Workload | avg | p95 | rps | ok |
|---|---|--:|--:|--:|--:|
| **isolated-vm** | hello | **6.7 ms** | 8 ms | **1487** | 100% |
| isolated-vm | cpu | 20 ms | 52 ms | 485 | 100% |
| isolated-vm | payload | 7 ms | 9 ms | 1333 | 100% |
| **QuickJS** | hello | 87 ms | 133 ms | 115 | 100% |
| QuickJS | cpu | **2673 ms** | 2984 ms | **3.5** | 100% |
| QuickJS | payload | 86 ms | 103 ms | 115 | 100% |
| **Piston** | hello | 686 ms | 1152 ms | 14 | 100% |
| Piston | cpu | 771 ms | 1125 ms | 13 | 100% |
| Piston | payload | 586 ms | 992 ms | 17 | 100% |
| Judge0 | hello | 1025 ms | 1311 ms | 4.8 | **0%** (exec broken) |

**Reading it:**
- **isolated-vm** is ~13× faster than QuickJS on `hello` and ~130× on `cpu`. JIT + per-isolate
  thread. This is the only engine whose CPU workload barely moved the latency.
- **QuickJS** is competitive on I/O-shaped work (`hello`/`payload` ~87 ms) but **collapses on
  CPU** — no JIT, and its own config caps it at 4 concurrent event-loop-bound runs, so
  throughput is 3.5 rps.
- **Piston**'s cost is process spawn (~0.6 s floor), independent of the code. Container CPU hit
  **835%** under Piston load vs ~0% for the sandboxes — it is by far the most expensive per run.
- **Backend proxy overhead is negligible:** QuickJS direct 74 ms vs 87 ms via backend;
  isolated-vm 6.3 ms vs 6.7 ms. The backend is not the bottleneck.

### 2.2 Saturation (50 VUs, CPU work, direct)

| Engine | rps | exec_ok | shed (429) | p95 |
|---|--:|--:|--:|--:|
| QuickJS | 12 | 31% | 227 | 14.7 s |
| isolated-vm | (reject-dominated) | — | 128k | — |

Both shed load rather than topple — the admission queue works. Two different failure modes:
QuickJS **queues** (deep, slow tails up to 27 s because each CPU job pins a slot for ~2.7 s);
isolated-vm **fast-rejects** (sub-ms 429s, tens of thousands/s). isolated-vm's fast-reject is
healthier for the host but, with no rate limit in front, becomes its own amplification surface.

### 2.3 Pathological input (`while(true){}`)

| Engine | Behaviour | Verdict |
|---|---|---|
| isolated-vm | interrupted, capped ~10 s ceiling, `ok:false timeout`, **0 restarts** | ✅ clean |
| QuickJS (isolated) | interrupted at **5.0 s**, `ok:false status:timeout` | ✅ timeout works… |
| QuickJS (under load) | 30 s client-timeout tails, head-of-line blocking of other requests | ⚠️ event-loop pinning |
| Piston | killed at run_timeout ~3 s | ✅ but always reports `ok:true` (see §4) |

QuickJS's timeout **does** fire in isolation; the danger is architectural — one CPU-bound
request degrades every other in-flight request on that process.

---

## 3. Security results — 21/27 contained (+2 info)

### 3.1 Sandbox escapes (QuickJS & isolated-vm) — all contained

| Attempt | QuickJS | isolated-vm |
|---|---|---|
| `Function('return process')()` constructor walk | ✅ contained | ✅ contained |
| Reach global `process` | ✅ only an empty shim `{env:{},cwd}` — no host leak | ✅ undefined |
| `require` present | ✅ absent | ✅ absent |
| Network egress via `fetch` | ✅ blocked | ✅ blocked |
| `__proto__` prototype pollution via `env` | ✅ no pollution | — |
| Fresh globals per request (no cross-request leak) | ✅ | ✅ |

### 3.2 DoS / limit enforcement

| Attack | QuickJS | isolated-vm |
|---|---|---|
| Infinite loop | ✅ timeout @5 s | ✅ timeout |
| Memory bomb | ⚠️ **container OOM-kill + restart** (cgroup caught it; app did not) | ✅ graceful `out_of_memory`, 0 restarts |
| Output flood | ✅ capped ~256 KB | ✅ capped |

**QuickJS memory bomb** (`while(true) a.push(new Array(1e6))`): the app's 64 MB QuickJS guest
limit did **not** catch this allocation pattern; RSS grew to the 512 MB container limit and
Docker OOM-killed + restarted the container (**restart count 2** over the run). Contained at the
infrastructure layer, but the request dies with `socket hang up` and any co-tenant requests on
that container die with it. isolated-vm caught the identical bomb in-process.

### 3.3 Sanitizer bypass (Piston & Judge0)

| Case | Expected | Piston | Judge0 |
|---|---|---|---|
| Plain `fetch()` | blocked 422 | ✅ 422 | ✅ 422 |
| `require('axios')` | blocked 422 | ✅ 422 | ✅ 422 |
| `globalThis['fet'+'ch'](...)` | must not egress | 🔴 **NET-OK — reached backend** | ✅ (exec broken) |
| Python `import socket` → connect | must not egress | 🔴 **NET-OK — reached backend** | ✅ (exec broken) |
| Python `subprocess.run(['id'])` | not root | ✅ not root | ✅ (exec broken) |
| Read `/etc/passwd` (info) | observe | ℹ️ readable (`root:x:0:0…`) | ℹ️ empty |

🔴 **The sanitizer is a speed-bump, not a boundary.** It has **no Python rules at all**
(`import socket`, `import subprocess`, `open()` all sail through), and its JS rules are defeated
by string concatenation. On this host Judge0 "passes" these only because it cannot execute; the
real containment layer is Piston's nsjail — which brings us to the headline:

### 3.4 🔴 Piston network egress is OPEN

With `PISTON_DISABLE_NETWORKING: "false"` in the working tree, sandboxed code — **both JS via a
sanitizer-bypassing `fetch` and Python via raw `socket`** — successfully connected to
`backend:3001` and read its response. Sandboxed user code can reach every other container on the
host network and anything the host can reach. This is the single most important finding.
**Fix:** set `PISTON_DISABLE_NETWORKING: "true"`.

### 3.5 API layer

| Check | Result |
|---|---|
| CORS | ✅ locked to `http://localhost:5173`; evil origin not reflected |
| Rate limiting | 🟠 **none** — 30 rapid requests all 200; one client saturates all engines |
| Auth | 🟠 none on backend; 🟠 Judge0 on `0.0.0.0:2358` with auth disabled |
| Error messages | ✅ clean, no stack/info leak on malformed input |
| Security headers | 🟡 `X-Powered-By: Express` leaked; no CSP/X-Frame/X-Content-Type (no helmet) |
| Container posture (sandboxes) | ✅ `read_only`, `cap_drop: ALL`, `no-new-privileges`, `sandbox-net` only |
| Container posture (Piston) | 🟡 `privileged: true` + egress on — large blast radius if nsjail is bypassed |

---

## 4. Contract inconsistencies (non-security, worth fixing)

- **Piston always returns `ok: true`** even on SIGKILL/timeout (`routes/execute.ts` hardcodes
  `{ ok: true, ...result }`). A timed-out Piston run is indistinguishable from success by `ok`.
  The sandboxes and Judge0 branch on `meta.status`; Piston should too.
- **QuickJS memory exhaustion** surfaces as a transport-level `socket hang up` / 502, not the
  documented `ok:false, status:out_of_memory`. The README's "branch on `ok`, not HTTP status"
  contract doesn't hold for this case.

---

## 5. Recommendations (priority order)

1. 🔴 **Set `PISTON_DISABLE_NETWORKING: "true"`.** Egress is the whole point of the sandbox.
2. 🔴 **Stop trusting the sanitizer as a boundary.** Add Python rules if you keep it, but treat
   nsjail/isolate as the real control. Document it as defence-in-depth only.
3. 🟠 **Add rate limiting + optional auth** to the backend; enable Judge0 auth or bind it to
   loopback.
4. 🟠 **Harden QuickJS against memory bombs** — lower the container memory limit toward the guest
   limit, or handle the allocation-storm pattern so it returns `out_of_memory` instead of dying.
5. 🟡 **Fix the Piston `ok:true`-on-failure contract** and the QuickJS OOM contract.
6. 🟡 **Add helmet** to the backend; commit the missing `.dockerignore` files; fix
   `PISTON_LOG_LEVEL`; update the README's runtime-install section.

### Which engine for what
- **Untrusted rules/transforms, need speed:** **isolated-vm.** Fastest by far, cleanest limit
  enforcement, strongest graceful containment. Caveat: the boundary is V8-with-JIT, so a V8
  escape is an escape into the process.
- **Untrusted rules where the audit story beats speed:** **QuickJS.** No JIT to corrupt, but keep
  runs short and CPU-light, and fix the memory-bomb behaviour. Not for CPU-heavy work.
- **Full runtime / real stdlib / multi-language:** **Piston** — once networking is disabled.
  Expensive per run (~0.6 s spawn floor, 800%+ CPU under load); put a queue/rate-limit in front.
- **Per-run kernel CPU/RSS metering:** **Judge0** — but only on a **cgroup v1** host. Unusable on
  Docker Desktop / macOS.

_Raw data: `bench/results/` — `00-baseline.md`, `01-parity.json`, `03-security.json`,
`k6/*.json`, `k6/run.log`._
