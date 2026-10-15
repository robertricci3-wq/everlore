import { z } from "zod";
import { Transcript } from "../../shared/contracts.js";
import {
  HeartContract,
  HeartReview,
  EditorialReview,
  StoryManuscript,
  CRAFT_WEIGHTS,
} from "../../shared/studio.js";
import { requireOperator } from "../access.js";
import { pilotAccess, pilotJobFunding } from "../pilot/service.js";
import { pilotConnectionReady } from "../pilot/integration.js";
import { isRecoveryLocked } from "../recovery-lock.js";
import { canonical, hash, id, now, type Store } from "../store.js";
import { evaluateStory, heartProblems } from "./editorial.js";
import { PoeticsReview, poeticsProblems } from "./poetics.js";
import { EngineError } from "./pipeline.js";
import type { EngineConfig } from "./provider.js";
import {
  readOperatorEditorialRevisionV2,
  isPreVisualOperatorTextStage,
  OPERATOR_EDITORIAL_ACCEPTED_V2_STAGE,
} from "./operator-editorial-revision.js";

export const STORY_REVIEW_EDITION_STAGE =
  "story_review_edition_authorization_v1";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const StoryReviewEditionInput = z
  .object({
    ownerId: z.string().min(1),
    projectId: z.string().min(1),
    jobId: z.string().min(1),
    sourceHash: digest,
    profileHash: digest,
    manuscriptHash: digest,
    reviewedCandidateHash: digest,
    scope: z.literal("private_illustrated_story_review_only"),
    reason: z.string().trim().min(10).max(3000),
    approval: z
      .object({
        quote: z.string().trim().min(1).max(3000),
        receivedAt: z.iso.datetime({ offset: true }),
      })
      .strict(),
  })
  .strict();
export const StoryReviewEditionAuthorization = StoryReviewEditionInput.extend({
  version: z.literal(1),
  id: z.string(),
  actorId: z.string(),
  approvedAt: z.string(),
  operatorRevisionHash: digest,
  heartHash: digest,
  creationId: z.string(),
  campaignId: z.string(),
  policyHash: digest,
}).strict();
const fingerprint = (
  body: z.infer<typeof StoryReviewEditionInput>,
  actorId: string,
) => hash(canonical({ body, actorId }));
function read(store: Store, jobId: string, stage: string) {
  const row = store.one<{ inputHash: string; result: string }>(
    "SELECT inputHash,result FROM studio_steps WHERE jobId=? AND stage=? AND state='completed'",
    jobId,
    stage,
  );
  return row ? { ...row, value: JSON.parse(row.result) } : null;
}
function verifiedBase(
  store: Store,
  body: z.infer<typeof StoryReviewEditionInput>,
) {
  const revision = readOperatorEditorialRevisionV2(store, body.jobId);
  const candidate = read(
    store,
    body.jobId,
    OPERATOR_EDITORIAL_ACCEPTED_V2_STAGE,
  );
  if (
    !revision ||
    !candidate ||
    revision.ownerId !== body.ownerId ||
    revision.projectId !== body.projectId ||
    revision.sourceHash !== body.sourceHash ||
    revision.profileHash !== body.profileHash ||
    revision.manuscriptHash !== body.manuscriptHash ||
    candidate.inputHash !==
      hash(canonical({ input: revision, profile: revision.profileHash })) ||
    hash(canonical(candidate.value)) !== body.reviewedCandidateHash ||
    hash(canonical(candidate.value.manuscript)) !== body.manuscriptHash ||
    candidate.value.verdict?.passed !== false
  )
    throw new EngineError(
      "The exact failed second editorial revision is required.",
    );
  const state = JSON.parse(
    store.one<{ state: string }>(
      "SELECT state FROM studio_jobs WHERE id=?",
      body.jobId,
    )!.state,
  );
  const heart = HeartContract.parse(state.heart),
    source = Transcript.parse(state.source);
  const accepted = {
    manuscript: StoryManuscript.parse(candidate.value.manuscript),
    heartReview: HeartReview.parse(candidate.value.heartReview),
    editorialReview: EditorialReview.parse(candidate.value.editorialReview),
    poeticsReview: candidate.value.poeticsReview
      ? PoeticsReview.parse(candidate.value.poeticsReview)
      : undefined,
  };
  const criteria = Object.keys(CRAFT_WEIGHTS);
  if (
    accepted.editorialReview.scores.length !== criteria.length ||
    new Set(accepted.editorialReview.scores.map((score) => score.criterion))
      .size !== criteria.length ||
    criteria.some(
      (criterion) =>
        !accepted.editorialReview.scores.some(
          (score) => score.criterion === criterion,
        ),
    )
  )
    throw new EngineError(
      "The retained editorial review must have one complete, unique score per criterion.",
    );
  const verdict = evaluateStory(
    heart,
    accepted.manuscript,
    accepted.heartReview,
    accepted.editorialReview,
  );
  if (
    heartProblems(heart, source).length ||
    verdict.heartFailures.length ||
    verdict.mechanical.length ||
    !accepted.editorialReview.ageAppropriate ||
    accepted.editorialReview.genericStory ||
    (accepted.poeticsReview &&
      poeticsProblems(accepted.poeticsReview, accepted.manuscript).length)
  )
    throw new EngineError(
      "Protected source, structure, age suitability and the retained poetics checks must pass.",
    );
  if (
    store.one(
      "SELECT stage FROM studio_steps WHERE jobId=? AND stage='digital_review_copy_authorization_v1'",
      body.jobId,
    )
  )
    throw new EngineError(
      "This story-only authorization cannot be combined with an art-review waiver.",
    );
  return { revision, heart };
}

/** A one-book story-score exception only. No new writing, judging, image waiver or allowance. */
export function authorizeStoryReviewEdition(
  store: Store,
  actorId: string,
  input: unknown,
  config: EngineConfig,
) {
  const body = StoryReviewEditionInput.parse(input);
  return store.transaction(() => {
    requireOperator(store, actorId);
    const job = store.one<{
      kind: string;
      status: string;
      stage: string;
      leaseToken: string | null;
      leaseUntil: number;
      baseRevision: number;
      state: string;
    }>(
      "SELECT * FROM studio_jobs WHERE id=? AND projectId=?",
      body.jobId,
      body.projectId,
    );
    const project = store.one<{ revision: number }>(
      "SELECT revision FROM projects WHERE id=? AND ownerId=?",
      body.projectId,
      body.ownerId,
    );
    if (!job || !project || job.kind !== "generation")
      throw new EngineError(
        "This owner's original story job could not be found.",
      );
    const inputHash = fingerprint(body, actorId),
      prior = read(store, body.jobId, STORY_REVIEW_EDITION_STAGE);
    if (prior) {
      const record = StoryReviewEditionAuthorization.parse(prior.value);
      if (
        prior.inputHash !== inputHash ||
        fingerprint(
          StoryReviewEditionInput.strip().parse(record),
          record.actorId,
        ) !== inputHash
      )
        throw new EngineError(
          "This one-book authorization is immutable; the retry differs.",
        );
      return record;
    }
    const { revision, heart } = verifiedBase(store, body),
      state = JSON.parse(job.state);
    if (
      isRecoveryLocked(store) ||
      job.status !== "needs_editor" ||
      !/^operator_revision_v2_(?:heart|craft|poetics)$/.test(job.stage) ||
      job.leaseToken !== null ||
      job.leaseUntil !== 0 ||
      job.baseRevision !== 0 ||
      project.revision !== 0 ||
      state.castApproved ||
      state.artApproved ||
      state.familyVersionId ||
      store.one(
        "SELECT id FROM studio_jobs WHERE projectId=? AND rowid>(SELECT rowid FROM studio_jobs WHERE id=?)",
        body.projectId,
        body.jobId,
      ) ||
      store.one(
        "SELECT revision FROM revisions WHERE projectId=?",
        body.projectId,
      ) ||
      store.one("SELECT id FROM editions WHERE projectId=?", body.projectId) ||
      store.one(
        "SELECT jobId FROM studio_pause_requests WHERE jobId=?",
        body.jobId,
      )
    )
      throw new EngineError(
        "Only the stopped original pre-scenes second editorial review can receive this authorization.",
      );
    if (
      store
        .all<{ stage: string; state: string }>(
          "SELECT stage,state FROM studio_steps WHERE jobId=?",
          body.jobId,
        )
        .some(
          (s) =>
            !isPreVisualOperatorTextStage(s.stage) || s.state !== "completed",
        ) ||
      store
        .all<{ stage: string; kind: string; status: string }>(
          "SELECT stage,kind,status FROM studio_calls WHERE jobId=?",
          body.jobId,
        )
        .some(
          (c) =>
            !isPreVisualOperatorTextStage(c.stage) ||
            c.kind === "image" ||
            !["completed", "rejected"].includes(c.status),
        ) ||
      store.one(
        "SELECT id FROM pilot_attempts WHERE jobId=? AND status NOT IN ('completed','not_processed')",
        body.jobId,
      ) ||
      store.one(
        "SELECT hash FROM assets WHERE projectId=? AND kind IN ('art','pdf')",
        body.projectId,
      )
    )
      throw new EngineError(
        "Unfinished, visual, or ambiguous work prevents this authorization.",
      );
    const funding = pilotJobFunding(store, body.jobId),
      access = pilotAccess(store, body.ownerId);
    if (
      !funding ||
      funding.ownerId !== body.ownerId ||
      funding.creationId !== revision.creationId ||
      funding.campaign.id !== revision.campaignId ||
      funding.campaign.policyHash !== revision.policyHash ||
      funding.campaign.state !== "active" ||
      !access ||
      access.campaign.id !== funding.campaign.id ||
      access.remainingCents <= 0 ||
      !pilotConnectionReady(store, config)
    )
      throw new EngineError(
        "The existing funded pilot must be active; this action adds no allowance.",
      );
    const record = StoryReviewEditionAuthorization.parse({
      ...body,
      version: 1,
      id: id(),
      actorId,
      approvedAt: now(),
      operatorRevisionHash: hash(canonical(revision)),
      heartHash: hash(canonical(heart)),
      creationId: funding.creationId,
      campaignId: funding.campaign.id,
      policyHash: funding.campaign.policyHash,
    });
    store.run(
      "INSERT INTO studio_steps VALUES(?,?,?,'completed',?)",
      body.jobId,
      STORY_REVIEW_EDITION_STAGE,
      inputHash,
      canonical(record),
    );
    store.run(
      "UPDATE studio_jobs SET status='queued',error=NULL WHERE id=?",
      body.jobId,
    );
    store.run(
      "UPDATE projects SET status='creating_legacy' WHERE id=?",
      body.projectId,
    );
    return record;
  });
}

export function readStoryReviewEditionAuthorization(
  store: Store,
  jobId: string,
) {
  const saved = read(store, jobId, STORY_REVIEW_EDITION_STAGE);
  if (!saved) {
    if (
      store.one(
        "SELECT stage FROM studio_steps WHERE jobId=? AND stage=?",
        jobId,
        STORY_REVIEW_EDITION_STAGE,
      )
    )
      throw new EngineError("The story review-edition receipt is incomplete.");
    return null;
  }
  const record = StoryReviewEditionAuthorization.parse(saved.value),
    body = StoryReviewEditionInput.strip().parse(record);
  const { revision, heart } = verifiedBase(store, body);
  if (
    record.jobId !== jobId ||
    fingerprint(body, record.actorId) !== saved.inputHash ||
    hash(canonical(revision)) !== record.operatorRevisionHash ||
    hash(canonical(heart)) !== record.heartHash ||
    revision.creationId !== record.creationId ||
    revision.campaignId !== record.campaignId ||
    revision.policyHash !== record.policyHash
  )
    throw new EngineError(
      "The story review-edition authorization binding changed.",
    );
  return record;
}
