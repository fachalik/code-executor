export type Language = 'javascript' | 'typescript' | 'python';

export type Engine = 'piston';

export interface ExecuteResult {
  ok:       boolean;
  stdout:   string;
  stderr:   string;
  exitCode: number;
  signal:   string | null;
  engine:   Engine;
  language: Language;
  meta?: {
    status?:   string;
    timeMs?:   number;
    memoryKb?: number;
  };
  error?: string;
  hint?:  string;
}

export interface LanguageConfig {
  label:         string;
  monacoId:      string;
  defaultCode:   string;
}

export const LANGUAGE_CONFIG: Record<Language, LanguageConfig> = {
  javascript: {
    label:    'JavaScript',
    monacoId: 'javascript',
    defaultCode: `// JavaScript — Node.js 20.11.1
// fetch() dan package import tidak diizinkan

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
  },
  typescript: {
    label:    'TypeScript',
    monacoId: 'typescript',
    defaultCode: `// TypeScript 5.0.3 — compiled with tsc, run on Node
interface User {
  id:   number;
  name: string;
  role: 'admin' | 'user';
}

const users: User[] = [
  { id: 1, name: 'Alice', role: 'admin' },
  { id: 2, name: 'Bob',   role: 'user'  },
  { id: 3, name: 'Carol', role: 'user'  },
];

const admins = users
  .filter((u): u is User & { role: 'admin' } => u.role === 'admin')
  .map(u => u.name);

console.log('Admins:', admins.join(', '));

function greet(user: User): string {
  return \`Hello, \${user.name} [\${user.role}]\`;
}

users.forEach(u => console.log(greet(u)));
`,
  },
  python: {
    label:    'Python',
    monacoId: 'python',
    defaultCode: `# Python 3.12
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
};
