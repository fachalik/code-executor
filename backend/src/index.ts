import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { executeRouter } from './routes/execute';

const app = express();

// A bare-metal Express default leaks `X-Powered-By: Express` and sets no
// CSP/X-Frame-Options/X-Content-Type-Options at all (bench/REPORT.md §3.5).
// helmet's defaults cover all of that; this app serves no HTML itself so
// there's nothing here that needs a looser CSP.
//
// One default overridden: helmet's Cross-Origin-Resource-Policy defaults to
// `same-origin`, which browsers enforce independently of CORS headers — it
// would silently break the frontend's cross-origin fetch to this backend
// (:5173 → :3001 is cross-origin even on localhost). `cors` below is already
// the intended, narrower gate on who can read these responses.
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

app.use(express.json({ limit: '128kb' }));
app.use(
  cors({
    origin: process.env.CORS_ORIGIN ?? '*',
    methods: ['GET', 'POST'],
  })
);

/**
 * Unauthenticated by default, matching how this app has always run — but one
 * client sending 30 requests back-to-back previously got 30 200s (§3.5),
 * enough to keep every engine busy (a Piston run alone spawns a real OS
 * process). This bounds that without requiring the rest of the stack to
 * change: a burst still gets through, a sustained flood gets 429s instead of
 * a saturated backend.
 *
 * 120/min (2 rps sustained) rather than matching the report's 30-request
 * probe exactly: this is an interactive code playground where a normal
 * session (or `bench/scripts/security.mjs`'s own ~27-request run) can
 * legitimately burst past 30 in a few seconds, and the goal is to stop a
 * flood, not to throttle normal use.
 */
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 120);
app.use(
  '/api',
  rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    limit: RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests — slow down and try again shortly.' },
  })
);

/**
 * Off by default — this stayed unauthenticated in the original setup and
 * flipping that on unconditionally would break the frontend's existing
 * requests with no way to configure it. Set API_AUTH_TOKEN to require every
 * `/api/*` request to carry `Authorization: Bearer <token>` (see §3.5:
 * "no auth on backend" was flagged as worth having *available*, not
 * necessarily on by default for a local dev/demo stack).
 */
const API_AUTH_TOKEN = process.env.API_AUTH_TOKEN;
if (API_AUTH_TOKEN) {
  app.use('/api', (req, res, next) => {
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (token !== API_AUTH_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });
  console.log('[backend] API_AUTH_TOKEN set — /api/* requires Authorization: Bearer <token>');
}

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/api', executeRouter);

// 404
app.use((_req, res) => res.status(404).json({ error: 'not found' }));

const PORT = Number(process.env.PORT ?? 3001);
app.listen(PORT, () => {
  console.log(`[backend] listening on :${PORT}`);
  console.log(`[backend] piston  → ${process.env.PISTON_URL ?? 'http://localhost:2000'}`);
  console.log(`[backend] judge0  → ${process.env.JUDGE0_URL ?? 'http://localhost:2358'}`);
  console.log(`[backend] quickjs → ${process.env.QUICKJS_URL ?? 'http://localhost:3002'}`);
  console.log(`[backend] isolated-vm → ${process.env.ISOLATEDVM_URL ?? 'http://localhost:3003'}`);
});
