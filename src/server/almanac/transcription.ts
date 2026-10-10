import { z } from "zod";
import { id, now, hash, canonical, type Store } from "../store.js";
import {
  AccessError,
  allocateGeneration,
  requireAllocationIncrease,
  requireOperator,
} from "../access.js";
import { isRecoveryLocked } from "../recovery-lock.js";
import { activeProfile, verifyProfile } from "../lab/profiles.js";
import type { Profile } from "../../shared/profile.js";
import {
  availability,
  ProviderRequestError,
  type EngineConfig,
  type Provider,
} from "../engine/provider.js";
import {
  audioRequestCost,
  type RequestCostBound,
} from "../engine/request-cost.js";
import {
  ensureStudioBudgetRecords,
  recordStudioCheckpoint,
  reservedBudget,
  studioPauseRequested,
  StudioPreDispatchPause,
} from "../engine/budget.js";
import {
  ownedSession,
  readTurn,
  writeTurn,
  makeTranscript,
  persistTranscript,
} from "./service.js";

interface Job {
  id: string;
  projectId: string;
  request: string;
  profile: string;
  status: string;
  allowance: number;
  leaseToken: string | null;
}
interface Transcription {
  jobId: string;
  turnId: string;
  sessionId: string;
  audioHash: string;
  model: string;
  consentAt: string;
}
const stage = "interview_transcription";

/** Explicit consent dispatches one bounded audio request, not a whole book. */
export function queueInterviewTranscription(
  s: Store,
  ownerId: string,
  sessionId: string,
  turnId: string,
  input: unknown,
  config: EngineConfig,
  pinnedProfile?: Profile,
) {
  z.object({ processWithOpenAI: z.literal(true) }).parse(input);
  const session = ownedSession(s, ownerId, sessionId),
    turn = readTurn(s, sessionId, turnId);
  if (isRecoveryLocked(s))
    throw new AccessError(
      409,
      "This restored shelf is waiting for recovery checks.",
    );
  if (!turn.audio) throw new AccessError(409, "Save your recording first.");
  const previous = s.one<Job>(
    "SELECT j.* FROM studio_jobs j JOIN almanac_transcriptions t ON t.jobId=j.id WHERE t.turnId=?",
    turnId,
  );
  if (
    previous?.status === "complete" ||
    ["queued", "running"].includes(previous?.status ?? "")
  )
    return { jobId: previous!.id, status: previous!.status };
  if (turn.transcript)
    throw new AccessError(409, "This answer already has a transcript.");
  if (!availability(config).ready)
    throw new AccessError(
      409,
      "Your recording is saved. Transcription is not available right now; you can add the words yourself or return later.",
    );
  if (turn.audio.mime === "audio/ogg")
    throw new AccessError(
      415,
      "This audio format needs a written transcript or a WAV, MP3, M4A or WebM recording.",
    );
  ensureStudioBudgetRecords(s);
  return s.transaction(() => {
    const profile = pinnedProfile ? verifyProfile(pinnedProfile) : activeProfile(s, config);
    const bound = audioRequestCost(
      previous
        ? s.one<Transcription>(
            "SELECT * FROM almanac_transcriptions WHERE jobId=?",
            previous.id,
          )!.model
        : profile.models.audio,
      turn.audio!.bytes,
    );
    if (previous) {
      if (
        s.one(
          "SELECT id FROM studio_calls WHERE jobId=? AND status IN ('started','ambiguous_failure','completed')",
          previous.id,
        )
      )
        throw new AccessError(
          409,
          "This transcription may already have been processed. Your recording is safe; its saved request needs reconciliation before another paid attempt.",
        );
      if (
        s.one(
          "SELECT id FROM studio_jobs WHERE projectId=? AND id!=? AND status NOT IN ('complete','superseded')",
          session.projectId,
          previous.id,
        )
      )
        throw new AccessError(
          409,
          "Another answer is being transcribed. Please let it finish first.",
        );
      const held =
        s.one<{ allowance: number }>(
          "SELECT allowance FROM engine_budget WHERE runId=?",
          previous.id,
        )?.allowance ?? 0;
      if (reservedBudget(s) - held + bound.maxCostCents > config.budgetCents)
        throw new AccessError(
          409,
          "Your recording is saved. The available transcription allowance is currently used.",
        );
      requireAllocationIncrease(
        s,
        previous.id,
        Math.max(0, bound.maxCostCents - held),
        config,
      );
      // Keep existing invitation allocation and all rejected call evidence. No new book grant.
      s.run(
        "UPDATE engine_budget SET allowance=? WHERE runId=?",
        bound.maxCostCents,
        previous.id,
      );
      s.run(
        "UPDATE studio_jobs SET status='queued',error=NULL,leaseToken=NULL,leaseUntil=0 WHERE id=?",
        previous.id,
      );
      s.run(
        "UPDATE studio_checkpoints SET resumedAt=? WHERE jobId=? AND resumedAt IS NULL",
        now(),
        previous.id,
      );
      s.run("DELETE FROM studio_pause_requests WHERE jobId=?", previous.id);
      turn.status = "transcribing";
      writeTurn(s, turn);
      return { jobId: previous.id, status: "queued" };
    }
    if (
      s.one(
        "SELECT id FROM studio_jobs WHERE projectId=? AND status NOT IN ('complete','superseded')",
        session.projectId,
      )
    )
      throw new AccessError(
        409,
        "Another answer is being transcribed. Please let it finish first.",
      );
    if (reservedBudget(s) + bound.maxCostCents > config.budgetCents)
      throw new AccessError(
        409,
        "Your recording is saved. The available transcription allowance is currently used.",
      );
    const jobId = id(),
      at = now();
    allocateGeneration(s, ownerId, jobId, bound.maxCostCents, config, false);
    const request = {
      version: 1,
      sessionId,
      turnId,
      models: profile.models,
      strictCostGuard: true,
      audioHash: turn.audio!.sha256,
    };
    s.run(
      "INSERT INTO studio_jobs(id,projectId,baseRevision,kind,status,stage,request,state,profile,allowance,createdAt) VALUES(?,?,0,'interview_transcription','queued',?,?,'{}',?,?,?)",
      jobId,
      session.projectId,
      stage,
      canonical(request),
      profile.hash,
      bound.maxCostCents,
      at,
    );
    s.run(
      "INSERT INTO engine_budget VALUES(?,?,?)",
      jobId,
      bound.maxCostCents,
      at,
    );
    s.run(
      "INSERT INTO almanac_transcriptions VALUES(?,?,?,?,?,?)",
      jobId,
      turnId,
      sessionId,
      turn.audio!.sha256,
      profile.models.audio,
      at,
    );
    s.run(
      "UPDATE almanac_sessions SET aiConsentAt=?,updatedAt=? WHERE id=?",
      at,
      at,
      sessionId,
    );
    turn.status = "transcribing";
    writeTurn(s, turn);
    return { jobId, status: "queued" };
  });
}

/** Shares the normal worker's provider, grant ledger and call receipts. */
export async function runInterviewTranscription(
  s: Store,
  provider: Provider,
  config: EngineConfig,
) {
  if (isRecoveryLocked(s) || !availability(config).ready) return false;
  ensureStudioBudgetRecords(s);
  const token = id();
  const job = s.transaction(() => {
    const row = s.one<Job>(
      "SELECT * FROM studio_jobs WHERE kind='interview_transcription' AND (status='queued' OR (status='running' AND leaseUntil<?)) ORDER BY rowid LIMIT 1",
      Date.now(),
    );
    if (row)
      s.run(
        "UPDATE studio_jobs SET status='running',leaseToken=?,leaseUntil=? WHERE id=?",
        token,
        Date.now() + 240000,
        row.id,
      );
    return row;
  });
  if (!job) return false;
  const source = s.one<Transcription>(
    "SELECT * FROM almanac_transcriptions WHERE jobId=?",
    job.id,
  )!;
  const owns = () =>
    !!s.one(
      "SELECT id FROM studio_jobs WHERE id=? AND leaseToken=? AND status='running' AND leaseUntil>?",
      job.id,
      token,
      Date.now(),
    );
  const heartbeat = setInterval(
    () =>
      s.run(
        "UPDATE studio_jobs SET leaseUntil=? WHERE id=? AND leaseToken=? AND status='running'",
        Date.now() + 240000,
        job.id,
        token,
      ),
    15000,
  );
  const request = JSON.parse(job.request) as {
    models: { text: string; image: string; audio: string };
  };
  provider = provider.withModels?.(request.models) ?? provider;
  let callId: string | null = null,
    outcome = "ambiguous_failure",
    startedAt = Date.now();
  const inputHash = hash(
    canonical({
      audioHash: source.audioHash,
      model: source.model,
      profile: job.profile,
    }),
  );
  const pause = (message: string) => {
    if (!owns()) return;
    const turn = readTurn(s, source.sessionId, source.turnId);
    if (!turn.transcript) {
      turn.status = "needs_attention";
      writeTurn(s, turn);
    }
    s.run(
      "UPDATE studio_jobs SET status='needs_attention',error=?,leaseToken=NULL,leaseUntil=0 WHERE id=? AND leaseToken=?",
      message,
      job.id,
      token,
    );
  };
  try {
    if (
      s.one(
        "SELECT id FROM studio_calls WHERE jobId=? AND status IN ('started','ambiguous_failure','completed')",
        job.id,
      )
    ) {
      pause(
        "A saved transcription request may have completed. It will not be sent again automatically.",
      );
      return true;
    }
    const turn = readTurn(s, source.sessionId, source.turnId);
    if (
      !turn.audio ||
      turn.audio.sha256 !== source.audioHash ||
      turn.transcript
    )
      throw new StudioPreDispatchPause(
        "This answer changed after transcription was queued. Its saved source needs review.",
      );
    if (studioPauseRequested(s, job.id))
      throw new StudioPreDispatchPause(
        "Transcription paused before sending your recording.",
        "pause",
      );
    if (!provider.withRequestGuard)
      throw new StudioPreDispatchPause(
        "This provider cannot verify transcription costs. No recording was sent.",
      );
    const expected = audioRequestCost(source.model, turn.audio.bytes);
    provider = provider.withRequestGuard((bound: RequestCostBound) => {
      if (callId || !owns() || isRecoveryLocked(s))
        throw new StudioPreDispatchPause(
          "This saved request is no longer ready to send.",
        );
      if (studioPauseRequested(s, job.id))
        throw new StudioPreDispatchPause(
          "Transcription paused before sending your recording.",
          "pause",
        );
      if (
        canonical(bound) !== canonical(expected) ||
        bound.maxCostCents > job.allowance
      )
        throw new StudioPreDispatchPause(
          "The transcription cost rule changed. No recording was sent.",
        );
      s.transaction(() => {
        if (reservedBudget(s) > config.budgetCents)
          throw new StudioPreDispatchPause(
            "The transcription allowance is not available. No recording was sent.",
            "budget",
            bound.maxCostCents,
          );
        callId = id();
        startedAt = Date.now();
        s.run(
          "INSERT INTO studio_calls VALUES(?,?,?,?,?,?,'started',NULL,NULL,NULL,?,NULL,?)",
          callId,
          job.id,
          stage,
          "audio",
          source.model,
          inputHash,
          bound.maxCostCents,
          now(),
        );
        s.run(
          "INSERT INTO studio_request_bounds VALUES(?,?)",
          callId,
          canonical(bound),
        );
      });
    });
    const text = await provider.transcribe(
      s.readAsset(job.projectId, source.audioHash),
      turn.audio.mime,
    );
    if (!callId)
      throw new StudioPreDispatchPause(
        "The provider returned without reserving its transcription request.",
      );
    if (!owns()) return true;
    const current = readTurn(s, source.sessionId, source.turnId);
    if (current.audio?.sha256 !== source.audioHash || current.transcript)
      throw new Error("Stale transcription result");
    const transcript = makeTranscript(text, "live", current.audio.recordingId);
    s.transaction(() => {
      persistTranscript(s, current, transcript);
      s.run(
        "INSERT OR REPLACE INTO studio_steps VALUES(?,?,?,'completed',?)",
        job.id,
        stage,
        inputHash,
        canonical(transcript),
      );
      s.run(
        "UPDATE studio_jobs SET status='complete',state=?,error=NULL,leaseToken=NULL,leaseUntil=0 WHERE id=? AND leaseToken=?",
        canonical({ transcriptHash: hash(canonical(transcript)) }),
        job.id,
        token,
      );
      s.run("UPDATE studio_calls SET status='completed' WHERE id=?", callId!);
    });
    outcome = "completed";
  } catch (error) {
    if (!callId) {
      const stopped =
        error instanceof StudioPreDispatchPause
          ? error
          : new StudioPreDispatchPause(
              "Transcription stopped before sending your recording. Your saved answer is safe.",
            );
      recordStudioCheckpoint(s, job.id, stage, inputHash, stopped);
      pause(stopped.message);
    } else {
      if (error instanceof ProviderRequestError) {
        outcome = error.failure.retrySafe ? "rejected" : "ambiguous_failure";
        s.run(
          "INSERT OR REPLACE INTO studio_call_failures VALUES(?,?)",
          callId,
          canonical(error.failure),
        );
      }
      pause(
        outcome === "rejected"
          ? "The provider did not accept this transcription. Your recording is saved; you can retry after the connection is fixed."
          : "The transcription outcome needs checking before another paid attempt. Your recording is saved.",
      );
    }
  } finally {
    clearInterval(heartbeat);
    if (callId) {
      const receipt = provider.takeReceipt?.();
      s.run(
        "UPDATE studio_calls SET status=?,latencyMs=?,requestId=?,usage=? WHERE id=?",
        outcome,
        Date.now() - startedAt,
        receipt?.requestId ?? null,
        receipt?.usage ? canonical(receipt.usage) : null,
        callId,
      );
      if (receipt?.meteredCost)
        s.run(
          "INSERT OR IGNORE INTO studio_metered_costs VALUES(?,?)",
          callId,
          canonical(receipt.meteredCost),
        );
    }
    // Retain completed and uncertain request estimates; release only definite rejection.
    s.run(
      "UPDATE engine_budget SET allowance=(SELECT COALESCE(SUM(estimatedCents),0) FROM studio_calls WHERE jobId=? AND status!='rejected') WHERE runId=? AND EXISTS(SELECT 1 FROM studio_jobs WHERE id=? AND status IN ('complete','needs_attention'))",
      job.id,
      job.id,
      job.id,
    );
  }
  return true;
}

export function interviewRecovery(
  s: Store,
  actorId: string,
  sessionId: string,
  turnId: string,
) {
  requireOperator(s, actorId);
  const session = s.one<{ ownerId: string }>(
    "SELECT ownerId FROM almanac_sessions WHERE id=?",
    sessionId,
  );
  if (!session) throw new AccessError(404, "That interview is unavailable.");
  const turn = readTurn(s, sessionId, turnId);
  const job = s.one<Job>(
    "SELECT j.* FROM studio_jobs j JOIN almanac_transcriptions t ON t.jobId=j.id WHERE t.turnId=? AND t.sessionId=?",
    turnId,
    sessionId,
  );
  if (!job)
    throw new AccessError(404, "This answer has no transcription request.");
  const calls = s.all<{
    id: string;
    status: string;
    requestId: string | null;
    estimatedCents: number;
    actualCents: number | null;
    createdAt: string;
  }>(
    "SELECT id,status,requestId,estimatedCents,actualCents,createdAt FROM studio_calls WHERE jobId=? ORDER BY rowid",
    job.id,
  );
  const uncertain = calls.some((call) =>
    ["started", "ambiguous_failure"].includes(call.status),
  );
  const resumable =
    !turn.transcript &&
    job.status === "needs_attention" &&
    !uncertain &&
    !calls.some((call) => call.status === "completed");
  return {
    sessionId,
    turnId,
    jobId: job.id,
    status: job.status,
    calls,
    resumable,
    uncertain,
    message: uncertain
      ? "A provider outcome is uncertain. Reconcile the listed request with the provider before any paid retry; no retry is enabled here."
      : resumable
        ? "No unresolved paid request remains. An explicit retry can resume this saved answer."
        : "This answer does not need a retry.",
  };
}
export function retryInterviewTranscription(
  s: Store,
  actorId: string,
  sessionId: string,
  turnId: string,
  input: unknown,
  config: EngineConfig,
) {
  z.object({ retry: z.literal(true) }).parse(input);
  const recovery = interviewRecovery(s, actorId, sessionId, turnId);
  if (["queued", "running", "complete"].includes(recovery.status))
    return { jobId: recovery.jobId, status: recovery.status };
  if (!recovery.resumable) throw new AccessError(409, recovery.message);
  const session = s.one<{ ownerId: string; aiConsentAt: string | null }>(
    "SELECT ownerId,aiConsentAt FROM almanac_sessions WHERE id=?",
    sessionId,
  )!;
  if (!session.aiConsentAt)
    throw new AccessError(
      409,
      "This family has not consented to AI transcription.",
    );
  const result = queueInterviewTranscription(
    s,
    session.ownerId,
    sessionId,
    turnId,
    { processWithOpenAI: true },
    config,
  );
  s.run(
    "INSERT INTO almanac_recovery_actions VALUES(?,?,?,?,?)",
    id(),
    result.jobId,
    actorId,
    "retry_saved_transcription",
    now(),
  );
  return result;
}
