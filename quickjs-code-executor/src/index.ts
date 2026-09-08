import cors from "cors";
import express from "express";
import { config } from "./config";
import { runQuickJs } from "./engine/quickjs";
import { queueStats } from "./queue";
import { executeRouter } from "./routes/execute";

const app = express();

app.use(express.json({ limit: "128kb" }));
app.use(
  cors({
    origin: config.corsOrigin,
    methods: ["GET", "POST"],
  })
);

app.get("/health", (_req, res) =>
  res.json({ ok: true, engine: "quickjs", ...queueStats() })
);
app.use("/api", executeRouter);

app.use((_req, res) => res.status(404).json({ error: "not found" }));

/**
 * Compile the WebAssembly module before taking traffic. Emscripten caches the
 * compiled module in-process, so this moves the one-off cost off the first
 * real request.
 */
async function warmUp(): Promise<void> {
  const started = Date.now();
  const result = await runQuickJs("export default 1 + 1", {
    language: "javascript",
    timeoutMs: 5_000,
    memoryLimitBytes: config.defaultMemoryBytes,
    env: {},
  });
  if (result.meta.status !== "success") {
    throw new Error(`warm-up failed: ${result.error?.message ?? "unknown"}`);
  }
  console.log(`[quickjs] warm-up ok in ${Date.now() - started} ms`);
}

warmUp()
  .then(() => {
    app.listen(config.port, () => {
      console.log(`[quickjs-executor] listening on :${config.port}`);
      console.log(
        `[quickjs-executor] timeout ${config.defaultTimeoutMs} ms (max ${config.maxTimeoutMs}) · ` +
          `memory ${Math.round(config.defaultMemoryBytes / 1024 / 1024)} MB (max ${Math.round(config.maxMemoryBytes / 1024 / 1024)} MB) · ` +
          `concurrency ${config.maxConcurrent}`
      );
      console.log("[quickjs-executor] network: OFF · filesystem: OFF");
    });
  })
  .catch((err: unknown) => {
    console.error("[quickjs-executor] failed to start:", err);
    process.exit(1);
  });
