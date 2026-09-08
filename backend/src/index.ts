import express from 'express';
import cors from 'cors';
import { executeRouter } from './routes/execute';

const app = express();

app.use(express.json({ limit: '128kb' }));
app.use(
  cors({
    origin: process.env.CORS_ORIGIN ?? '*',
    methods: ['GET', 'POST'],
  })
);

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/api', executeRouter);

// 404
app.use((_req, res) => res.status(404).json({ error: 'not found' }));

const PORT = Number(process.env.PORT ?? 3001);
app.listen(PORT, () => {
  console.log(`[backend] listening on :${PORT}`);
  console.log(`[backend] piston  → ${process.env.PISTON_URL ?? 'http://localhost:2000'}`);
});
