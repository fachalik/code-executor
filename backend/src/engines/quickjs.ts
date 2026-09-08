import axios from "axios";
import type { ExecuteResult, Language } from "../types";

const QUICKJS_URL = process.env.QUICKJS_URL ?? "http://localhost:3002";

/**
 * The QuickJS service enforces its own per-execution deadline and answers with
 * a timeout result rather than hanging, so this only has to outlast that
 * deadline plus the service's queue wait.
 */
const REQUEST_TIMEOUT = Number(process.env.QUICKJS_REQUEST_TIMEOUT ?? 30_000);

/** QuickJS runs JS/TS only — Python has no interpreter in this sandbox. */
const QUICKJS_LANGUAGES: Language[] = ["javascript", "typescript"];

export const supportsQuickJs = (language: Language): boolean =>
  QUICKJS_LANGUAGES.includes(language);

/** The service's response is already this shape, plus an `ok` flag. */
type QuickJsResponse = ExecuteResult & { ok: boolean };

export async function runQuickJs(
  code: string,
  language: Language,
  env: Record<string, unknown> = {},
): Promise<ExecuteResult> {
  try {
    const { data } = await axios.post<QuickJsResponse>(
      `${QUICKJS_URL}/api/execute`,
      { code, language, env },
      { timeout: REQUEST_TIMEOUT },
    );

    const { ok: _ok, ...result } = data;
    return result;
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      // 429 (saturated) and 400 (rejected input) carry a useful message; a
      // connection error means the service is down, which reads very differently.
      const msg = err.response?.data?.error ?? err.message;
      throw new Error(`QuickJS engine error: ${msg}`);
    }
    throw err;
  }
}
