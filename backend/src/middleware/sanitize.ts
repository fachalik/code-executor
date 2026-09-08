/**
 * Code sanitizer — blocks network access and package imports
 * before the code ever reaches the execution engine.
 *
 * Two layers of defence:
 *  1. Regex scan here (fast, pre-flight)
 *  2. Engine-level: Piston runs via nsjail (network OFF by default)
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
