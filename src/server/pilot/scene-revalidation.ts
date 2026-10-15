import { z } from "zod";
import { requireOperator, AccessError } from "../access.js";
import { canonical, hash, id, now, type Store } from "../store.js";
import { isRecoveryLocked } from "../recovery-lock.js";
import {
  ProductionImageReview,
  imageAccepted,
  imageReviewCopyEligible,
} from "../engine/art-review.js";
import { pilotAccess, pilotJobFunding } from "./service.js";
import { readPilotReviewSlots } from "./review-slots.js";
import { migratePilot } from "./schema.js";

export const SCENE_REVALIDATION_NAME = "picture_9_revalidation_v1";
export const SCENE_REVALIDATION_REVIEW = `${SCENE_REVALIDATION_NAME}_staged_meaning_v1`;
export const SCENE_REVALIDATION_ACCEPTED =
  "authorized_picture_revalidation_v1_9";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const SceneRevalidationInput = z
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
    imageHash: digest,
    meaningReviewHash: digest,
    requirementsReviewHash: digest,
    spread: z.literal(9),
    scope: z.literal("existing_image_staging_revalidation_only"),
    additionalReviews: z.literal(1),
    additionalImages: z.literal(0),
    amountCents: z.literal(2500),
    instruction: z.string().trim().min(20).max(3000),
    reason: z.string().trim().min(10).max(3000),
    approval: z
      .object({
        quote: z.string().trim().min(1).max(3000),
        receivedAt: z.iso.datetime({ offset: true }),
      })
      .strict(),
  })
  .strict();
export const SceneRevalidationRecord = SceneRevalidationInput.extend({
  version: z.literal(1),
  id: z.string(),
  actorId: z.string(),
  approvedAt: z.string(),
  reviewSlotExtensionHash: digest,
  meaningInputHash: digest,
  requirementsInputHash: digest,
  visualContextHash: digest,
}).strict();
type Input = z.infer<typeof SceneRevalidationInput>;
const fingerprint = (body: Input, actorId: string) =>
  hash(canonical({ body, actorId }));
const fail = (): never => {
  throw new AccessError(
    409,
    "This exact existing-image staging revalidation no longer matches its approved evidence.",
  );
};
function readStep(s: Store, jobId: string, stage: string) {
  const row = s.one<{ result: string; inputHash: string }>(
    "SELECT result,inputHash FROM studio_steps WHERE jobId=? AND stage=? AND state='completed'",
    jobId,
    stage,
  );
  return row
    ? { value: JSON.parse(row.result), inputHash: row.inputHash }
    : null;
}
function bound(s: Store, body: Input) {
  const extension = readPilotReviewSlots(s, body.jobId);
  const image = readStep(s, body.jobId, "picture_9_attempt_3");
  const requirements = readStep(
    s,
    body.jobId,
    "picture_9_requirements_v4_review_3",
  );
  const meaning = readStep(
    s,
    body.jobId,
    "picture_9_attempt_3_meaning_review_v2",
  );
  const scenes = readStep(s, body.jobId, "scenes");
  if (
    !extension ||
    !image ||
    !requirements ||
    !meaning ||
    !scenes ||
    image.value !== body.imageHash ||
    extension.ownerId !== body.ownerId ||
    extension.projectId !== body.projectId ||
    extension.creationId !== body.creationId ||
    extension.campaignId !== body.campaignId ||
    extension.policyHash !== body.policyHash ||
    extension.sourceHash !== body.sourceHash ||
    extension.manuscriptHash !== body.manuscriptHash ||
    extension.profileHash !== body.profileHash ||
    hash(canonical(requirements.value)) !== body.requirementsReviewHash ||
    hash(canonical(meaning.value)) !== body.meaningReviewHash ||
    hash(s.readAsset(body.projectId, body.imageHash)) !== body.imageHash ||
    readStep(s, body.jobId, "accepted_picture_meaning_v2_9")?.value !== null
  )
    fail();
  const review = ProductionImageReview.parse(requirements!.value);
  const prior = z
    .object({
      visibleCharacterIds: z.array(z.string()),
      unexpectedForegroundCharacters: z.array(z.string()),
      identityConsistent: z.boolean(),
      actionReadable: z.boolean(),
      physicalCoherence: z.boolean(),
      childAppropriate: z.boolean(),
      unwantedLettering: z.boolean(),
      protectedContradictions: z.array(z.unknown()),
      evidence: z.array(z.string().min(1)).min(1),
      refinements: z.array(z.string()),
    })
    .parse(meaning!.value);
  const expected: string[] = scenes!.value.scenes[8].characterIds;
  if (
    review.identity < 4 ||
    Math.min(review.style, review.actionReadability, review.physicalCoherence) <
      3 ||
    imageAccepted(review) ||
    imageReviewCopyEligible(review) ||
    prior.actionReadable ||
    !prior.identityConsistent ||
    !prior.physicalCoherence ||
    !prior.childAppropriate ||
    prior.unwantedLettering ||
    prior.protectedContradictions.length ||
    prior.unexpectedForegroundCharacters.length ||
    new Set(prior.visibleCharacterIds).size !== expected.length ||
    prior.visibleCharacterIds.length !== expected.length ||
    expected.some((x) => !prior.visibleCharacterIds.includes(x))
  )
    fail();
  const visualContext = s.all(
    "SELECT stage,inputHash,result FROM studio_steps WHERE jobId=? AND state='completed' AND (stage='world' OR stage='operator_character_appearance_v1' OR stage='references' OR stage LIKE 'references_%') ORDER BY stage",
    body.jobId,
  );
  if (!readStep(s, body.jobId, "world") || visualContext.length < 2) fail();
  return {
    extension: extension!,
    meaning: meaning!,
    requirements: requirements!,
    visualContextHash: hash(canonical(visualContext)),
  };
}

/** Append permission and queue the same stopped job. No provider call occurs here. */
export function authorizeSceneRevalidation(
  s: Store,
  actorId: string,
  input: unknown,
) {
  migratePilot(s.db);
  const body = SceneRevalidationInput.parse(input);
  return s.transaction(() => {
    requireOperator(s, actorId);
    const requestHash = fingerprint(body, actorId);
    const prior = s.one<{ requestHash: string; body: string }>(
      "SELECT * FROM pilot_scene_revalidations WHERE jobId=?",
      body.jobId,
    );
    if (prior) {
      const record = SceneRevalidationRecord.parse(JSON.parse(prior.body));
      if (
        prior.requestHash !== requestHash ||
        fingerprint(
          SceneRevalidationInput.strip().parse(record),
          record.actorId,
        ) !== requestHash
      )
        fail();
      return record;
    }
    const base = bound(s, body);
    const job = s.one<{
      status: string;
      leaseToken: string | null;
      leaseUntil: number;
    }>("SELECT * FROM studio_jobs WHERE id=?", body.jobId)!;
    const funding = pilotJobFunding(s, body.jobId);
    if (
      isRecoveryLocked(s) ||
      job.status !== "needs_editor" ||
      job.leaseToken !== null ||
      job.leaseUntil !== 0 ||
      funding?.campaign.state !== "active" ||
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
        "SELECT stage FROM studio_steps WHERE jobId=? AND (stage LIKE 'whole_book_%' OR stage=?)",
        body.jobId,
        SCENE_REVALIDATION_REVIEW,
      ) ||
      Array.from({ length: 12 }, (_, i) => i + 1).some(
        (spread) =>
          !readStep(s, body.jobId, `accepted_picture_meaning_v2_${spread}`),
      )
    )
      throw new AccessError(
        409,
        "Wait for the same job to stop after all twelve ordinary illustration outcomes, with no ambiguous work.",
      );
    const record = SceneRevalidationRecord.parse({
      ...body,
      version: 1,
      id: id(),
      actorId,
      approvedAt: now(),
      reviewSlotExtensionHash: hash(canonical(base.extension)),
      meaningInputHash: base.meaning.inputHash,
      requirementsInputHash: base.requirements.inputHash,
      visualContextHash: base.visualContextHash,
    });
    s.run(
      "INSERT INTO pilot_scene_revalidations VALUES(?,?,?)",
      body.jobId,
      requestHash,
      canonical(record),
    );
    s.run(
      "UPDATE studio_jobs SET status='queued',error=NULL WHERE id=?",
      body.jobId,
    );
    s.run("UPDATE projects SET status='creating_legacy' WHERE id=? AND revision=0", body.projectId);
    return record;
  });
}

export function readSceneRevalidation(s: Store, jobId: string) {
  const row = s.one<{ requestHash: string; body: string }>(
    "SELECT * FROM pilot_scene_revalidations WHERE jobId=?",
    jobId,
  );
  if (!row) return null;
  const record = SceneRevalidationRecord.parse(JSON.parse(row.body)),
    body = SceneRevalidationInput.strip().parse(record);
  const base = bound(s, body);
  if (
    record.jobId !== jobId ||
    fingerprint(body, record.actorId) !== row.requestHash ||
    record.reviewSlotExtensionHash !== hash(canonical(base.extension)) ||
    record.meaningInputHash !== base.meaning.inputHash ||
    record.requirementsInputHash !== base.requirements.inputHash ||
    record.visualContextHash !== base.visualContextHash
  )
    fail();
  return record;
}
