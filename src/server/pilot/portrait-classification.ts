import { z } from "zod";
import { AccessError, requireOperator } from "../access.js";
import { canonical, hash, id, now, type Store } from "../store.js";
import { isRecoveryLocked } from "../recovery-lock.js";
import { ScenePlan, VisualWorld } from "../../shared/studio.js";
import {
  ProductionImageReview,
  imageAccepted,
  imageReviewCopyEligible,
} from "../engine/art-review.js";
import { readPilotReviewSlots } from "./review-slots.js";
import { pilotJobFunding } from "./service.js";
import { migratePilot } from "./schema.js";

export const PORTRAIT_CLASSIFICATION_ACCEPTED =
  "accepted_portrait_classification_v1_12";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const PortraitClassificationInput = z
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
    sceneHash: digest,
    canonHash: digest,
    imageHash: digest,
    requirementsReviewHash: digest,
    meaningReviewHash: digest,
    spread: z.literal(12),
    attempt: z.literal(2),
    scope: z.literal("retained_portrait_classification_only"),
    characterId: z.string().min(1),
    representation: z.literal("memory_portrait"),
    sceneEvidenceQuote: z.string().trim().min(20).max(3000),
    reviewEvidenceQuote: z.string().trim().min(20).max(3000),
    inspectedImageHash: digest,
    operatorObservation: z.string().trim().min(20).max(3000),
    reason: z.string().trim().min(10).max(3000),
  })
  .strict();
export const PortraitClassificationRecord = PortraitClassificationInput.extend({
  version: z.literal(1),
  id: z.string(),
  actorId: z.string(),
  recordedAt: z.string(),
  reviewSlotExtensionHash: digest,
  meaningInputHash: digest,
  requirementsInputHash: digest,
}).strict();
type Input = z.infer<typeof PortraitClassificationInput>;
const fingerprint = (body: Input, actorId: string) =>
  hash(canonical({ body, actorId }));
const fail = (): never => {
  throw new AccessError(
    409,
    "The retained portrait evidence no longer supports this exact character classification.",
  );
};
function step(s: Store, jobId: string, stage: string) {
  const row = s.one<{ result: string; inputHash: string }>(
    "SELECT result,inputHash FROM studio_steps WHERE jobId=? AND stage=? AND state='completed'",
    jobId,
    stage,
  );
  return row
    ? { value: JSON.parse(row.result), inputHash: row.inputHash }
    : null;
}
/** Hashes retained canon and references; this does not infer a portrait identity. */
export function portraitClassificationCanonHash(s: Store, jobId: string) {
  const rows = s.all<{ stage: string; inputHash: string; result: string }>(
    "SELECT stage,inputHash,result FROM studio_steps WHERE jobId=? AND state='completed' AND (stage='world' OR stage='operator_character_appearance_v1' OR stage='references' OR stage LIKE 'references_%') ORDER BY stage",
    jobId,
  );
  if (
    !rows.some((r) => r.stage === "world") ||
    !rows.some((r) => r.stage === "references")
  )
    fail();
  return hash(canonical(rows));
}
function identifiesPortrait(
  quote: string,
  character: { id: string; name: string },
) {
  const words = quote.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u);
  return (
    /\b(portrait|medallion)\b/i.test(quote) &&
    [character.id, character.name].some((name) =>
      name
        .split(/[^\p{L}\p{N}_-]+/u)
        .every((word) => words.includes(word.toLocaleLowerCase())),
    )
  );
}
function affirmativePortraitEvidence(quote: string) {
  // Conservative screening of retained prose, not a new identity judgment.
  // "Not a literal figure" is valid; uncertainty about the portrait identity is not.
  return (
    /\b(recogni[sz]able|identifiable|matching|matches|consistent|canonical)\b/i.test(
      quote,
    ) &&
    !/\b(cannot|can't|could not|couldn't|unable to)\s+(?:be\s+)?(?:clearly\s+)?(identify|identified|verify|verified|confirm|confirmed|recogni[sz]e|recogni[sz]ed|see|seen|distinguish|distinguished)\b/i.test(
      quote,
    ) &&
    !/\b(unidentifiable|unrecogni[sz]able|unverifiable|uncertain|unclear|ambiguous|possibly|perhaps|maybe|missing|absent)\b/i.test(
      quote,
    ) &&
    !/\b(not|isn't|is not)\s+(?:clearly\s+)?(identifiable|recogni[sz]able|visible|verified|confirmed|consistent|matching)\b/i.test(
      quote,
    ) &&
    !/\b(does not|doesn't|not)\s+match\b/i.test(quote)
  );
}
function bound(s: Store, body: Input) {
  const extension = readPilotReviewSlots(s, body.jobId);
  const image = step(s, body.jobId, "picture_12_attempt_2");
  const requirements = step(
    s,
    body.jobId,
    "picture_12_requirements_v4_review_2",
  );
  const meaning = step(s, body.jobId, "picture_12_attempt_2_meaning_review_v2");
  const scenes = step(s, body.jobId, "scenes"),
    world = step(s, body.jobId, "world");
  if (
    !extension ||
    !image ||
    !requirements ||
    !meaning ||
    !scenes ||
    !world ||
    extension.ownerId !== body.ownerId ||
    extension.projectId !== body.projectId ||
    extension.creationId !== body.creationId ||
    extension.campaignId !== body.campaignId ||
    extension.policyHash !== body.policyHash ||
    extension.sourceHash !== body.sourceHash ||
    extension.manuscriptHash !== body.manuscriptHash ||
    extension.profileHash !== body.profileHash ||
    image.value !== body.imageHash ||
    body.inspectedImageHash !== body.imageHash ||
    hash(s.readAsset(body.projectId, body.imageHash)) !== body.imageHash ||
    hash(canonical(requirements.value)) !== body.requirementsReviewHash ||
    hash(canonical(meaning.value)) !== body.meaningReviewHash ||
    portraitClassificationCanonHash(s, body.jobId) !== body.canonHash ||
    step(s, body.jobId, "accepted_picture_meaning_v2_12")?.value !== null
  )
    fail();
  const scene = ScenePlan.parse(scenes!.value).scenes[11];
  const character = VisualWorld.parse(world!.value).characters.find(
    (c) => c.id === body.characterId,
  );
  const prior = z
    .object({
      visibleCharacterIds: z.array(z.string()),
      unexpectedForegroundCharacters: z.array(z.string()),
      identityConsistent: z.boolean(),
      actionReadable: z.boolean(),
      physicalCoherence: z.boolean(),
      childAppropriate: z.boolean(),
      unwantedLettering: z.boolean(),
      protectedContradictions: z.array(
        z.object({ nuggetId: z.string(), evidence: z.string().min(1) }),
      ),
      evidence: z.array(z.string().min(1)).min(1),
      refinements: z.array(z.string()),
    })
    .parse(meaning!.value);
  const review = ProductionImageReview.parse(requirements!.value);
  const covered = [...prior.visibleCharacterIds, body.characterId];
  if (
    !character ||
    hash(canonical(scene)) !== body.sceneHash ||
    ![
      scene.action,
      ...scene.physicalInteractions,
      ...scene.exclusions,
    ].includes(body.sceneEvidenceQuote) ||
    !prior.evidence.includes(body.reviewEvidenceQuote) ||
    !identifiesPortrait(body.sceneEvidenceQuote, character) ||
    !identifiesPortrait(body.reviewEvidenceQuote, character) ||
    /\b(do not|don't|never|must not)\s+(draw|depict|include|show)\b/i.test(
      body.sceneEvidenceQuote,
    ) ||
    /\b(no|without)\s+(?:visible\s+)?(portrait|medallion)\b/i.test(
      body.sceneEvidenceQuote,
    ) ||
    !affirmativePortraitEvidence(body.reviewEvidenceQuote) ||
    new Set(scene.characterIds).size !== scene.characterIds.length ||
    new Set(covered).size !== covered.length ||
    covered.length !== scene.characterIds.length ||
    scene.characterIds.some((id) => !covered.includes(id)) ||
    prior.unexpectedForegroundCharacters.length ||
    !prior.identityConsistent ||
    !prior.actionReadable ||
    !prior.physicalCoherence ||
    !prior.childAppropriate ||
    prior.unwantedLettering ||
    prior.protectedContradictions.length ||
    review.identity < 4 ||
    Math.min(review.style, review.actionReadability, review.physicalCoherence) <
      3 ||
    imageAccepted(review) ||
    imageReviewCopyEligible(review)
  )
    fail();
  // This derives coverage only. Original critic arrays, booleans, scores and evidence remain immutable.
  const resolved = {
    ...review,
    correctnessDefects: [],
    meaningVerified: true,
    defects: [...review.defects, ...prior.refinements],
  };
  if (!imageReviewCopyEligible(resolved)) fail();
  return {
    extension: extension!,
    meaning: meaning!,
    requirements: requirements!,
    resolved,
  };
}

/** Record local evidence only. Normal guarded resume remains a separate action. */
export function applyPortraitClassification(
  s: Store,
  actorId: string,
  input: unknown,
) {
  migratePilot(s.db);
  const body = PortraitClassificationInput.parse(input);
  return s.transaction(() => {
    requireOperator(s, actorId);
    const requestHash = fingerprint(body, actorId);
    const prior = s.one<{ requestHash: string; body: string }>(
      "SELECT * FROM pilot_portrait_classifications WHERE jobId=?",
      body.jobId,
    );
    if (prior) {
      const record = PortraitClassificationRecord.parse(JSON.parse(prior.body));
      if (
        prior.requestHash !== requestHash ||
        fingerprint(
          PortraitClassificationInput.strip().parse(record),
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
    if (
      isRecoveryLocked(s) ||
      job.status !== "needs_editor" ||
      job.leaseToken !== null ||
      job.leaseUntil !== 0 ||
      pilotJobFunding(s, body.jobId)?.campaign.state !== "active" ||
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
        PORTRAIT_CLASSIFICATION_ACCEPTED,
      ) ||
      Array.from({ length: 12 }, (_, i) => i + 1).some(
        (n) => !step(s, body.jobId, `accepted_picture_meaning_v2_${n}`),
      )
    )
      throw new AccessError(
        409,
        "Wait for an unleased, unambiguous job stopped after all twelve ordinary illustration outcomes.",
      );
    const record = PortraitClassificationRecord.parse({
      ...body,
      version: 1,
      id: id(),
      actorId,
      recordedAt: now(),
      reviewSlotExtensionHash: hash(canonical(base.extension)),
      meaningInputHash: base.meaning.inputHash,
      requirementsInputHash: base.requirements.inputHash,
    });
    s.run(
      "INSERT INTO pilot_portrait_classifications VALUES(?,?,?)",
      body.jobId,
      requestHash,
      canonical(record),
    );
    return record;
  });
}
export function readPortraitClassification(s: Store, jobId: string) {
  const row = s.one<{ requestHash: string; body: string }>(
    "SELECT * FROM pilot_portrait_classifications WHERE jobId=?",
    jobId,
  );
  if (!row) return null;
  const record = PortraitClassificationRecord.parse(JSON.parse(row.body));
  const body = PortraitClassificationInput.strip().parse(record),
    base = bound(s, body);
  if (
    record.jobId !== jobId ||
    fingerprint(body, record.actorId) !== row.requestHash ||
    record.reviewSlotExtensionHash !== hash(canonical(base.extension)) ||
    record.meaningInputHash !== base.meaning.inputHash ||
    record.requirementsInputHash !== base.requirements.inputHash
  )
    fail();
  return { record, resolved: base.resolved };
}
