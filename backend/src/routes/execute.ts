import { Request, Response, Router } from "express";
import { runPiston } from "../engines/piston";
import { runJudge0, supportsJudge0 } from "../engines/judge0";
import { runIsolatedVm, supportsIsolatedVm } from "../engines/isolatedvm";
import { runQuickJs, supportsQuickJs } from "../engines/quickjs";
import { sanitizeCode } from "../middleware/sanitize";
import type { ExecuteRequest, Language } from "../types";

export const executeRouter = Router();

const SUPPORTED_LANGUAGES: Language[] = ["javascript", "python"];
const JUDGE0_LANGUAGES: Language[] = ["javascript", "typescript", "python"];
const QUICKJS_LANGUAGES: Language[] = ["javascript", "typescript"];
const ISOLATEDVM_LANGUAGES: Language[] = ["javascript", "typescript"];

executeRouter.get("/languages", (_req: Request, res: Response) => {
  res.json({
    engine: "piston",
    languages: SUPPORTED_LANGUAGES,
    platforms: {
      piston: SUPPORTED_LANGUAGES,
      judge0: JUDGE0_LANGUAGES,
      quickjs: QUICKJS_LANGUAGES,
      "isolated-vm": ISOLATEDVM_LANGUAGES,
    },
  });
});

executeRouter.post("/execute", async (req: Request, res: Response) => {
  const {
    code,
    language = "javascript",
    platform,
    env,
  } = req.body as ExecuteRequest;

  // ── Validation ──────────────────────────────────────────────────────────
  if (!code || typeof code !== "string" || code.trim() === "") {
    return res
      .status(400)
      .json({ error: "code is required and must be a non-empty string" });
  }
  if (code.length > 65_536) {
    return res.status(400).json({ error: "code exceeds 64 KB limit" });
  }

  // ── Execute ─────────────────────────────────────────────────────────────
  try {
    switch (platform) {
      case "quickjs": {
        if (!supportsQuickJs(language as Language)) {
          return res.status(400).json({
            error: `QuickJS does not support: ${language}`,
            supported: QUICKJS_LANGUAGES,
          });
        }
        // No sanitizer here. The sandbox is the boundary — no network, no
        // filesystem, and no http/net/child_process module to import — and the
        // regex rules would reject legitimate code, starting with the bare
        // `import { join } from "path"` that QuickJS supports natively.
        const result = await runQuickJs(
          code,
          language as Language,
          env ?? {},
        );
        return res.json({
          ok: result.meta?.status === "success",
          ...result,
        });
      }

      case "isolated-vm": {
        if (!supportsIsolatedVm(language as Language)) {
          return res.status(400).json({
            error: `isolated-vm does not support: ${language}`,
            supported: ISOLATEDVM_LANGUAGES,
          });
        }
        // No sanitizer here either. A V8 isolate has no Node bindings at all —
        // no `require`, no `process`, no `fetch`, no timers, no module resolver
        // — so the regex rules would only reject legitimate code.
        const result = await runIsolatedVm(
          code,
          language as Language,
          env ?? {},
        );
        return res.json({
          ok: result.meta?.status === "success",
          ...result,
        });
      }

      case "judge0": {
        if (!supportsJudge0(language as Language)) {
          return res.status(400).json({
            error: `Judge0 does not support: ${language}`,
            supported: JUDGE0_LANGUAGES,
          });
        }
        // Same reasoning as piston: Judge0 runs real compilers and interpreters
        // with real module systems, so the pre-flight regex pass still earns
        // its place. The isolate boundary underneath is the real defence.
        const judge0Check = sanitizeCode(code);
        if (!judge0Check.ok) {
          return res.status(422).json({
            error: `Blocked pattern detected: "${judge0Check.blocked}"`,
            hint: judge0Check.hint,
            blocked: judge0Check.blocked,
          });
        }
        const result = await runJudge0(code, language as Language);
        return res.json({
          ok: result.meta?.status === "success",
          ...result,
        });
      }

      case "piston": {
        if (!SUPPORTED_LANGUAGES.includes(language as Language)) {
          return res.status(400).json({
            error: `Unsupported language: ${language}`,
            supported: SUPPORTED_LANGUAGES,
          });
        }
        // Piston runs real interpreters with real module systems, so the
        // pre-flight regex pass still earns its place there.
        const check = sanitizeCode(code);
        if (!check.ok) {
          return res.status(422).json({
            error: `Blocked pattern detected: "${check.blocked}"`,
            hint: check.hint,
            blocked: check.blocked,
          });
        }
        const result = await runPiston(code, language as Language);
        return res.json({ ok: true, ...result });
      }

      default:
        return res.status(400).json({
          error: `Unsupported platform: ${platform}`,
          supported: ["quickjs", "isolated-vm", "piston", "judge0"],
        });
    }
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Execution engine returned an error";
    console.error("[execute]", message);
    return res.status(502).json({ error: message });
  }
});
