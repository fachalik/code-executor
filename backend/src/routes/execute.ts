import { Router, Request, Response } from 'express';
import { sanitizeCode } from '../middleware/sanitize';
import { runPiston } from '../engines/piston';
import type { ExecuteRequest, Language } from '../types';

export const executeRouter = Router();

const SUPPORTED_LANGUAGES: Language[] = ['javascript', 'typescript', 'python'];

executeRouter.get('/languages', (_req: Request, res: Response) => {
  res.json({ languages: SUPPORTED_LANGUAGES, engine: 'piston' });
});

executeRouter.post('/execute', async (req: Request, res: Response) => {
  const { code, language = 'javascript' } = req.body as ExecuteRequest;

  // ── Validation ──────────────────────────────────────────────────────────
  if (!code || typeof code !== 'string' || code.trim() === '') {
    return res.status(400).json({ error: 'code is required and must be a non-empty string' });
  }
  if (code.length > 65_536) {
    return res.status(400).json({ error: 'code exceeds 64 KB limit' });
  }
  if (!SUPPORTED_LANGUAGES.includes(language as Language)) {
    return res.status(400).json({
      error: `Unsupported language: ${language}`,
      supported: SUPPORTED_LANGUAGES,
    });
  }

  // ── Sanitize ────────────────────────────────────────────────────────────
  // const check = sanitizeCode(code);
  // if (!check.ok) {
  //   return res.status(422).json({
  //     error:   `Blocked pattern detected: "${check.blocked}"`,
  //     hint:    check.hint,
  //     blocked: check.blocked,
  //   });
  // }

  // ── Execute ─────────────────────────────────────────────────────────────
  try {
    const result = await runPiston(code, language as Language);
    return res.json({ ok: true, ...result });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'Execution engine returned an error';
    console.error('[execute]', message);
    return res.status(502).json({ error: message });
  }
});
