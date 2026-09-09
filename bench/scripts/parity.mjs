#!/usr/bin/env node
// Phase 1 — conformance/parity harness.
// Runs the same semantic tasks on each engine and checks the contract holds,
// so a broken engine in the load phase reads as broken, not as "slow".
import http from 'node:http';

const BACKEND = process.env.BACKEND ?? 'http://localhost:3001';

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const u = new URL(BACKEND + path);
    const req = http.request(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      timeout: 30000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json; try { json = JSON.parse(buf); } catch { json = { _raw: buf }; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end(data);
  });
}

// Each case: what we send + a predicate on the response.
const stdoutEngines = ['piston', 'judge0'];
const sandboxEngines = ['quickjs', 'isolated-vm'];

const cases = [];
// stdout-contract engines
for (const p of stdoutEngines) {
  cases.push({ engine: p, name: 'hello js', req: { code: "console.log('hi')", language: 'javascript', platform: p },
    ok: r => r.json.stdout?.trim() === 'hi' });
  cases.push({ engine: p, name: 'arithmetic py', req: { code: 'print(6*7)', language: 'python', platform: p },
    ok: r => r.json.stdout?.trim() === '42' });
  cases.push({ engine: p, name: 'runtime error surfaces', req: { code: 'throw new Error("boom")', language: 'javascript', platform: p },
    ok: r => /boom/.test(r.json.stderr ?? '') || r.json.meta?.status === 'runtime_error' || r.json.ok === false });
}
// sandbox-contract engines: env in, export default out
for (const p of sandboxEngines) {
  cases.push({ engine: p, name: 'env->result', req: { code: 'const {a,b}=env; export default {sum:a+b}', language: 'javascript', platform: p, env: { a: 20, b: 22 } },
    ok: r => r.json.result?.sum === 42 && r.json.ok === true });
  cases.push({ engine: p, name: 'console captured', req: { code: "console.log('side'); export default 1", language: 'javascript', platform: p, env: {} },
    ok: r => r.json.stdout?.includes('side') && r.json.result === 1 });
  cases.push({ engine: p, name: 'typescript erased', req: { code: 'const x:number=21; export default x*2', language: 'typescript', platform: p, env: {} },
    ok: r => r.json.result === 42 });
  cases.push({ engine: p, name: 'throw -> ok:false runtime_error', req: { code: 'throw new Error("boom")', language: 'javascript', platform: p, env: {} },
    ok: r => r.json.ok === false && r.json.meta?.status === 'runtime_error' });
  cases.push({ engine: p, name: 'meta metering present', req: { code: 'export default 1', language: 'javascript', platform: p, env: {} },
    ok: r => typeof r.json.meta?.timeMs === 'number' });
}

const results = [];
for (const c of cases) {
  try {
    const r = await post('/api/execute', c.req);
    const pass = !!c.ok(r);
    results.push({ ...c, pass, status: r.status, snapshot: { ok: r.json.ok, status: r.json.meta?.status, stdout: (r.json.stdout||'').slice(0,40), result: r.json.result, stderr: (r.json.stderr||'').slice(0,60) } });
  } catch (e) {
    results.push({ ...c, pass: false, error: e.message });
  }
}

let pass = 0;
for (const r of results) {
  const tag = r.pass ? 'PASS' : 'FAIL';
  if (r.pass) pass++;
  console.log(`[${tag}] ${r.engine.padEnd(12)} ${r.name.padEnd(32)} ${r.pass ? '' : JSON.stringify(r.snapshot ?? r.error)}`);
}
console.log(`\n${pass}/${results.length} passed`);
import fs from 'node:fs';
fs.writeFileSync(new URL('../results/01-parity.json', import.meta.url), JSON.stringify(results, null, 2));
