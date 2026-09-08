import axios from "axios";
import type { ExecuteResult, Language } from "../types";

const PISTON_URL = process.env.PISTON_URL ?? "http://localhost:2000";

/**
 * Piston enforces its own ceilings server-side and rejects the whole request
 * with `"<field> cannot exceed the configured limit of N"` if we ask for more.
 * The stock image caps run/compile timeout at 3000 ms — check yours with:
 *   docker compose exec piston cat /piston_api/src/config.js | grep -A2 timeout
 * Raise the container's limit first, then bump these via env.
 */
const RUN_TIMEOUT = Number(process.env.PISTON_RUN_TIMEOUT ?? 3_000);
const COMPILE_TIMEOUT = Number(process.env.PISTON_COMPILE_TIMEOUT ?? 10_000);
const MEMORY_LIMIT = Number(process.env.PISTON_MEMORY_LIMIT ?? 134_217_728);

/**
 * Language → Piston runtime identifier + pinned version.
 * Run `GET /api/v2/runtimes` against your Piston instance to see
 * the full list after installing runtimes (see README).
 */
const PISTON_LANG: Record<Language, { language: string; version: string }> = {
  javascript: { language: "javascript", version: "20.11.1" },
  typescript: { language: "typescript", version: "5.0.3" },
  python: { language: "python", version: "3.12.0" },
};

interface PistonResponse {
  compile?: { stdout: string; stderr: string; code: number };
  run: { stdout: string; stderr: string; code: number; signal: string | null };
  message?: string;
}

export async function runPiston(
  code: string,
  language: Language,
): Promise<ExecuteResult> {
  const lang = PISTON_LANG[language] ?? PISTON_LANG.javascript;

  let response: PistonResponse;
  try {
    const { data } = await axios.post<PistonResponse>(
      `${PISTON_URL}/api/v2/execute`,
      {
        language: lang.language,
        version: lang.version,
        files: [{ name: getFileName(language), content: code }],
        run_timeout: 3000,
        compile_timeout: 10000,
        run_memory_limit: 134_217_728, // 128 MB in bytes
      },
      { timeout: 20_000 },
    );
    response = data;
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      const msg = err.response?.data?.message ?? err.message;
      throw new Error(`Piston engine error: ${msg}`);
    }
    throw err;
  }

  const compileErr = response.compile?.stderr ?? "";
  const runErr = response.run?.stderr ?? "";

  return {
    stdout: response.run?.stdout ?? "",
    stderr: compileErr || runErr,
    exitCode: response.run?.code ?? 0,
    signal: response.run?.signal ?? null,
    engine: "piston",
    language,
  };
}

function getFileName(lang: Language): string {
  const ext: Record<Language, string> = {
    javascript: "main.js",
    typescript: "main.ts",
    python: "main.py",
  };
  return ext[lang] ?? "main";
}
