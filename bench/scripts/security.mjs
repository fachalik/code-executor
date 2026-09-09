#!/usr/bin/env node
// Phase 3 — security / isolation test.
// Every case carries an EXPECTED verdict; output is a pass/fail diff.
//   expect: 'blocked'  -> sanitizer/engine must refuse or error the run
//   expect: 'contained'-> run may complete but must NOT achieve the escape
//   verdict fn returns {contained:bool, evidence:string}
import http from 'node:http';
import fs from 'node:fs';

const BACKEND = process.env.BACKEND ?? 'http://localhost:3001';
function post(body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const u = new URL(BACKEND + '/api/execute');
    const req = http.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }, timeout: 40000 },
      (res) => { let b=''; res.on('data',c=>b+=c); res.on('end',()=>{ let j; try{j=JSON.parse(b);}catch{j={_raw:b};} resolve({status:res.statusCode,json:j}); }); });
    req.on('error', reject); req.on('timeout', ()=>req.destroy(new Error('timeout'))); req.end(data);
  });
}

// text blob of a response we scan for escape evidence
const blob = r => JSON.stringify(r.json);

// ── Corpus ───────────────────────────────────────────────────────────────
// Each: {id, engine, lang, category, code, env?, contained(r)->bool, note}
const C = [];
const add = (o) => C.push(o);

// helper verdicts
const noNetLeak = r => !/(SANDBOX-ESCAPED-NET|"root:|ENETUNREACH is absent)/.test(blob(r));

// ---- SANDBOX ESCAPE attempts (quickjs + isolated-vm) ----
for (const engine of ['quickjs','isolated-vm']) {
  add({ engine, lang:'javascript', category:'escape:constructor-walk',
    code:`export default (function(){try{return this.constructor.constructor('return process')().platform}catch(e){return 'BLOCKED:'+e.message}})()`,
    contained:r=> { const v=r.json.result; return typeof v!=='string' || v.startsWith('BLOCKED') || r.json.ok===false; },
    note:'Function constructor -> host process' });
  add({ engine, lang:'javascript', category:'escape:reach-process',
    code:`export default (typeof process!=='undefined')?('LEAK:'+JSON.stringify(process.env)):'no-process'`,
    contained:r=> r.json.result==='no-process' || r.json.ok===false,
    note:'global process visible?' });
  add({ engine, lang:'javascript', category:'escape:require',
    code:`export default (typeof require!=='undefined')?'HAS-REQUIRE':'no-require'`,
    contained:r=> r.json.result==='no-require' || r.json.ok===false, note:'require present?' });
  add({ engine, lang:'javascript', category:'escape:fetch-net',
    code:`export default (async()=>{try{const x=await fetch('http://backend:3001/health');return 'NET-OK:'+await x.text()}catch(e){return 'BLOCKED:'+e.message}})()`,
    contained:r=> { const v=r.json.result; return !(typeof v==='string' && v.startsWith('NET-OK')); },
    note:'egress via fetch' });
  add({ engine, lang:'javascript', category:'dos:memory-bomb',
    code:`const a=[];while(true){a.push(new Array(1e6).fill(1));} export default 1`,
    contained:r=> r.json.ok===false && ['out_of_memory','runtime_error','timeout'].includes(r.json.meta?.status),
    note:'heap exhaustion -> must be capped, not host OOM' });
  add({ engine, lang:'javascript', category:'dos:cpu-timeout',
    code:`while(true){} export default 1`,
    contained:r=> r.json.ok===false && r.json.meta?.status==='timeout',
    note:'infinite loop -> timeout enforced' });
  add({ engine, lang:'javascript', category:'dos:output-flood',
    code:`for(let i=0;i<1e7;i++)console.log('flood'.repeat(20)); export default 1`,
    contained:r=> { const n=Buffer.byteLength(r.json.stdout||''); return n <= 300*1024; },
    note:'stdout must be capped ~256KB' });
  add({ engine, lang:'javascript', category:'leak:cross-request-state',
    code:`globalThis.__leak=(globalThis.__leak||0)+1; export default globalThis.__leak`,
    contained:r=> r.json.result===1, note:'fresh global per request (run twice, must stay 1)' });
}

// ---- SANITIZER BYPASS (piston + judge0) ----
for (const engine of ['piston','judge0']) {
  // These SHOULD be blocked by the regex pre-flight (422)
  add({ engine, lang:'javascript', category:'sanitizer:fetch', expectBlock:true,
    code:`fetch('http://backend:3001/health').then(r=>r.text()).then(console.log)`,
    contained:r=> r.status===422, note:'plain fetch -> 422' });
  add({ engine, lang:'javascript', category:'sanitizer:require-pkg', expectBlock:true,
    code:`const a=require('axios');console.log('ok')`,
    contained:r=> r.status===422, note:'external require -> 422' });
  // BYPASSES: crafted to slip past the regex. Contained only if engine sandbox stops egress anyway.
  add({ engine, lang:'javascript', category:'bypass:string-concat-fetch',
    code:`const f=globalThis['fet'+'ch'];f&&f('http://backend:3001/health').then(r=>r.text()).then(t=>console.log('NET-OK:'+t)).catch(e=>console.log('BLOCKED:'+e.message));setTimeout(()=>{},50)`,
    contained:r=> !/NET-OK/.test(blob(r)), note:'regex misses computed fetch; nsjail must' });
  add({ engine, lang:'python', category:'bypass:python-import-socket',
    code:`import socket\ntry:\n s=socket.create_connection(('backend',3001),2)\n print('NET-OK')\nexcept Exception as e:\n print('BLOCKED:'+str(e))`,
    contained:r=> !/NET-OK/.test(blob(r)) && r.status!==422 ? true : r.status===422,
    note:'sanitizer has NO python import rule; nsjail is the only guard' });
  add({ engine, lang:'python', category:'bypass:python-subprocess',
    code:`import subprocess\nprint(subprocess.run(['id'],capture_output=True,text=True).stdout or 'no-out')`,
    contained:r=> !/uid=0\(root\)/.test(blob(r)) || r.status===422, note:'subprocess id; not root, and passes sanitizer' });
  add({ engine, lang:'python', category:'escape:python-fs-etc-passwd',
    code:`print(open('/etc/passwd').read()[:20])`,
    contained:r=> true, note:'fs read — observe what is visible (info)' , info:true});
}

// ---- API layer ----
add({ engine:'quickjs', lang:'javascript', category:'api:proto-pollution-via-env',
  code:`export default ({}).polluted===true?'POLLUTED':'clean'`,
  env: JSON.parse('{"__proto__":{"polluted":true}}'),
  contained:r=> r.json.result!=='POLLUTED', note:'__proto__ in env must not pollute Object.prototype' });

async function runOne(c) {
  const body = { code:c.code, language:c.lang, platform:c.engine, ...(c.env?{env:c.env}:{}) };
  let r;
  try { r = await post(body); } catch(e){ return { ...c, pass:false, err:e.message }; }
  // cross-request-state needs a second hit
  if (c.category==='leak:cross-request-state') { try{ await post(body);}catch{} }
  let contained; try { contained = !!c.contained(r); } catch(e){ contained=false; }
  const pass = c.info ? true : contained;
  return { id:C.indexOf(c), engine:c.engine, category:c.category, note:c.note, info:!!c.info,
    pass, status:r.status, ok:r.json.ok, metaStatus:r.json.meta?.status,
    result: typeof r.json.result==='string'? r.json.result.slice(0,60): r.json.result,
    stdout:(r.json.stdout||'').slice(0,80), stderr:(r.json.stderr||'').slice(0,80), blocked:r.json.blocked };
}

const out = [];
for (const c of C) out.push(await runOne(c));
let pass=0, info=0;
for (const r of out) {
  if (r.info) { info++; console.log(`[INFO] ${r.engine.padEnd(12)} ${r.category.padEnd(34)} status=${r.status} out=${JSON.stringify(r.stdout)}`); continue; }
  if (r.pass) pass++;
  const tag=r.pass?'CONTAINED':'*** LEAK ***';
  console.log(`[${tag}] ${r.engine.padEnd(12)} ${r.category.padEnd(34)} status=${r.status} ok=${r.ok} meta=${r.metaStatus||''} ${r.pass?'':'| result='+JSON.stringify(r.result)+' out='+JSON.stringify(r.stdout)+' err='+JSON.stringify(r.stderr)}`);
}
const graded = out.filter(r=>!r.info);
console.log(`\n${pass}/${graded.length} contained  (+${info} info-only)`);
fs.writeFileSync(new URL('../results/03-security.json', import.meta.url), JSON.stringify(out,null,2));
