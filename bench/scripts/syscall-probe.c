/* Phase 4 helper — direct syscall probe.
 *
 * Exercises the syscalls that matter for kernel privilege escalation but that
 * shell tools (bpftool, keyctl) usually aren't installed to reach. Prints one
 * line per syscall: ALLOWED, or the errno it failed with.
 *
 * The point is the DIFF between three runtimes:
 *
 *   docker run --rm -v "$PWD/bench/scripts:/p:ro" gcc:13 \
 *     sh -c 'gcc -static -O2 /p/syscall-probe.c -o /t && /t'
 *   docker run --rm --security-opt seccomp=unconfined -v ... gcc:13 sh -c '...'
 *   docker run --rm --runtime=runsc               -v ... gcc:13 sh -c '...'
 *
 * runc (default): most are EPERM — Docker's seccomp-bpf filter refuses them
 *   before the host kernel sees them.
 * runc + seccomp=unconfined: the filter is gone, so calls like io_uring_setup
 *   and userfaultfd reach the HOST kernel and succeed (ALLOWED).
 * runsc: the same calls still fail — gVisor's sentry simply does not implement
 *   them, so containment does not depend on the seccomp layer being intact.
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <errno.h>
#include <string.h>
#include <unistd.h>
#include <sys/syscall.h>

static void probe(const char *name, long nr,
                  long a1, long a2, long a3, long a4, long a5) {
    errno = 0;
    long r = syscall(nr, a1, a2, a3, a4, a5);
    if (r >= 0) printf("%-18s ALLOWED (ret=%ld)\n", name, r);
    else        printf("%-18s denied: %s\n", name, strerror(errno));
}
#define P(sym, ...) probe(#sym, SYS_##sym, __VA_ARGS__)

int main(void) {
    /* zeroed scratch buffer for calls that copy_from_user a struct — without a
     * valid pointer they fail EFAULT and mask whether the call itself is allowed */
    static unsigned char params[256];

#ifdef SYS_bpf
    P(bpf, 5 /*BPF_PROG_LOAD*/, (long)params, sizeof(params), 0, 0);
#endif
#ifdef SYS_userfaultfd
    P(userfaultfd, 0, 0, 0, 0, 0);
#endif
#ifdef SYS_io_uring_setup
    P(io_uring_setup, 1, (long)params, 0, 0, 0);
#endif
#ifdef SYS_perf_event_open
    P(perf_event_open, 0, 0, -1, -1, 0);
#endif
#ifdef SYS_add_key
    P(add_key, (long)"user", (long)"k", (long)"v", 1, -2 /*PROCESS_KEYRING*/);
#endif
#ifdef SYS_keyctl
    P(keyctl, 0 /*GET_KEYRING_ID*/, -2, 0, 0, 0);
#endif
#ifdef SYS_kexec_load
    P(kexec_load, 0, 0, 0, 0, 0);
#endif
#ifdef SYS_finit_module
    P(finit_module, -1, (long)"", 0, 0, 0);
#endif
#ifdef SYS_process_vm_readv
    P(process_vm_readv, getpid(), 0, 0, 0, 0);
#endif
#ifdef SYS_ptrace
    P(ptrace, 0 /*PTRACE_TRACEME*/, 0, 0, 0, 0);
#endif
    return 0;
}
