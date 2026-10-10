import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, canonical, hash, id, now, type ProjectRow } from "../src/server/store.js";
import { configureAccess, setOperator } from "../src/server/access.js";
import { engineConfig, OpenAIProvider } from "../src/server/engine/provider.js";
import { startJourney, createJourney, advanceCreationRequest } from "../src/server/almanac/journey.js";
import { saveTurnAudio, saveTurnText, readTurn } from "../src/server/almanac/service.js";
import { interviewRecovery, retryInterviewTranscription, runInterviewTranscription } from "../src/server/almanac/transcription.js";
import { resumeStudio, studioRecovery } from "../src/server/engine/recovery.js";
import { recordStudioCheckpoint, requestStudioPause, StudioPreDispatchPause } from "../src/server/engine/budget.js";
import { scopedPilotConfig } from "../src/server/pilot/integration.js";
import { makePilotPolicy, createPilotCampaign, authorizePilotCampaign, issuePilotInvitation, redeemPilotInvitation, reservePilotRequest, markPilotDispatched, settlePilotRequest, reconcilePilotRequest, setPilotCampaignState } from "../src/server/pilot/service.js";
import { REQUEST_RATE_CARD } from "../src/server/engine/request-cost.js";
import { FAMILY_CONSENT_VERSION } from "../src/shared/journey.js";

// Synthetic records and mocked provider boundaries only; no live requests.
function fixture(audio = false) {
  const previousWorker = process.env.EVERLORE_PILOT_WORKER;
  process.env.EVERLORE_PILOT_WORKER = "1";
  const dir = mkdtempSync(join(tmpdir(), "everlore-pilot-recovery-")), s = new Store(dir);
  configureAccess(s, false);
  for (const owner of ["operator", "family"])
    s.run("INSERT INTO users VALUES(?,?,?,'private',?)", owner, owner, "unused", now());
  setOperator(s, "operator");
  const base = { ...engineConfig({}), apiKey: "offline-unused", enabled: false, strictCostGuard: true, budgetCents: 0 };
  const campaign = createPilotCampaign(s, "operator", {
    key: "recovery-test", totalCents: 10000, maxHouseholds: 1,
    policy: makePilotPolicy({ version: 1, mode: "estimated_pilot", textInputTokensPerByte: 1,
      imagePromptTokensPerByte: 1, imageInputTokensPerReference: 6000, imageInputOverheadTokens: 1000, safetyMultiplier: 2 }),
  });
  authorizePilotCampaign(s, "operator", campaign.id, { authorizationReference: "Synthetic recovery authorization only", acknowledgeEstimatedCosts: true });
  const invitation = issuePilotInvitation(s, "operator", campaign.id, { key: "family", label: "Synthetic family" });
  assert(invitation.code);
  redeemPilotInvitation(s, invitation.code, "family");
  const consent = { consent: true, consentVersion: FAMILY_CONSENT_VERSION, processWithOpenAI: true, imaginativeAdaptation: true };
  const session = startJourney(s, "family", { key: "start", ...consent }, base).session.session;
  const turnId = session.turns[0].id;
  if (audio) {
    const wav = Buffer.alloc(48);
    wav.write("RIFF"); wav.writeUInt32LE(40, 4); wav.write("WAVE", 8);
    wav.write("fmt ", 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(4, 40);
    saveTurnAudio(s, "family", session.id, turnId, wav, "audio/wav", "microphone");
  } else saveTurnText(s, "family", session.id, turnId, { rawText: "Ada waited while Nell tried her three blue buttons. Synthetic fixture." });
  const created = createJourney(s, "family", session.id, { key: "book", ...consent }, base);
  assert(created.requestId);
  const config = scopedPilotConfig(base, campaign, created.requestId);
  advanceCreationRequest(s, config, { creationId: created.requestId });
  const job = s.one<{ id: string; projectId: string }>("SELECT j.id,j.projectId FROM studio_jobs j JOIN pilot_jobs p ON p.jobId=j.id WHERE p.creationId=?", created.requestId)!;
  assert(job);
  return { s, base, config, campaign, session, turnId, job,
    project: () => s.one<ProjectRow>("SELECT * FROM projects WHERE id=?", job.projectId)!,
    close() { s.close(); rmSync(dir, { recursive: true, force: true }); if (previousWorker === undefined) delete process.env.EVERLORE_PILOT_WORKER; else process.env.EVERLORE_PILOT_WORKER = previousWorker; },
  };
}

test("pilot pre-dispatch story recovery ignores legacy grants without touching them", () => {
  const t = fixture();
  try {
    t.s.run("INSERT INTO engine_budget VALUES('rosa-sentinel',7500,?)", now());
    t.s.run("UPDATE studio_jobs SET status='needs_attention',stage='heart' WHERE id=?", t.job.id);
    recordStudioCheckpoint(t.s, t.job.id, "heart", hash("input"), new StudioPreDispatchPause("Synthetic before-dispatch stop", "budget", 500));
    const recovery = studioRecovery(t.s, t.job.id)!;
    assert.equal(recovery.preDispatch, true);
    assert.equal(recovery.resumeReserveUsd, 0);
    const input = { jobId: t.job.id, callId: recovery.callId, acknowledgePossibleCharge: false };
    process.env.EVERLORE_PILOT_WORKER = "0";
    assert.throws(() => resumeStudio(t.s, t.project(), input, t.base), /pilot is paused/);
    process.env.EVERLORE_PILOT_WORKER = "1";
    setPilotCampaignState(t.s, "operator", t.campaign.id, "paused");
    assert.throws(() => resumeStudio(t.s, t.project(), input, t.base), /pilot is paused/);
    setPilotCampaignState(t.s, "operator", t.campaign.id, "active");
    assert.deepEqual(resumeStudio(t.s, t.project(), input, t.base), { id: t.job.id });
    assert.deepEqual(resumeStudio(t.s, t.project(), input, t.base), { id: t.job.id });
    assert.equal(t.s.one<{ status: string }>("SELECT status FROM studio_jobs WHERE id=?", t.job.id)!.status, "queued");
    assert.equal(t.s.one("SELECT runId FROM engine_budget WHERE runId=?", t.job.id), undefined);
    assert.equal(t.s.one<{ allowance: number }>("SELECT allowance FROM engine_budget WHERE runId='rosa-sentinel'")!.allowance, 7500);
    assert.equal(t.base.enabled, false); assert.equal(t.base.strictCostGuard, true); assert.equal(t.base.budgetCents, 0);
  } finally { t.close(); }
});

test("pilot story retry requires recorded non-processing evidence, never a possible-charge acknowledgement", () => {
  const t = fixture();
  try {
    const callId = id(), inputHash = hash("heart-input");
    reservePilotRequest(t.s, { jobId: t.job.id, attemptId: callId, stage: "heart", inputHash,
      reservation: { version: 1, costConfidence: "estimate", policyHash: t.campaign.policyHash,
        rateCardVersion: REQUEST_RATE_CARD.version, model: t.campaign.policy.models.text, kind: "text", reservationCents: 30, evidence: { measuredBytes: 100 } } });
    markPilotDispatched(t.s, callId);
    settlePilotRequest(t.s, callId, { outcome: "ambiguous", evidenceKind: "unknown_outcome", evidenceHash: hash("lost response") });
    t.s.run("INSERT INTO studio_calls VALUES(?,?,?,'text',?,?,'ambiguous_failure',NULL,NULL,NULL,30,NULL,?)", callId, t.job.id, "heart", t.campaign.policy.models.text, inputHash, now());
    t.s.run("INSERT INTO studio_steps VALUES(?,?,?,'started',NULL)", t.job.id, "heart", inputHash);
    t.s.run("UPDATE studio_jobs SET status='needs_attention',stage='heart' WHERE id=?", t.job.id);
    const originalCall = canonical(t.s.one("SELECT * FROM studio_calls WHERE id=?", callId));
    const input = { jobId: t.job.id, callId, acknowledgePossibleCharge: true };
    assert.throws(() => resumeStudio(t.s, t.project(), input, t.base), /Reconcile.*not processed/);
    assert.equal(t.s.all("SELECT * FROM studio_recoveries WHERE jobId=?", t.job.id).length, 0);
    reconcilePilotRequest(t.s, "operator", callId, { outcome: "not_processed", evidenceKind: "provider_rejection", evidenceHash: hash("synthetic provider verified no processing") });
    assert.equal(studioRecovery(t.s, t.job.id)!.uncertain, false);
    resumeStudio(t.s, t.project(), { ...input, acknowledgePossibleCharge: false }, t.base);
    assert.equal(canonical(t.s.one("SELECT * FROM studio_calls WHERE id=?", callId)), originalCall);
    assert.equal(t.s.one("SELECT * FROM studio_steps WHERE jobId=? AND stage='heart'", t.job.id), undefined);
    assert.equal(t.s.all("SELECT * FROM engine_budget").length, 0);
  } finally { t.close(); }
});

test("pilot transcription safely resumes before dispatch using its saved funding", async () => {
  const t = fixture(true);
  let calls = 0;
  const provider = new OpenAIProvider(t.config, async () => { calls++; return Response.json({ text: "A synthetic recovered memory." }); });
  try {
    requestStudioPause(t.s, t.job.id);
    await runInterviewTranscription(t.s, provider, t.config, { jobId: t.job.id });
    assert.equal(calls, 0);
    assert.equal(interviewRecovery(t.s, "operator", t.session.id, t.turnId).resumable, true);
    retryInterviewTranscription(t.s, "operator", t.session.id, t.turnId, { retry: true }, t.base);
    await runInterviewTranscription(t.s, provider, t.config, { jobId: t.job.id });
    assert.equal(calls, 1);
    assert.equal(readTurn(t.s, t.session.id, t.turnId).transcript?.rawText, "A synthetic recovered memory.");
    assert.equal(t.s.all("SELECT * FROM engine_budget").length, 0);
    assert.equal(t.base.enabled, false);
  } finally { t.close(); }
});

test("reconciled pilot transcription can retry once while retaining the uncertain original receipt", async () => {
  const t = fixture(true);
  let calls = 0;
  const provider = new OpenAIProvider(t.config, async () => {
    calls++; if (calls === 1) throw new Error("Synthetic lost response");
    return Response.json({ text: "The only accepted synthetic transcript." });
  });
  try {
    const audioBefore = canonical(readTurn(t.s, t.session.id, t.turnId).audio);
    await runInterviewTranscription(t.s, provider, t.config, { jobId: t.job.id });
    const uncertain = t.s.one<{ id: string }>("SELECT id FROM studio_calls WHERE jobId=?", t.job.id)!;
    const original = canonical(t.s.one("SELECT * FROM studio_calls WHERE id=?", uncertain.id));
    assert.throws(() => retryInterviewTranscription(t.s, "operator", t.session.id, t.turnId, { retry: true }, t.base), /uncertain/);
    assert.equal(calls, 1);
    reconcilePilotRequest(t.s, "operator", uncertain.id, { outcome: "not_processed", evidenceKind: "provider_rejection", evidenceHash: hash("synthetic provider confirmed request rejected") });
    assert.equal(interviewRecovery(t.s, "operator", t.session.id, t.turnId).resumable, true);
    retryInterviewTranscription(t.s, "operator", t.session.id, t.turnId, { retry: true }, t.base);
    await runInterviewTranscription(t.s, provider, t.config, { jobId: t.job.id });
    assert.equal(calls, 2);
    assert.equal(readTurn(t.s, t.session.id, t.turnId).transcript?.rawText, "The only accepted synthetic transcript.");
    assert.equal(canonical(readTurn(t.s, t.session.id, t.turnId).audio), audioBefore);
    assert.equal(canonical(t.s.one("SELECT * FROM studio_calls WHERE id=?", uncertain.id)), original);
    retryInterviewTranscription(t.s, "operator", t.session.id, t.turnId, { retry: true }, t.base);
    assert.equal(await runInterviewTranscription(t.s, provider, t.config, { jobId: t.job.id }), false);
    assert.equal(calls, 2);
    assert.equal(t.s.all("SELECT * FROM engine_budget").length, 0);
    assert.throws(() => resumeStudio(t.s, t.project(), { jobId: t.job.id, callId: uncertain.id, acknowledgePossibleCharge: true }, t.base), /could not be found/);
  } finally { t.close(); }
});
