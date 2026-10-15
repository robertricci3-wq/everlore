import { z } from "zod";
import { Transcript, wordCount } from "../../shared/contracts.js";
import {
  HeartContract,
  StoryManuscript,
  VisualWorld,
} from "../../shared/studio.js";
import { requireOperator } from "../access.js";
import { verifyProfile } from "../lab/profiles.js";
import { pilotAccess, pilotJobFunding } from "../pilot/service.js";
import { pilotConnectionReady } from "../pilot/integration.js";
import { isRecoveryLocked } from "../recovery-lock.js";
import { canonical, hash, id, now, type Store } from "../store.js";
import { heartProblems } from "./editorial.js";
import { EngineError } from "./pipeline.js";
import type { EngineConfig } from "./provider.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const OPERATOR_EDITORIAL_REVISION_STAGE =
  "operator_editorial_revision_v1";
export const OPERATOR_EDITORIAL_ACCEPTED_STAGE =
  "accepted_story_operator_revision_v1";
export const OperatorEditorialRevisionInput = z
  .object({
    ownerId: z.string().min(1),
    projectId: z.string().min(1),
    jobId: z.string().min(1),
    sourceHash: digest,
    baseManuscriptHash: digest,
    profileHash: digest,
    manuscriptHash: digest,
    manuscript: StoryManuscript,
    reason: z.string().trim().min(10).max(3000),
    approval: z
      .object({
        quote: z.string().trim().min(1).max(3000),
        receivedAt: z.iso.datetime({ offset: true }),
      })
      .strict(),
  })
  .strict();
export const OperatorEditorialRevisionRecord =
  OperatorEditorialRevisionInput.extend({
    version: z.literal(1),
    id: z.string(),
    actorId: z.string(),
    createdAt: z.string(),
    requestHash: digest,
    reviewedCandidateHash: digest,
    creationId: z.string(),
    campaignId: z.string(),
    policyHash: digest,
    frozenSourceHash: digest,
  }).strict();
const fingerprint = (
  body: z.infer<typeof OperatorEditorialRevisionInput>,
  actorId: string,
) => hash(canonical({ body, actorId }));
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function read(store: Store, jobId: string, stage: string) {
  const row = store.one<{ result: string; inputHash: string }>(
    "SELECT result,inputHash FROM studio_steps WHERE jobId=? AND stage=? AND state='completed'",
    jobId,
    stage,
  );
  return row ? { ...row, value: JSON.parse(row.result) } : null;
}
function forbiddenControls(value: unknown): boolean {
  if (typeof value === "string")
    return [...value].some((character) => {
      const code = character.codePointAt(0)!;
      return (
        (code < 32 && ![9, 10, 13].includes(code)) ||
        (code >= 127 && code <= 159)
      );
    });
  return (
    !!value &&
    typeof value === "object" &&
    Object.values(value).some(forbiddenControls)
  );
}
function textStage(stage: string) {
  return (
    [
      "transcription",
      "heart",
      "heart_cue_evidence_v1",
      "heart_questions_v1",
      "operator_heart_correction_v1",
      "operator_character_appearance_v1",
      "concepts",
      "concept_review",
      "selected_concept",
      "story_plan",
      "continuity_world_candidate_v1",
      "world",
      "accepted_story",
      "accepted_story_evidence_v1",
      "accepted_story_editorial_attention_v1",
      "editorial_attention_submission_v1",
    ].includes(stage) ||
    /^(?:draft_[123]|refine_[12])(?:_heart|_craft|_poetics)?$/.test(stage) ||
    /^(?:evidence_v1_(?:draft_[123]|refine_[12]|retained)|editorial_attention_v1)_(?:heart|craft|poetics)$/.test(
      stage,
    ) ||
    stage.startsWith("budget_allocation_")
  );
}

/** Shell-only operator action: one approved supplied manuscript; never authors or dispatches. */
export function applyOperatorEditorialRevision(
  store: Store,
  actorId: string,
  input: unknown,
  config: EngineConfig,
) {
  const body = OperatorEditorialRevisionInput.parse(input);
  return store.transaction(() => {
    requireOperator(store, actorId);
    const job = store.one<{
      id: string;
      projectId: string;
      kind: string;
      status: string;
      stage: string;
      baseRevision: number;
      state: string;
      request: string;
      profile: string;
      leaseToken: string | null;
      leaseUntil: number;
    }>(
      "SELECT * FROM studio_jobs WHERE id=? AND projectId=?",
      body.jobId,
      body.projectId,
    );
    const project = store.one<{ revision: number; transcript: string | null }>(
      "SELECT revision,transcript FROM projects WHERE id=? AND ownerId=?",
      body.projectId,
      body.ownerId,
    );
    if (!job || !project || job.kind !== "generation")
      throw new EngineError(
        "This owner's original story job could not be found.",
      );
    const inputHash = fingerprint(body, actorId);
    const prior = read(store, job.id, OPERATOR_EDITORIAL_REVISION_STAGE);
    if (prior) {
      const record = OperatorEditorialRevisionRecord.parse(prior.value);
      if (
        prior.inputHash !== inputHash ||
        fingerprint(
          OperatorEditorialRevisionInput.strip().parse(record),
          record.actorId,
        ) !== inputHash
      )
        throw new EngineError(
          "This one-time editorial revision is immutable; the retry differs.",
        );
      return record; // Receipt only: even a retry after completion never queues again.
    }
    const state = JSON.parse(job.state),
      request = JSON.parse(job.request);
    const source = Transcript.parse(state.source),
      profile = verifyProfile(request.engineProfile);
    if (
      !project.transcript ||
      !same(source, Transcript.parse(JSON.parse(project.transcript))) ||
      hash(canonical(source)) !== body.sourceHash
    )
      throw new EngineError("The frozen source changed.");
    if (
      profile.hash !== job.profile ||
      job.profile !== body.profileHash ||
      request.lab ||
      request.seed ||
      request.repair ||
      request.autonomous !== true
    )
      throw new EngineError(
        "The original generation profile or request changed.",
      );
    if (
      isRecoveryLocked(store) ||
      job.status !== "needs_editor" ||
      !/^editorial_attention_v1_(?:heart|craft|poetics)$/.test(job.stage) ||
      job.leaseToken !== null ||
      job.leaseUntil !== 0 ||
      job.baseRevision !== 0 ||
      project.revision !== 0 ||
      store.one(
        "SELECT id FROM studio_jobs WHERE projectId=? AND rowid>(SELECT rowid FROM studio_jobs WHERE id=?)",
        body.projectId,
        job.id,
      ) ||
      store.one(
        "SELECT revision FROM revisions WHERE projectId=?",
        body.projectId,
      ) ||
      store.one("SELECT id FROM editions WHERE projectId=?", body.projectId) ||
      store.one(
        "SELECT jobId FROM studio_pause_requests WHERE jobId=?",
        job.id,
      ) ||
      state.castApproved ||
      state.artApproved ||
      state.familyVersionId
    )
      throw new EngineError(
        "Only the stopped original pre-scenes editorial review may receive this revision.",
      );
    const steps = store.all<{ stage: string; state: string }>(
      "SELECT stage,state FROM studio_steps WHERE jobId=?",
      job.id,
    );
    if (
      steps.some((s) => !textStage(s.stage) || s.state !== "completed") ||
      [
        "accepted_story",
        "draft_1",
        "draft_2",
        "draft_3",
        "refine_1",
        "refine_2",
      ].some((stage) => !steps.some((s) => s.stage === stage)) ||
      store
        .all<{ stage: string; kind: string; status: string }>(
          "SELECT stage,kind,status FROM studio_calls WHERE jobId=?",
          job.id,
        )
        .some(
          (c) =>
            !textStage(c.stage) ||
            c.kind === "image" ||
            !["completed", "rejected"].includes(c.status),
        ) ||
      store.one(
        "SELECT id FROM pilot_attempts WHERE jobId=? AND status NOT IN ('completed','not_processed')",
        job.id,
      ) ||
      store.one(
        "SELECT hash FROM assets WHERE projectId=? AND kind IN ('art','pdf')",
        body.projectId,
      )
    )
      throw new EngineError(
        "Unfinished, visual, or ambiguous work prevents an editorial revision.",
      );
    const accepted = read(
      store,
      job.id,
      "accepted_story_editorial_attention_v1",
    );
    const submission = read(store, job.id, "editorial_attention_submission_v1");
    if (
      !accepted ||
      !submission ||
      accepted.inputHash !==
        hash(canonical({ input: submission.value, profile: job.profile })) ||
      !same(accepted.value.manuscript, submission.value.manuscript) ||
      hash(canonical(StoryManuscript.parse(accepted.value.manuscript))) !==
        body.baseManuscriptHash
    )
      throw new EngineError(
        "The current reviewed manuscript changed; earlier drafts cannot authorize this revision.",
      );
    const funding = pilotJobFunding(store, job.id),
      access = pilotAccess(store, body.ownerId);
    if (
      !funding ||
      funding.ownerId !== body.ownerId ||
      !access ||
      access.campaign.id !== funding.campaign.id ||
      funding.campaign.state !== "active" ||
      access.remainingCents <= 0 ||
      !pilotConnectionReady(store, config)
    )
      throw new EngineError(
        "The existing funded pilot must be active; this action adds no allowance.",
      );
    const creation = store.one<{
      sourceId: string;
      profile: string;
      continuity: string;
    }>(
      "SELECT sourceId,profile,continuity FROM almanac_creation_requests WHERE id=? AND ownerId=? AND projectId=? AND studioJobId=?",
      funding.creationId,
      body.ownerId,
      body.projectId,
      job.id,
    );
    const frozen =
      creation &&
      store.one<{ body: string; sourceHash: string }>(
        "SELECT body,sourceHash FROM almanac_sources WHERE id=? AND generationProjectId=?",
        creation.sourceId,
        body.projectId,
      );
    if (
      !creation ||
      !frozen ||
      !same(JSON.parse(creation.profile), profile) ||
      !same(JSON.parse(creation.continuity), request.continuity)
    )
      throw new EngineError("The original creation binding changed.");
    const frozenBody = JSON.parse(frozen.body);
    const turns = z
      .array(z.object({ sequence: z.number(), transcript: Transcript }))
      .parse(frozenBody.turns);
    if (
      hash(canonical(frozenBody)) !== frozen.sourceHash ||
      source.rawText !== turns.map((t) => t.transcript.rawText).join("\n\n") ||
      !same(
        source.segments,
        turns.flatMap((t) =>
          t.transcript.segments.map((s) => ({
            ...s,
            id: `t${t.sequence}-${s.id}`,
          })),
        ),
      )
    )
      throw new EngineError("The original source snapshot changed.");
    const heart = HeartContract.parse(state.heart),
      world = VisualWorld.parse(read(store, job.id, "world")?.value);
    const known = new Set(heart.nuggets.map((n) => n.id)),
      characters = new Set(world.characters.map((c) => c.id));
    const words = wordCount(
      body.manuscript.spreads.map((s) => s.text).join(" "),
    );
    if (
      heartProblems(heart, source).length ||
      hash(canonical(body.manuscript)) !== body.manuscriptHash ||
      body.manuscriptHash === body.baseManuscriptHash ||
      words < 250 ||
      words > 450 ||
      body.manuscript.spreads.some(
        (s) =>
          wordCount(s.text) > 45 ||
          s.nuggetIds.some((n) => !known.has(n)) ||
          s.characterIds.some((c) => !characters.has(c)),
      ) ||
      new Set(body.manuscript.spreads.map((s) => s.text)).size !== 12 ||
      forbiddenControls(body.manuscript)
    )
      throw new EngineError(
        "The supplied revision fails its exact hash, source references, or mechanical limits.",
      );
    const record = OperatorEditorialRevisionRecord.parse({
      ...body,
      version: 1,
      id: id(),
      actorId,
      createdAt: now(),
      requestHash: hash(canonical(request)),
      reviewedCandidateHash: hash(canonical(accepted.value)),
      creationId: funding.creationId,
      campaignId: funding.campaign.id,
      policyHash: funding.campaign.policyHash,
      frozenSourceHash: frozen.sourceHash,
    });
    store.run(
      "INSERT INTO studio_steps VALUES(?,?,?,'completed',?)",
      job.id,
      OPERATOR_EDITORIAL_REVISION_STAGE,
      inputHash,
      canonical(record),
    );
    store.run(
      "UPDATE studio_jobs SET status='queued',error=NULL WHERE id=?",
      job.id,
    );
    store.run(
      "UPDATE projects SET status='creating_legacy' WHERE id=?",
      body.projectId,
    );
    return record;
  });
}

/** Validate the immutable operator input again before its independent reviews. */
export function readOperatorEditorialRevision(store: Store, jobId: string) {
  const saved = read(store, jobId, OPERATOR_EDITORIAL_REVISION_STAGE);
  if (!saved) return null;
  const record = OperatorEditorialRevisionRecord.parse(saved.value);
  const body = OperatorEditorialRevisionInput.strip().parse(record);
  const job = store.one<{
    profile: string;
    request: string;
    state: string;
    projectId: string;
    kind: string;
  }>(
    "SELECT profile,request,state,projectId,kind FROM studio_jobs WHERE id=?",
    jobId,
  )!;
  const project = store.one<{ transcript: string | null }>(
    "SELECT transcript FROM projects WHERE id=? AND ownerId=?",
    record.projectId,
    record.ownerId,
  );
  const funding = pilotJobFunding(store, jobId);
  const creation = store.one<{
    sourceId: string;
    profile: string;
    continuity: string;
  }>(
    "SELECT sourceId,profile,continuity FROM almanac_creation_requests WHERE id=? AND ownerId=? AND projectId=? AND studioJobId=?",
    record.creationId,
    record.ownerId,
    record.projectId,
    jobId,
  );
  const frozen =
    creation &&
    store.one<{ body: string; sourceHash: string }>(
      "SELECT body,sourceHash FROM almanac_sources WHERE id=? AND generationProjectId=?",
      creation.sourceId,
      record.projectId,
    );
  const request = JSON.parse(job.request);
  const accepted = read(store, jobId, "accepted_story_editorial_attention_v1");
  if (
    record.jobId !== jobId ||
    job.projectId !== record.projectId ||
    job.kind !== "generation" ||
    !project?.transcript ||
    hash(canonical(Transcript.parse(JSON.parse(project.transcript)))) !==
      record.sourceHash ||
    !funding ||
    funding.ownerId !== record.ownerId ||
    funding.creationId !== record.creationId ||
    funding.campaign.id !== record.campaignId ||
    funding.campaign.policyHash !== record.policyHash ||
    !creation ||
    !same(JSON.parse(creation.profile), verifyProfile(request.engineProfile)) ||
    !same(JSON.parse(creation.continuity), request.continuity) ||
    !frozen ||
    frozen.sourceHash !== record.frozenSourceHash ||
    hash(canonical(JSON.parse(frozen.body))) !== record.frozenSourceHash ||
    fingerprint(body, record.actorId) !== saved.inputHash ||
    hash(canonical(record.manuscript)) !== record.manuscriptHash ||
    job.profile !== record.profileHash ||
    hash(canonical(JSON.parse(job.request))) !== record.requestHash ||
    hash(canonical(Transcript.parse(JSON.parse(job.state).source))) !==
      record.sourceHash ||
    !accepted ||
    hash(canonical(accepted.value)) !== record.reviewedCandidateHash ||
    hash(canonical(accepted.value.manuscript)) !== record.baseManuscriptHash
  )
    throw new EngineError("The approved editorial revision binding changed.");
  return record;
}
