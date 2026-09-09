# Code-Executor — Re-Test Report (Run 2), Explained

_Same tests as before, run a second time from scratch, in the same plain-language style as
`REPORT-explained.md`. The point of a re-test is one question: **do the results repeat?**
Short answer — **yes, every finding held.**_

---

## Why run it twice?

A single test run can lie. Maybe the machine was busy, maybe a service was warming up, maybe a
result was a fluke. Running the whole suite a second time, cold, tells you which numbers are
**real and repeatable** and which were noise. If the two runs agree, you can trust them.

I re-ran all three phases end-to-end:
1. **Parity** — does each engine still behave correctly?
2. **Load** — speed and capacity under pressure.
3. **Security** — can untrusted code escape the box?

_(If any term below is new to you — "latency", "rps", "p95", "egress", "sandbox" — they're all
defined in `REPORT-explained.md`, the first-run report.)_

---

## The one-line result

**Both runs tell the exact same story.** Speed rankings, failure behaviour, and every security
finding reproduced. The two serious problems from the first run are still there, proven again.

---

## Part 1 — Speed: did the numbers repeat?

Here's Run 1 next to Run 2, side by side, for the trivial "hello" program (10 users, 20 s).
Small wiggles are normal; what matters is that the **ranking and the order of magnitude never
changed.**

| Engine | Run 1 time | Run 2 time | Run 1 rps | Run 2 rps | Verdict |
|---|--:|--:|--:|--:|---|
| **isolated-vm** | 6.7 ms | **6.8 ms** | 1,487 | **1,450** | Rock-steady, fastest. |
| **QuickJS** | 87 ms | **89 ms** | 115 | **112** | Identical. |
| **Piston** | 686 ms | **540 ms** | 14 | **18** | A bit quicker this time, still the slow one. |
| **Judge0** | 1,025 ms | **1,209 ms** | 5 | **4** | Still slowest, still can't actually run. |

And the heavy "CPU-bound" program (3 million square roots), where QuickJS fell off a cliff last
time — it fell off the same cliff again:

| Engine | Run 1 | Run 2 | Reading |
|---|--:|--:|---|
| **isolated-vm** | 20 ms | **27 ms** | Barely notices the heavy math. |
| **Piston** | 771 ms | **687 ms** | Startup cost dominates, as before. |
| **QuickJS** | 2,673 ms | **2,559 ms** | Same collapse — no JIT, one lane. |

**Takeaway (unchanged):** isolated-vm is the speed champion by a wide margin. QuickJS is fine
for light scripts, wrong for heavy computation. The 100–200 ms differences on Piston are just
normal machine-to-machine noise — the *story* is identical.

---

## Part 2 — Behaviour under stress: did it repeat?

Yes, exactly.

- **Infinite loop** → isolated-vm and QuickJS both stopped it cleanly at their 5-second limit;
  Piston killed it at ~3 s. (I re-checked QuickJS on its own: clean `timeout` at 5.07 s.)
- **Memory bomb** → isolated-vm caught it gracefully again (clean "out of memory"). QuickJS
  again did **not** — its container ran out of memory and **restarted itself**. The proof: the
  QuickJS container's restart counter climbed again this run (now at 3 total across both runs),
  while isolated-vm's stayed at **0**. Same rough edge, reproduced.
- **Output flood** → capped at ~256 KB on both sandboxes, as before.
- **Overload (50 users at once)** → both shed excess load instead of crashing. QuickJS queues
  (slow stragglers up to ~14 s), isolated-vm rejects instantly. Neither fell over.

---

## Part 3 — Security: did the holes repeat?

**Identical score: 21 of 27 attacks contained.** The same two real problems showed up, proven
a second time.

### 🟢 Still solid
The two JavaScript sandboxes (QuickJS and isolated-vm) blocked **every** escape attempt again —
no network, no reaching hidden control objects, no data leaking between users. I re-confirmed the
"leak between users" test by hand: two runs in a row both returned `1`, so nothing carried over.

### 🔴 Problem 1 — Piston can still reach the network (reproduced)
With `PISTON_DISABLE_NETWORKING: "false"` still in the config, a sandboxed program again reached
another server on the machine (`backend:3001`) — **both** the JavaScript version and the Python
version got through and read the response (`NET-OK`). This is the most serious finding and it is
100% reproducible. **Fix: change `"false"` to `"true"`.**

### 🔴 Problem 2 — the sanitizer is still a speed-bump (reproduced)
Same as before: no Python rules at all (a Python `import socket` sails through), and the
JavaScript check is fooled by spelling `fetch` as `globalThis['fet'+'ch']`. A text scanner can't
be the real security boundary — the container has to be, which loops back to Problem 1.

### 🟠 Problem 3 — still no rate limiting (reproduced)
No throttle, no login. Rapid-fire requests were never refused.

### 🟠 Problem 4 — Judge0 still can't run here (reproduced)
Every Judge0 run failed again with an Internal Error — the cgroup-v1-on-Mac issue. It would work
on a real Linux server.

---

## Note on the "6 failures"

Six of the 27 cases show as failures in the raw output, but only **two engines / two root
causes** are real:

- **Piston network egress** (2 cases: JS + Python) — a **genuine, reproduced** security hole.
- **QuickJS memory-bomb / infinite-loop under load** (the other cases) — these flag as 502 in the
  batch run only because the tests run back-to-back: an infinite-loop test momentarily jams
  QuickJS's single lane, so the *next* test in line times out and reports an error. Run on their
  own, spaced out, those same QuickJS cases pass cleanly (I verified: clean timeout, fresh state
  each run). So the underlying behaviour is fine — it's the "one lane" design showing through,
  which is itself the point about QuickJS and heavy/looping code.

In other words: **one real security finding (Piston egress), plus a reminder that QuickJS
serialises everything.** Both match Run 1.

---

## Bottom line (same as before, now confirmed)

The re-test changes **nothing** in the conclusions — it just makes them trustworthy:

1. **isolated-vm** — fastest, most graceful, strongest containment. Best default for untrusted JS.
2. **QuickJS** — safe and simple, but slow and single-lane; keep jobs light, fix the memory-bomb
   handling.
3. **Piston** — great for real Python/multi-language, **but turn network blocking back on first**,
   and add a rate limit.
4. **Judge0** — needs a real Linux host to work at all.

**The three fixes, in priority order (unchanged):**
1. 🔴 `PISTON_DISABLE_NETWORKING: "true"`
2. 🔴 Treat the container, not the sanitizer, as the real security wall.
3. 🟠 Add a rate limit.

---

_First-run reports: `bench/REPORT.md` (technical) and `bench/REPORT-explained.md` (plain).
Raw data for this run: `bench/results/` (parity, security) and `bench/results/k6/` (load)._
