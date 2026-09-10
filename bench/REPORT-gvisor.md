# Code-Executor — gVisor Implementation & Test Report

_Test date: 2026-09-10 · Host: macOS / Apple Silicon (arm64), **Colima** (Lima + Apple
Virtualization), Docker 27, gVisor `runsc` (systrap platform)_
_Scope: wrap the two in-process JS sandboxes (`quickjs`, `isolated-vm`) in a gVisor kernel
boundary and prove (a) it is actually in force, (b) it removes host-kernel attack surface,
(c) it does not regress isolation or function. Piston and Judge0 are unchanged — they already
bring their own kernel/namespace sandbox._

> Host note: the load numbers in `REPORT.md` were taken on Docker Desktop. This run is on
> Colima, which is faster on this machine, so **only the same-host runc-vs-runsc A/B in §5 is a
> valid gVisor cost measurement** — do not compare its absolute ms to `REPORT.md`.

---

## TL;DR

- **gVisor is in force.** `quickjs` and `isolated-vm` run under `runtime: runsc`; every syscall
  they make terminates in the gVisor sentry (`/proc/version` → `4.19.0-gvisor`), not the host
  kernel 6.8. `backend`, `piston`, `frontend` stay on `runc`.
- **Real host-kernel surface removed.** Under plain `runc` an attacker with code execution in
  the container could read `/proc/kcore` (live kernel memory) and `/proc/kallsyms` (kernel
  symbol addresses), and write `/sys/kernel/uevent_helper` (a classic escape-to-host primitive).
  Under `runsc` **all three are gone.** `io_uring_setup` — serviced by the host kernel once
  Docker's seccomp filter is removed — is refused by gVisor unconditionally.
- **No isolation regression.** The Phase 3 corpus is **27/27 contained** under gVisor (identical
  to the pre-gVisor baseline); both engines still execute correctly.
- **Cost is small and fixed.** Same-host A/B on a trivial run: `quickjs` +~5–8 ms, `isolated-vm`
  +~2–3 ms per request. Relative hit is larger for `isolated-vm` (sub-ms → ~3 ms) but absolute
  cost is negligible for the workload. CPU-bound runs pay proportionally less (compute isn't
  syscall-bound).
- **Required side-change:** `isolated-vm@7.0.1` needs **Node ≥ 24**; the executor Dockerfile was
  bumped `node:20-bookworm-slim` → `node:24-bookworm-slim`. Unrelated to gVisor, but the stack
  did not build without it.
- **What gVisor does *not* do:** it is a second layer, not a replacement. Network egress is
  still enforced by Docker (`sandbox-net: internal: true`), and the in-process V8/WASM boundary
  is still the first line of defence. gVisor only matters *after* one of those is breached.

**Phase 4 result: 18 pass / 0 fail / 3 info.** Raw: `bench/results/04-gvisor.json`.

---

## 1. What was implemented

### 1.1 Runtime wrapper — `docker-compose.gvisor.yml`

```yaml
services:
  quickjs:     { runtime: runsc }
  isolated-vm: { runtime: runsc }
```

An override, not an edit to `docker-compose.yml`. Local dev stays on `runc`
(`docker compose up`); the boundary is opt-in per environment:

```bash
docker compose -f docker-compose.yml -f docker-compose.gvisor.yml up -d
```

All existing hardening (`read_only`, `tmpfs`, `cap_drop: ALL`, `no-new-privileges`,
`sandbox-net` only, `deploy.resources` limits) is unchanged and compatible with `runsc`.

### 1.2 Host prerequisite — `runsc` registered with Docker

gVisor needs a Linux host. On macOS that means a Linux VM whose Docker daemon you control —
Docker Desktop's VM does not allow this, **Colima does**:

```bash
colima start --vm-type vz --cpu 4 --memory 8
colima ssh
  ARCH=$(uname -m)
  URL=https://storage.googleapis.com/gvisor/releases/release/latest/${ARCH}
  wget ${URL}/runsc ${URL}/containerd-shim-runsc-v1
  chmod a+rx runsc containerd-shim-runsc-v1
  sudo mv runsc containerd-shim-runsc-v1 /usr/local/bin/
  sudo /usr/local/bin/runsc install      # writes the "runsc" runtime into /etc/docker/daemon.json
  sudo service docker restart
```

`docker info --format '{{json .Runtimes}}'` must then list `runsc`.

### 1.3 Required side-change — Node 24 for `isolated-vm`

`isolated-vm-code-executor` pins `isolated-vm@^7.0.1` (the fix line for
GHSA-864f-rcv7-6rh4). `isolated-vm@7.0.1` declares `engines: { node: '>=24.0.0' }`; against
Node 20's V8 the native addon fails to compile
(`'SourceLocation' in namespace 'v8' does not name a type`). Fix: all three build stages in
`isolated-vm-code-executor/Dockerfile` moved to `node:24-bookworm-slim`. v7 ships prebuilt
binaries via `node-gyp-build`, so no toolchain compile is needed at image-build time
(`prebuilds/linux-arm64/isolated-vm.abi147.glibc.node` is selected at require-time).

### 1.4 Test harness — Phase 4

| File | Role |
|---|---|
| `bench/scripts/run-gvisor.sh` | Phase 4 runner. Asserts wiring, boundary, and regression; writes `bench/results/04-gvisor.json`; exit ≠ 0 on any failure. |
| `bench/scripts/kernel-probe.sh` | Shell probe of the `/proc`, `/sys`, namespace, raw-socket and egress surface. Runs in any container. |
| `bench/scripts/syscall-probe.c` | Compiled probe for `io_uring`, `userfaultfd`, `bpf`, `perf_event_open`, `keyctl`, `ptrace` — calls shell tools can't reach. |

```bash
bash bench/scripts/run-gvisor.sh
```

---

## 2. Scope & method

### 2.1 Threat model — where gVisor sits

| Layer | Control | Changed by this work? |
|---|---|---|
| 1. In-process sandbox | V8 Isolate (isolated-vm) / WASM linear memory (quickjs) | No — unchanged |
| 2. Container | `cap_drop: ALL`, `no-new-privileges`, `read_only`, non-root `USER node` | No — unchanged |
| 3. Network | `sandbox-net: internal: true` (no gateway, no published port) | No — unchanged |
| **4. Kernel** | **`runc` → `runsc`: syscalls served by the gVisor sentry, not the host kernel** | **Yes — added** |

Layer 4 only does anything once Layer 1 is breached — i.e. an attacker who has achieved native
code execution inside the executor process (a V8 sandbox escape, or a bug in isolated-vm's C++
marshalling glue such as GHSA-864f-rcv7-6rh4). The test therefore **models a post-escape
attacker**: arbitrary code running as `node` (uid 1000) inside the container, probing what the
layer below the process will give them.

### 2.2 What is asserted

1. **Wiring** — `runsc` registered; `quickjs` + `isolated-vm` on `runtime=runsc`; other
   services still `runc`.
2. **Boundary** — run `kernel-probe.sh` under `runc` and `runsc` on a baseline `alpine`
   container and diff; any line that is `ALLOWED` under `runc` must be locked down under
   `runsc`. Repeat *inside the running executors* as `node`.
3. **Syscall floor** — run `syscall-probe.c` under `runc`, `runc --security-opt
   seccomp=unconfined`, and `runsc`; calls the unconfined host kernel services must still fail
   under `runsc`.
4. **Regression** — re-run the Phase 3 corpus (`security.mjs`) under gVisor; leak count must be
   0. Baseline `03-security.json` is snapshotted and restored; the gVisor run is kept as
   `04-security-under-gvisor.json`.
5. **Function** — both engines still return `42` for `export default 6*7`.

---

## 3. Wiring results — all pass

| Check | Result |
|---|---|
| `runsc` registered with Docker | ✅ |
| `quickjs` runtime = `runsc` | ✅ |
| `isolated-vm` runtime = `runsc` | ✅ |
| `backend` / `piston` / `frontend` still `runc` | ✅ |
| `/proc/version` inside `quickjs`, `isolated-vm` | `Linux 4.19.0-gvisor` — sentry, not host |
| probe runs as | `uid=1000(node)` — non-root, as shipped |

---

## 4. Kernel-boundary results

### 4.1 `/proc` and `/sys` surface — `runc` vs `runsc` (alpine baseline)

| Probe | `runc` (host kernel 6.8) | `runsc` (gVisor sentry) | Why it matters |
|---|---|---|---|
| `/proc/kallsyms` | 🔴 **readable — real symbol addresses** | ✅ empty | Kernel address disclosure → defeats KASLR, step 1 of most kernel LPEs |
| `/proc/kcore` | 🔴 **readable — live kernel memory image** | ✅ absent | Direct read of ring-0 memory |
| `/sys/kernel/uevent_helper` | 🔴 **writable** | ✅ absent | Write a path + trigger a uevent → host kernel runs it as root in the init namespace |
| `/proc/version`, `uname -r` | `6.8.0-117-generic` | `4.19.0-gvisor` | Every syscall now lands in ~200 Go handlers, not the host's 350+ |
| `dmesg` | (blocked, no `CAP_SYSLOG`) | `Starting gVisor...` | Confirms the sentry is live |

Docker's default seccomp profile does **not** touch filesystem info leaks — the synthetic
`/proc` and `/sys` that the sentry serves are what removes them.

### 4.2 Same probe, inside the running executors (as `node`)

| Check | `quickjs` | `isolated-vm` |
|---|---|---|
| syscalls hit the gVisor sentry (`/proc/version`) | ✅ | ✅ |
| `/proc/kcore` | ✅ denied | ✅ denied |

### 4.3 Direct syscall probe — `runc` / `runc seccomp=unconfined` / `runsc`

| Syscall | `runc` (Docker seccomp) | `runc` unconfined | `runsc` | Verdict |
|---|---|---|---|---|
| `io_uring_setup` | denied (EPERM, filtered) | 🔴 **ALLOWED — host kernel** | ✅ denied | gVisor refuses it regardless of the seccomp layer |
| `userfaultfd` | denied | denied (`vm.unprivileged_userfaultfd=0`) | denied | ℹ️ host already locks this — no diff to show |
| `bpf` | denied | denied (`unprivileged_bpf_disabled=1`) | denied | ℹ️ same |
| `perf_event_open` | denied | denied (`perf_event_paranoid`) | denied | ℹ️ same |

**Reading it:** on a kernel with the unprivileged sysctls already tightened (this Colima VM),
seccomp-bypass alone does not re-open `userfaultfd`/`bpf`/`perf_event_open`, so those three are
reported *info*, not *pass* — an honest "nothing to prove here on this host". `io_uring_setup`
is the clean demonstration: remove the seccomp filter and the **host kernel hands you an
io_uring instance** (a large, LPE-prone surface); gVisor never does, because the sentry does not
implement it. On a stock cloud host, `userfaultfd` and `perf_event_open` typically show the same
`runc-unconfined ALLOWED → runsc denied` pattern.

---

## 5. Performance cost — same-host `runc` vs `runsc` A/B

40 sequential `export default 6*7` runs through the backend, both engines recreated on each
runtime on the same idle Colima VM. Trivial workload → this is essentially the **fixed
per-request overhead** gVisor adds.

| Engine | Runtime | avg | p50 | p95 | min |
|---|---|--:|--:|--:|--:|
| **quickjs** | runc | 19.6 ms | 10.5 ms | 66.7 ms | 7.9 ms |
| quickjs | **runsc** | 27.2 ms | 20.9 ms | 110.0 ms | **12.7 ms** |
| **isolated-vm** | runc | 1.4 ms | 0.8 ms | 2.6 ms | 0.6 ms |
| isolated-vm | **runsc** | 4.1 ms | 3.1 ms | 6.1 ms | **2.4 ms** |

**Reading it** (use `min` — least noise):
- `quickjs`: **+4.8 ms** floor (7.9 → 12.7). ~+60 % on a trivial run.
- `isolated-vm`: **+1.8 ms** floor (0.6 → 2.4). Absolute cost is tiny; relative cost looks large
  only because the `runc` baseline is sub-millisecond.
- This is syscall-interception overhead on the request/response and isolate/context-setup path.
  A CPU-bound run (JIT'd compute, few syscalls) pays a much smaller *relative* penalty — not
  measured here; run `bench/scripts/run-load.sh` with and without the override for the full
  workload matrix.

---

## 6. Regression results — no change to isolation or function

| Check | Result |
|---|---|
| Phase 3 corpus under gVisor | ✅ **27/27 contained**, 0 LEAK lines (baseline: same) |
| `quickjs` executes (`6*7` → `42`) | ✅ |
| `isolated-vm` executes (`6*7` → `42`) | ✅ |

`isolated-vm` memory accounting note: the Phase 3 memory-bomb case still trips the **in-process**
V8 heap cap first (fast `out_of_memory`), not gVisor's memory accounting or the container
`mem_limit` — the desired order. `quickjs`'s pre-existing memory-bomb behaviour
(container OOM-kill, `REPORT.md` §3.2) is unchanged; gVisor does not fix it.

---

## 7. Limitations

- **No real escape was exercised.** There is no public V8 0-day to hand and GHSA-864f-rcv7-6rh4
  is patched at 7.0.1. The test proves what a *hypothetical* post-escape attacker can and cannot
  reach; it does not prove gVisor stops a specific exploit chain.
- **Host already hardened.** This Colima kernel has `unprivileged_bpf_disabled`,
  `unprivileged_userfaultfd=0` and `perf_event_paranoid` set, so three of four syscall probes
  had no `runc`-vs-`runsc` delta to show. On a less-locked host the gVisor win there is larger.
- **Not the production host.** Colima ≠ your Linux deploy target. Re-run Phase 4 there before
  relying on the numbers; `runsc` platform, kernel version and sysctls all differ.
- **gVisor's own attack surface.** The sentry is ~200k lines of Go; it has had its own CVEs.
  gVisor trades the host kernel's surface for a smaller, memory-safe, but non-zero one.

---

## 8. Recommendations

1. **Keep `runsc` on `quickjs` and `isolated-vm` in staging/production.** The cost (~2–5 ms
   fixed) is worth a real kernel boundary behind a JIT-on V8 isolate, which per `REPORT.md` is
   the engine whose escape blast radius is "host Node process (RCE)".
2. **Ship the override as the deploy default.** Add `docker-compose.gvisor.yml` to the
   documented production bring-up; keep local dev on `runc`.
3. **Commit the Node 24 bump** — it is required for `isolated-vm@7.0.1` regardless of gVisor.
4. **Run `run-load.sh` under `runsc`** on the real deploy host for the full workload matrix
   (CPU-bound, payload, saturation, pathological) before sign-off.
5. **Do not drop any existing layer.** gVisor is defence-in-depth on top of the in-process
   sandbox, `cap_drop`, `read_only`, non-root and `sandbox-net: internal` — not a substitute for
   any of them.
6. **Re-run Phase 4 in CI** on a Linux runner (`ubuntu-latest` + `runsc` install) so a
   regression in wiring or containment fails the build.

_Raw data: `bench/results/04-gvisor.json`, `bench/results/04-security-under-gvisor.json`.
Scripts: `bench/scripts/run-gvisor.sh`, `kernel-probe.sh`, `syscall-probe.c`._
