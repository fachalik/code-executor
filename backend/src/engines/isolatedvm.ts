import axios from "axios";
import type { ExecuteResult, Language } from "../types";

const ISOLATEDVM_URL = process.env.ISOLATEDVM_URL ?? "http://localhost:3003";

/**
 * The isolated-vm service enforces its own per-execution deadline and answers
 * with a timeout result rather than hanging, so this only has to outlast that
 * deadline plus the service's queue wait.
 */
const REQUEST_TIMEOUT = Number(
  process.env.ISOLATEDVM_REQUEST_TIMEOUT ?? 30_000,
);

/** A V8 isolate runs JS only; TypeScript is transpiled by the service first. */
const ISOLATEDVM_LANGUAGES: Language[] = ["javascript", "typescript"];

export const supportsIsolatedVm = (language: Language): boolean =>
  ISOLATEDVM_LANGUAGES.includes(language);

/** The service's response is already this shape, plus an `ok` flag. */
type IsolatedVmResponse = ExecuteResult & { ok: boolean };

export async function runIsolatedVm(
  code: string,
  language: Language,
  env: Record<string, unknown> = {},
): Promise<ExecuteResult> {
  try {
    const { data } = await axios.post<IsolatedVmResponse>(
      `${ISOLATEDVM_URL}/api/execute`,
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
      throw new Error(`isolated-vm engine error: ${msg}`);
    }
    throw err;
  }
}
