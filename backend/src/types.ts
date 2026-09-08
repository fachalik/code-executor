export type Language = 'javascript' | 'typescript' | 'python';

export type Engine = 'piston';

export interface ExecuteResult {
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
}

export interface ExecuteRequest {
  code:      string;
  language?: Language;
}
