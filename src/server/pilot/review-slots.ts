import { z } from "zod";
import { AccessError, requireOperator } from "../access.js";
import { canonical, hash, id, now, type Store } from "../store.js";
import { isRecoveryLocked } from "../recovery-lock.js";
import { readStoryReviewEditionAuthorization } from "../engine/story-review-edition.js";
import { SceneAttemptAuthorization } from "../engine/scene-attempt.js";
import { pilotJobFunding, pilotAccess } from "./service.js";
import { migratePilot } from "./schema.js";
import {
  readSceneRevalidation,
  SCENE_REVALIDATION_REVIEW,
} from "./scene-revalidation.js";

export const PILOT_REVIEW_EXTENSION_STAGES = Object.freeze([
  "picture_9_attempt_3_meaning_review_v2",
  ...[10, 12].flatMap((spread) =>
    [1, 2, 3].flatMap((attempt) => [
      `picture_${spread}_requirements_v4_review_${attempt}`,
      `picture_${spread}_attempt_${attempt}_meaning_review_v2`,
    ]),
  ),
  "picture_8_authorized_extra_v1_requirements_v4_review_1",
  "picture_8_authorized_extra_v1_attempt_1_staged_meaning_v1",
  "picture_8_authorized_extra_v1_identity_scope_v1",
  "whole_book_sequence_review_v2",
  "whole_book_sequence_meaning_v3",
]);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const PilotReviewSlotExtensionInput = z
  .object({
    ownerId: z.string().min(1),
    projectId: z.string().min(1),
    jobId: z.string().min(1),
    creationId: z.string().min(1),
    campaignId: z.string().min(1),
    policyHash: digest,
    sourceHash: digest,
    manuscriptHash: digest,
    profileHash: digest,
    checkpointId: z.string().min(1),
    checkpointInputHash: digest,
    scope: z.literal("remaining_illustration_reviews_only"),
    originalTextLimit: z.literal(70),
    maxAdditionalReviews: z.literal(18),
    amountCents: z.literal(2500),
    reason: z.string().trim().min(10).max(3000),
    approval: z
      .object({
        quote: z.string().trim().min(1).max(3000),
        receivedAt: z.iso.datetime({ offset: true }),
      })
      .strict(),
  })
  .strict();
export const PilotReviewSlotExtensionRecord =
  PilotReviewSlotExtensionInput.extend({
    version: z.literal(1),
    id: z.string(),
    actorId: z.string(),
    approvedAt: z.string(),
    storyAuthorizationHash: digest,
    jobRequestHash: digest,
    scenesHash: digest,
    stages: z.array(z.string()).length(18),
  }).strict();
type Input = z.infer<typeof PilotReviewSlotExtensionInput>;
type Record = z.infer<typeof PilotReviewSlotExtensionRecord>;
const fingerprint = (body: Input, actorId: string) =>
  hash(canonical({ body, actorId }));
const fail = (message: string): never => {
  throw new AccessError(409, message);
};

function bindings(s: Store, body: Input) {
  const story = readStoryReviewEditionAuthorization(s, body.jobId);
  const funding = pilotJobFunding(s, body.jobId);
  const job = s.one<{
    kind: string;
    request: string;
    profile: string;
    baseRevision: number;
    status: string;
    stage: string;
    leaseToken: string | null;
    leaseUntil: number;
  }>(
    "SELECT * FROM studio_jobs WHERE id=? AND projectId=?",
    body.jobId,
    body.projectId,
  );
  const project = s.one<{ revision: number }>(
    "SELECT revision FROM projects WHERE id=? AND ownerId=?",
    body.projectId,
    body.ownerId,
  );
  const scenes = s.one<{ result: string }>(
    "SELECT result FROM studio_steps WHERE jobId=? AND stage='scenes' AND state='completed'",
    body.jobId,
  );
  if (
    !story ||
    !funding ||
    !job ||
    !project ||
    !scenes ||
    job.kind !== "generation" ||
    job.baseRevision !== 0 ||
    project.revision !== 0 ||
    job.profile !== body.profileHash ||
    story.ownerId !== body.ownerId ||
    story.projectId !== body.projectId ||
    story.sourceHash !== body.sourceHash ||
    story.manuscriptHash !== body.manuscriptHash ||
    story.profileHash !== body.profileHash ||
    funding.ownerId !== body.ownerId ||
    funding.creationId !== body.creationId ||
    funding.campaign.id !== body.campaignId ||
    funding.campaign.policyHash !== body.policyHash ||
    funding.campaign.totalCents !== body.amountCents ||
    funding.campaign.policy.maxRequests.text !== 70 ||
    funding.campaign.policy.maxRequests.image !== 42 ||
    s.one(
      "SELECT id FROM studio_jobs WHERE projectId=? AND rowid>(SELECT rowid FROM studio_jobs WHERE id=?)",
      body.projectId,
      body.jobId,
    ) ||
    s.one("SELECT id FROM editions WHERE projectId=?", body.projectId)
  )
    fail(
      "The review-slot authorization no longer matches this exact source, manuscript, job and frozen pilot policy.",
    );
  return {
    story: story!,
    funding: funding!,
    job: job!,
    scenesHash: hash(canonical(JSON.parse(scenes!.result))),
  };
}

/** Records permission only. The operator must separately resume the existing checkpoint. */
export function authorizePilotReviewSlots(
  s: Store,
  actorId: string,
  input: unknown,
) {
  migratePilot(s.db);
  const body = PilotReviewSlotExtensionInput.parse(input);
  return s.transaction(() => {
    requireOperator(s, actorId);
    const requestHash = fingerprint(body, actorId);
    const prior = s.one<{ requestHash: string; body: string }>(
      "SELECT * FROM pilot_review_slot_extensions WHERE jobId=?",
      body.jobId,
    );
    if (prior) {
      const record = PilotReviewSlotExtensionRecord.parse(
        JSON.parse(prior.body),
      );
      if (
        prior.requestHash !== requestHash ||
        fingerprint(
          PilotReviewSlotExtensionInput.strip().parse(record),
          record.actorId,
        ) !== requestHash
      )
        fail(
          "This one-time review-slot authorization is immutable; the retry differs.",
        );
      return record;
    }
    const bound = bindings(s, body),
      { job, funding } = bound;
    const checkpoint = s.one<{ id: string }>(
      "SELECT id FROM studio_checkpoints WHERE id=? AND jobId=? AND stage=? AND inputHash=? AND resumedAt IS NULL",
      body.checkpointId,
      body.jobId,
      PILOT_REVIEW_EXTENSION_STAGES[0],
      body.checkpointInputHash,
    );
    const count = s.one<{ n: number }>(
      "SELECT COUNT(*) n FROM pilot_attempts WHERE creationId=? AND kind='text' AND status!='not_processed'",
      body.creationId,
    )!.n;
    if (
      isRecoveryLocked(s) ||
      job.status !== "needs_attention" ||
      job.stage !== PILOT_REVIEW_EXTENSION_STAGES[0] ||
      job.leaseToken !== null ||
      job.leaseUntil !== 0 ||
      !checkpoint ||
      count !== 70 ||
      funding.campaign.state !== "active" ||
      (pilotAccess(s, body.ownerId)?.remainingCents ?? 0) <= 0 ||
      s.one(
        "SELECT id FROM pilot_attempts WHERE creationId=? AND status NOT IN ('completed','not_processed')",
        body.creationId,
      ) ||
      s.one(
        "SELECT id FROM studio_calls WHERE jobId=? AND status NOT IN ('completed','rejected')",
        body.jobId,
      ) ||
      s.one(
        "SELECT stage FROM studio_steps WHERE jobId=? AND stage=? AND state='completed'",
        body.jobId,
        job.stage,
      )
    )
      fail(
        "Only the unleased, unambiguous 70-text-request checkpoint can receive these review slots.",
      );
    const record = PilotReviewSlotExtensionRecord.parse({
      ...body,
      version: 1,
      id: id(),
      actorId,
      approvedAt: now(),
      stages: [...PILOT_REVIEW_EXTENSION_STAGES],
      storyAuthorizationHash: hash(canonical(bound.story)),
      jobRequestHash: hash(canonical(JSON.parse(job.request))),
      scenesHash: bound.scenesHash,
    });
    s.run(
      "INSERT INTO pilot_review_slot_extensions VALUES(?,?,?)",
      body.jobId,
      requestHash,
      canonical(record),
    );
    return record;
  });
}

export function readPilotReviewSlots(s: Store, jobId: string): Record | null {
  const row = s.one<{ requestHash: string; body: string }>(
    "SELECT * FROM pilot_review_slot_extensions WHERE jobId=?",
    jobId,
  );
  if (!row) return null;
  const record = PilotReviewSlotExtensionRecord.parse(JSON.parse(row.body));
  const body = PilotReviewSlotExtensionInput.strip().parse(record),
    bound = bindings(s, body);
  if (
    record.jobId !== jobId ||
    fingerprint(body, record.actorId) !== row.requestHash ||
    !s.one(
      "SELECT id FROM studio_checkpoints WHERE id=? AND jobId=? AND stage=? AND inputHash=?",
      record.checkpointId,
      jobId,
      PILOT_REVIEW_EXTENSION_STAGES[0],
      record.checkpointInputHash,
    ) ||
    canonical(record.stages) !== canonical(PILOT_REVIEW_EXTENSION_STAGES) ||
    record.storyAuthorizationHash !== hash(canonical(bound.story)) ||
    record.scenesHash !== bound.scenesHash ||
    record.jobRequestHash !== hash(canonical(JSON.parse(bound.job.request)))
  )
    fail("The immutable review-slot receipt failed its binding check.");
  return record;
}

function stageAllowed(s: Store, record: Record, stage: string) {
  if (!PILOT_REVIEW_EXTENSION_STAGES.includes(stage))
    fail(
      "This authorization permits only the eighteen named illustration reviews.",
    );
  if (stage.startsWith("picture_8_authorized_extra_v1_")) {
    const raw = s.one<{ result: string }>(
      "SELECT result FROM studio_steps WHERE jobId=? AND stage='scene_attempt_authorization_v1_8' AND state='completed'",
      record.jobId,
    );
    const prior = s.one<{ result: string }>(
      "SELECT result FROM studio_steps WHERE jobId=? AND stage='picture_8_attempt_3' AND state='completed'",
      record.jobId,
    );
    const approval =
      raw && SceneAttemptAuthorization.parse(JSON.parse(raw.result));
    if (
      !approval ||
      !prior ||
      approval.spread !== 8 ||
      approval.baseRevision !== 0 ||
      approval.priorHash !== JSON.parse(prior.result)
    )
      fail(
        "Spread eight still requires its separate exact one-image authorization.",
      );
  }
}

/** Called only inside the reservation transaction. A consumed slot is never refunded or replayed. */
export function claimPilotReviewSlot(
  s: Store,
  input: {
    jobId: string;
    attemptId: string;
    stage: string;
    inputHash: string;
    kind: string;
  },
) {
  if (input.kind !== "text") return 0;
  const record = readPilotReviewSlots(s, input.jobId);
  if (!record) return 0;
  if (!s.db.isTransaction)
    fail("Review-slot consumption requires an atomic reservation.");
  const revalidation = readSceneRevalidation(s, input.jobId);
  const special = input.stage === SCENE_REVALIDATION_REVIEW;
  if (special && !revalidation)
    fail("This existing-image review requires its separate authorization.");
  if (!special) stageAllowed(s, record, input.stage);
  const ceiling = revalidation ? 19 : 18;
  if (
    s.one(
      "SELECT stage FROM studio_steps WHERE jobId=? AND stage=? AND state='completed'",
      input.jobId,
      input.stage,
    ) ||
    s.one(
      "SELECT attemptId FROM pilot_review_slot_uses WHERE jobId=? AND stage=?",
      input.jobId,
      input.stage,
    ) ||
    s.one<{ n: number }>(
      "SELECT COUNT(*) n FROM pilot_review_slot_uses WHERE jobId=?",
      input.jobId,
    )!.n >= ceiling ||
    (!special &&
      s.one<{ n: number }>(
        "SELECT COUNT(*) n FROM pilot_review_slot_uses WHERE jobId=? AND stage!=?",
        input.jobId,
        SCENE_REVALIDATION_REVIEW,
      )!.n >= 18)
  )
    fail(
      "This review slot has already been consumed; it cannot authorize another request.",
    );
  s.run(
    "INSERT INTO pilot_review_slot_uses VALUES(?,?,?,?,?,?)",
    input.attemptId,
    input.jobId,
    input.stage,
    input.inputHash,
    hash(canonical(special ? revalidation : record)),
    now(),
  );
  return ceiling;
}

export function verifyPilotReviewSlotDispatch(
  s: Store,
  attempt: {
    id: string;
    jobId: string;
    stage: string;
    inputHash: string;
    kind: string;
  },
) {
  const use = s.one<{
    authorizationHash: string;
    inputHash: string;
    stage: string;
    jobId: string;
  }>("SELECT * FROM pilot_review_slot_uses WHERE attemptId=?", attempt.id);
  if (!use) {
    if (
      attempt.kind === "text" &&
      s.one(
        "SELECT jobId FROM pilot_review_slot_extensions WHERE jobId=?",
        attempt.jobId,
      )
    )
      fail("This new text request has no matching review-slot reservation.");
    return;
  }
  const special = attempt.stage === SCENE_REVALIDATION_REVIEW;
  const record = special
    ? readSceneRevalidation(s, attempt.jobId)
    : readPilotReviewSlots(s, attempt.jobId);
  if (
    !record ||
    attempt.kind !== "text" ||
    use.jobId !== attempt.jobId ||
    use.stage !== attempt.stage ||
    use.inputHash !== attempt.inputHash ||
    use.authorizationHash !== hash(canonical(record))
  )
    fail("The review-slot reservation no longer matches this request.");
  if (!special) stageAllowed(s, record as Record, attempt.stage);
}
