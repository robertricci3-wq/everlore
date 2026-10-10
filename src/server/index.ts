import { runPilotTick } from "./pilot/integration.js";
import { fulfillOne, pollShippingOne } from "./commerce/service.js";
import { startWorkerLanes } from "./worker-lanes.js";
import { isRecoveryLocked } from "./recovery-lock.js";
import { commerceConfig } from "./commerce/config.js";
import { publicOrigin } from "./hosting.js";
import express from "express";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { Store } from "./store.js";
import { runOneJob } from "./pipeline.js";
import { z } from "zod";
import {
  engineConfig,
  OpenAIProvider,
  availability,
} from "./engine/provider.js";
import { runEngine } from "./engine/pipeline.js";
import { runStudio } from "./engine/studio.js";
import { loadStudioConnection } from "./engine/setup.js";
import { runInterviewTranscription } from "./almanac/transcription.js";
import { advanceCreationRequest } from "./almanac/journey.js";

const config = z
  .object({
    PORT: z.coerce.number().int().min(1024).max(65535).default(4317),
    DATA_DIR: z.string().default(".data"),
  })
  .parse(process.env);
const store = new Store(config.DATA_DIR);
const studioConfig = engineConfig();
loadStudioConnection(store, studioConfig);
const app = createApp(store, studioConfig),
  server = createServer(app),
  provider = new OpenAIProvider(studioConfig);
let vite:
  Awaited<ReturnType<(typeof import("vite"))["createServer"]>> | undefined;
if (process.env.NODE_ENV === "production") {
  app.use(express.static(resolve("dist"), { index: false }));
  app.get("/{*path}", (_req, res) => res.sendFile(resolve("dist/index.html")));
} else {
  const { createServer: createVite } = await import("vite");
  vite = await createVite({
    server: { middlewareMode: true, hmr: { server } },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
const workers = startWorkerLanes([
  { name: "creative", run: async () => {
    if (process.env.DISABLE_WORKER === "1") return;
    loadStudioConnection(store, studioConfig);
    advanceCreationRequest(store, studioConfig);
    if (!(await runOneJob(store)) && !(await runEngine(store, provider, studioConfig)) && !(await runInterviewTranscription(store, provider, studioConfig)))
      await runStudio(store, provider, studioConfig);
  } },
  { name: "pilot", run: async () => { loadStudioConnection(store, studioConfig); return runPilotTick(store, studioConfig); } },
  { name: "fulfillment", run: () => process.env.DISABLE_WORKER === "1" ? Promise.resolve(false) : fulfillOne(store, commerceConfig(store.dir)) },
  { name: "shipping", run: () => process.env.DISABLE_WORKER === "1" ? Promise.resolve(false) : pollShippingOne(store, commerceConfig(store.dir)) },
], { disabled: () => isRecoveryLocked(store), onError: name => console.error(`worker_${name}_failed`) });
app.locals.workerHealth = workers.status;
server.listen(config.PORT, publicOrigin() ? "0.0.0.0" : "127.0.0.1", () =>
  console.log(
    `Everlore is open at ${publicOrigin() ?? `http://127.0.0.1:${config.PORT}`} (story studio ${availability(studioConfig).ready ? "enabled" : "disabled"})`,
  ),
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  app.locals.draining = true;
  const connectionsClosed = new Promise<void>(resolve => server.close(() => resolve()));
  const drained = workers.stop();
  await vite?.close();
  await Promise.all([connectionsClosed, drained]);
  store.close();
  process.exitCode = 0;
}
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
