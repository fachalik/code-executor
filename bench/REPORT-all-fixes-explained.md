# All Bench Findings — Fixed and Retested

_Plain-language walkthrough of every actionable issue from `bench/REPORT.md`'s "Recommendations"
list (§5), what changed for each, and the retest proving it. The QuickJS memory-bomb fix has its
own deeper writeup in `bench/REPORT-oom-fix-explained.md` — this covers everything else, plus a
final full-stack retest with all fixes in place together._

---

## The scorecard

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | Piston network egress open | 🔴 | ✅ Fixed |
| 2 | Sanitizer is a speed-bump (no Python rules, JS trivially bypassed) | 🔴 | ✅ Improved + documented honestly |
| 3 | No rate limiting on the backend | 🟠 | ✅ Fixed |
| 4 | No auth on the backend | 🟠 | ✅ Added (optional) |
| 5 | Judge0 reachable with auth disabled | 🟠 | ⚠️ Documented — can't be fixed from this repo |
| 6 | QuickJS memory bomb crashes the container | 🟠 | ✅ Fixed (separate report) |
| 7 | Piston always reports `ok: true`, even on failure | 🟡 | ✅ Fixed |
| 8 | QuickJS OOM contract broken (`502` instead of `ok:false`) | 🟡 | ✅ Fixed (separate report) |
| 9 | No `helmet`, `X-Powered-By` leaked | 🟡 | ✅ Fixed |
| 10 | Missing `.dockerignore` files | 🟡 | ✓ Already fixed (committed earlier) |
| 11 | `PISTON_LOG_LEVEL` invalid casing | 🟡 | ✓ Already fixed (committed earlier) |
| 12 | README's Piston runtime-install steps are stale | 🟡 | ✅ Fixed |

**Final retest: 27 / 27 security cases contained**, all 5 containers running with **0 restarts**.
(Items 10–11 were already fixed in an earlier commit; verified rather than re-done.)

---

## 1 — 🔴 Piston network egress: closed

**What it was:** `docker-compose.yml` had `PISTON_DISABLE_NETWORKING: "false"` — sandboxed code
could reach the network. Confirmed in the original report by having JS (via a sanitizer-dodging
`fetch`) and Python (`socket.connect`) both successfully reach another container on the host.

**The fix:** one setting.

```diff
- PISTON_DISABLE_NETWORKING: "false"
+ PISTON_DISABLE_NETWORKING: "true"
```

**Retest — same two attacks, same code, run again:**

| Attack | Before | After |
|---|---|---|
| JS `globalThis['fet'+'ch'](...)` → backend | `NET-OK:{...}` (reached it) | `BLOCKED:fetch failed` |
| Python `socket.create_connection(...)` → backend | connected | `BLOCKED:[Errno -3] Temporary failure in name resolution` |

Sandboxed code can no longer resolve DNS or open a socket to anything.

---

## 2 — 🔴 The sanitizer: made honest, not just stronger

**What it was:** a regex pre-filter with **zero Python rules** — `import socket`,
`import subprocess`, `open()` all sailed straight through — and JS rules defeated by writing
`fetch` as `globalThis['fet'+'ch']` instead of the literal text `fetch(`.

**Why "stronger" alone isn't the fix:** the original report's real point wasn't "the regex list is
too short," it was that *a regex list is the wrong thing to trust at all*. No amount of pattern
additions makes a text scanner airtight — Python alone has a dozen ways to reach a socket without
typing `socket`. So this fix does two things, not one:

1. **Closed the concrete gaps** the report demonstrated: added rules for `import socket`,
   `import subprocess`, `os.system`/`os.exec*`, `open()`, `import ctypes`, and dynamic
   `__import__(...)` of those same modules.
2. **Rewrote the file's own doc comment** to say plainly what it is: defence-in-depth against
   accidental/non-adversarial code, not the security boundary. The boundary is nsjail with
   networking off — which is fix #1 above. A sanitizer can catch a typo; it cannot catch a
   determined bypass, and the code now says so instead of implying otherwise.

**Retest:**

| Case | Before | After |
|---|---|---|
| `import socket` | ran, unblocked | `422` at the pre-flight, before any container spins up |
| `import subprocess` | ran, unblocked | `422` |
| `open("/etc/passwd")` | ran, unblocked | `422` |
| Legit Python with no blocked pattern (`print(sum([1,2,3]))`) | ran | still runs, `200` |
| Legit JS with an unrelated `.open()` method (`door.open()`) | ran | still runs, `200` — the new rule only matches the bare, Python-style `open(...)` call, not a `.open(...)` method, to avoid false-flagging ordinary JS |

The JS string-concatenation bypass (`globalThis['fet'+'ch']`) still isn't caught by the *regex* —
by design, per the point above — but is now caught by the real boundary (fix #1): the request
completes normally, the `fetch` call itself just fails to reach anything.

---

## 3 & 4 — 🟠 Rate limiting and optional auth

**What it was:** zero limits. 30 requests fired back-to-back all returned `200` — enough to keep
every engine (including Piston, which spawns a real OS process per run) busy at once, with no
login required anywhere.

**The fix — `backend/src/index.ts`:**
- **Rate limiting**, via `express-rate-limit`, on all `/api/*` routes: 120 requests/minute per IP
  by default (both numbers configurable via `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS`). Sized
  higher than the report's 30-request probe on purpose — that number was the *test's* burst size,
  not a target ceiling, and this is an interactive playground plus a suite (this very
  `security.mjs`, ~27 requests per run) that both legitimately burst past 30 in a few seconds. The
  goal is stopping a flood, not throttling normal use.
- **Optional bearer-token auth**, off by default (nothing changes for the existing frontend,
  which sends no auth header). Set `API_AUTH_TOKEN` and every `/api/*` request must carry
  `Authorization: Bearer <token>` or get `401`.

**Retest:**

| Test | Result |
|---|---|
| Full 27-case security suite (bursts past 30 requests in seconds) | all `200`/expected codes, **zero false `429`s** |
| 150 rapid-fire requests in one go | **89 got through, 61 got `429`** — the limiter engages under a real flood |
| Request with no `Authorization` header, `API_AUTH_TOKEN` unset (default) | works exactly as before |

---

## 5 — 🟠 Judge0 auth: documented, not fixable from here

**What it was:** a real Judge0 instance on this host, reachable on `0.0.0.0:2358`, with
authentication disabled.

**Why this one is different:** Judge0 runs its own separate `docker compose` stack — the
README already says as much ("not managed by this project's `docker-compose.yml`"). There is no
file in *this* repository that controls whether that other stack's server requires auth or which
interface it binds to. The backend here already had the client-side half of the fix
(`JUDGE0_AUTH_TOKEN`/`JUDGE0_AUTH_USER`, sent as headers when set) — what was missing was telling
anyone to actually turn the server-side switch on.

**What changed:** the README's Judge0 section now says explicitly, in one place, to enable
Judge0's own auth env vars and bind its port to loopback (`127.0.0.1:2358:2358`) unless something
outside the host genuinely needs it, with a link to Judge0's own configuration docs. This is
guidance, not a code fix — the actual switch lives in a deployment this repo doesn't own.

---

## 6 & 8 — 🟠🟡 QuickJS memory bomb and its OOM contract

Both fixed in the earlier pass — full writeup with root-cause analysis and burst testing in
`bench/REPORT-oom-fix-explained.md`. Short version: QuickJS's own memory limit was a soft,
overshoot-prone check; the fix hard-caps the actual WASM memory block per request, so a bomb now
gets a clean `out_of_memory` in well under a second instead of taking the container down.

---

## 7 — 🟡 Piston's `ok: true`-on-failure contract

**What it was:** `routes/execute.ts` hardcoded `{ ok: true, ...result }` for every Piston
response — a script that got `SIGKILL`ed for running past its timeout, or one that never even
compiled, still came back saying `ok: true`. Every other engine here branches `ok` off its actual
outcome; Piston was the one exception, silently.

**The fix:**
- `backend/src/engines/piston.ts` now classifies each run the same way `judge0.ts` already did —
  reading the exit code and signal Piston returns and mapping them to `success` / `timeout`
  (Piston's own timeout kills with `SIGKILL`) / `syntax_error` / `runtime_error`, and attaches a
  proper `meta.status` and `error` to the result.
- `routes/execute.ts` now does `ok: result.meta?.status === "success"` for Piston, matching every
  other engine, instead of the hardcoded `true`.

**Retest:**

| Code | `ok` before | `ok` / `status` after |
|---|---|---|
| `while(true){}` (times out, `SIGKILL`) | `true` | `false` / `timeout` |
| `this is not valid js !!!` (fails to run) | `true` | `false` / `runtime_error` |
| `console.log(1+1)` (normal success) | `true` | `true` / `success` |

A caller can now trust `ok` for every engine this backend proxies, not three out of four.

---

## 9 — 🟡 Security headers (`helmet`)

**What it was:** plain Express defaults — `X-Powered-By: Express` leaked the framework, and there
was no Content-Security-Policy, `X-Frame-Options`, or `X-Content-Type-Options` at all.

**The fix:** added `helmet()` to the backend. One thing needed overriding, though, and it's worth
calling out because it wouldn't have shown up in a `curl`-based check: helmet's default
`Cross-Origin-Resource-Policy: same-origin` is enforced by *browsers* independently of CORS
headers, and this app's frontend (`:5173`) and backend (`:3001`) are on different origins even on
localhost — the default would have silently broken every real fetch from the actual web app while
every `curl` test kept passing (curl doesn't enforce browser-side policies). Caught this by
checking the response headers, not just the response body, and set
`crossOriginResourcePolicy: { policy: 'cross-origin' }` — the existing `cors` middleware is
already the intended, narrower gate on who can read these responses.

**Retest:**

| Header | Before | After |
|---|---|---|
| `X-Powered-By` | `Express` | *(absent)* |
| `X-Content-Type-Options` | *(absent)* | `nosniff` |
| `X-Frame-Options` | *(absent)* | `SAMEORIGIN` |
| `Content-Security-Policy` | *(absent)* | present, locked down |
| Cross-origin fetch from `localhost:5173` to `localhost:3001` | worked | **still works** — verified after the CORP override, not just before it |

---

## 10 & 11 — 🟡 Already fixed

Both had already been committed before this session (`git log` shows them in
`aeff15d test(bench): add load/security benchmark suite and fix docker setup`):
- `.dockerignore` exists and is tracked for both `backend/` and `frontend/`.
- `PISTON_LOG_LEVEL` is `INFO` (uppercase) in `docker-compose.yml`.

Verified, not re-done.

---

## 12 — 🟡 README's Piston runtime-install section

**What it was:** told readers to run `docker compose exec piston ppman install javascript` — a
binary (`ppman`) this Piston image doesn't ship, and a package name (`javascript`) that isn't the
real one.

**The fix:** replaced with the actual mechanism, confirmed against the running container —
`POST /api/v2/packages` with `{"language": "node", "version": "20.11.1"}` (JavaScript's real
package name is **`node`**, not `javascript`), plus a note that installed packages persist on the
`piston-packages` volume so this is a one-time step per volume, not per boot.

Also added a short, concrete note to the Judge0 section — see #5 above — instead of leaving that
finding undocumented.

---

## The final retest: everything, together

Rebuilt and redeployed the backend, QuickJS, and Piston containers with every fix above applied
at once, then ran the full 27-case security suite one more time against the live stack:

```
27/27 contained  (+2 info-only)
```

Every container's restart count: **0**. No regressions found in a full pass over: successful
execution, timeouts, syntax errors, runtime errors, TypeScript, the memory bomb, the network
bypasses, the Python bypasses, cross-request state isolation, prototype-pollution-via-`env`, CORS,
and — the one that would've been easy to miss — an actual cross-origin fetch from the frontend's
own origin, checked after the helmet change rather than assumed safe.

---

## What's left, and why it's left

- **Judge0's own auth** (#5) — needs a change in a deployment outside this repo. Documented with
  exact settings; not something a code change here can flip.
- **The regex sanitizer's fundamental bypassability** (#2) — by design left as "improved, not
  solved," because a text scanner can't be solved into a real boundary. The actual containment
  (nsjail with networking off) is fixed and verified; the sanitizer is correctly relegated to
  "catches typos," which is now what its own comment says.
- Everything else on the original list is fixed and retested above.

---

_Companion report: `bench/REPORT-oom-fix-explained.md` (QuickJS memory bomb, in depth). Original
findings: `bench/REPORT.md`. Code changes span `docker-compose.yml`, `README.md`, and
`backend/src/{index.ts, routes/execute.ts, engines/piston.ts, middleware/sanitize.ts}`. Not yet
committed — sitting in the working tree pending review._
