import { CheckCircle2, XCircle, Clock, MemoryStick, AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { ExecuteResult } from '@/types';

interface Props {
  result:  ExecuteResult | null;
  loading: boolean;
  error:   string | null;
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

  const success = result.exitCode === 0 && !result.stderr;
  const hasStderr = result.stderr && result.stderr.trim().length > 0;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[hsl(222,47%,6%)]">
      {/* Status bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/50 flex-shrink-0">
        {success ? (
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
        ) : (
          <XCircle className="w-3.5 h-3.5 text-red-400" />
        )}
        <Badge variant={success ? 'success' : 'error'} className="text-[10px] h-5">
          exit {result.exitCode}
        </Badge>
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

        {!result.stdout?.trim() && !hasStderr && (
          <p className="text-muted-foreground text-xs italic">// no output</p>
        )}
      </div>
    </div>
  );
}
