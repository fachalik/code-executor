# Phase 0 — Baseline & Environment

_Captured: 2026-09-09T07:41:46Z_

## Host
- Platform: darwin (Apple Silicon, arm64), Docker Desktop 29.2.1
- cgroup: v2 (unified hierarchy) — relevant to Judge0

## Services (all built from this repo's working tree)
| Service | State | Reachability |
|---|---|---|
| backend | up :3001 | host + executor-net + sandbox-net |
| frontend | up :5173 | host |
| piston | up :2000 | host + executor-net |
| quickjs | up (internal) | sandbox-net only, via backend |
| isolated-vm | up (internal) | sandbox-net only, via backend |
| judge0 (external stack) | up :2358 | host, via backend host.docker.internal |

## Installed runtimes
- Piston: javascript (node 20.11.1), python 3.12.0, typescript 5.0.3
- Judge0: JS (Node 12.14.0, id 63), TS (3.7.4, id 74), Python (3.8.1, id 71)

## Smoke test (via backend POST /api/execute)
| Engine | Result |
|---|---|
| piston js | ok — stdout "2" |
| piston python | ok — stdout "42" |
| judge0 js | **FAIL — internal_error: rb_sysopen /box/script.js** |
| judge0 python | **FAIL — internal_error** |
| quickjs | ok — result {y:42}, timeMs 100, memKb 150 |
| isolated-vm | ok — result {y:42}, timeMs 7, cpuMs 1, memKb 623 |

## Setup issues found & fixed to get the stack running
1. **Missing `.dockerignore` in backend/ and frontend/** — host pnpm node_modules
   copied into build context, collided with image's, build failed
   (`cannot replace to directory .../node_modules/@types/cors with file`).
   Fixed by adding .dockerignore to both (mirrors the executor services').
2. **`PISTON_LOG_LEVEL: warn`** invalid — Piston requires uppercase; container
   crash-looped with "Log level warn does not exist". Changed to `INFO`.
3. **Piston ships empty AND has no `ppman`** in this image; README's
   `ppman install` commands fail. Runtimes must be installed via the HTTP API
   (`POST /api/v2/packages`), and JavaScript is the **`node`** package, not
   `javascript`. README is stale on both points.

## Judge0 execution: BROKEN on this host (as README warns)
cgroup v2 host + isolate 1.8.1 (cgroup v1 only) → every submission is Internal
Error. The backend surfaces it cleanly. Judge0 is therefore covered at the
API/reachability layer only; its execution latency/throughput cannot be measured
here. Numbers for it would require a cgroup-v1 Linux host.
