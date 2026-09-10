#!/usr/bin/env bash
# Phase 4 runner — gVisor / kernel-boundary test.
#
# Answers three questions:
#   1. Wiring    — is `runsc` actually the runtime under quickjs + isolated-vm?
#   2. Boundary  — does the kernel attack surface that plain runc exposes
#                  (/proc/kcore, /proc/kallsyms, /sys writes, io_uring,
#                  userfaultfd, …) get absorbed by the gVisor sentry?
#   3. Regression— did enabling gVisor break the in-process sandbox (Phase 3)
#                  or basic execution?
#
# Prereqs:
#   - `runsc` registered as a docker runtime (`docker info | grep -i runtimes`)
#   - stack up WITH the override:
#       docker compose -f docker-compose.yml -f docker-compose.gvisor.yml up -d
#
# Usage:  bench/scripts/run-gvisor.sh
# Writes: bench/results/04-gvisor.json   (exit 1 if any assertion fails)

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$ROOT/.." && pwd)"
SCRIPTS="$ROOT/scripts"
OUT="$ROOT/results"; mkdir -p "$OUT"
LOGDIR="$(mktemp -d)"
BACKEND="${BACKEND:-http://localhost:3001}"
DC="docker compose -f $REPO/docker-compose.yml -f $REPO/docker-compose.gvisor.yml"
PROBE="$SCRIPTS/kernel-probe.sh"

PASS=0; FAIL=0; SKIP=0
REC="$LOGDIR/records.tsv"; : > "$REC"
rec () { # $1=status(pass|fail|skip|info)  $2=name  $3=detail
  printf '  [%-4s] %-42s %s\n' "$1" "$2" "${3:+— $3}"
  printf '%s\t%s\t%s\n' "$1" "$2" "${3:-}" >> "$REC"
  case "$1" in pass) PASS=$((PASS+1));; fail) FAIL=$((FAIL+1));; skip) SKIP=$((SKIP+1));; esac
}
have () { command -v "$1" >/dev/null 2>&1; }

echo "═══ Phase 4 — gVisor / kernel-boundary ═══"
echo "repo=$REPO  backend=$BACKEND  logs=$LOGDIR"

# ── 1. Wiring ────────────────────────────────────────────────────────────────
echo
echo "1. Wiring"
if docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"runsc"'; then
  rec pass "runsc registered with docker"
else
  rec fail "runsc registered with docker" "install gVisor + 'runsc install' + restart docker"
fi

for svc in quickjs isolated-vm; do
  cid="$($DC ps -q "$svc" 2>/dev/null)"
  if [ -z "$cid" ]; then rec fail "$svc container running" "bring the stack up with the gvisor override"; continue; fi
  rt="$(docker inspect -f '{{.HostConfig.Runtime}}' "$cid" 2>/dev/null)"
  [ "$rt" = "runsc" ] && rec pass "$svc runtime = runsc" || rec fail "$svc runtime = runsc" "got '$rt'"
done

# other services must stay on runc
for svc in backend piston frontend; do
  cid="$($DC ps -q "$svc" 2>/dev/null)"; [ -z "$cid" ] && continue
  rt="$(docker inspect -f '{{.HostConfig.Runtime}}' "$cid" 2>/dev/null)"
  [ "$rt" = "runc" ] && rec pass "$svc still on runc" || rec info "$svc runtime" "$rt"
done

# ── 2. Kernel boundary — baseline alpine, runc vs runsc ──────────────────────
echo
echo "2. Kernel boundary  (alpine baseline: runc vs runsc)"
run_probe () { # $1=runtime  -> stdout capture to $LOGDIR/probe-$1.txt
  docker run --rm --network none $2 -v "$SCRIPTS:/p:ro" alpine sh /p/kernel-probe.sh \
    > "$LOGDIR/probe-$1.txt" 2>&1
}
run_probe runc  ""
run_probe runsc "--runtime=runsc"

grep -qi 'gvisor' "$LOGDIR/probe-runsc.txt" \
  && rec pass "runsc: /proc/version is a gVisor sentry" \
  || rec fail "runsc: /proc/version is a gVisor sentry" "see probe-runsc.txt"

# each: must be ALLOWED under runc AND locked down under runsc
assert_closed () { # $1=probe-line-prefix  $2=name
  local rc rs
  rc="$(grep -m1 "^$1" "$LOGDIR/probe-runc.txt"  | sed 's/  */ /g')"
  rs="$(grep -m1 "^$1" "$LOGDIR/probe-runsc.txt" | sed 's/  */ /g')"
  if echo "$rc" | grep -qi 'ALLOWED' && ! echo "$rs" | grep -qi 'ALLOWED'; then
    rec pass "$2 closed by gVisor" "runc:'${rc#$1 }' -> runsc:'${rs#$1 }'"
  elif echo "$rc" | grep -qi 'ALLOWED'; then
    rec fail "$2 closed by gVisor" "still reachable under runsc: '$rs'"
  else
    rec info "$2" "not exposed under runc on this host either ('$rc')"
  fi
}
assert_closed "read /proc/kallsyms" "kernel symbol leak (/proc/kallsyms)"
assert_closed "read /proc/kcore"    "kernel memory image (/proc/kcore)"
assert_closed "/sys/kernel writable" "/sys/kernel/uevent_helper write"

# ── 3. Kernel boundary — inside the REAL services (as their own user) ────────
echo
echo "3. Kernel boundary  (inside the running executors)"
for svc in quickjs isolated-vm; do
  f="$LOGDIR/probe-$svc.txt"
  if $DC exec -T "$svc" sh - < "$PROBE" > "$f" 2>&1; then
    who="$(grep -m1 '^whoami' "$f" | sed 's/  */ /g')"
    if grep -qi 'gvisor' "$f"; then
      rec pass "$svc: syscalls hit the gVisor sentry" "${who#whoami }"
    else
      rec fail "$svc: syscalls hit the gVisor sentry" "no gvisor tag in /proc/version"
    fi
    grep -m1 "^read /proc/kcore" "$f" | grep -qi 'ALLOWED' \
      && rec fail "$svc: /proc/kcore denied" \
      || rec pass "$svc: /proc/kcore denied"
  else
    rec skip "$svc kernel probe" "exec failed (missing /bin/sh?) — see $f"
  fi
done

# ── 4. Direct syscall probe — runc / runc-unconfined / runsc ────────────────
echo
echo "4. Syscall probe  (io_uring, userfaultfd, bpf, perf_event_open …)"
GCC_IMG=gcc:13
if docker image inspect "$GCC_IMG" >/dev/null 2>&1 || docker pull -q "$GCC_IMG" >/dev/null 2>&1; then
  sc_run () { # $1=tag  $2=extra docker args
    docker run --rm --network none $2 -v "$SCRIPTS:/p:ro" "$GCC_IMG" \
      sh -c 'gcc -static -O2 /p/syscall-probe.c -o /t 2>/dev/null && /t' \
      > "$LOGDIR/syscall-$1.txt" 2>&1
  }
  sc_run runc        ""
  sc_run unconfined  "--security-opt seccomp=unconfined"
  sc_run runsc       "--runtime=runsc"

  # for calls the unconfined host kernel SERVICES, gVisor must still refuse
  for call in io_uring_setup userfaultfd perf_event_open bpf; do
    u="$(grep -m1 "^$call " "$LOGDIR/syscall-unconfined.txt")"
    g="$(grep -m1 "^$call " "$LOGDIR/syscall-runsc.txt")"
    if echo "$u" | grep -q 'ALLOWED'; then
      echo "$g" | grep -q 'ALLOWED' \
        && rec fail "$call refused by gVisor" "host kernel serviced it AND gVisor did too" \
        || rec pass "$call refused by gVisor" "unconfined host: ALLOWED"
    else
      rec info "$call" "host kernel refused it even unconfined ('${u#$call }')"
    fi
  done
else
  rec skip "syscall probe" "cannot obtain $GCC_IMG (offline?)"
fi

# ── 5. Regression — Phase 3 in-process sandbox ─────────────────────────────
echo
echo "5. Regression  (Phase 3 corpus under gVisor)"
# security.mjs hard-writes results/03-security.json — snapshot the pre-gVisor
# baseline, then restore it and keep the gVisor run under its own name.
BASELINE="$OUT/03-security.json"; SNAP="$LOGDIR/03-security.baseline.json"
[ -f "$BASELINE" ] && cp "$BASELINE" "$SNAP"
if BACKEND="$BACKEND" node "$SCRIPTS/security.mjs" > "$LOGDIR/security.txt" 2>&1; then
  tail="$(grep -Eo '[0-9]+/[0-9]+ contained' "$LOGDIR/security.txt" | tail -1)"
  leaks="$(grep -c 'LEAK' "$LOGDIR/security.txt" || true)"
  [ -f "$BASELINE" ] && cp "$BASELINE" "$OUT/04-security-under-gvisor.json"
  [ -f "$SNAP" ] && cp "$SNAP" "$BASELINE"   # restore the untouched baseline
  if [ "${leaks:-1}" -eq 0 ] 2>/dev/null; then
    rec pass "no new sandbox leaks under gVisor" "$tail, 0 LEAK lines"
  else
    rec fail "no new sandbox leaks under gVisor" "$leaks LEAK line(s) — see security.txt"
  fi
else
  [ -f "$SNAP" ] && cp "$SNAP" "$BASELINE"
  rec skip "Phase 3 corpus" "security.mjs did not run — see $LOGDIR/security.txt"
fi

# ── 6. Regression — basic execution ───────────────────────────────────────
echo
echo "6. Regression  (execution still works)"
for eng in quickjs isolated-vm; do
  r="$(curl -s -m 15 -X POST "$BACKEND/api/execute" -H 'content-type: application/json' \
        -d "{\"platform\":\"$eng\",\"language\":\"javascript\",\"code\":\"export default 6*7\"}" 2>&1)"
  echo "$r" | grep -q '"result":42' \
    && rec pass "$eng executes under gVisor" \
    || rec fail "$eng executes under gVisor" "resp: ${r:0:120}"
done

# ── Report ────────────────────────────────────────────────────────────────
echo
echo "──────────────────────────────────────────────"
echo "  pass=$PASS  fail=$FAIL  skip=$SKIP"
echo "  full probe logs: $LOGDIR"
echo "──────────────────────────────────────────────"

node -e '
  const fs=require("fs");
  const rows=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean)
    .map(l=>{const[status,name,detail]=l.split("\t");return{status,name,detail:detail||""};});
  const summary={pass:rows.filter(r=>r.status==="pass").length,
                 fail:rows.filter(r=>r.status==="fail").length,
                 skip:rows.filter(r=>r.status==="skip").length};
  fs.writeFileSync(process.argv[2],JSON.stringify(
    {phase:"04-gvisor",when:new Date().toISOString(),summary,checks:rows},null,2));
' "$REC" "$OUT/04-gvisor.json"
echo "  wrote $OUT/04-gvisor.json"

[ "$FAIL" -eq 0 ]
