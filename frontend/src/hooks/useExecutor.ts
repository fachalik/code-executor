import { useState, useCallback } from 'react';
import type { ExecuteResult, Language, Platform } from '@/types';

interface ExecutorState {
  result:  ExecuteResult | null;
  loading: boolean;
  error:   string | null;
}

/**
 * A 2xx carries an ExecuteResult; a 4xx/5xx carries `{ error, hint }` from the
 * backend. `error` therefore means two different things depending on status —
 * a rejection message on failure, a sandbox error object on a completed run.
 */
type ResponseBody = Partial<ExecuteResult> & { error?: unknown; hint?: string };

/**
 * Flattens a rejection body into one line. Also surfaces `hint`, which the
 * sanitizer sets to explain *why* a pattern was blocked.
 */
function rejectionMessage(body: ResponseBody, status: number): string {
  const { error, hint } = body;
  const message =
    typeof error === 'string'
      ? error
      : error && typeof error === 'object' && 'message' in error
        ? String((error as { message: unknown }).message)
        : `Server error ${status}`;

  return hint ? `${message}\n${hint}` : message;
}

/**
 * The dev proxy (and nginx in prod) answers with a 0-byte `text/plain` body
 * when the backend is down, so `res.json()` would throw a bare
 * "Unexpected end of JSON input". Parse defensively and report what the
 * status actually means instead.
 */
async function parseResponse(res: Response): Promise<ResponseBody> {
  const raw = await res.text();

  if (raw.trim() === '') {
    if (res.status >= 500) {
      throw new Error(
        `Backend unreachable (HTTP ${res.status}). Is the API running on :3001? ` +
          `Start it with \`cd backend && npm run dev\`, or \`docker compose up\`.`
      );
    }
    throw new Error(`Empty response from server (HTTP ${res.status})`);
  }

  try {
    return JSON.parse(raw) as ResponseBody;
  } catch {
    // HTML error page, proxy message, stack trace, …
    const snippet = raw.slice(0, 200).replace(/\s+/g, ' ').trim();
    throw new Error(`Non-JSON response (HTTP ${res.status}): ${snippet}`);
  }
}

export function useExecutor() {
  const [state, setState] = useState<ExecutorState>({
    result:  null,
    loading: false,
    error:   null,
  });

  const run = useCallback(
    async (code: string, language: Language, platform: Platform) => {
      setState({ result: null, loading: true, error: null });

      try {
        const res = await fetch('/api/execute', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ code, language, platform }),
        });

        const data = await parseResponse(res);

        if (!res.ok) {
          setState({
            result:  null,
            loading: false,
            error:   rejectionMessage(data, res.status),
          });
          return;
        }

        setState({ result: data as ExecuteResult, loading: false, error: null });
      } catch (err) {
        setState({
          result:  null,
          loading: false,
          error:   err instanceof Error ? err.message : 'Network error',
        });
      }
    },
    []
  );

  const clear = useCallback(() => {
    setState({ result: null, loading: false, error: null });
  }, []);

  return { ...state, run, clear };
}
