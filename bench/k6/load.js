// Phase 2 — load test. One script, parameterized by env:
//   TARGET   : base URL to hit (http://backend:3001 or http://quickjs:3002 ...)
//   ENGINE   : piston | judge0 | quickjs | isolated-vm  (backend path)
//   DIRECT   : "1" => hit an executor service's own /execute (no `platform` field)
//   WORKLOAD : hello | cpu | payload | pathological
//   VUS, DURATION : load profile
import http from 'k6/http';
import { check } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

const ENGINE = __ENV.ENGINE || 'quickjs';
const DIRECT = __ENV.DIRECT === '1';
const WORKLOAD = __ENV.WORKLOAD || 'hello';
const TARGET = __ENV.TARGET || 'http://backend:3001';

const execOk = new Rate('exec_ok');          // engine reported ok:true
const httpFail = new Rate('http_fail');       // non-2xx (429 shed, 5xx, etc.)
const shed = new Counter('shed_429');
const engineMs = new Trend('engine_time_ms', true); // meta.timeMs when present

// ── Workload bodies ─────────────────────────────────────────────────────────
const isSandbox = ENGINE === 'quickjs' || ENGINE === 'isolated-vm' || DIRECT;
const bigEnv = {}; for (let i = 0; i < 200; i++) bigEnv['k' + i] = 'v'.repeat(50);

function bodyFor(wl) {
  if (isSandbox) {
    switch (wl) {
      case 'hello':   return { code: 'export default 1', language: 'javascript', env: {} };
      case 'cpu':     return { code: 'let s=0; for(let i=0;i<3e6;i++)s+=Math.sqrt(i); export default s', language: 'javascript', env: {} };
      case 'payload': return { code: 'export default Object.keys(env).length + "x".repeat(20000).length', language: 'javascript', env: bigEnv };
      case 'pathological': return { code: 'while(true){} export default 1', language: 'javascript', env: {} };
    }
  } else {
    switch (wl) {
      case 'hello':   return { code: "console.log('hi')", language: 'javascript' };
      case 'cpu':     return { code: 'let s=0;for(let i=0;i<3e6;i++)s+=Math.sqrt(i);console.log(s)', language: 'javascript' };
      case 'payload': return { code: 'console.log("x".repeat(50000))', language: 'javascript' };
      case 'pathological': return { code: 'while(true){}', language: 'javascript' };
    }
  }
}

const path = '/api/execute'; // both backend and executor services mount here
export const options = {
  scenarios: {
    load: {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || 10),
      duration: __ENV.DURATION || '20s',
    },
  },
  // Cap how long k6 itself waits, so a hung request doesn't stall the run.
  noConnectionReuse: false,
};

export default function () {
  const b = bodyFor(WORKLOAD);
  if (!DIRECT) b.platform = ENGINE;
  const res = http.post(`${TARGET}${path}`, JSON.stringify(b), {
    headers: { 'Content-Type': 'application/json' },
    timeout: '30s',
  });
  const twoxx = res.status >= 200 && res.status < 300;
  httpFail.add(!twoxx);
  if (res.status === 429) shed.add(1);
  let ok = false, tms = null;
  try { const j = res.json(); ok = j.ok === true; tms = j.meta && j.meta.timeMs; } catch (_) {}
  execOk.add(ok);
  if (typeof tms === 'number') engineMs.add(tms);
  check(res, { 'responded': (r) => r.status !== 0 });
}

export function handleSummary(data) {
  const m = data.metrics;
  const g = (name, stat) => (m[name] && m[name].values && m[name].values[stat]) ?? null;
  const summary = {
    engine: ENGINE, direct: DIRECT, workload: WORKLOAD,
    vus: Number(__ENV.VUS || 10), duration: __ENV.DURATION || '20s',
    iterations: g('iterations', 'count'),
    rps: g('http_reqs', 'rate'),
    http_fail_rate: g('http_fail', 'rate'),
    exec_ok_rate: g('exec_ok', 'rate'),
    shed_429: g('shed_429', 'count'),
    lat_ms: {
      avg: g('http_req_duration', 'avg'),
      p50: g('http_req_duration', 'med'),
      p90: g('http_req_duration', 'p(90)'),
      p95: g('http_req_duration', 'p(95)'),
      p99: g('http_req_duration', 'p(99)'),
      max: g('http_req_duration', 'max'),
    },
    engine_time_ms: { avg: g('engine_time_ms', 'avg'), p95: g('engine_time_ms', 'p(95)') },
  };
  const tag = `${ENGINE}${DIRECT ? '-direct' : ''}_${WORKLOAD}`;
  return {
    stdout: `\n== ${tag} ==\n` + JSON.stringify(summary.lat_ms) +
            `\nrps=${(summary.rps||0).toFixed(1)} exec_ok=${((summary.exec_ok_rate||0)*100).toFixed(1)}% http_fail=${((summary.http_fail_rate||0)*100).toFixed(1)}% shed=${summary.shed_429||0}\n`,
    [`/out/${tag}.json`]: JSON.stringify(summary, null, 2),
  };
}
