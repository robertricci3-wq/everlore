import { z } from "zod";
import { Transcript, type TranscriptDocument } from "../../shared/contracts.js";
import {
  CharacterVersion,
  VisualWorld,
  type Snapshot,
} from "../../shared/studio.js";
import { requireOperator } from "../access.js";
import { verifyProfile } from "../lab/profiles.js";
import { isRecoveryLocked } from "../recovery-lock.js";
import { canonical, hash, id, now, type Store } from "../store.js";
import { EngineError } from "./pipeline.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const Appearance = CharacterVersion.pick({
  silhouette: true,
  face: true,
  bodyColors: true,
  proportions: true,
}).strict();
export const MeetingAgeClarification = z
  .object({
    kind: z.literal("user_clarification"),
    usage: z.literal("illustration_guidance_only"),
    // Preserve the exact received words; this is separate from frozen source.
    quote: z
      .string()
      .min(1)
      .max(3000)
      .refine((value) => value.trim().length > 0),
    receivedAt: z.iso.datetime({ offset: true }),
    ages: z
      .array(
        z
          .object({
            characterId: z.string().min(1),
            age: z.number().int().min(18).max(120),
          })
          .strict(),
      )
      .min(1)
      .max(5),
  })
  .strict();
export const CharacterAppearanceInput = z
  .object({
    ownerId: z.string().min(1),
    projectId: z.string().min(1),
    jobId: z.string().min(1),
    checkpointId: z.string().min(1),
    sourceHash: digest,
    baseWorldHash: digest,
    characterId: z.string().min(1),
    appearance: Appearance,
    direction: z.string().trim().min(5).max(3000),
    meetingAgeClarification: MeetingAgeClarification.optional(),
  })
  .strict();
export const CHARACTER_APPEARANCE_STAGE = "operator_character_appearance_v1";
export const CharacterAppearanceRecord = CharacterAppearanceInput.extend({
  version: z.literal(1),
  id: z.string(),
  actorId: z.string(),
  createdAt: z.string(),
  profileHash: digest,
  requestHash: digest,
  derivedWorldHash: digest,
  before: Appearance,
  world: VisualWorld,
}).strict();
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const fingerprint = (
  body: z.infer<typeof CharacterAppearanceInput>,
  actorId: string,
  profileHash: string,
  requestHash: string,
) => hash(canonical({ body, actorId, profileHash, requestHash }));
function derive(
  world: Snapshot["world"],
  body: z.infer<typeof CharacterAppearanceInput>,
) {
  if (world.characters.filter((c) => c.id === body.characterId).length !== 1)
    throw new EngineError("Choose one character from the retained world.");
  const clarification = body.meetingAgeClarification;
  const ages = new Map(
    clarification?.ages.map((entry) => [entry.characterId, entry.age]) ?? [],
  );
  if (
    clarification &&
    (ages.size !== clarification.ages.length ||
      clarification.ages.some(
        (entry) =>
          world.characters.filter((c) => c.id === entry.characterId).length !==
          1,
      ))
  )
    throw new EngineError(
      "Meeting ages must name each existing character at most once.",
    );
  const meetingGuidance = clarification
    ? `\n\nPRIVATE ILLUSTRATION GUIDANCE ONLY — later user clarification received ${clarification.receivedAt}, separate from the original frozen transcript. Meeting likenesses: ${clarification.ages.map((entry) => `${world.characters.find((c) => c.id === entry.characterId)!.name} (${entry.characterId}) was ${entry.age}`).join("; ")}. Depict these mature adults at those ages in opening/meeting scenes. Teddy-like styling must not make an adult a child. Later scenes may show the passage of years only as supported by the Heart and manuscript; the meeting ages do not replace any later-life or death age. Do not copy these numbers or this clarification into narrative, title, labels, lettering, The True Parts or other backmatter.`
    : "";
  return VisualWorld.parse({
    ...world,
    worldRules: world.worldRules + meetingGuidance,
    characters: world.characters.map((c) => ({
      ...c,
      ...(c.id === body.characterId ? body.appearance : {}),
      ...(ages.has(c.id)
        ? {
            depictedAge: ages.get(c.id)!,
            ageState: `Mature adult, age ${ages.get(c.id)} at the meeting; later life stages follow the story timeline. Private illustration guidance, not story text.`,
          }
        : {}),
    })),
  });
}
function textStage(stage: string) {
  return (
    [
      "transcription",
      "heart",
      "heart_cue_evidence_v1",
      "heart_questions_v1",
      "operator_heart_correction_v1",
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

/** Append direction only. Existing resumeStudio still owns funding and restart. */
export function appendCharacterAppearanceDirection(
  store: Store,
  actorId: string,
  input: unknown,
) {
  const body = CharacterAppearanceInput.parse(input);
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
    const state = JSON.parse(job.state),
      request = JSON.parse(job.request);
    if (request.autonomous !== true)
      throw new EngineError(
        "Only an autonomous original story supports this appearance direction.",
      );
    const source = Transcript.parse(state.source);
    if (
      !project.transcript ||
      !same(source, Transcript.parse(JSON.parse(project.transcript))) ||
      hash(canonical(source)) !== body.sourceHash
    )
      throw new EngineError("The frozen source changed.");
    const profile = verifyProfile(request.engineProfile);
    if (
      profile.hash !== job.profile ||
      request.lab ||
      request.seed ||
      request.repair
    )
      throw new EngineError("The original generation profile changed.");
    const rawWorld = store.one<{ result: string }>(
      "SELECT result FROM studio_steps WHERE jobId=? AND stage='world' AND state='completed'",
      job.id,
    );
    if (!rawWorld)
      throw new EngineError("A completed original world is required.");
    const world = VisualWorld.parse(JSON.parse(rawWorld.result));
    if (hash(canonical(world)) !== body.baseWorldHash)
      throw new EngineError("The original world changed.");
    const requestHash = hash(canonical(request));
    const inputHash = fingerprint(body, actorId, job.profile, requestHash);
    const prior = store.one<{ inputHash: string; result: string }>(
      "SELECT inputHash,result FROM studio_steps WHERE jobId=? AND stage=? AND state='completed'",
      job.id,
      CHARACTER_APPEARANCE_STAGE,
    );
    if (prior) {
      if (prior.inputHash !== inputHash)
        throw new EngineError(
          "This appearance direction is immutable; the retry differs.",
        );
      return CharacterAppearanceRecord.parse(JSON.parse(prior.result));
    }
    if (
      isRecoveryLocked(store) ||
      job.status !== "needs_attention" ||
      job.baseRevision !== 0 ||
      project.revision !== 0 ||
      job.leaseToken !== null ||
      job.leaseUntil !== 0 ||
      store.one(
        "SELECT id FROM studio_jobs WHERE projectId=? AND rowid>(SELECT rowid FROM studio_jobs WHERE id=?)",
        body.projectId,
        job.id,
      ) ||
      store.one(
        "SELECT revision FROM revisions WHERE projectId=?",
        body.projectId,
      ) ||
      store.one("SELECT id FROM editions WHERE projectId=?", body.projectId)
    )
      throw new EngineError(
        "Only an original story stopped before visual work may receive appearance direction.",
      );
    if (
      request.familyVersionId ||
      state.familyVersionId ||
      state.castApproved ||
      state.artApproved ||
      (state.continuityBindings ?? []).some(
        (b: { personId: string | null }) => b.personId,
      )
    )
      throw new EngineError(
        "An established family design needs a separate character revision.",
      );
    const checkpoint = store.one<{ stage: string; inputHash: string }>(
      "SELECT stage,inputHash FROM studio_checkpoints WHERE id=? AND jobId=? AND reason='pause' AND resumedAt IS NULL",
      body.checkpointId,
      job.id,
    );
    if (
      !checkpoint ||
      checkpoint.stage !== job.stage ||
      (!textStage(job.stage) && job.stage !== "scenes") ||
      !store.one(
        "SELECT jobId FROM studio_pause_requests WHERE jobId=?",
        job.id,
      )
    )
      throw new EngineError(
        "A retained pre-dispatch operator pause is required.",
      );
    const steps = store.all<{
      stage: string;
      state: string;
      result: string | null;
      inputHash: string;
    }>(
      "SELECT stage,state,result,inputHash FROM studio_steps WHERE jobId=?",
      job.id,
    );
    if (
      steps.some(
        (s) =>
          !textStage(s.stage) &&
          !(
            s.stage === "scenes" &&
            checkpoint.stage === "scenes" &&
            s.state === "started" &&
            s.result === null &&
            s.inputHash === checkpoint.inputHash
          ),
      ) ||
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
        "SELECT hash FROM assets WHERE projectId=? AND kind IN ('art','pdf')",
        body.projectId,
      )
    )
      throw new EngineError(
        "Visual work or an unresolved paid request already exists.",
      );
    const pending = steps.find((s) => s.stage === checkpoint.stage);
    if (
      pending &&
      (pending.state !== "started" ||
        pending.result !== null ||
        pending.inputHash !== checkpoint.inputHash)
    )
      throw new EngineError(
        "The paused stage no longer matches its checkpoint.",
      );
    const changed = derive(world, body);
    if (same(changed, world))
      throw new EngineError(
        "The appearance direction does not change this character.",
      );
    const record = CharacterAppearanceRecord.parse({
      ...body,
      version: 1,
      id: id(),
      actorId,
      createdAt: now(),
      profileHash: job.profile,
      requestHash,
      derivedWorldHash: hash(canonical(changed)),
      before: Appearance.strip().parse(
        world.characters.find((c) => c.id === body.characterId),
      ),
      world: changed,
    });
    store.run(
      "INSERT INTO studio_steps VALUES(?,?,?,'completed',?)",
      job.id,
      CHARACTER_APPEARANCE_STAGE,
      inputHash,
      canonical(record),
    );
    return record;
  });
}

/** Resolve only AFTER text acceptance. Original world remains all text-stage input. */
export function resolveCharacterAppearance(
  store: Store,
  jobId: string,
  base: Snapshot["world"],
  source: TranscriptDocument,
): Snapshot["world"] {
  const row = store.one<{ result: string; inputHash: string }>(
    "SELECT result,inputHash FROM studio_steps WHERE jobId=? AND stage=? AND state='completed'",
    jobId,
    CHARACTER_APPEARANCE_STAGE,
  );
  if (!row) return base;
  const record = CharacterAppearanceRecord.parse(JSON.parse(row.result));
  const {
    ownerId,
    projectId,
    checkpointId,
    sourceHash,
    baseWorldHash,
    characterId,
    appearance,
    direction,
    meetingAgeClarification,
  } = record;
  const body = {
    ownerId,
    projectId,
    jobId: record.jobId,
    checkpointId,
    sourceHash,
    baseWorldHash,
    characterId,
    appearance,
    direction,
    ...(meetingAgeClarification ? { meetingAgeClarification } : {}),
  };
  const job = store.one<{
    projectId: string;
    request: string;
    profile: string;
    ownerId: string;
  }>(
    "SELECT j.projectId,j.request,j.profile,p.ownerId FROM studio_jobs j JOIN projects p ON p.id=j.projectId WHERE j.id=?",
    jobId,
  );
  if (
    !job ||
    record.jobId !== jobId ||
    job.projectId !== projectId ||
    job.ownerId !== ownerId ||
    job.profile !== record.profileHash ||
    hash(canonical(JSON.parse(job.request))) !== record.requestHash ||
    sourceHash !== hash(canonical(source)) ||
    baseWorldHash !== hash(canonical(base)) ||
    row.inputHash !==
      fingerprint(
        body,
        record.actorId,
        record.profileHash,
        record.requestHash,
      ) ||
    !same(record.world, derive(base, body)) ||
    record.derivedWorldHash !== hash(canonical(record.world))
  )
    throw new EngineError(
      "The appearance direction no longer matches this story.",
    );
  return record.world;
}
