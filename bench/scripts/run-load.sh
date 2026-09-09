#!/usr/bin/env bash
# Phase 2 runner. Drives k6 across engines × workloads and collects JSON summaries.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/results/k6"; mkdir -p "$OUT"
NET_EXEC=code-executor_executor-net
NET_SAND=code-executor_sandbox-net
k6run () { # $1=network $2..=envs
  local net="$1"; shift
  docker run --rm -i --network "$net" \
    -v "$ROOT/k6/load.js:/load.js:ro" -v "$OUT:/out" \
    "$@" grafana/k6 run --quiet /load.js 2>&1 | grep -A3 "== " || true
}
echo "### MAIN: backend path, VUS=10 20s"
for eng in piston quickjs isolated-vm; do
  for wl in hello cpu payload; do
    k6run "$NET_EXEC" -e ENGINE=$eng -e WORKLOAD=$wl -e VUS=10 -e DURATION=20s -e TARGET=http://backend:3001
  done
done
echo "### JUDGE0 (execution broken on cgroup v2 — latency/reachability only)"
k6run "$NET_EXEC" -e ENGINE=judge0 -e WORKLOAD=hello -e VUS=5 -e DURATION=10s -e TARGET=http://backend:3001
echo "### DIRECT: sandbox-net, isolate proxy overhead, VUS=10 20s"
for eng in quickjs isolated-vm; do
  port=3002; [ "$eng" = isolated-vm ] && port=3003
  for wl in hello cpu; do
    k6run "$NET_SAND" -e ENGINE=$eng -e DIRECT=1 -e WORKLOAD=$wl -e VUS=10 -e DURATION=20s -e TARGET=http://$eng:$port
  done
done
echo "### SATURATION: 50 VUs into 4-slot executors (expect 429 shedding)"
for eng in quickjs isolated-vm; do
  port=3002; [ "$eng" = isolated-vm ] && port=3003
  k6run "$NET_SAND" -e ENGINE=$eng -e DIRECT=1 -e WORKLOAD=cpu -e VUS=50 -e DURATION=20s -e TARGET=http://$eng:$port
done
echo "### PATHOLOGICAL: infinite loop, does timeout hold? VUS=6 18s"
for eng in quickjs isolated-vm piston; do
  path_net="$NET_EXEC"; tgt=http://backend:3001; direct=""
  k6run "$path_net" -e ENGINE=$eng -e WORKLOAD=pathological -e VUS=6 -e DURATION=18s -e TARGET=$tgt
done
echo "### DONE"
