# Code-Executor Test Report — Explained

_A plain-language walkthrough of the load & security tests. Written so you don't need
to already know what "nsjail" or "p95" mean — every term is explained the first time it shows up._

---

## First: what is this project?

This app lets a user type code into a web page and **run it on the server**. That's useful
(think: an online coding playground, or a rules engine where customers write little scripts)
but also dangerous — you're running **code you don't trust** on **your own machine**.

So the project offers **four different "engines"** to run that untrusted code, each with a
different way of keeping it locked in a box. A "box" here is called a **sandbox**: a restricted
environment where the code can run but can't touch the rest of your system (no reading your
files, no calling the internet, no crashing your server).

The four engines:

| Engine | The one-line version |
|---|---|
| **Piston** | Runs the code in a real Node.js / Python, inside a locked-down container. |
| **Judge0** | Similar idea, but also measures exactly how much CPU and memory each run used. |
| **QuickJS** | Runs JavaScript in a tiny interpreter that is *slow but very safe*. |
| **isolated-vm** | Runs JavaScript in a real fast engine (V8, the thing inside Chrome) but in its own private bubble. |

My job was to answer two questions for each engine:
1. **How fast is it, and how much load can it take?** (the *load test*)
2. **Can untrusted code break out of the box?** (the *security test*)

---

## The vocabulary you'll need

Just five terms. Everything in this report is built from these.

- **Latency** — how long *one* request takes, in milliseconds (ms). Lower is better.
  1000 ms = 1 second.
- **Throughput / rps** — "requests per second." How many runs the engine can finish each
  second when it's busy. Higher is better.
- **avg vs p95** — "avg" is the average time. **p95** means "95% of requests were faster than
  this." p95 matters because averages hide the slow stragglers — p95 tells you what your
  *unluckiest* users feel.
- **Egress** — the code's ability to reach out to the **network** (the internet, or other
  servers on your machine). For a sandbox, egress should normally be **blocked**.
- **Container** — a lightweight isolated box that a service runs in (via Docker). Several of
  the security protections here are enforced at the container level.

---

## Part 1 — How fast is each engine?

I hammered each engine with 10 simultaneous users for 20 seconds, running the same small
program, and measured latency and throughput.

### The trivial program ("hello")

This is just the fixed cost of *starting* a run — the program itself does almost nothing.

| Engine | Time per run | Runs per second | Plain reading |
|---|--:|--:|---|
| **isolated-vm** | **7 ms** | **1,487** | Blazing. Basically instant. |
| **QuickJS** | 87 ms | 115 | Fine for occasional use, slow if you need volume. |
| **Piston** | 686 ms | 14 | Slow — it starts a whole real program each time. |
| **Judge0** | 1,025 ms | 5 | Slowest (and it couldn't actually run — see below). |

**Why the huge gap?** isolated-vm keeps a fast engine warm and just hands your code a fresh
private bubble — cheap. Piston, by contrast, **launches a brand-new operating-system process**
for every single run (like opening a new program each time), which is inherently expensive.
That's the ~0.6-second floor you see.

### The heavy program ("CPU-bound")

Same test, but now the program does real math (3 million square roots). This separates the
engines that can run code *fast* from the ones that only run it *safely*.

| Engine | Time per run | Plain reading |
|---|--:|---|
| **isolated-vm** | **20 ms** | Barely slowed down. |
| **Piston** | 771 ms | The math is fast; the startup cost dominates. |
| **QuickJS** | **2,673 ms** | Fell off a cliff. |

**Why did QuickJS collapse?** Two reasons, both by design:
1. It has **no JIT**. (JIT = "just-in-time compilation," the trick that makes modern JavaScript
   fast by translating it to machine code on the fly. QuickJS skips this on purpose, because
   that translation step is exactly the kind of thing that can be attacked — no JIT means a
   smaller, safer target.) The tradeoff is raw speed.
2. It **runs on a single lane**. When one heavy program is running, others have to wait behind
   it. So heavy code doesn't just run slowly, it *blocks everyone else too*.

**Takeaway:** isolated-vm is the speed champion by a wide margin. QuickJS is fine for light,
quick scripts but is the wrong tool for heavy computation.

---

## Part 2 — What happens when things go wrong?

A good sandbox doesn't just run nice code — it survives *nasty* code without dying. I threw
three classic "attacks" at each engine.

### Attack 1: infinite loop (`while(true){}`)

Code that never stops. A weak sandbox would hang forever.

- **isolated-vm & QuickJS:** stopped the code cleanly after their time limit (5 s) and returned
  a "timeout" result. 
- **Piston:** killed it after ~3 s. 
- **Everyone passed** — but note QuickJS, because of its single-lane design, lets one infinite
  loop slow down other users while it's being stopped.

### Attack 2: memory bomb (allocate memory until it runs out)

- **isolated-vm:** caught it gracefully and returned a clean "out of memory" error. 
- **QuickJS:** did **not** catch it cleanly — the whole container ran out of memory and had to
  **restart itself**. The individual request just died with a broken connection.
  The good news: it was still contained (the container's memory limit stopped it from taking
  down the whole machine). The bad news: it's ungraceful, and any other requests sharing that
  container died too. This is worth fixing.

### Attack 3: flood of output

Both sandboxes correctly capped the output at ~256 KB instead of letting it grow forever. 

### What happens under overload?

I sent 50 users at once into engines built for ~4 at a time. Both **shed load** (turned excess
requests away) instead of crashing — which is the correct behavior. They just do it
differently: QuickJS makes people **wait in a queue** (some waited up to 15 s), isolated-vm
**rejects extra requests instantly**. Neither fell over.

---

## Part 3 — Can the code escape the box? (Security)

This is the important part. I wrote 27 little "attack" programs trying to break out of each
sandbox, and checked whether each was **contained** (blocked) or **leaked** (succeeded).

**Result: 21 of 27 contained.** The failures cluster around two real problems.

### 🟢 The good news

The two JavaScript sandboxes (QuickJS and isolated-vm) held up **completely**. Every escape
attempt failed:
- Couldn't reach the network.
- Couldn't find the hidden "master control" objects that would let them touch the server.
- Couldn't leave anything behind for the next user's run (no data leaking between users).
- Couldn't pollute shared state.

If you need to run untrusted JavaScript, **these two do their job.**

### 🔴 Problem 1: Piston can reach the network (the big one)

The most serious finding. There's a setting in the config file
(`docker-compose.yml`) that controls whether sandboxed code can use the network:

```yaml
PISTON_DISABLE_NETWORKING: "false"    # <-- this is currently OFF
```

Because it's set to `"false"`, **network blocking is turned off.** I proved this: I ran a
sandboxed program that called out to another server on the machine (`backend:3001`) — and it
**succeeded**. Both a JavaScript version and a Python version got through.

**Why this matters:** untrusted code could reach your internal services, databases, or cloud
metadata endpoints — things that are supposed to be private. This is the number-one thing to
fix.

**The fix is one word:** change `"false"` to `"true"`.

### 🔴 Problem 2: the "sanitizer" is a speed-bump, not a wall

Piston and Judge0 have a **sanitizer** — a piece of code that scans the user's program *before*
running it and rejects anything that looks dangerous (like `fetch(` for network calls). The
idea is fine, but this one is weak:

- **It has zero rules for Python.** A Python program can freely `import socket` (network),
  `import subprocess` (run system commands), or `open()` a file — the scanner doesn't look for
  any of these.
- **Its JavaScript rules are trivially fooled.** It looks for the literal text `fetch(`. So I
  wrote `globalThis['fet'+'ch']` instead — same thing, but the text `fetch(` never appears, so
  the scanner waved it through.

**Why this matters:** a text scanner can *never* reliably catch dangerous code, because there
are infinite ways to spell the same thing. The scanner is fine as a helpful hint to honest
users, but it must **not** be trusted as the real security boundary. The real boundary is
Piston's container isolation — which brings us right back to Problem 1: with networking turned
on, that boundary has a hole in it.

### 🟠 Problem 3: no rate limiting, no login

Anyone who can reach the backend can send **unlimited** requests — I sent 30 rapid-fire and not
one was refused. There's no login required and no limit on how often you can call it. One person
(or a bad script) could keep every engine busy and lock out real users. Add a **rate limit**
(cap requests per user per minute) and consider requiring a login.

### 🟠 Problem 4: Judge0 doesn't work here at all

Judge0 needs an older Linux feature (called "cgroup v1") that **doesn't exist on Macs** running
Docker Desktop. So on this machine, *every* Judge0 run fails with an "Internal Error." This
isn't a bug in the project — the project's own README warns about it — but it means Judge0 is
effectively unusable in this setup. It would work on a proper Linux server.

---

## Part 4 — A couple of "gotchas" to know about

Not security holes, but things that would confuse you as a developer:

1. **Piston always says `ok: true`, even when the code failed.** If a Piston run times out or
   gets killed, the response *still* says `"ok": true`. So you can't trust the `ok` field for
   Piston — you have to look at the detailed status instead. The other engines report failure
   honestly. This inconsistency is a trap.
2. **The project didn't build as shipped.** Three small setup issues stopped it from even
   starting (two missing config files and one typo in the Piston log setting). I fixed those to
   run the tests. They should be committed so the next person isn't stuck.

---

## The bottom line

**If you just want a recommendation:**

- **Running untrusted JavaScript and want it fast?** → **isolated-vm.** Fastest by far,
  handles bad input gracefully, strongest containment. (One caveat for later: its speed comes
  from V8's JIT, which is a bigger attack surface than QuickJS's simpler design.)
- **Running untrusted JavaScript and safety matters more than speed?** → **QuickJS.** Simpler,
  safer design. Just keep the programs short and light, and fix the memory-bomb behavior.
- **Need real Python, or multiple languages?** → **Piston** — but **only after you turn network
  blocking back on** (Problem 1). And put a rate limit in front of it.
- **Want precise CPU/memory measurements per run?** → **Judge0** — but only on a real Linux
  server, not on a Mac.

**The three things to fix, in order:**
1. 🔴 Turn Piston's network blocking back on (`PISTON_DISABLE_NETWORKING: "true"`).
2. 🔴 Stop relying on the sanitizer as security; treat the container as the real wall.
3. 🟠 Add a rate limit so nobody can flood the service.

---

_The full technical version of this report is in `bench/REPORT.md`. Raw test data is in
`bench/results/`._
