/**
 * Code sanitizer — blocks network access and package imports
 * before the code ever reaches the execution engine.
 *
 * This is defence-in-depth, NOT the security boundary. A regex scan over
 * source text cannot be complete — it was bypassed in a security review
 * (bench/REPORT.md §3.3/3.4) with nothing more exotic than
 * `globalThis['fet'+'ch']` instead of `fetch(`. Do not add rules here
 * expecting them to hold against a motivated bypass; add them because they
 * catch the common, non-adversarial case cheaply (typos, copy-pasted
 * snippets, accidental package imports) before a container ever spins up.
 *
 * The actual boundary is the engine underneath:
 *  - Piston: nsjail with networking disabled (`PISTON_DISABLE_NETWORKING`
 *    in docker-compose.yml — this must stay "true").
 *  - Judge0: the `isolate` sandbox.
 *  - QuickJS / isolated-vm: don't route through here at all (see
 *    routes/execute.ts) — their containment is the WASM/V8-isolate boundary
 *    itself, which a text scanner would only get in the way of.
 */

interface BlockedRule {
  pattern: RegExp;
  label: string;
  hint: string;
}

const BLOCKED_RULES: BlockedRule[] = [
  // Network
  {
    pattern: /\bfetch\s*\(/,
    label: 'fetch()',
    hint: 'Network access is disabled. Remove fetch() calls.',
  },
  {
    pattern: /\bnew\s+XMLHttpRequest\b/,
    label: 'XMLHttpRequest',
    hint: 'Network access is disabled. Remove XMLHttpRequest usage.',
  },
  {
    pattern: /\bnew\s+WebSocket\s*\(/,
    label: 'WebSocket',
    hint: 'Network access is disabled.',
  },
  // Package imports
  {
    pattern: /\brequire\s*\(\s*['"][^./'"][^'"]*['"]\s*\)/,
    label: 'require(package)',
    hint: 'External packages are not allowed. Use require() only for built-in modules.',
  },
  {
    pattern: /^\s*import\s+.+\s+from\s+['"][^./'"][^'"]*['"]/m,
    label: 'import from package',
    hint: 'External package imports are not allowed.',
  },
  // Dangerous builtins
  {
    pattern: /\bchild_process\b/,
    label: 'child_process',
    hint: 'System process execution is not allowed.',
  },
  {
    pattern: /\bprocess\.binding\b/,
    label: 'process.binding',
    hint: 'Low-level process access is not allowed.',
  },
  {
    pattern: /\b__non_webpack_require__\b/,
    label: '__non_webpack_require__',
    hint: 'Dynamic require bypass is not allowed.',
  },

  // ── Python — previously had no coverage at all (bench/REPORT.md §3.3):
  // `import socket`, `import subprocess`, and `open()` all sailed through.
  {
    pattern: /^\s*(import\s+socket\b|from\s+socket\s+import\b)/m,
    label: 'import socket',
    hint: 'Network access is disabled.',
  },
  {
    pattern: /^\s*(import\s+subprocess\b|from\s+subprocess\s+import\b)/m,
    label: 'import subprocess',
    hint: 'Spawning processes is not allowed.',
  },
  {
    pattern: /\bos\.(system|popen|exec[lv]p?e?|spawn[lv]p?e?)\s*\(/,
    label: 'os.system / os.exec*',
    hint: 'Spawning processes is not allowed.',
  },
  {
    pattern: /\b__import__\s*\(\s*['"](socket|subprocess|ctypes)['"]/,
    label: '__import__(...)',
    hint: 'Dynamic import of a blocked module is not allowed.',
  },
  {
    pattern: /^\s*import\s+ctypes\b/m,
    label: 'import ctypes',
    hint: 'Low-level native access is not allowed.',
  },
  {
    // Python's builtin `open(...)`, not a `.open(...)` method call — this
    // sanitizer runs over both languages, and `.open(` is common enough in
    // legitimate JS (e.g. a custom class method) that matching it bare would
    // be a false-positive magnet for no real gain.
    pattern: /(?<!\.)\bopen\s*\(/,
    label: 'open()',
    hint: 'Filesystem access is disabled.',
  },
];

export interface SanitizeResult {
  ok: boolean;
  blocked?: string;
  hint?: string;
}

export function sanitizeCode(code: string): SanitizeResult {
  for (const rule of BLOCKED_RULES) {
    if (rule.pattern.test(code)) {
      return { ok: false, blocked: rule.label, hint: rule.hint };
    }
  }
  return { ok: true };
}
