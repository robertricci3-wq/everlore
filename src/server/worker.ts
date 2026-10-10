import { runPilotTick } from "./pilot/integration.js";
import { Store } from "./store.js";
import { runOneJob } from "./pipeline.js";
import { engineConfig, OpenAIProvider } from "./engine/provider.js";
import { runEngine } from "./engine/pipeline.js";
import { runStudio } from "./engine/studio.js";
import { loadStudioConnection } from "./engine/setup.js";
import { runInterviewTranscription } from "./almanac/transcription.js";
import { advanceCreationRequest } from "./almanac/journey.js";
import { startWorkerLanes } from "./worker-lanes.js";
import { isRecoveryLocked } from "./recovery-lock.js";
import { fulfillOne, pollShippingOne } from "./commerce/service.js";
import { commerceConfig } from "./commerce/config.js";
import { migrateCommerce, recoverInterruptedCommerce } from "./commerce/schema.js";
const store = new Store(process.env.DATA_DIR ?? ".data");
const config = engineConfig(),
  provider = new OpenAIProvider(config);
migrateCommerce(store);
recoverInterruptedCommerce(store);
const workers = startWorkerLanes([
  { name: "creative", run: async () => {
    if (process.env.DISABLE_WORKER === "1") return;
    loadStudioConnection(store, config);
    advanceCreationRequest(store, config);
    if (!(await runOneJob(store)) && !(await runEngine(store, provider, config)) && !(await runInterviewTranscription(store, provider, config)))
      await runStudio(store, provider, config);
  } },
  { name: "pilot", run: async () => { loadStudioConnection(store, config); return runPilotTick(store, config); } },
  { name: "fulfillment", run: () => process.env.DISABLE_WORKER === "1" ? Promise.resolve(false) : fulfillOne(store, commerceConfig(store.dir)) },
  { name: "shipping", run: () => process.env.DISABLE_WORKER === "1" ? Promise.resolve(false) : pollShippingOne(store, commerceConfig(store.dir)) },
], { disabled: () => isRecoveryLocked(store), onError: name => console.error(`worker_${name}_failed`) });
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await workers.stop();
  store.close();
};
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
