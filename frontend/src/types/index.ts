export type Language = "javascript" | "typescript" | "python";

export type Platform = "piston" | "quickjs" | "isolated-vm";

export type Engine = Platform;

/** Mirrors the sandbox services' `meta.status`. Piston does not report one. */
export type ExecuteStatus =
  | "success"
  | "runtime_error"
  | "syntax_error"
  | "timeout"
  | "out_of_memory"
  | "internal_error";

export interface ExecuteResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: string | null;
  engine: Engine;
  language: Language;
  /** Sandbox engines only — the module's `export default`, handed back to the caller. */
  result?: unknown;
  /** Sandbox engines only — present when the run did not succeed. */
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  meta?: {
    status?: ExecuteStatus;
    timeMs?: number;
    memoryKb?: number;
    /** isolated-vm only — V8 CPU time burned inside the isolate. */
    cpuMs?: number;
    truncated?: boolean;
  };
  /** Set by the backend when the request itself was rejected. */
  hint?: string;
}

export interface LanguageConfig {
  label: string;
  monacoId: string;
}

export const LANGUAGE_CONFIG: Record<Language, LanguageConfig> = {
  javascript: { label: "JavaScript", monacoId: "javascript" },
  typescript: { label: "TypeScript", monacoId: "typescript" },
  python: { label: "Python", monacoId: "python" },
};

export interface PlatformConfig {
  label: string;
  /** One line on what the engine is, shown under the selector. */
  description: string;
  /** Shown as a badge — the constraint a user needs to know before writing code. */
  note: string;
  languages: Language[];
  /** Starter code per language. Keyed only by the languages above. */
  defaultCode: Partial<Record<Language, string>>;
}

/**
 * Each platform brings its own language set AND its own starter code — the
 * engines take input and return results differently enough that one shared
 * snippet would be wrong for all of them. Piston runs a script for its stdout;
 * the two sandboxes run a module, read `env`, and hand back its default export.
 */
export const PLATFORM_CONFIG: Record<Platform, PlatformConfig> = {
  piston: {
    label: "Piston",
    description: "nsjail container · real interpreters",
    note: "no fetch · no packages",
    languages: ["javascript", "python"],
    defaultCode: {
      javascript: `// JavaScript — Node.js 20.11.1 on Piston

const numbers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

const result = numbers
  .filter(n => n % 2 === 0)
  .map(n => n ** 2)
  .reduce((acc, n) => acc + n, 0);

console.log('Even numbers squared, sum:', result);

// Fibonacci
function fib(n) {
  let a = 0, b = 1;
  const seq = [a, b];
  while (b < n) {
    [a, b] = [b, a + b];
    seq.push(b);
  }
  return seq.filter(x => x <= n);
}

console.log('Fibonacci ≤ 100:', fib(100).join(', '));
`,
      python: `# Python 3.12 on Piston
from math import sqrt, pi

numbers = list(range(1, 21))
evens  = [n for n in numbers if n % 2 == 0]
primes = [n for n in numbers if n > 1 and all(n % i != 0 for i in range(2, int(sqrt(n)) + 1))]

print("Evens:", evens)
print("Primes:", primes)
print(f"Pi ≈ {pi:.6f}")

# Dictionary comprehension
squares = {n: n**2 for n in range(1, 11)}
print("Squares:", squares)
`,
    },
  },

  quickjs: {
    label: "QuickJS",
    description: "WASM sandbox · no JIT · in-process",
    note: "no network · no filesystem",
    languages: ["javascript", "typescript"],
    defaultCode: {
      javascript: `// QuickJS-WASM — no network, no filesystem, no JIT
// Kode dijalankan sebagai ES module:
//   input  → global \`env\`
//   output → \`export default\`

// Playground tidak mengirim env, jadi pakai contoh sebagai fallback.
const applicant = env.applicant ?? {
  name: 'Alice', income: 95_000, debt: 12_000, age: 34,
};

function score({ income, debt, age }) {
  let s = 500;
  s += income / 1000;
  s -= debt / 500;
  if (age > 25) s += 20;
  return Math.round(s);
}

const total = score(applicant);
console.log('scoring', applicant.name, '→', total);

export default {
  score: total,
  tier:  total > 550 ? 'A' : total > 500 ? 'B' : 'C',
};
`,
      typescript: `// TypeScript di QuickJS — di-transpile sebelum dieksekusi.
// Tipe dihapus, bukan dicek: type error tidak menggagalkan run.

interface Applicant {
  name:   string;
  income: number;
  debt:   number;
  age:    number;
}

const applicant: Applicant = env.applicant ?? {
  name: 'Alice', income: 95_000, debt: 12_000, age: 34,
};

const score = ({ income, debt, age }: Applicant): number => {
  let s = 500;
  s += income / 1000;
  s -= debt / 500;
  if (age > 25) s += 20;
  return Math.round(s);
};

const total = score(applicant);
console.log('scoring', applicant.name, '→', total);

export default { score: total, tier: total > 550 ? 'A' : 'B' };
`,
    },
  },

  "isolated-vm": {
    label: "isolated-vm",
    description: "V8 isolate · full JIT · native addon",
    note: "no node api · no network",
    languages: ["javascript", "typescript"],
    defaultCode: {
      javascript: `// isolated-vm — V8 isolate sungguhan, dengan JIT penuh.
// Heap dan context terpisah dari proses host: tidak ada \`require\`,
// \`process\`, \`fetch\`, maupun timer di dalam sini.
//
//   input  → global \`env\`
//   output → \`export default\`

const applicant = env.applicant ?? {
  name: 'Alice', income: 95_000, debt: 12_000, age: 34,
};

function score({ income, debt, age }) {
  let s = 500;
  s += income / 1000;
  s -= debt / 500;
  if (age > 25) s += 20;
  return Math.round(s);
}

// JIT-nya nyata — loop panas begini jauh lebih cepat daripada di QuickJS.
let checksum = 0;
for (let i = 0; i < 5_000_000; i++) checksum = (checksum + i * 31) % 1_000_003;

const total = score(applicant);
console.log('scoring', applicant.name, '→', total);
console.log('checksum', checksum);

export default {
  score: total,
  tier:  total > 550 ? 'A' : total > 500 ? 'B' : 'C',
};
`,
      typescript: `// TypeScript di isolated-vm — di-transpile lalu dievaluasi sebagai ES module.
// Tipe dihapus, bukan dicek: type error tidak menggagalkan run.

interface Applicant {
  name:   string;
  income: number;
  debt:   number;
  age:    number;
}

const applicant: Applicant = env.applicant ?? {
  name: 'Alice', income: 95_000, debt: 12_000, age: 34,
};

const score = ({ income, debt, age }: Applicant): number => {
  let s = 500;
  s += income / 1000;
  s -= debt / 500;
  if (age > 25) s += 20;
  return Math.round(s);
};

const total = score(applicant);
console.log('scoring', applicant.name, '→', total);

export default { score: total, tier: total > 550 ? 'A' : 'B' };
`,
    },
  },
};

/** Starter code for a pair, falling back to the platform's first language. */
export function getDefaultCode(platform: Platform, language: Language): string {
  const cfg = PLATFORM_CONFIG[platform];
  return cfg.defaultCode[language] ?? cfg.defaultCode[cfg.languages[0]] ?? "";
}
