import {
  isHosted,
  operatorId,
  requireOperator,
  generationAccess,
  committedFunding,
} from "../access.js";
import { reservedBudget } from "./budget.js";
import {
  readFileSync,
  existsSync,
  writeFileSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { hash, canonical, now, type Store } from "../store.js";
import {
  availability,
  checkProviderConnection,
  ProviderRequestError,
  type EngineConfig,
} from "./provider.js";
import {
  providerFailureMessage,
  type ProviderFailure,
} from "../../shared/providerFailure.js";
import { EngineError } from "./pipeline.js";
import {
  studioReservation,
  StudioSettingsInput,
  studioSettingsIssue,
  usdCents,
  type StudioSetupView,
} from "../../shared/studioSetup.js";
const Settings = z.object({
  ownerId: z.string(),
  apiKey: z.string().min(20).max(500),
  budgetCents: z.number().int().positive(),
  audioReserve: z.number().int().positive(),
  textReserve: z.number().int().positive(),
  imageReserve: z.number().int().positive(),
});
const location = (store: Store) => join(store.dir, "studio-connection.json");
function saved(store: Store) {
  return existsSync(location(store))
    ? Settings.parse(JSON.parse(readFileSync(location(store), "utf8")))
    : null;
}
export function loadStudioConnection(store: Store, config: EngineConfig) {
  const settings = saved(store);
  if (settings) Object.assign(config, { ...settings, enabled: true });
  applyConnectionCheck(store, config);
}
function applyConnectionCheck(store: Store, config: EngineConfig) {
  const check = store.one<{ failure: string | null }>(
    "SELECT failure FROM studio_connection_checks WHERE keyHash=?",
    hash(config.apiKey),
  );
  config.connectionError = check?.failure
    ? providerFailureMessage(JSON.parse(check.failure) as ProviderFailure)
    : undefined;
}
async function verifyKey(
  store: Store,
  config: EngineConfig,
  key: string,
  request: typeof fetch,
) {
  let failure: ProviderFailure | null = null;
  try {
    await checkProviderConnection(key, config.textModel, request);
  } catch (error) {
    if (!(error instanceof ProviderRequestError)) throw error;
    failure = error.failure;
  }
  store.run(
    "INSERT OR REPLACE INTO studio_connection_checks VALUES(?,?,?)",
    hash(key),
    failure ? JSON.stringify(failure) : null,
    now(),
  );
  if (config.apiKey === key) applyConnectionCheck(store, config);
  if (failure) throw new EngineError(providerFailureMessage(failure));
}
export async function checkSavedStudioConnection(
  store: Store,
  ownerId: string,
  config: EngineConfig,
  request: typeof fetch = fetch,
) {
  if (isHosted(store)) requireOperator(store, ownerId);
  if (!config.apiKey) throw new EngineError("Save an API key first.");
  try {
    await verifyKey(store, config, config.apiKey, request);
  } catch (error) {
    if (!(error instanceof EngineError)) throw error;
  }
  return setupView(store, ownerId, config);
}
export async function saveVerifiedStudioConnection(
  store: Store,
  ownerId: string,
  input: unknown,
  config: EngineConfig,
  request: typeof fetch = fetch,
) {
  const settings = prepareStudioConnection(store, ownerId, input, config);
  const previousHash = hash(canonical(saved(store)));
  await verifyKey(store, config, settings.apiKey, request);
  if (hash(canonical(saved(store))) !== previousHash)
    throw new EngineError(
      "The connection changed during verification. Reload its settings before saving.",
    );
  // Recheck ownership, active jobs and funds after the read-only network check.
  return saveStudioConnection(store, ownerId, input, config);
}
export function setupView(
  store: Store,
  ownerId: string,
  config: EngineConfig,
): StudioSetupView {
  applyConnectionCheck(store, config);
  const settings = saved(store),
    canManage = isHosted(store)
      ? operatorId(store) === ownerId
      : !settings || settings.ownerId === ownerId,
    connection = availability(config),
    cycle = studioReservation(config),
    used = reservedBudget(store),
    access = generationAccess(store, ownerId, config),
    canStart =
      connection.ready && config.budgetCents >= used + cycle && access.canStart;
  if (isHosted(store) && !canManage)
    return {
      ready: connection.ready,
      canStart,
      canManage: false,
      hasKey: false,
      budgetUsd: 0,
      audioReserveUsd: 0,
      textReserveUsd: 0,
      imageReserveUsd: 0,
      cycleReserveUsd: 0,
      usedReserveUsd: 0,
      message: connection.ready
        ? access.message
        : "Story creation is temporarily unavailable. Your saved memories are safe; please contact Everlore for help.",
    };
  return {
    ready: connection.ready,
    canStart,
    canManage,
    hasKey: !!config.apiKey,
    budgetUsd: config.budgetCents / 100,
    audioReserveUsd: config.audioReserve / 100,
    textReserveUsd: config.textReserve / 100,
    imageReserveUsd: config.imageReserve / 100,
    cycleReserveUsd: cycle / 100,
    usedReserveUsd: used / 100,
    message:
      connection.ready && !canStart
        ? `Your connection is saved. A new book needs $${(cycle / 100).toFixed(2)} available in the allowance. The total allowance would need to be at least $${((used + cycle) / 100).toFixed(2)} ($${(used / 100).toFixed(2)} already reserved). ${canManage ? "You can change the allowance below." : "The shelf that configured this connection manages the allowance."}`
        : connection.message,
  };
}
export function saveStudioConnection(
  store: Store,
  ownerId: string,
  input: unknown,
  config: EngineConfig,
) {
  const settings = prepareStudioConnection(store, ownerId, input, config);
  const temp = location(store) + ".tmp";
  writeFileSync(temp, JSON.stringify(settings), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, location(store));
  Object.assign(config, settings, { enabled: true });
  applyConnectionCheck(store, config);
  return setupView(store, ownerId, config);
}
function prepareStudioConnection(
  store: Store,
  ownerId: string,
  input: unknown,
  config: EngineConfig,
) {
  if (isHosted(store)) requireOperator(store, ownerId);
  const previous = saved(store);
  if (!isHosted(store) && previous && previous.ownerId !== ownerId)
    throw new EngineError(
      "Only the shelf that configured this connection can change it.",
    );
  if (
    store.one(
      "SELECT id FROM studio_jobs WHERE status='running' OR status='queued'",
    ) ||
    store.one(
      "SELECT id FROM engine_runs WHERE status='running' OR status='queued'",
    )
  )
    throw new EngineError(
      "Wait for the current generation to reach a review checkpoint before changing the connection.",
    );
  const used = isHosted(store)
    ? committedFunding(store)
    : reservedBudget(store);
  const issue = studioSettingsIssue(
    input,
    !!(previous?.apiKey || config.apiKey),
    used,
  );
  if (issue) throw new EngineError(issue);
  const body = StudioSettingsInput.parse(input);
  return Settings.parse({
    ownerId,
    apiKey: body.apiKey || previous?.apiKey || config.apiKey,
    budgetCents: usdCents(body.budgetUsd),
    audioReserve: usdCents(body.audioReserveUsd),
    textReserve: usdCents(body.textReserveUsd),
    imageReserve: usdCents(body.imageReserveUsd),
  });
}
