import axios, { AxiosInstance } from "axios";
import type { ExecuteResult, Language } from "../types";

const JUDGE0_URL = process.env.JUDGE0_URL ?? "http://localhost:2358";

/** Seconds — Judge0 speaks in float seconds, not milliseconds. */
const CPU_TIME_LIMIT = Number(process.env.JUDGE0_CPU_TIME_LIMIT ?? 5);
const WALL_TIME_LIMIT = Number(process.env.JUDGE0_WALL_TIME_LIMIT ?? 10);
/** Kilobytes — Judge0's own unit for `memory_limit` and the `memory` it reports. */
const MEMORY_LIMIT_KB = Number(process.env.JUDGE0_MEMORY_LIMIT_KB ?? 128_000);

/** Matches the sandbox services' cap, so one engine cannot flood the client. */
const MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Language → Judge0 language_id, pinned to the ids this instance reports.
 * Run `GET /languages` against your Judge0 to confirm before changing these:
 * the ids are per-deployment, not a stable part of the API.
 */
const JUDGE0_LANG: Record<Language, number> = {
  javascript: 63, // JavaScript (Node.js 12.14.0)
  typescript: 74, // TypeScript (3.7.4)
  python: 71, // Python (3.8.1)
};

type MappedStatus =
  | "success"
  | "runtime_error"
  | "syntax_error"
  | "timeout"
  | "internal_error";

/**
 * Judge0 status ids → the status vocabulary the frontend already renders.
 * Only terminal ids appear: In Queue (1) and Processing (2) are polled away
 * before this map is consulted. Ids 7–12 are all "the program died"; only the
 * signal tells them apart, and that lands in `signal` rather than the status.
 */
const STATUS_BY_ID: Record<number, MappedStatus> = {
  3: "success",
  4: "runtime_error", // Wrong Answer — only meaningful with expected_output
  5: "timeout",
  6: "syntax_error", // Compilation Error
  7: "runtime_error", // SIGSEGV
  8: "runtime_error", // SIGXFSZ
  9: "runtime_error", // SIGFPE
  10: "runtime_error", // SIGABRT
  11: "runtime_error", // NZEC
  12: "runtime_error", // Runtime Error (Other)
  13: "internal_error",
  14: "internal_error", // Exec Format Error
};

/** Judge0 hands back a raw signal number; name the ones a sandbox actually sees. */
const SIGNAL_NAMES: Record<number, string> = {
  6: "SIGABRT",
  8: "SIGFPE",
  9: "SIGKILL",
  11: "SIGSEGV",
  15: "SIGTERM",
  24: "SIGXCPU",
  25: "SIGXFSZ",
};

interface Judge0Status {
  id: number;
  description: string;
}

interface Judge0Submission {
  token: string;
  /** All four are base64 when the request asks for `base64_encoded=true`. */
  stdout: string | null;
  stderr: string | null;
  compile_output: string | null;
  /** Judge0's own note about the run — set on internal errors. */
  message: string | null;
  /** Seconds, as a string. */
  time: string | null;
  /** Kilobytes. */
  memory: number | null;
  exit_code: number | null;
  exit_signal: number | null;
  status: Judge0Status;
}

const FIELDS = [
  "token",
  "stdout",
  "stderr",
  "compile_output",
  "message",
  "time",
  "memory",
  "exit_code",
  "exit_signal",
  "status",
].join(",");

function client(): AxiosInstance {
  return axios.create({
    baseURL: JUDGE0_URL,
    timeout: 30_000,
    headers: {
      "Content-Type": "application/json",
      // Only sent when configured. A Judge0 with authn/authz disabled ignores
      // them; one with it enabled rejects every request without them.
      ...(process.env.JUDGE0_AUTH_TOKEN
        ? { "X-Auth-Token": process.env.JUDGE0_AUTH_TOKEN }
        : {}),
      ...(process.env.JUDGE0_AUTH_USER
        ? { "X-Auth-User": process.env.JUDGE0_AUTH_USER }
        : {}),
    },
  });
}

export function supportsJudge0(language: Language): boolean {
  return language in JUDGE0_LANG;
}

export async function runJudge0(
  code: string,
  language: Language,
): Promise<ExecuteResult> {
  const languageId = JUDGE0_LANG[language];
  if (languageId === undefined) {
    throw new Error(`Judge0 does not support: ${language}`);
  }

  const api = client();
  const payload = {
    language_id: languageId,
    // base64 throughout, so a source file with any byte in it survives the trip
    // and the response never depends on the server's JSON escaping.
    source_code: Buffer.from(code, "utf8").toString("base64"),
    cpu_time_limit: CPU_TIME_LIMIT,
    wall_time_limit: WALL_TIME_LIMIT,
    memory_limit: MEMORY_LIMIT_KB,
  };

  let submission: Judge0Submission;
  try {
    const { data } = await api.post<Judge0Submission>(
      `/submissions?base64_encoded=true&wait=true&fields=${FIELDS}`,
      payload,
    );
    submission = data;
  } catch (err: unknown) {
    if (!axios.isAxiosError(err)) throw err;

    const detail = errorDetail(err);

    // `wait=true` is a per-deployment switch (`enable_wait_result` in
    // /config_info). When it is off Judge0 rejects the request with a 400 that
    // says so, and the create-then-poll path is always available instead.
    // Every other 400 is a real complaint about the submission — a bad
    // language id, a limit above the instance ceiling — so let it surface.
    if (err.response?.status === 400 && /wait/i.test(detail)) {
      submission = await submitAndPoll(api, payload);
    } else {
      throw new Error(`Judge0 engine error: ${detail}`);
    }
  }

  // `wait=true` can still answer while the job sits in the queue on a busy
  // instance, so settle it either way.
  if (submission.status.id <= 2) {
    submission = await poll(api, submission.token);
  }

  return toResult(submission, language);
}

async function submitAndPoll(
  api: AxiosInstance,
  payload: object,
): Promise<Judge0Submission> {
  const { data } = await api.post<{ token: string }>(
    "/submissions?base64_encoded=true&wait=false",
    payload,
  );
  return poll(api, data.token);
}

/**
 * Judge0 has no push channel, so a queued job is polled until its status
 * leaves In Queue (1) / Processing (2). The budget matches the wall clock the
 * submission itself was given, plus room for the queue ahead of it.
 */
async function poll(
  api: AxiosInstance,
  token: string,
): Promise<Judge0Submission> {
  const intervalMs = 250;
  const deadline = Date.now() + (WALL_TIME_LIMIT * 1000 + 20_000);

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const { data } = await api.get<Judge0Submission>(
      `/submissions/${token}?base64_encoded=true&fields=${FIELDS}`,
    );
    if (data.status.id > 2) return data;
  }

  throw new Error(
    `Judge0 engine error: submission ${token} still queued after ` +
      `${Math.round((WALL_TIME_LIMIT * 1000 + 20_000) / 1000)}s`,
  );
}

/**
 * Judge0 reports request-level problems as `{ error }` or as per-field arrays
 * (`{ memory_limit: ["must be less than or equal to 512000"] }`). Flatten
 * whichever shape came back into one line.
 */
function errorDetail(err: import("axios").AxiosError): string {
  const body = err.response?.data;
  if (typeof body === "string" && body.trim()) return body.trim();
  if (typeof body === "object" && body !== null) {
    const entries = Object.entries(body as Record<string, unknown>)
      .map(([key, value]) =>
        key === "error"
          ? String(value)
          : `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`,
      )
      .filter((line) => line.trim().length > 0);
    if (entries.length > 0) return entries.join("; ");
  }
  return err.message;
}

function decode(value: string | null): string {
  if (!value) return "";
  return Buffer.from(value, "base64").toString("utf8");
}

function toResult(
  submission: Judge0Submission,
  language: Language,
): ExecuteResult {
  const statusId = submission.status.id;
  const status = STATUS_BY_ID[statusId] ?? "internal_error";

  const stdout = decode(submission.stdout);
  const compileOutput = decode(submission.compile_output);
  const stderr = decode(submission.stderr);
  // Judge0's `message` is the harness talking, not the program: an isolate
  // failure, a killed job. Surfacing it is the difference between "no output"
  // and a diagnosable error.
  const message = decode(submission.message);

  // Compile output first — a program that never built has no runtime stderr,
  // and the compiler's complaint is the whole answer.
  const errorStream = [compileOutput, stderr, statusId === 13 ? message : ""]
    .filter((s) => s.trim().length > 0)
    .join("\n");

  const truncatedStdout = truncate(stdout);
  const truncatedStderr = truncate(errorStream);

  const signal =
    submission.exit_signal != null && submission.exit_signal !== 0
      ? SIGNAL_NAMES[submission.exit_signal] ?? `SIG${submission.exit_signal}`
      : null;

  // Judge0 reports no exit code when the program never ran (compile error,
  // internal error). Anything short of Accepted has to read as a failure.
  const exitCode =
    submission.exit_code ?? (statusId === 3 ? 0 : 1);

  const result: ExecuteResult = {
    stdout: truncatedStdout.text,
    stderr: truncatedStderr.text,
    exitCode,
    signal,
    engine: "judge0",
    language,
    meta: {
      status,
      ...(submission.time != null
        ? { timeMs: Math.round(Number(submission.time) * 1000) }
        : {}),
      ...(submission.memory != null ? { memoryKb: submission.memory } : {}),
      ...(truncatedStdout.truncated || truncatedStderr.truncated
        ? { truncated: true }
        : {}),
    },
  };

  if (status !== "success") {
    result.error = {
      name: submission.status.description,
      message:
        errorStream.trim() ||
        message.trim() ||
        submission.status.description,
    };
  }

  return result;
}

function truncate(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES) {
    return { text, truncated: false };
  }
  const clipped = Buffer.from(text, "utf8")
    .subarray(0, MAX_OUTPUT_BYTES)
    .toString("utf8");
  return { text: `${clipped}\n… output truncated`, truncated: true };
}
