# QuickJS Memory-Bomb Fix — Explained

_A plain-language walkthrough of the QuickJS out-of-memory bug, why it happened, what changed,
and the retest that proves it. Companion to `bench/REPORT-explained.md`, which is where this
bug was first found. Updated once more after a second, smaller fix (see the last section) closed
out the one loose end the first retest had flagged._

---

## The bug, in one sentence

A script that ate memory in a loop didn't get a clean "out of memory" error — it took the whole
QuickJS server down with it, and Docker had to restart it.

`bench/REPORT.md` flagged this back in the original test round:

> ⚠️ **container OOM-kill + restart** (cgroup caught it; app did not)

That's the bad kind of failure: not just *that* request dying, but every other request sharing
that container dying with it, plus a few seconds of downtime while it restarts.

---

## Why it happened (the part that isn't obvious)

QuickJS is given a memory limit per request — 64 MB by default. You'd assume that means "this
script can never use more than 64 MB." It doesn't. Here's the gap:

1. **QuickJS's own limit is a soft check, not a hard wall.** It's only checked *between*
   allocations, not enforced *during* one. I measured it directly: a script making lots of small
   allocations blew past a 16 MB limit to 45 MB of "logical" usage before QuickJS's own check
   caught up and threw an error.
2. **The real memory underneath — the WASM "linear memory" — never shrinks, and isn't capped at
   all.** QuickJS's limit only tracks its own bookkeeping of what it *thinks* is in use. The
   actual block of memory backing it can grow far past that, and once it grows, it never gives
   that space back.
3. **A few big allocations are worse than many small ones.** I re-ran the exact memory bomb from
   the original test (`while(true) { array.push(new Array(1e6).fill(1)) }` — allocate a real,
   filled million-item array, over and over). Each loop iteration is *one* big allocation. That
   let the real memory footprint rocket to **655 MB–1.5 GB** — many times past the 64 MB limit —
   before anything noticed, which is exactly what blew through the container's 512 MB ceiling
   and got it killed.

In short: the app told QuickJS "stay under 64 MB," and QuickJS mostly listened — but "mostly"
left enough slack to sink the whole container.

---

## The fix

Two layers, both host-side (nothing about the sandbox's security posture changed):

1. **Watch memory *during* execution, not just log it after.** JavaScript running in a tight
   loop can't be interrupted by a normal timer — the loop blocks everything else until it's done.
   But QuickJS already has a mechanism for this: it politely checks in with the host between
   instructions to ask "should I stop?" (this is how the existing 5-second timeout already
   works). The fix piggybacks a memory check onto that same check-in, so a runaway script gets
   stopped within milliseconds of crossing its budget — instead of QuickJS's own, looser
   built-in check catching it much later.
2. **Physically cap the memory block itself.** This is the one that actually matters for the
   `.fill(1)`-style bomb. Instead of trusting QuickJS to stay under a *logical* limit, each
   request now gets its own memory block built with a hard ceiling (about 1.5× its configured
   limit, so a well-behaved overshoot still gets the friendlier error from check #1 first). Once
   a script tries to grow past that ceiling, the growth request itself fails immediately —
   there's no way for it to "sneak past" the limit anymore, no matter how it allocates.

Every request already got a brand-new, disposable copy of the whole sandbox (that part was
already true before this fix) — so giving each one its own capped memory block was a small
addition, not a redesign.

---

## The retest

Same environment as the original report: the full stack via `docker compose`, hitting the real
backend on `localhost:3001`, QuickJS's container capped at 512 MB like before.

### Step 1 — the exact bomb that killed it last time, sent directly

```
const a=[]; while(true){ a.push(new Array(1e6).fill(1)); } export default 1
```

| | Before the fix | After the fix |
|---|---|---|
| Response | connection dropped (`502`) | clean `200`, `"status": "out_of_memory"` |
| Time to respond | — (container died) | **140 ms** |
| Container | restarted | **stayed up** |

### Step 2 — 20 of that same bomb, fired at once

This simulates the worst realistic case: a burst of bad requests landing together, not just one.

| Metric | Result |
|---|---|
| Responses | **20 / 20** clean `out_of_memory` |
| Wall time for all 20 | 3 s |
| Container restarts | **0** |
| Peak memory | **103 MB** of the 512 MB limit (20%) |
| A normal request sent right after | worked normally, 16 ms |

### Step 3 — the full 27-case security suite, once more

Ran back-to-back today, same stack, same corpus — before the fix (old image, still running) and
after (rebuilt, redeployed):

| | Before this fix | After this fix |
|---|---|---|
| `dos:memory-bomb` (QuickJS) | 🔴 `502`, container restarted mid-run | ✅ `out_of_memory`, clean |
| `dos:cpu-timeout` (QuickJS) | 🔴 `502` — collateral damage from the container restarting mid-suite | ✅ `timeout`, clean (this path was never actually broken — it only failed because the *previous* test case had just taken the container down) |
| Everything else | unchanged | unchanged |
| Total contained | 24/27 (+2 info-only) | **26/27** (+2 info-only) |

The one remaining gap after this first fix was the pre-existing `escape:reach-process` item,
present in both runs and unrelated to memory — see the follow-up fix below, which closes it too.
(The original `bench/REPORT.md` reported 21/27 for the *whole* stack at a different point in
time, including the separate, still-open Piston network-egress issue — not a like-for-like number
with the two runs above, which only vary in this one fix.)

### Step 4 — did the fix break anything normal?

Every other outcome was re-checked and is byte-for-byte the same as before:

- ✅ Successful runs — same result, same shape of response.
- ✅ Infinite loop → timeout at 5 s, same as before.
- ✅ Syntax errors, runtime errors — unchanged.
- ✅ TypeScript execution — unchanged.
- ✅ A **legitimate** script that actually needs ~30 MB (not a bomb, just a real workload) still
  succeeds — the fix doesn't punish real memory use, only runaway growth.

---

## Follow-up fix: the last remaining gap, closed too

The one thing flagged above — `typeof process !== 'undefined'` inside the QuickJS sandbox — turned
out to be simple to fix, so it's fixed now rather than left as a ticket.

**Why it was there:** the underlying sandbox library injects a small `process` shim
(`{ env, cwd: () => '/' }`) for scripts written in a Node-y style. It never leaked real host data
— `process.env` was always just an alias for the same `env` object this app already exposes
deliberately — but its mere presence let guest code fingerprint the sandbox, which a
"no host globals" boundary shouldn't hand out for free.

**The fix:** one line, run once per request right after the sandbox is set up and before the
guest's own code runs: `delete globalThis.process`. The documented `env` global — the app's real,
intended way to hand data to guest code — is untouched.

**Verified:**
- `typeof process` is now `"undefined"` inside the sandbox — the escape test that was failing now
  passes.
- The app's actual `env` mechanism (`const { applicant } = env`) still works exactly as
  documented.
- Every other regression check (success, timeout, syntax/runtime errors, TypeScript, the memory
  bomb) re-run clean after this change too.
- **Full suite, once more, with both fixes deployed: 27 / 27 contained.** The two Piston rows
  that still show `502` are the separate, already-documented network-egress/sanitizer issue from
  the original report — out of scope here, and scored as "contained" by the test script because
  the attack request itself fails rather than succeeding.

---

## Bottom line

The memory-bomb crash from the original report is fixed and verified two ways: a direct repeat
of the exact failing case, and a 20-request burst of it. The container no longer restarts, every
run gets a clean `out_of_memory` response in well under a second, and normal (non-bomb) code
behaves exactly as it did before. QuickJS now matches isolated-vm's behavior on this specific
attack — the one item on that engine's "worth fixing" list from the original report. The one
loose end that surfaced during retesting (the `process` global leak) is fixed too, and the full
security suite is clean: **27 / 27 contained**.

---

_Code changes: `quickjs-code-executor/src/config.ts`, `src/engine/quickjs.ts`, and a small local
type declaration for `WebAssembly.Memory`. Not yet committed — sitting in the working tree
pending review. Full technical detail on the original findings is in `bench/REPORT.md`; raw data
in `bench/results/`._
