#!/bin/sh
# Kernel-boundary probe. Models an attacker who ALREADY has code execution
# inside the executor container (i.e. the V8 / WASM sandbox is assumed breached)
# and asks: what does the layer *below* the process let them touch?
#
# Run the SAME script under runc and under runsc and diff the output. Lines that
# change are exactly what gVisor's sentry is absorbing instead of the host kernel.
#
#   docker run --rm -v "$PWD/bench/scripts:/p" alpine       sh /p/kernel-probe.sh   # runc
#   docker run --rm -v "$PWD/bench/scripts:/p" --runtime=runsc alpine sh /p/kernel-probe.sh
#
# Or point it at the real services:
#   docker compose exec -T quickjs     sh - < bench/scripts/kernel-probe.sh
#   docker compose exec -T isolated-vm sh - < bench/scripts/kernel-probe.sh

line() { printf '%-34s %s\n' "$1" "$2"; }
try() { "$@" >/dev/null 2>&1 && echo "ALLOWED" || echo "denied ($?)"; }

echo "== identity =="
line "whoami"              "$(id 2>/dev/null)"
line "/proc/version"       "$(head -c 90 /proc/version 2>/dev/null)"
line "uname -r"            "$(uname -r)"
line "dmesg (gVisor tag?)" "$(dmesg 2>/dev/null | head -1 | cut -c1-70 || echo 'dmesg denied')"

echo
echo "== kernel attack surface (a real kernel would service these; gVisor answers ENOSYS/EPERM in its sentry) =="
line "unshare -Urn"        "$(try unshare -Urn true)"
line "mount -t proc"       "$(try mount -t proc proc /mnt)"
line "ptrace (strace ls)"  "$(command -v strace >/dev/null && try strace -f -e trace=none true || echo 'strace absent')"
line "raw socket (ping -c1)" "$(try ping -c1 -W1 127.0.0.1)"
line "read /proc/kallsyms" "$(head -1 /proc/kallsyms 2>/dev/null | grep -q ' ' && echo 'ALLOWED (symbols readable)' || echo 'denied/empty')"
line "read /proc/kcore"    "$(test -r /proc/kcore && echo ALLOWED || echo 'denied/absent')"
line "/sys/kernel writable" "$(test -w /sys/kernel/uevent_helper && echo ALLOWED || echo 'denied/absent')"
line "load kernel module"  "$(try modprobe dummy)"
line "bpf() syscall"       "$(command -v bpftool >/dev/null && try bpftool prog || echo 'bpftool absent - see C probe')"
line "keyctl / add_key"    "$(command -v keyctl >/dev/null && try keyctl show || echo 'keyctl absent - see C probe')"

echo
echo "== host visibility =="
line "host PIDs visible"   "$(ps -eo pid,comm 2>/dev/null | wc -l) procs; max pid $(ps -eo pid 2>/dev/null | sort -n | tail -1)"
line "/proc/1/comm"        "$(cat /proc/1/comm 2>/dev/null)"
line "docker.sock present" "$(test -S /var/run/docker.sock && echo YES || echo no)"

echo
echo "== egress (should be dead regardless: sandbox-net is internal) =="
line "tcp connect backend" "$(try nc -w2 -z backend 3001 || echo 'nc absent/denied')"
line "dns resolve"         "$(nslookup example.com 2>/dev/null | grep -q Address && echo RESOLVED || echo 'no dns')"
