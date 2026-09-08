import { Request, Response, Router } from "express";
import { clamp, config } from "../config";
import { runQuickJs } from "../engine/quickjs";
import { QueueFullError, withSlot } from "../queue";
import type { ExecuteRequest, Language } from "../types";

export const executeRouter = Router();

const SUPPORTED_LANGUAGES: Language[] = ["javascript", "typescript"];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

executeRouter.get("/languages", (_req: Request, res: Response) => {
  res.json({ languages: SUPPORTED_LANGUAGES, engine: "quickjs" });
});

executeRouter.post("/execute", async (req: Request, res: Response) => {
  const {
    code,
    language = "javascript",
    env,
    timeoutMs,
    memoryLimitBytes,
  } = req.body as ExecuteRequest;

  // ── Validation ────────────────────────────────────────────────────────────
  if (!code || typeof code !== "string" || code.trim() === "") {
    return res
      .status(400)
      .json({ error: "code is required and must be a non-empty string" });
  }
  if (Buffer.byteLength(code) > config.maxCodeBytes) {
    return res
      .status(400)
      .json({ error: `code exceeds the ${config.maxCodeBytes} byte limit` });
  }
  if (!SUPPORTED_LANGUAGES.includes(language)) {
    return res.status(400).json({
      error: `Unsupported language: ${language}`,
      supported: SUPPORTED_LANGUAGES,
    });
  }
  if (env !== undefined && !isPlainObject(env)) {
    return res.status(400).json({ error: "env must be an object" });
  }

  // ── Execute ───────────────────────────────────────────────────────────────
  // No sanitizer runs here on purpose. The sandbox is the boundary: there is no
  // network, no filesystem, and no `http`/`net`/`child_process` module to reach
  // for, so pattern-matching the source would only add false rejections.
  try {
    const result = await withSlot(() =>
      runQuickJs(code, {
        language,
        timeoutMs: clamp(
          Number(timeoutMs) || config.defaultTimeoutMs,
          config.maxTimeoutMs
        ),
        memoryLimitBytes: clamp(
          Number(memoryLimitBytes) || config.defaultMemoryBytes,
          config.maxMemoryBytes
        ),
        env: env ?? {},
      })
    );

    // A guest-side error is still a completed execution, so it answers 200 with
    // `ok: false` — the caller branches on `ok`, not on the HTTP status.
    return res.json({ ok: result.meta.status === "success", ...result });
  } catch (err: unknown) {
    if (err instanceof QueueFullError) {
      return res.status(429).json({ error: err.message });
    }
    const message =
      err instanceof Error ? err.message : "Execution engine returned an error";
    console.error("[execute]", message);
    return res.status(500).json({ error: message });
  }
});
