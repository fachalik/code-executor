import { CheckCircle2, XCircle, Clock, Cpu, MemoryStick, AlertTriangle, CornerDownLeft, Scissors } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { ExecuteResult, ExecuteStatus } from '@/types';

interface Props {
  result:  ExecuteResult | null;
  loading: boolean;
  error:   string | null;
}

/** Badge tone per QuickJS status — timeouts and OOM are limits, not crashes. */
const STATUS_VARIANT: Record<ExecuteStatus, 'success' | 'warning' | 'error'> = {
  success:        'success',
  runtime_error:  'error',
  syntax_error:   'error',
  timeout:        'warning',
  out_of_memory:  'warning',
  internal_error: 'error',
};

/** `export default` comes back as JSON; render it readably, never throw. */
function formatValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function OutputPanel({ result, loading, error }: Props) {
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[hsl(222,47%,6%)] text-muted-foreground font-mono text-sm">
        <span className="animate-pulse">● running…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex flex-col bg-[hsl(222,47%,6%)] p-4 gap-2">
        <div className="flex items-center gap-2 text-red-400 text-xs font-mono">
          <AlertTriangle className="w-3.5 h-3.5" />
          <span>ERROR</span>
        </div>
        <pre className="text-red-400 font-mono text-sm whitespace-pre-wrap break-all">
          {error}
        </pre>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[hsl(222,47%,6%)] text-muted-foreground font-mono text-xs">
        // output akan muncul di sini — tekan ▶ Run atau Ctrl+Enter
      </div>
    );
  }

  // The sandbox engines report `ok` accurately, including for code that threw.
  // Piston always answers `ok: true`, so there success still has to be inferred.
  const success = result.engine === 'piston'
    ? result.exitCode === 0 && !result.stderr
    : result.ok;

  const hasStderr    = result.stderr && result.stderr.trim().length > 0;
  const hasReturn    = result.result !== undefined;
  const status       = result.meta?.status;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[hsl(222,47%,6%)]">
      {/* Status bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/50 flex-shrink-0 flex-wrap">
        {success ? (
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
        ) : (
          <XCircle className="w-3.5 h-3.5 text-red-400" />
        )}
        <Badge variant={success ? 'success' : 'error'} className="text-[10px] h-5">
          exit {result.exitCode}
        </Badge>
        {status && (
          <Badge variant={STATUS_VARIANT[status]} className="text-[10px] h-5 font-mono">
            {status}
          </Badge>
        )}
        <Badge variant="outline" className="text-[10px] h-5 font-mono">
          {result.engine}
        </Badge>
        <Badge variant="secondary" className="text-[10px] h-5 font-mono">
          {result.language}
        </Badge>
        {result.meta?.timeMs !== undefined && (
          <span className="flex items-center gap-1 text-muted-foreground text-[10px] ml-auto font-mono">
            <Clock className="w-3 h-3" />
            {result.meta.timeMs}ms
          </span>
        )}
        {result.meta?.cpuMs !== undefined && (
          <span className="flex items-center gap-1 text-muted-foreground text-[10px] font-mono" title="V8 CPU time inside the isolate">
            <Cpu className="w-3 h-3" />
            {result.meta.cpuMs}ms cpu
          </span>
        )}
        {result.meta?.memoryKb !== undefined && (
          <span className="flex items-center gap-1 text-muted-foreground text-[10px] font-mono">
            <MemoryStick className="w-3 h-3" />
            {(result.meta.memoryKb / 1024).toFixed(1)} MB
          </span>
        )}
        {result.signal && (
          <Badge variant="warning" className="text-[10px] h-5">
            signal: {result.signal}
          </Badge>
        )}
      </div>

      {/* Output body */}
      <div className="flex-1 overflow-auto p-3 space-y-3 font-mono text-sm min-h-0">
        {/* Sandbox error — QuickJS reports name/message/stack separately from stderr */}
        {result.error && (
          <div>
            <p className="text-[10px] text-muted-foreground mb-1.5 uppercase tracking-wider">
              {result.error.name}
            </p>
            <pre className="text-red-400 whitespace-pre-wrap break-all leading-relaxed">
              {result.error.message}
            </pre>
            {result.error.stack && (
              <pre className="text-red-400/60 text-xs whitespace-pre-wrap break-all leading-relaxed mt-1.5">
                {result.error.stack}
              </pre>
            )}
          </div>
        )}

        {result.stdout && result.stdout.trim() && (
          <div>
            <p className="text-[10px] text-muted-foreground mb-1.5 uppercase tracking-wider">stdout</p>
            <pre className="text-green-300 whitespace-pre-wrap break-all leading-relaxed">
              {result.stdout}
            </pre>
          </div>
        )}

        {hasStderr && (
          <div>
            <p className="text-[10px] text-muted-foreground mb-1.5 uppercase tracking-wider">stderr / compile</p>
            <pre className="text-red-400 whitespace-pre-wrap break-all leading-relaxed">
              {result.stderr}
            </pre>
          </div>
        )}

        {/* The module's `export default` — what a workflow step actually consumes */}
        {hasReturn && (
          <div>
            <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground mb-1.5 uppercase tracking-wider">
              <CornerDownLeft className="w-3 h-3" />
              export default
            </p>
            <pre className="text-sky-300 whitespace-pre-wrap break-all leading-relaxed">
              {formatValue(result.result)}
            </pre>
          </div>
        )}

        {result.meta?.truncated && (
          <p className="flex items-center gap-1.5 text-amber-400/80 text-[10px] font-mono">
            <Scissors className="w-3 h-3" />
            output melebihi batas dan dipotong
          </p>
        )}

        {!result.stdout?.trim() && !hasStderr && !hasReturn && !result.error && (
          <p className="text-muted-foreground text-xs italic">// no output</p>
        )}
      </div>
    </div>
  );
}
