import { worldProblems } from "./scene-validation.js";
import { requireAllocationIncrease } from "../access.js";
import { HeartContract, StoryManuscript, VisualWorld, ScenePlan } from "../../shared/studio.js";
import { Transcript } from "../../shared/contracts.js";
import {
  heartProblems,
  reconcileHeartCues,
  evaluateStory,
  canAssembleReviewCopy,
} from "./editorial.js";
import { reservedBudget, pendingStudioCheckpoint } from "./budget.js";
import { z } from "zod";
import { id, now, type Store, type ProjectRow } from "../store.js";
import { EngineError } from "./pipeline.js";
import { availability, type EngineConfig } from "./provider.js";
import { pilotAccess, pilotJobFunding } from "../pilot/service.js";
import { pilotConnectionReady } from "../pilot/integration.js";
import {
  providerFailureMessage,
  type ProviderFailure,
} from "../../shared/providerFailure.js";

export function studioRecovery(store: Store, jobId: string) {
  const job = store.one<{ status: string; stage: string; allowance: number }>(
    "SELECT status,stage,allowance FROM studio_jobs WHERE id=?",
    jobId,
  );
  if (!job || !["needs_attention", "needs_editor"].includes(job.status))
    return null;
  const pilot = pilotJobFunding(store, jobId);
  const checkpoint = pendingStudioCheckpoint(store, jobId, job.stage);
  if (checkpoint) {
    const pending = store.one<{ state: string; inputHash: string }>(
      "SELECT state,inputHash FROM studio_steps WHERE jobId=? AND stage=?",
      jobId,
      job.stage,
    );
    // A pause marker can never make an un-reconciled paid attempt retryable.
    const unsafe = store.one(
      `SELECT c.id FROM studio_calls c WHERE c.jobId=? AND c.stage=? AND c.status!='rejected' AND ${pilot
        ? "NOT EXISTS(SELECT 1 FROM pilot_attempts a WHERE a.id=c.id AND a.jobId=c.jobId AND a.status='not_processed')"
        : "NOT EXISTS(SELECT 1 FROM studio_recoveries r WHERE r.callId=c.id)"} LIMIT 1`,
      jobId,
      job.stage,
    );
    if (
      !unsafe &&
      pending?.state !== "completed" &&
      (!pending || pending.inputHash === checkpoint.inputHash)
    ) {
      if (!pilot) reservedBudget(store);
      const held =
        store.one<{ allowance: number }>(
          "SELECT allowance FROM engine_budget WHERE runId=?",
          jobId,
        )?.allowance ?? 0;
      const ceiling = Math.max(
        job.allowance,
        held + (checkpoint.requiredCents ?? 0),
      );
      return {
        preDispatch: true,
        localRepair: false,
        callId: checkpoint.id,
        stage: checkpoint.stage,
        requestId: null,
        uncertain: false,
        extraReserveUsd: pilot ? 0 : Math.max(0, ceiling - job.allowance) / 100,
        resumeReserveUsd: pilot ? 0 : Math.max(0, ceiling - held) / 100,
        message: checkpoint.message,
      };
    }
  }
  const attempt = store.one<{
    id: string;
    stage: string;
    status: string;
    requestId: string | null;
    estimatedCents: number;
    details: string | null;
  }>(
    "SELECT c.id,c.stage,c.status,c.requestId,c.estimatedCents,f.details FROM studio_calls c LEFT JOIN studio_call_failures f ON f.callId=c.id WHERE c.jobId=? AND c.stage=? ORDER BY c.rowid DESC LIMIT 1",
    jobId,
    job.stage === "heart_cue_evidence_v1" ? "heart" : job.stage,
  );
  if (!attempt) return null;
  let metadataRepair = false;
  if (
    ["needs_editor", "needs_attention"].includes(job.status) &&
    ["heart", "heart_cue_evidence_v1"].includes(job.stage) &&
    attempt.status === "completed"
  ) {
    const saved = store.one<{ state: string }>(
      "SELECT state FROM studio_jobs WHERE id=?",
      jobId,
    );
    const cached = store.one<{ result: string }>(
      "SELECT result FROM studio_steps WHERE jobId=? AND stage='heart' AND state='completed'",
      jobId,
    );
    try {
      const source = Transcript.parse(JSON.parse(saved!.state).source);
      const heart = HeartContract.parse(JSON.parse(cached!.result));
      const repaired = reconcileHeartCues(heart, source);
      metadataRepair =
        repaired.correctedIds.length > 0 &&
        !heartProblems(repaired.heart, source).length;
    } catch {
      return null;
    }
  }
  let evidenceRepair = false;
  if (job.status === "needs_editor" && attempt.status === "completed") {
    const cached = store.one<{ result: string }>(
      "SELECT result FROM studio_steps WHERE jobId=? AND stage='accepted_story' AND state='completed'",
      jobId,
    );
    if (cached) {
      try {
        const candidate = JSON.parse(cached.result);
        evidenceRepair =
          !candidate.reviewProtocol &&
          candidate.verdict?.passed === false &&
          StoryManuscript.safeParse(candidate.manuscript).success &&
          !store.one(
            "SELECT stage FROM studio_steps WHERE jobId=? AND stage='accepted_story_evidence_v1'",
            jobId,
          );
      } catch {
        evidenceRepair = false;
      }
    }
  }
  const submitted = store.one<{ result: string }>(
    "SELECT result FROM studio_steps WHERE jobId=? AND stage='editorial_attention_submission_v1' AND state='completed'",
    jobId,
  );
  let editorialRepair = false;
  if (
    job.status === "needs_editor" &&
    submitted &&
    !store.one(
      "SELECT stage FROM studio_steps WHERE jobId=? AND stage='accepted_story_editorial_attention_v1'",
      jobId,
    )
  ) {
    try {
      editorialRepair = StoryManuscript.safeParse(
        JSON.parse(submitted.result).manuscript,
      ).success;
    } catch {
      editorialRepair = false;
    }
  }
  let reviewCopyReady = false;
  if (
    job.status === "needs_editor" &&
    /_(craft|poetics)$/.test(job.stage) &&
    !store.one(
      "SELECT stage FROM studio_steps WHERE jobId=? AND stage='scenes'",
      jobId,
    )
  ) {
    const candidate = store.one<{ result: string }>(
      "SELECT result FROM studio_steps WHERE jobId=? AND stage='accepted_story_editorial_attention_v1' AND state='completed'",
      jobId,
    );
    const saved = store.one<{ state: string }>(
      "SELECT state FROM studio_jobs WHERE id=?",
      jobId,
    );
    if (candidate && saved)
      try {
        const c = JSON.parse(candidate.result),
          h = HeartContract.parse(JSON.parse(saved.state).heart);
        reviewCopyReady = canAssembleReviewCopy(
          evaluateStory(h, c.manuscript, c.heartReview, c.editorialReview),
          c.editorialReview,
        );
      } catch {
        reviewCopyReady = false;
      }
  }
  const artRequirementsRepair =
    job.status === "needs_editor" &&
    !!store.one(
      "SELECT stage FROM studio_steps WHERE jobId=? AND stage='references' AND result='[]'",
      jobId,
    ) &&
    !!store.one(
      "SELECT stage FROM studio_steps WHERE jobId=? AND stage LIKE 'canon_identity_review_%'",
      jobId,
    ) &&
    !store.one(
      "SELECT stage FROM studio_steps WHERE jobId=? AND stage='references_requirements_v2'",
      jobId,
    );
  const artDirectionRepair =
    job.status === "needs_editor" &&
    !!store.one(
      "SELECT stage FROM studio_steps WHERE jobId=? AND stage='canon_directed_request_v1' AND state='completed'",
      jobId,
    ) &&
    !store.one(
      "SELECT stage FROM studio_steps WHERE jobId=? AND stage='references_art_direction_v1'",
      jobId,
    );
  const artScopeRepair =
    job.status === "needs_editor" &&
    !!store.one(
      "SELECT stage FROM studio_steps WHERE jobId=? AND stage='canon_identity_directed_v1' AND state='completed'",
      jobId,
    ) &&
    !store.one(
      "SELECT stage FROM studio_steps WHERE jobId=? AND stage='references_scope_v3'",
      jobId,
    );
  const artStyleRepair =
    job.status === "needs_editor" &&
    !!store.one(
      "SELECT stage FROM studio_steps WHERE jobId=? AND stage='canon_style_request_v1' AND state='completed'",
      jobId,
    ) &&
    !store.one(
      "SELECT stage FROM studio_steps WHERE jobId=? AND stage='references_style_v1'",
      jobId,
    );
  const artReviewCopyRepair =
    job.status === "needs_editor" &&
    !!store.one(
      "SELECT stage FROM studio_steps WHERE jobId=? AND stage='canon_style_sheet_v1' AND state='completed'",
      jobId,
    ) &&
    !store.one(
      "SELECT stage FROM studio_steps WHERE jobId=? AND stage='references_review_copy_v1'",
      jobId,
    );
  const artEvidenceRepair =
    job.status === "needs_editor" &&
    /^(picture_|whole_book_review)/.test(job.stage) &&
    !store.one(
      "SELECT stage FROM studio_steps WHERE jobId=? AND stage='art_evidence_protocol_v1'",
      jobId,
    );
  const artMeaningRepair =
    job.status === "needs_editor" &&
    /^(picture_|whole_book_review)/.test(job.stage) &&
    !store.one(
      "SELECT stage FROM studio_steps WHERE jobId=? AND stage='art_meaning_protocol_v2'",
      jobId,
    );
  let sceneReferenceRepair = false;
  if (job.status === "needs_editor" && job.stage === "scenes") {
    try {
      const read = (stage: string) => JSON.parse(store.one<{ result: string }>(
        "SELECT result FROM studio_steps WHERE jobId=? AND stage=? AND state='completed'", jobId, stage,
      )!.result);
      sceneReferenceRepair = worldProblems(VisualWorld.parse(read("world")),
        StoryManuscript.parse(read("accepted_story").manuscript), ScenePlan.parse(read("scenes"))).length === 0;
    } catch { /* Invalid or incomplete evidence cannot authorize recovery. */ }
  }
  const continueIndependentArt = job.status === "needs_editor" &&
    !!store.one("SELECT stage FROM studio_steps WHERE jobId=? AND stage LIKE 'accepted_picture_meaning_v2_%' AND state='completed' AND result='null'", jobId) &&
    (store.one<{ n: number }>("SELECT COUNT(*) n FROM studio_steps WHERE jobId=? AND stage LIKE 'accepted_picture_meaning_v2_%' AND state='completed'", jobId)?.n ?? 0) < 12;
  const localRepair =
    continueIndependentArt ||
    sceneReferenceRepair ||
    metadataRepair ||
    evidenceRepair ||
    editorialRepair ||
    reviewCopyReady ||
    artRequirementsRepair ||
    artDirectionRepair ||
    artScopeRepair ||
    artStyleRepair ||
    artReviewCopyRepair ||
    artEvidenceRepair ||
    artMeaningRepair;
  if (job.status === "needs_editor" && !localRepair) return null;
  if (attempt.status === "completed" && !localRepair) return null;
  const failure = attempt.details
    ? (JSON.parse(attempt.details) as ProviderFailure)
    : null;
  const uncertain =
    !localRepair && (pilot
      ? !store.one("SELECT id FROM pilot_attempts WHERE id=? AND jobId=? AND status='not_processed'", attempt.id, jobId)
      : attempt.status !== "rejected" || !failure?.retrySafe);
  if (!pilot) reservedBudget(store);
  const held =
    store.one<{ allowance: number }>(
      "SELECT allowance FROM engine_budget WHERE runId=?",
      jobId,
    )?.allowance ?? 0;
  return {
    preDispatch: false,
    metadataRepair,
    evidenceRepair,
    editorialRepair,
    localRepair,
    sceneReferenceRepair,
    continueIndependentArt,
    reviewCopyReady,
    artRequirementsRepair,
    artDirectionRepair,
    artScopeRepair,
    artStyleRepair,
    artReviewCopyRepair,
    artEvidenceRepair,
    artMeaningRepair,
    resumeReserveUsd: pilot ? 0 :
      Math.max(
        0,
        job.allowance + (uncertain ? attempt.estimatedCents : 0) - held,
      ) / 100,
    callId: localRepair
      ? `${attempt.id}:${job.stage}:${reviewCopyReady ? "reviewcopy1" : "evidence1"}`
      : attempt.id,
    stage: attempt.stage,
    requestId: attempt.requestId,
    uncertain,
    extraReserveUsd: !pilot && uncertain ? attempt.estimatedCents / 100 : 0,
    message: sceneReferenceRepair
      ? "The saved scene cast passes corrected required-character validation. Continue using the saved story and scene plan."
      : artRequirementsRepair
      ? "Saved reference images can be inspected against the correct model-sheet requirements. Earlier attempts remain saved; the correction limit is unchanged."
      : reviewCopyReady
        ? "The manuscript can continue as an illustrated review copy. Editorial notes remain visible; no claim of final literary approval is made."
        : editorialRepair
          ? "A targeted editorial repair is saved. Resume will review it before continuing to illustrations; original drafts remain unchanged."
          : evidenceRepair
            ? "The saved drafts need re-evaluation with corrected agency and citation checks. Earlier drafts and critiques stay saved; no manuscript is rewritten."
            : metadataRepair
              ? "The saved extraction needs an audio-label correction. Resume will reuse it and continue your book without repeating that request."
              : failure
                ? providerFailureMessage(failure)
                : "This older attempt did not retain its provider error. Its completion and charge cannot be confirmed. Your saved work is intact.",
  };
}

export function resumeStudio(
  store: Store,
  project: ProjectRow,
  input: unknown,
  config: EngineConfig,
) {
  const body = z
    .object({
      jobId: z.string(),
      callId: z.string(),
      acknowledgePossibleCharge: z.boolean(),
    })
    .parse(input);
  return store.transaction(() => {
    const job = store.one<{ id: string; status: string; baseRevision: number }>(
      "SELECT id,status,baseRevision FROM studio_jobs WHERE id=? AND projectId=? AND kind!='interview_transcription' AND NOT EXISTS(SELECT 1 FROM lab_runs WHERE lab_runs.jobId=studio_jobs.id)",
      body.jobId,
      project.id,
    );
    if (!job) throw new EngineError("This saved story could not be found.");
    if (
      store.one(
        "SELECT id FROM studio_jobs WHERE projectId=? AND rowid>(SELECT rowid FROM studio_jobs WHERE id=?)",
        project.id,
        job.id,
      ) ||
      job.baseRevision !== project.revision
    )
      throw new EngineError(
        "A newer story revision exists. This older job cannot resume.",
      );
    if (
      store.one(
        "SELECT id FROM studio_recoveries WHERE jobId=? AND callId=?",
        job.id,
        body.callId,
      )
    )
      return { id: job.id };
    const recovery = studioRecovery(store, job.id);
    if (!recovery || recovery.callId !== body.callId)
      throw new EngineError(
        "The saved attempt changed. Reload before resuming.",
      );
    const pilot = pilotJobFunding(store, job.id);
    if (pilot) {
      if (!pilotConnectionReady(store, config) || pilot.campaign.state !== "active" ||
        (pilotAccess(store, pilot.ownerId)?.remainingCents ?? 0) <= 0)
        throw new EngineError("This feedback pilot is paused. Its saved work can resume when the authorized service is available.");
      // A user's acknowledgement is not evidence that an uncertain paid call
      // was never processed. Keep both original receipts and settlement history.
      if (!recovery.localRepair && (recovery.uncertain || store.one(
        "SELECT id FROM pilot_attempts WHERE jobId=? AND stage=? AND status!='not_processed' LIMIT 1",
        job.id, recovery.stage,
      ))) throw new EngineError("Reconcile the saved pilot request as not processed before retrying. A possible-charge acknowledgement cannot authorize a duplicate request.");
    } else if (!availability(config).ready)
      throw new EngineError(availability(config).message);
    if (!pilot && recovery.uncertain && !body.acknowledgePossibleCharge)
      throw new EngineError(
        "Confirm the possible earlier charge before explicitly retrying this attempt.",
      );
    const extra = Math.round(recovery.extraReserveUsd * 100);
    const used = pilot ? 0 : reservedBudget(store);
    const remaining = Math.round(recovery.resumeReserveUsd * 100);
    if (!pilot && remaining > 0)
      requireAllocationIncrease(store, job.id, remaining, config);
    if (!pilot && used + remaining > config.budgetCents)
      throw new EngineError(
        `This retry needs $${(remaining / 100).toFixed(2)} more reserved allowance for its remaining work. Update your total allowance before resuming.`,
      );
    const pending = store.one<{ state: string }>(
      "SELECT state FROM studio_steps WHERE jobId=? AND stage=?",
      job.id,
      recovery.stage,
    );
    if (pending?.state === "completed" && !recovery.localRepair)
      throw new EngineError(
        "This stage is already saved and will not be repeated.",
      );
    // Retain the failed call and recovery evidence; only clear its unfinished
    // cache entry. Every completed stage, source, profile and edition survives.
    store.run(
      "INSERT INTO studio_recoveries VALUES(?,?,?,?,?,?,?)",
      id(),
      job.id,
      body.callId,
      recovery.stage,
      Number(recovery.uncertain),
      extra,
      now(),
    );
    store.run(
      "DELETE FROM studio_steps WHERE jobId=? AND stage=? AND state!='completed'",
      job.id,
      recovery.stage,
    );
    if (recovery.preDispatch) {
      store.run(
        "UPDATE studio_checkpoints SET resumedAt=? WHERE id=? AND resumedAt IS NULL",
        now(),
        body.callId,
      );
      store.run("DELETE FROM studio_pause_requests WHERE jobId=?", job.id);
    }
    store.run(
      "UPDATE studio_jobs SET status='queued',error=NULL,allowance=allowance+?,leaseToken=NULL,leaseUntil=0 WHERE id=?",
      extra,
      job.id,
    );
    if (!pilot) store.run(
      "UPDATE engine_budget SET allowance=(SELECT allowance FROM studio_jobs WHERE id=?) WHERE runId=?",
      job.id,
      job.id,
    );
    store.run(
      "UPDATE projects SET status='creating_legacy' WHERE id=? AND revision=?",
      project.id,
      job.baseRevision,
    );
    return { id: job.id };
  });
}
