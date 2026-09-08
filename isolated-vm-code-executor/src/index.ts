import cors from "cors";
import express from "express";
import { config } from "./config";
import { runIsolatedVm } from "./engine/isolatedvm";
import { queueStats } from "./queue";
import { executeRouter } from "./routes/execute";

const app = express();

app.use(express.json({ limit: "128kb" }));
app.use(
  cors({
    origin: config.corsOrigin,
    methods: ["GET", "POST"],
  }),
);

app.get("/health", (_req, res) =>
  res.json({ ok: true, engine: "isolated-vm", ...queueStats() }),
);
app.use("/api", executeRouter);

app.use((_req, res) => res.status(404).json({ error: "not found" }));

/**
 * Build and tear down one isolate before taking traffic. `isolated-vm` is a
 * native addon, so this is where a bad build or a missing `--no-node-snapshot`
 * shows up — as a startup failure with a readable message, rather than as a
 * crash on somebody's first request.
 */
async function warmUp(): Promise<void> {
  const started = Date.now();
  const result = await runIsolatedVm("export default 1 + 1", {
    language: "javascript",
    timeoutMs: 5_000,
    memoryLimitBytes: config.defaultMemoryBytes,
    env: {},
  });
  if (result.meta.status !== "success") {
    throw new Error(`warm-up failed: ${result.error?.message ?? "unknown"}`);
  }
  console.log(`[isolated-vm] warm-up ok in ${Date.now() - started} ms`);
}

warmUp()
  .then(() => {
    app.listen(config.port, () => {
      console.log(`[isolated-vm-executor] listening on :${config.port}`);
      console.log(
        `[isolated-vm-executor] timeout ${config.defaultTimeoutMs} ms (max ${config.maxTimeoutMs}) · ` +
          `memory ${Math.round(config.defaultMemoryBytes / 1024 / 1024)} MB (max ${Math.round(config.maxMemoryBytes / 1024 / 1024)} MB) · ` +
          `concurrency ${config.maxConcurrent}`,
      );
      console.log("[isolated-vm-executor] network: OFF · filesystem: OFF · node api: OFF");
    });
  })
  .catch((err: unknown) => {
    console.error("[isolated-vm-executor] failed to start:", err);
    process.exit(1);
  });
