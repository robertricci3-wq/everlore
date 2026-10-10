import type { Store } from "../store.js";
import { isRecoveryLocked } from "../recovery-lock.js";
import { OpenAIProvider, type EngineConfig, type Provider } from "../engine/provider.js";
import { advanceCreationRequest } from "../almanac/journey.js";
import { runInterviewTranscription } from "../almanac/transcription.js";
import { runStudio } from "../engine/studio.js";
import {
  eligiblePilotCreations, eligiblePilotJobs, pilotAccess,
  pilotCreationFunding, pilotJobFunding, type PilotCampaign,
} from "./service.js";

export const pilotWorkerEnabled = () => process.env.EVERLORE_PILOT_WORKER === "1";
export function pilotConnectionReady(s: Store, config: EngineConfig) {
  return pilotWorkerEnabled() && !!config.apiKey && !config.connectionError && !isRecoveryLocked(s);
}
export function pilotFamilyReadiness(s: Store, ownerId: string, config: EngineConfig) {
  const access = pilotAccess(s, ownerId);
  if (!access) return null;
  const ready = pilotConnectionReady(s, config) && access.campaign.state === "active" && access.remainingCents > 0;
  return { ready, canStart: ready && access.canStart };
}
export function scopedPilotConfig(base: EngineConfig, campaign: PilotCampaign, creationId: string): EngineConfig {
  return {
    ...base, enabled: true, strictCostGuard: false,
    pilotCampaignId: campaign.id, pilotCreationId: creationId,
    budgetCents: campaign.totalCents,
    // Legacy cycle reserves are unused in this scope. Every dispatch is reserved
    // in the separate campaign ledger against its immutable request policy.
    audioReserve: 1, textReserve: 1, imageReserve: 1,
    audioModel: campaign.policy.models.audio,
    textModel: campaign.policy.models.text,
    imageModel: campaign.policy.models.image,
  };
}

/** Only explicitly funded pilot work enters this lane. Rosa/Lab/legacy queues
 * remain governed by their existing worker switch and authorizations. */
export async function runPilotTick(
  s: Store,
  base: EngineConfig,
  providerFactory: (config: EngineConfig) => Provider = (config) => new OpenAIProvider(config),
) {
  if (!pilotConnectionReady(s, base)) return false;
  for (const creationId of eligiblePilotCreations(s)) {
    const funding = pilotCreationFunding(s, creationId);
    if (!funding) continue;
    advanceCreationRequest(s, scopedPilotConfig(base, funding.campaign, creationId), { creationId });
  }
  const jobId = eligiblePilotJobs(s)[0];
  if (!jobId) return false;
  const funding = pilotJobFunding(s, jobId);
  if (!funding) return false;
  const config = scopedPilotConfig(base, funding.campaign, funding.creationId);
  const provider = providerFactory(config);
  const job = s.one<{kind: string}>("SELECT kind FROM studio_jobs WHERE id=?", jobId);
  if (job?.kind === "interview_transcription")
    return runInterviewTranscription(s, provider, config, { jobId });
  return runStudio(s, provider, config, { jobId, shouldContinue: () => pilotWorkerEnabled() && !isRecoveryLocked(s) });
}
