import { DigitalReviewCopyAuthorization } from "./review-copy-authorization.js";
import { IdentityScopeReview, identityScopePasses } from "./identity-scope.js";
import { SceneAttemptAuthorization } from "./scene-attempt.js";
import { worldProblems } from "./scene-validation.js";
import { isRecoveryLocked } from "../recovery-lock.js";
import {
  AccessError,
  allocateGeneration,
  requireAllocationIncrease,
} from "../access.js";
import {
  ReaderExperience,
  VisualDirection,
  PremiseDiversity,
} from "../../shared/picturebook.js";
import {
  readerExperienceProblems,
  premiseDiversityProblems,
  visualDirectionProblems,
  roughCompositionSvg,
} from "./picturebook.js";
import {
  ProductionImageReview,
  imageAccepted,
  imageReviewCopyEligible,
} from "./art-review.js";
import {
  reservedBudget,
  settleStudioReservations,
  ensureStudioBudgetRecords,
  studioPauseRequested,
  recordStudioCheckpoint,
  StudioPreDispatchPause,
} from "./budget.js";
import type { RequestCostBound } from "./request-cost.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Book,
  Transcript,
  type TranscriptDocument,
} from "../../shared/contracts.js";
import {
  STUDIO_VERSION,
  STYLE_VERSION,
  HeartContract,
  ConceptSet,
  ConceptReview,
  StoryPlan,
  VisualWorld,
  StoryManuscript,
  HeartReview,
  EditorialReview,
  ScenePlan,
  ProductionSnapshot,
  RepairRequest,
  ManuscriptPatch,
  ScenePatch,
  CharacterVersion,
  CRAFT_WEIGHTS,
  type Heart,
  type Snapshot,
  type StudioView,
  type StoryVerdict,
} from "../../shared/studio.js";
import { Store, canonical, hash, id, now, type ProjectRow } from "../store.js";
import { finalizeBook, renderPdf } from "../layout.js";
import {
  type Provider,
  type EngineConfig,
  availability,
  ProviderRequestError,
} from "./provider.js";
import { studioRecovery } from "./recovery.js";
import { EngineError } from "./pipeline.js";
import {
  STORY_SYSTEM as DEFAULT_STORY_SYSTEM,
  ART_SYSTEM as DEFAULT_ART_SYSTEM,
  instructions as defaultInstructions,
} from "./studio-prompts.js";
import { activeProfile, verifyProfile } from "../lab/profiles.js";
import { legacyImageRender } from "../../shared/imageRender.js";
import type { Profile } from "../../shared/profile.js";
import { PoeticsReview, POETICS_PROMPT, poeticsProblems } from "./poetics.js";
import { explicitAudioCues } from "./craft.js";
import { CALIBRATION_VERSION } from "./calibration.js";
import {
  heartProblems,
  reconcileHeartCues,
  chooseConcept,
  planProblems,
  evaluateStory,
  canAssembleReviewCopy,
  notWorse,
} from "./editorial.js";
import {
  ContinuityMode,
  PinnedContinuity,
  type ContinuityState,
} from "../../shared/continuity.js";
import {
  ContinuityAnswer,
  continuityFamilies,
  pinStudioContinuity,
  resolveContinuity,
  rememberContinuityCast,
  rememberStoryContinuity,
  type ContinuityResolution,
  inheritedContinuityBindings,
} from "./continuity.js";
export { pinStudioContinuity } from "./continuity.js";
import { pilotCreationFunding, pilotJobFunding, linkPilotJob, reservePilotRequest, markPilotDispatched, settlePilotRequest } from "../pilot/service.js";
import type { EstimatedRequestReservation } from "./request-cost.js";

interface State {
  continuity?: ContinuityState;
  continuityBindings?: ContinuityResolution["bindings"];
  source?: TranscriptDocument;
  sourceApproved?: boolean;
  heart?: Heart;
  castApproved?: boolean;
  artApproved?: boolean;
  familyVersionId?: string | null;
  selectedConceptId?: string;
}
interface RequestData {
  continuity?: PinnedContinuity;
  strictCostGuard?: boolean;
  engineProfile?: Profile;
  autonomous?: boolean;
  lab?: { runId: string; lane: "story" | "book" };
  consent: {
    processWithOpenAI: true;
    imaginativeAdaptation: true;
    legacyWish: string;
  };
  familyVersionId: string | null;
  repair?: z.infer<typeof RepairRequest>;
  seed?: Snapshot;
}
export interface StudioJob {
  id: string;
  projectId: string;
  baseRevision: number;
  kind: string;
  status: string;
  stage: string;
  request: string;
  state: string;
  profile: string;
  allowance: number;
  leaseUntil: number;
  leaseToken: string | null;
  error: string | null;
}
const fingerprint = (config: EngineConfig) =>
  canonical({
    version: STUDIO_VERSION,
    calibration: CALIBRATION_VERSION,
    text: config.textModel,
    image: config.imageModel,
    audio: config.audioModel,
  });
export { studioReservation as studioAllowance } from "../../shared/studioSetup.js";
import { studioReservation as studioAllowance } from "../../shared/studioSetup.js";
export function studioCached<T>(
  store: Store,
  jobId: string,
  stage: string,
): T | null {
  const row = store.one<{ result: string }>(
    "SELECT result FROM studio_steps WHERE jobId=? AND stage=? AND state='completed'",
    jobId,
    stage,
  );
  return row ? (JSON.parse(row.result) as T) : null;
}
export function latestStudio(store: Store, projectId: string) {
  return store.one<StudioJob>(
    "SELECT * FROM studio_jobs WHERE projectId=? ORDER BY rowid DESC LIMIT 1",
    projectId,
  );
}
export function familyVersions(store: Store, ownerId: string) {
  return store.all<{ id: string; name: string; createdAt: string }>(
    `SELECT f.id,f.name,f.createdAt FROM family_versions f WHERE f.ownerId=?
     ORDER BY (SELECT MAX(j.rowid) FROM studio_jobs j JOIN projects p ON p.id=j.projectId
       WHERE p.ownerId=f.ownerId AND json_extract(j.state,'$.familyVersionId')=f.id) DESC, f.rowid DESC`,
    ownerId,
  );
}
function family(store: Store, ownerId: string, familyId: string) {
  const row = store.one<{ world: string; referenceData: string }>(
    "SELECT world,referenceData FROM family_versions WHERE id=? AND ownerId=?",
    familyId,
    ownerId,
  );
  if (!row) throw new EngineError("That family cast is not on your shelf.");
  return {
    world: VisualWorld.parse(JSON.parse(row.world)),
    references: ProductionSnapshot.shape.references.parse(
      JSON.parse(row.referenceData),
    ),
  };
}
function importFamilyReferences(
  store: Store,
  projectId: string,
  familyId: string,
  refs: Snapshot["references"],
) {
  for (const ref of refs) {
    if (
      !ref.approved ||
      !store.one(
        "SELECT hash FROM family_assets WHERE familyId=? AND hash=?",
        familyId,
        ref.hash,
      )
    )
      throw new EngineError("A family reference needs approval.");
    const bytes = readFileSync(join(store.dir, "media", ref.hash));
    if (hash(bytes) !== ref.hash)
      throw new EngineError("A family reference failed its integrity check.");
    store.putAsset(projectId, bytes, "art");
  }
}
function insertJob(
  store: Store,
  project: ProjectRow,
  request: RequestData,
  state: State,
  config: EngineConfig,
  kind: string,
) {
  if (!availability(config).ready)
    throw new EngineError(availability(config).message);
  const pilot = config.pilotCreationId ? pilotCreationFunding(store, config.pilotCreationId) : null;
  if (config.pilotCreationId && !pilot) throw new EngineError("This pilot book has no authorized creation request.");
  const allowance = pilot ? 0 : studioAllowance(config),
    used = reservedBudget(store);
  if (!pilot && used + allowance > config.budgetCents)
    throw new EngineError(
      "The approved allowance does not cover this bounded story and art cycle. Your work is saved.",
    );
  request.engineProfile ??=
    request.seed?.engineProfile ?? activeProfile(store, config);
  request.autonomous ??= request.seed?.automation !== "guided";
  request.strictCostGuard = config.strictCostGuard === true;
  const jobId = id();
  if (!pilot) allocateGeneration(
    store,
    project.ownerId,
    jobId,
    allowance,
    config,
    kind === "generation",
  );
  if (!pilot) store.run("INSERT INTO engine_budget VALUES(?,?,?)", jobId, allowance, now());
  store.run(
    "INSERT INTO studio_jobs(id,projectId,baseRevision,kind,status,stage,request,state,profile,allowance,createdAt) VALUES(?,?,?,?,'queued','source',?,?,?,?,?)",
    jobId,
    project.id,
    project.revision,
    kind,
    JSON.stringify(request),
    JSON.stringify(state),
    request.engineProfile.hash,
    allowance,
    now(),
  );
  if (pilot) linkPilotJob(store, project.ownerId, config.pilotCreationId!, jobId);
  store.run(
    "UPDATE projects SET status='creating_legacy' WHERE id=?",
    project.id,
  );
  return jobId;
}
export function queueStudio(
  store: Store,
  project: ProjectRow,
  input: unknown,
  config: EngineConfig,
  pinnedProfile?: Profile,
  pinnedContinuity?: PinnedContinuity,
) {
  const body = z
    .object({
      processWithOpenAI: z.literal(true),
      imaginativeAdaptation: z.literal(true),
      legacyWish: z.string().trim().max(1000).default(""),
      familyVersionId: z.string().nullable().default(null),
      autonomous: z.boolean().default(true),
      continuityMode: ContinuityMode.optional(),
    })
    .parse(input);
  return store.transaction(() => {
    const previous = latestStudio(store, project.id);
    if (previous) return previous.id;
    if (
      project.mode === "synthetic_fixture" ||
      project.revision ||
      store.one("SELECT id FROM engine_runs WHERE projectId=?", project.id)
    )
      throw new EngineError("Start with an unadapted memory.");
    const recording = store.one<{ mime: string }>(
      "SELECT mime FROM recordings WHERE projectId=?",
      project.id,
    );
    if (!recording && !project.transcript)
      throw new EngineError("Save a recording or a memory first.");
    if (recording?.mime === "audio/ogg" && !project.transcript)
      throw new EngineError(
        "Add a manual transcript for this OGG recording first.",
      );
    if (body.familyVersionId)
      family(store, project.ownerId, body.familyVersionId);
    const continuity = pinnedContinuity
      ? PinnedContinuity.parse(pinnedContinuity)
      : body.continuityMode
        ? pinStudioContinuity(
            store,
            project.ownerId,
            body.continuityMode,
            body.familyVersionId,
          )
        : undefined;
    if (continuity) continuityFamilies(store, project.ownerId, continuity);
    return insertJob(
      store,
      project,
      {
        consent: body,
        familyVersionId: body.familyVersionId,
        autonomous: body.autonomous,
        ...(pinnedProfile
          ? { engineProfile: verifyProfile(pinnedProfile) }
          : {}),
        ...(continuity ? { continuity } : {}),
      },
      {
        source: project.transcript
          ? Transcript.parse(JSON.parse(project.transcript))
          : undefined,
        sourceApproved: project.status === "awaiting_editorial",
      },
      config,
      "generation",
    );
  });
}
function approve(
  store: Store,
  projectId: string,
  status: string,
  gate: string,
  update: (job: StudioJob, state: State) => State,
) {
  store.transaction(() => {
    const job = latestStudio(store, projectId);
    if (!job || job.status !== status)
      throw new EngineError(
        "This review has changed. Reopen the current story.",
      );
    const state = update(job, JSON.parse(job.state));
    store.run(
      "INSERT INTO studio_approvals VALUES(?,?,?,?,?)",
      job.id,
      gate,
      hash(canonical(state)),
      JSON.stringify(state),
      now(),
    );
    store.run(
      "UPDATE studio_jobs SET state=?,status='queued',error=NULL WHERE id=?",
      JSON.stringify(state),
      job.id,
    );
    store.run(
      "UPDATE projects SET status='creating_legacy' WHERE id=?",
      projectId,
    );
  });
}
export function confirmStudioSource(
  store: Store,
  projectId: string,
  input: unknown,
) {
  const body = z
    .object({
      confirmed: z.literal(true),
      rawText: z.string().trim().min(10).max(50000),
    })
    .parse(input);
  approve(store, projectId, "awaiting_source", "source", (_job, state) => {
    const p = store.one<ProjectRow>(
      "SELECT * FROM projects WHERE id=?",
      projectId,
    )!;
    if (
      p.transcript &&
      Transcript.parse(JSON.parse(p.transcript)).rawText !== body.rawText
    )
      throw new EngineError("The original transcript is already stored.");
    const source = Transcript.parse({
      ...state.source,
      rawText: body.rawText,
      mode:
        state.source?.rawText === body.rawText ? state.source.mode : "manual",
      segments: body.rawText
        .split(/\n+|(?<=[.!?])\s+/)
        .filter(Boolean)
        .map((text, i) => ({
          id: `s${i + 1}`,
          text,
          startMs: null,
          endMs: null,
        })),
    });
    store.run(
      "UPDATE projects SET transcript=? WHERE id=?",
      JSON.stringify(source),
      projectId,
    );
    return { ...state, source, sourceApproved: true };
  });
}
export function confirmStudioHeart(
  store: Store,
  projectId: string,
  input: unknown,
) {
  const body = z
    .object({
      heartHash: z.string(),
      summary: z.string().trim().min(1).max(3000),
      emotionalInheritance: z.string().trim().min(1).max(3000),
      protectedIds: z.array(z.string()).min(1),
      adultNotes: z.string().max(3000),
      answers: z.array(
        z.object({ id: z.string(), answer: z.string().max(1500) }),
      ),
    })
    .parse(input);
  approve(store, projectId, "awaiting_heart", "heart", (job, state) => {
    const original = studioCached<Heart>(store, job.id, "heart")!;
    if (
      hash(canonical(original)) !== body.heartHash ||
      body.protectedIds.some((id) => !original.nuggets.some((n) => n.id === id))
    )
      throw new EngineError("The memory review changed. Please reopen it.");
    const heart = HeartContract.parse({
      ...original,
      summary: body.summary,
      emotionalInheritance: body.emotionalInheritance,
      adultNotes: body.adultNotes,
      ledger: original.ledger.map((e) => ({
        ...e,
        tier: body.protectedIds.includes(e.nuggetId)
          ? "protected"
          : e.tier === "protected"
            ? "flexible"
            : e.tier,
      })),
      questions: original.questions.map((q) => ({
        ...q,
        answer:
          body.answers.find((a) => a.id === q.id)?.answer.trim() ?? q.answer,
      })),
    });
    if (heart.questions.some((q) => q.essential && !q.answer))
      throw new EngineError(
        "Answer the essential memory question before continuing.",
      );
    return { ...state, heart };
  });
}
export function approveStudioCast(
  store: Store,
  projectId: string,
  input: unknown,
) {
  z.object({ approved: z.literal(true) }).parse(input);
  approve(store, projectId, "awaiting_cast", "cast", (job, state) => {
    const world = studioCached<Snapshot["world"]>(store, job.id, "world")!,
      refs = studioCached<Snapshot["references"]>(
        store,
        job.id,
        "references",
      )!.map((r) => ({ ...r, approved: true }));
    const owner = store.one<ProjectRow>(
        "SELECT * FROM projects WHERE id=?",
        projectId,
      )!.ownerId,
      familyId = id();
    store.run(
      "INSERT INTO family_versions VALUES(?,?,?,?,?,?)",
      familyId,
      owner,
      world.name,
      JSON.stringify(world),
      JSON.stringify(refs),
      now(),
    );
    for (const ref of refs)
      store.run("INSERT INTO family_assets VALUES(?,?)", familyId, ref.hash);
    if (state.source)
      rememberContinuityCast(
        store,
        owner,
        familyId,
        world,
        state.source,
        state.continuityBindings ??
          inheritedContinuityBindings(
            store,
            state.familyVersionId,
            world,
            state.source,
          ),
      );
    return { ...state, castApproved: true, familyVersionId: familyId };
  });
}
export function answerStudioContinuity(
  store: Store,
  projectId: string,
  input: unknown,
) {
  const body = ContinuityAnswer.parse(input);
  return store.transaction(() => {
    const job = latestStudio(store, projectId);
    if (!job) throw new EngineError("This story is no longer available.");
    const state = JSON.parse(job.state) as State;
    const prior = state.continuity?.responses[body.questionId];
    if (prior) {
      if (
        canonical(prior) !==
        canonical({
          answerId: body.answerId,
          key: body.key,
          ...(body.text ? { text: body.text } : {}),
        })
      )
        throw new EngineError(
          "This question already has a saved answer. Reopen your story.",
        );
      return { ok: true };
    }
    const question = state.continuity?.questions.find(
      (q) => q.id === body.questionId,
    );
    if (job.status !== "awaiting_continuity" || !question || !state.continuity)
      throw new EngineError("This question has changed. Reopen your story.");
    if (
      Object.values(state.continuity.responses).some(
        (answer) => answer.key === body.key,
      )
    )
      throw new EngineError("That answer key belongs to another question.");
    if (
      !(question.allowUnspecified && body.answerId === "unspecified") &&
      !question.options.some((o) => o.id === body.answerId)
    )
      throw new EngineError("Choose one of the saved answers.");
    if (
      question.kind === "relationship" &&
      body.answerId === "answer" &&
      !body.text?.trim()
    )
      throw new EngineError(
        "Add a short answer, or choose that you are not sure.",
      );
    state.continuity.responses[question.id] = {
      answerId: body.answerId,
      key: body.key,
      ...(body.text ? { text: body.text } : {}),
    };
    if (question.kind === "relationship" && state.heart) {
      const questionId = question.id.slice("relationship-".length);
      const answer =
        body.answerId === "unspecified"
          ? "The family is unsure. Keep this relationship unspecified; do not invent an answer."
          : `Family clarification: ${body.text}`;
      state.heart.questions = state.heart.questions.map((q) =>
        q.id === questionId ? { ...q, answer, essential: false } : q,
      );
      if (body.answerId === "unspecified")
        state.heart.sensitiveBoundaries.push(answer);
    }
    const pending = state.continuity.questions.some(
      (q) => !state.continuity!.responses[q.id],
    );
    store.run(
      "UPDATE studio_jobs SET state=?,status=?,error=NULL,leaseToken=NULL,leaseUntil=0 WHERE id=?",
      JSON.stringify(state),
      pending ? "awaiting_continuity" : "queued",
      job.id,
    );
    return { ok: true };
  });
}
export function approveStudioArt(
  store: Store,
  projectId: string,
  input: unknown,
) {
  z.object({ approved: z.literal(true) }).parse(input);
  approve(store, projectId, "awaiting_art", "art", (_job, state) => ({
    ...state,
    artApproved: true,
  }));
}
export function queueRepair(
  store: Store,
  project: ProjectRow,
  input: unknown,
  config: EngineConfig,
  options: { renderProfile?: Profile } = {},
) {
  const repair = RepairRequest.parse(input);
  const renderProfile = options.renderProfile
    ? verifyProfile(options.renderProfile)
    : undefined;
  if (repair.kind === "resolution") {
    if (
      !renderProfile ||
      renderProfile.imageRender?.capability !== "verified" ||
      renderProfile.imageRender.width !== 2560 ||
      renderProfile.imageRender.height !== 2560 ||
      renderProfile.imageRender.quality !== "high" ||
      renderProfile.change.target !== "art" ||
      canonical([...repair.spreads].sort((a, b) => a - b)) !==
        canonical(Array.from({ length: 12 }, (_, i) => i + 1)) ||
      repair.characterId
    )
      throw new EngineError(
        "A print-art revision requires a verified 2560-pixel profile and all twelve spreads.",
      );
  } else if (renderProfile)
    throw new EngineError(
      "Only print-art revisions may override the rendering profile.",
    );
  return store.transaction(() => {
    const duplicate = store
      .all<StudioJob>(
        "SELECT * FROM studio_jobs WHERE projectId=? AND kind='repair'",
        project.id,
      )
      .find(
        (j) =>
          (JSON.parse(j.request) as RequestData).repair?.key === repair.key,
      );
    if (duplicate) {
      if (
        canonical((JSON.parse(duplicate.request) as RequestData).repair) !==
          canonical(repair) ||
        (renderProfile &&
          (JSON.parse(duplicate.request) as RequestData).engineProfile?.hash !==
            renderProfile.hash)
      )
        throw new EngineError(
          "That repair key already belongs to another request.",
        );
      return duplicate.id;
    }
    if (project.revision !== repair.baseRevision)
      throw new EngineError("The book changed. Reopen its current revision.");
    const previous = latestStudio(store, project.id);
    if (previous && previous.status !== "complete")
      throw new EngineError(
        "Finish the current review before starting another repair.",
      );
    const book = Book.parse(
      JSON.parse(
        store.one<{ book: string }>(
          "SELECT book FROM revisions WHERE projectId=? AND revision=?",
          project.id,
          project.revision,
        )!.book,
      ),
    );
    if (!book.production)
      throw new EngineError(
        "This earlier book does not have a repairable studio snapshot.",
      );
    if (renderProfile) {
      const base = book.production.engineProfile;
      if (!base || renderProfile.parentHash !== base.hash)
        throw new EngineError(
          "The print-art profile must derive from this edition's pinned profile.",
        );
      const content = (p: Profile) => {
        const {
          hash: _hash,
          name: _name,
          parentHash: _parent,
          change: _change,
          imageRender: _render,
          ...rest
        } = p;
        return rest;
      };
      if (canonical(content(base)) !== canonical(content(renderProfile)))
        throw new EngineError(
          "A print-art revision cannot change storytelling, models, canon rules or evaluation criteria.",
        );
    }
    if (
      repair.kind === "character" &&
      !book.production.world.characters.some((c) => c.id === repair.characterId)
    )
      throw new EngineError("Choose an existing family character.");
    if (repair.kind === "character") {
      const affected = book.production.scenes.scenes
        .filter((s) => s.characterIds.includes(repair.characterId!))
        .map((s) => s.spread);
      if (
        canonical([...repair.spreads].sort((a, b) => a - b)) !==
        canonical(affected)
      )
        throw new EngineError(
          "A character change must include every scene in which that character appears. Reopen the current book and try again.",
        );
    }
    const consent = previous
      ? (JSON.parse(previous.request) as RequestData).consent
      : {
          processWithOpenAI: true as const,
          imaginativeAdaptation: true as const,
          legacyWish: book.production.heart.emotionalInheritance,
        };
    const familyVersionId =
      book.production.familyVersionId &&
      store.one(
        "SELECT id FROM family_versions WHERE id=? AND ownerId=?",
        book.production.familyVersionId,
        project.ownerId,
      )
        ? book.production.familyVersionId
        : null;
    return insertJob(
      store,
      project,
      {
        consent,
        familyVersionId,
        repair,
        seed: book.production,
        ...(renderProfile ? { engineProfile: renderProfile } : {}),
      },
      {
        source: book.transcript,
        sourceApproved: true,
        heart: book.production.heart,
        castApproved: repair.kind !== "character",
        familyVersionId,
      },
      config,
      "repair",
    );
  });
}
export function changeDirection(
  store: Store,
  project: ProjectRow,
  input: unknown,
  config: EngineConfig,
) {
  const body = z
    .object({ conceptId: z.string(), jobId: z.string() })
    .parse(input);
  return store.transaction(() => {
    const job = latestStudio(store, project.id);
    if (
      !job ||
      job.id !== body.jobId ||
      !["awaiting_cast", "awaiting_art", "needs_editor"].includes(job.status) ||
      job.kind !== "generation"
    )
      throw new EngineError("This story is not waiting for a new direction.");
    const concepts = studioCached<z.infer<typeof ConceptSet>>(
        store,
        job.id,
        "concepts",
      ),
      state: State = JSON.parse(job.state);

    if (
      !concepts?.concepts.some((c) => c.id === body.conceptId) ||
      !state.heart
    )
      throw new EngineError("Choose an available story direction.");
    store.run("UPDATE studio_jobs SET status='superseded' WHERE id=?", job.id);
    const request: RequestData = JSON.parse(job.request),
      next = insertJob(
        store,
        project,
        request,
        {
          source: state.source,
          sourceApproved: true,
          heart: state.heart,
          selectedConceptId: body.conceptId,
        },
        config,
        "generation",
      );
    // A local, immutable seed; paid outputs are never relabeled as newly generated.
    store.run(
      "INSERT INTO studio_steps VALUES(?, 'seed_concepts', ?, 'completed', ?)",
      next,
      hash(canonical(concepts)),
      JSON.stringify(concepts),
    );
    return next;
  });
}
export function studioView(store: Store, projectId: string): StudioView | null {
  const job = latestStudio(store, projectId);
  if (!job) return null;
  const state: State = JSON.parse(job.state),
    accepted =
      studioCached<{ manuscript: Snapshot["manuscript"] }>(
        store,
        job.id,
        "accepted_story_editorial_attention_v1",
      ) ??
      studioCached<{ manuscript: Snapshot["manuscript"] }>(
        store,
        job.id,
        "accepted_story_evidence_v1",
      ) ??
      studioCached<{ manuscript: Snapshot["manuscript"] }>(
        store,
        job.id,
        "accepted_story",
      );
  const heart = state.heart ?? studioCached<Heart>(store, job.id, "heart");
  const scenes = studioCached<Snapshot["scenes"]>(store, job.id, "scenes");
  const progressArt = Array.from({ length: 12 }, (_, i) => ({
    spread: i + 1,
    artHash:
      studioCached<string>(
        store,
        job.id,
        `accepted_picture_meaning_v2_${i + 1}`,
      ) ??
      studioCached<string>(
        store,
        job.id,
        `accepted_picture_meaning_v1_${i + 1}`,
      ) ??
      studioCached<string>(
        store,
        job.id,
        `accepted_picture_evidence_v1_${i + 1}`,
      ) ??
      studioCached<string>(store, job.id, `accepted_picture_${i + 1}`),
  })).find((picture) => picture.artHash);
  const preview =
    job.status === "awaiting_art" && accepted && heart
      ? {
          title: accepted.manuscript.title,
          heart: heart.emotionalInheritance,
          inventions: accepted.manuscript.inventions,
          spreads: [0, 5, 10].map((i) => ({
            text: accepted.manuscript.spreads[i].text,
            artHash:
              studioCached<string>(
                store,
                job.id,
                `accepted_picture_meaning_v2_${i + 1}`,
              ) ??
              studioCached<string>(
                store,
                job.id,
                `accepted_picture_meaning_v1_${i + 1}`,
              ) ??
              studioCached<string>(
                store,
                job.id,
                `accepted_picture_evidence_v1_${i + 1}`,
              ) ??
              studioCached<string>(store, job.id, `accepted_picture_${i + 1}`)!,
            artDescription: scenes?.scenes[i].action ?? "Story illustration",
          })),
        }
      : null;
  return {
    ...(progressArt?.artHash
      ? {
          progressPreview: {
            artHash: progressArt.artHash,
            alt:
              scenes?.scenes[progressArt.spread - 1]?.action ??
              "An illustration from your story",
          },
        }
      : {}),
    ...(state.continuity
      ? {
          continuity: {
            status: state.continuity.questions.some(
              (q) => !state.continuity!.responses[q.id],
            )
              ? ("needs_identity" as const)
              : ("resolved" as const),
            question:
              state.continuity.questions.find(
                (q) => !state.continuity!.responses[q.id],
              ) ?? null,
          },
        }
      : {}),
    id: job.id,
    status: job.status,
    stage: job.stage,
    error: job.error,
    transcript: state.source?.rawText ?? null,
    heart,
    heartHash: heart ? hash(canonical(heart)) : null,
    concepts: studioCached(store, job.id, "concepts"),
    selectedConceptId:
      studioCached<{ id: string }>(store, job.id, "selected_concept")?.id ??
      null,
    world: studioCached(store, job.id, "world"),
    references: studioCached(store, job.id, "references") ?? [],
    preview,
    kind: job.kind,
    recovery: studioRecovery(store, job.id),
  };
}
export async function runStudio(
  store: Store,
  provider: Provider,
  config: EngineConfig,
  options: { jobId?: string; shouldContinue?: () => boolean } = {},
) {
  if (isRecoveryLocked(store) || !availability(config).ready) return false;
  ensureStudioBudgetRecords(store);
  store.run(
    "CREATE TABLE IF NOT EXISTS studio_image_renders(callId TEXT PRIMARY KEY,body TEXT NOT NULL)",
  );
  const token = id(),
    job = store.transaction(() => {
      const row = store.one<StudioJob>(
        `SELECT * FROM studio_jobs WHERE kind!='interview_transcription' AND (status='queued' OR (status='running' AND leaseUntil<?)) AND ${options.jobId ? "id=?" : "NOT EXISTS(SELECT 1 FROM lab_runs WHERE lab_runs.jobId=studio_jobs.id) AND NOT EXISTS(SELECT 1 FROM pilot_jobs WHERE jobId=studio_jobs.id)"} ORDER BY rowid LIMIT 1`,
        Date.now(),
        ...(options.jobId ? [options.jobId] : []),
      );
      if (row)
        store.run(
          "UPDATE studio_jobs SET status='running',leaseToken=?,leaseUntil=? WHERE id=?",
          token,
          Date.now() + 240000,
          row.id,
        );
      return row;
    });
  if (!job) return false;
  const pilotFunding = pilotJobFunding(store, job.id);
  const request: RequestData = JSON.parse(job.request),
    state: State = JSON.parse(job.state);
  // A strict job must stay strict if it is resumed under a later server config.
  if (config.strictCostGuard && !pilotFunding && !request.lab && !request.strictCostGuard) {
    request.strictCostGuard = true;
    store.run(
      "UPDATE studio_jobs SET request=? WHERE id=?",
      JSON.stringify(request),
      job.id,
    );
  }
  const strictCosts = !pilotFunding && !request.lab && request.strictCostGuard === true;
  const profile = request.engineProfile
    ? verifyProfile(request.engineProfile)
    : null;
  const STORY_SYSTEM = profile?.storySystem ?? DEFAULT_STORY_SYSTEM,
    ART_SYSTEM = profile?.artSystem ?? DEFAULT_ART_SYSTEM;
  const instructions = profile
    ? { ...defaultInstructions, ...profile.instructions }
    : defaultInstructions;
  if (profile) {
    config = {
      ...config,
      textModel: profile.models.text,
      imageModel: profile.models.image,
      audioModel: profile.models.audio,
    };
    provider = provider.withModels?.(profile.models) ?? provider;
    provider =
      provider.withImageRender?.(
        profile.imageRender ?? legacyImageRender(profile.models.image),
      ) ?? provider;
  }
  const readerPlanning = profile?.craftRules.readerExperienceVersion === 1;
  const visualPlanning = profile?.craftRules.visualDirectionVersion === 1;
  const diversityPlanning = profile?.craftRules.premiseDiversityVersion === 1;
  const owns = () =>
    !!store.one(
      "SELECT id FROM studio_jobs WHERE id=? AND leaseToken=? AND status='running' AND leaseUntil>?",
      job.id,
      token,
      Date.now(),
    );
  const heartbeat = setInterval(() => {
    store.run(
      "UPDATE studio_jobs SET leaseUntil=? WHERE id=? AND leaseToken=? AND status='running'",
      Date.now() + 240000,
      job.id,
      token,
    );
  }, 15000);
  const pause = (status: string, error: string | null = null) => {
    if (!owns()) throw new EngineError("This studio job changed.");
    store.run(
      "UPDATE studio_jobs SET status=?,error=?,state=?,leaseToken=NULL,leaseUntil=0 WHERE id=?",
      status,
      error,
      JSON.stringify(state),
      job.id,
    );
    store.run(
      "UPDATE projects SET status='legacy_review' WHERE id=? AND revision=?",
      job.projectId,
      job.baseRevision,
    );
  };
  let reserveActiveRequest: ((bound: RequestCostBound) => void) | undefined;
  let reserveEstimatedRequest: ((estimate: EstimatedRequestReservation) => void) | undefined;
  if (pilotFunding && provider.withEstimatedPolicy)
    provider = provider.withEstimatedPolicy(pilotFunding.campaign.policy.requestPolicy, pilotFunding.campaign.policyHash, (estimate) => {
      if (!reserveEstimatedRequest) throw new StudioPreDispatchPause("This pilot request has no durable stage.");
      reserveEstimatedRequest(estimate);
    });
  const guardedProvider = strictCosts && !!provider.withRequestGuard;
  if (guardedProvider)
    provider = provider.withRequestGuard!((bound) => {
      if (!reserveActiveRequest)
        throw new StudioPreDispatchPause(
          "A paid request has no active durable stage.",
        );
      reserveActiveRequest(bound);
    });
  const step = async <T>(
    name: string,
    input: unknown,
    fn: () => Promise<T>,
    kind: "text" | "image" | "audio" | "local" = "text",
  ): Promise<T> => {
    if (!owns()) throw new EngineError("This studio job changed.");
    const inputHash = hash(canonical({ input, profile: job.profile })),
      previous = store.one<{
        inputHash: string;
        state: string;
        result: string | null;
      }>("SELECT * FROM studio_steps WHERE jobId=? AND stage=?", job.id, name);
    if (previous) {
      if (previous.inputHash !== inputHash)
        throw new EngineError(
          "An input changed at a saved checkpoint. Start a new reviewed revision.",
        );
      if (previous.state === "completed")
        return JSON.parse(previous.result!) as T;
      if (kind !== "local")
        throw new EngineError(
          "A request may already have completed. Reconcile it before any paid retry.",
        );
    }
    const estimate =
      kind === "local" || request.lab
        ? 0
        : kind === "image"
          ? config.imageReserve
          : kind === "audio"
            ? config.audioReserve
            : config.textReserve;
    const callId = id(),
      start = Date.now();
    let dispatched = false,
      status = "ambiguous_failure";
    const previousGuard = reserveActiveRequest;
    const previousEstimateGuard = reserveEstimatedRequest;
    const checkContinue = () => {
      if (!owns()) throw new EngineError("This studio job changed.");
      if (options.shouldContinue && !options.shouldContinue()) {
        if (request.lab) throw new LabPaused();
        throw new StudioPreDispatchPause(
          "The story is paused before its next request. Completed work is saved.",
          "pause",
        );
      }
      if (!request.lab && studioPauseRequested(store, job.id))
        throw new StudioPreDispatchPause(
          "The story is paused before its next request. Completed work is saved.",
          "pause",
        );
    };
    const reserve = (cents: number, bound?: RequestCostBound, forecast?: EstimatedRequestReservation) => {
      if (dispatched)
        throw new EngineError(
          "A stage attempted more than one paid request. Reconcile the saved attempt.",
        );
      if (bound) checkContinue();
      if (
        !Number.isSafeInteger(cents) ||
        cents < 0 ||
        (bound && (cents === 0 || bound.kind !== kind))
      )
        throw new StudioPreDispatchPause(
          "The next request has no valid conservative cost bound.",
        );
      store.transaction(() => {
        if (pilotFunding && kind !== "local") {
          if (!forecast) throw new StudioPreDispatchPause("The pilot request has no pinned cost estimate.");
          const reservation = reservePilotRequest(store, { jobId: job.id, attemptId: callId, stage: name, inputHash, reservation: forecast });
          if (!reservation.isNew) throw new StudioPreDispatchPause("This pilot attempt is already recorded; reconcile it before retrying.");
          markPilotDispatched(store, callId);
        }
        const used = store.one<{ total: number }>(
          "SELECT COALESCE(SUM(estimatedCents),0) AS total FROM studio_calls WHERE jobId=? AND status!='rejected'",
          job.id,
        )!.total;
        const increase = pilotFunding ? 0 : Math.max(0, used + cents - job.allowance);
        const totalHeld = !request.lab ? reservedBudget(store) : 0;
        if (
          (kind !== "local" &&
            !request.lab &&
            !pilotFunding &&
            totalHeld + increase > config.budgetCents) ||
          (increase > 0 && (!request.autonomous || request.lab))
        )
          throw new StudioPreDispatchPause(
            `The remaining authorized allowance cannot cover the next request's ${bound ? "conservative cost bound" : "estimate"}. No request was sent; completed work is saved.`,
            "budget",
            cents,
          );
        if (increase > 0) {
          if (!request.lab) {
            try {
              requireAllocationIncrease(store, job.id, increase, config);
            } catch (error) {
              if (error instanceof AccessError)
                throw new StudioPreDispatchPause(
                  error.message,
                  "budget",
                  cents,
                );
              throw error;
            }
          }
          const allocation = {
            version: 1,
            reason: "Draw only on the already authorized family allowance",
            fromCents: job.allowance,
            toCents: used + cents,
            totalAuthorizedCents: config.budgetCents,
          };
          store.run(
            "INSERT INTO studio_steps VALUES(?,?,?,'completed',?)",
            job.id,
            `budget_allocation_${callId}`,
            hash(canonical(allocation)),
            JSON.stringify(allocation),
          );
          store.run(
            "UPDATE studio_jobs SET allowance=? WHERE id=?",
            used + cents,
            job.id,
          );
          store.run(
            "UPDATE engine_budget SET allowance=allowance+? WHERE runId=?",
            increase,
            job.id,
          );
          job.allowance = used + cents;
        }
        store.run(
          "INSERT OR IGNORE INTO studio_steps VALUES(?,?,?,'started',NULL)",
          job.id,
          name,
          inputHash,
        );
        store.run("UPDATE studio_jobs SET stage=? WHERE id=?", name, job.id);
        // Lab owns the authoritative request-bound ledger. Do not reserve a
        // second flat estimate or create an ambiguous-looking studio attempt.
        if (kind !== "local" && !request.lab) {
          store.run(
            "INSERT INTO studio_calls VALUES(?,?,?,?,?,?,'started',NULL,NULL,NULL,?,NULL,?)",
            callId,
            job.id,
            name,
            kind,
            bound?.model ??
              (kind === "image"
                ? config.imageModel
                : kind === "audio"
                  ? config.audioModel
                  : config.textModel),
            inputHash,
            cents,
            now(),
          );
          if (bound)
            store.run(
              "INSERT INTO studio_request_bounds VALUES(?,?)",
              callId,
              JSON.stringify(bound),
            );
          if (forecast) store.run("INSERT INTO studio_request_estimates VALUES(?,?)", callId, canonical(forecast));
        }
      });
      if (kind !== "local" && !request.lab) dispatched = true;
    };
    try {
      checkContinue();
      if (kind !== "local" && pilotFunding) {
        if (!provider.withEstimatedPolicy) throw new StudioPreDispatchPause("This provider cannot account for pilot requests.");
        reserveEstimatedRequest = (forecast) => { checkContinue(); reserve(forecast.reservationCents, undefined, forecast); };
      } else if (kind !== "local" && strictCosts) {
        if (!guardedProvider || !provider.validateRequestCosts)
          throw new StudioPreDispatchPause(
            "This provider cannot verify conservative request costs. No request was sent.",
          );
        // Validate all required modalities before even the first transcription.
        provider.validateRequestCosts();
        reserveActiveRequest = (bound) => reserve(bound.maxCostCents, bound);
      } else reserve(estimate);
      const result = await fn();
      if (!owns()) throw new EngineError("This studio job changed.");
      if ((strictCosts || pilotFunding) && kind !== "local" && !dispatched)
        throw new StudioPreDispatchPause(
          "The provider returned without a verified request reservation.",
        );
      store.run(
        "UPDATE studio_steps SET state='completed',result=? WHERE jobId=? AND stage=?",
        JSON.stringify(result),
        job.id,
        name,
      );
      status = "completed";
      return result;
    } catch (error) {
      if (
        !dispatched &&
        (error instanceof StudioPreDispatchPause ||
          (error instanceof Error &&
            "preDispatch" in error &&
            error.preDispatch === true))
      ) {
        const stopped =
          error instanceof StudioPreDispatchPause
            ? error
            : new StudioPreDispatchPause(error.message);
        if (request.lab && kind !== "local")
          store.run(
            "DELETE FROM studio_steps WHERE jobId=? AND stage=? AND state='started'",
            job.id,
            name,
          );
        // Nested local orchestration must not replace the actual blocked stage.
        if (!stopped.checkpointRecorded) {
          recordStudioCheckpoint(store, job.id, name, inputHash, stopped);
          stopped.checkpointRecorded = true;
        }
        throw stopped;
      }
      if (dispatched && error instanceof ProviderRequestError) {
        status = error.failure.retrySafe ? "rejected" : "ambiguous_failure";
        store.run(
          "INSERT OR REPLACE INTO studio_call_failures VALUES(?,?)",
          callId,
          JSON.stringify(error.failure),
        );
        if (error.failure.kind === "authentication")
          store.run(
            "INSERT OR REPLACE INTO studio_connection_checks VALUES(?,?,?)",
            hash(config.apiKey),
            JSON.stringify(error.failure),
            now(),
          );
      }
      throw error;
    } finally {
      reserveActiveRequest = previousGuard;
      reserveEstimatedRequest = previousEstimateGuard;
      if (dispatched) {
        const receipt = provider.takeReceipt?.();
        if (pilotFunding) settlePilotRequest(store, callId, {
          outcome: status === "rejected" ? "not_processed" : status === "completed" ? "completed" : "ambiguous",
          evidenceKind: status === "rejected" ? "provider_rejection" : status === "completed" && receipt?.meteredCost ? "provider_usage" : "unknown_outcome",
          ...(status === "completed" && receipt?.meteredCost ? { usageEstimatedCents: receipt.meteredCost.estimatedCostCents } : {}),
          evidenceHash: hash(canonical(receipt ?? { outcome: status })),
        });
        if (receipt?.imageRender)
          store.run(
            "INSERT OR IGNORE INTO studio_image_renders VALUES(?,?)",
            callId,
            JSON.stringify(receipt.imageRender),
          );
        if (receipt?.meteredCost)
          store.run(
            "INSERT OR IGNORE INTO studio_metered_costs VALUES(?,?)",
            callId,
            JSON.stringify(receipt.meteredCost),
          );
        store.run(
          "UPDATE studio_calls SET status=?,latencyMs=?,requestId=?,usage=? WHERE id=?",
          status,
          Date.now() - start,
          receipt?.requestId ?? null,
          receipt?.usage ? JSON.stringify(receipt.usage) : null,
          callId,
        );
      }
    }
  };
  const editorial = <T>(
    name: string,
    schema: z.ZodType<T>,
    instruction: string,
    data: unknown,
    images: Buffer[] = [],
  ) =>
    step(name, { instruction, data, images: images.map((b) => hash(b)) }, () =>
      provider.structured(
        name,
        schema,
        `${STORY_SYSTEM}\n\n${instruction}`,
        data,
        images,
      ),
    );
  const artNotes: string[] =
    request.seed?.artStatus === "revision_recommended"
      ? [...(request.seed.artNotes ?? [])]
      : [];
  const imageGood = (r: z.infer<typeof ProductionImageReview>) => {
    if (imageAccepted(r)) return true;
    if (imageReviewCopyEligible(r)) {
      artNotes.push(...r.defects);
      return true;
    }
    return false;
  };
  try {
    if (job.profile !== (profile?.hash ?? fingerprint(config)))
      throw new EngineError(
        "The provider or engine version changed. Reconcile this saved run before continuing.",
      );
    const project = store.one<ProjectRow>(
      "SELECT * FROM projects WHERE id=?",
      job.projectId,
    )!;
    if (project.revision !== job.baseRevision)
      throw new EngineError("The book changed while this job was running.");
    if (!state.source) {
      const recording = store.one<{
        id: string;
        assetHash: string;
        mime: string;
      }>("SELECT * FROM recordings WHERE projectId=?", job.projectId)!;
      const rawText = await step(
        "transcription",
        { hash: recording.assetHash, mime: recording.mime },
        () =>
          provider.transcribe(
            store.readAsset(job.projectId, recording.assetHash),
            recording.mime,
          ),
        "audio",
      );
      state.source = Transcript.parse({
        version: 1,
        mode: "live",
        recordingId: recording.id,
        rawText,
        segments: rawText
          .split(/\n+|(?<=[.!?])\s+/)
          .filter(Boolean)
          .map((text, i) => ({
            id: `s${i + 1}`,
            text,
            startMs: null,
            endMs: null,
          })),
      });
      store.run(
        "UPDATE studio_jobs SET state=? WHERE id=?",
        JSON.stringify(state),
        job.id,
      );
    }
    if (request.autonomous) state.sourceApproved = true;
    if (!state.sourceApproved) {
      pause("awaiting_source");
      return true;
    }
    if (!state.heart) {
      const extractedHeart = HeartContract.parse(
        await editorial("heart", HeartContract, instructions.heart, {
          source: state.source,
          explicitAudioCues: explicitAudioCues(state.source.rawText),
          legacyWish: request.consent.legacyWish,
        }),
      );
      const evidence = await step(
        "heart_cue_evidence_v1",
        { heart: extractedHeart, source: state.source },
        async () => reconcileHeartCues(extractedHeart, state.source!),
        "local",
      );
      const heart = evidence.heart;
      const issues = heartProblems(heart, state.source);
      if (issues.length) {
        pause("needs_editor", issues.join(" "));
        return true;
      }
      if (!request.autonomous) {
        pause("awaiting_heart");
        return true;
      }
      if (heart.questions.some((q) => !q.answer.trim())) {
        const QuestionDecisions = z.object({
          decisions: z
            .array(
              z.object({
                id: z.string(),
                kind: z.enum([
                  "creative_choice",
                  "unresolved_fact",
                  "blocking_relationship",
                ]),
                decision: z.string().min(1).max(2000),
              }),
            )
            .max(3),
        });
        const resolution = await editorial(
          "heart_questions_v1",
          QuestionDecisions,
          "Resolve follow-up questions for an autonomous family picture book. Return exactly one decision per unanswered question ID. Choose artistic preferences yourself: species, imaginative setting, age-appropriate presentation and quote placement never need human permission. Do not answer missing historical facts: use unresolved_fact and state what must stay unspecified. Use blocking_relationship ONLY when the core family relationship cannot be preserved without the missing fact. A desire for extra detail is not a blocker. Decision text is an engine editorial decision, never a claim that the family answered.",
          { heart, questions: heart.questions.filter((q) => !q.answer.trim()) },
        );
        const pending = heart.questions.filter((q) => !q.answer.trim());
        if (
          resolution.decisions.length !== pending.length ||
          new Set(resolution.decisions.map((d) => d.id)).size !==
            pending.length ||
          resolution.decisions.some((d) => !pending.some((q) => q.id === d.id))
        )
          throw new EngineError(
            "The question-resolution record did not match this memory.",
          );
        const blocked = resolution.decisions.filter(
          (d) => d.kind === "blocking_relationship",
        );
        if (blocked.length) {
          state.heart = heart;
          state.continuity ??= { questions: [], responses: {} };
          for (const decision of blocked) {
            const original = pending.find((q) => q.id === decision.id)!;
            const questionId = `relationship-${original.id}`;
            if (!state.continuity.questions.some((q) => q.id === questionId))
              state.continuity.questions.push({
                id: questionId,
                kind: "relationship",
                prompt: original.question,
                options: [{ id: "answer", label: "Add a short answer" }],
                allowUnspecified: true,
              });
          }
          // Preserve nonblocking editorial decisions too; resuming never repeats
          // the paid question classifier or asks a family to review the whole heart.
          heart.questions = heart.questions.map((q) => {
            const decision = resolution.decisions.find(
              (d) => d.id === q.id && d.kind !== "blocking_relationship",
            );
            return decision
              ? {
                  ...q,
                  essential: false,
                  answer: `Engine editorial decision (${decision.kind}): ${decision.decision}`,
                }
              : q;
          });
          pause("awaiting_continuity");
          return true;
        }
        heart.questions = heart.questions.map((q) => {
          const d = resolution.decisions.find((d) => d.id === q.id);
          return d
            ? {
                ...q,
                essential: false,
                answer: `Engine editorial decision (${d.kind}): ${d.decision}`,
              }
            : q;
        });
        heart.sensitiveBoundaries = [
          ...heart.sensitiveBoundaries,
          ...resolution.decisions
            .filter((d) => d.kind === "unresolved_fact")
            .map((d) => d.decision),
        ];
      }
      state.heart = heart;
      store.run(
        "UPDATE studio_jobs SET state=? WHERE id=?",
        JSON.stringify(state),
        job.id,
      );
    }
    const heart = state.heart,
      seed = request.seed;
    const concepts = await step(
      "concepts",
      { heart },
      async () =>
        seed?.concepts ??
        studioCached<z.infer<typeof ConceptSet>>(
          store,
          job.id,
          "seed_concepts",
        ) ??
        (await provider.structured(
          "concepts",
          ConceptSet,
          `${STORY_SYSTEM}\n${instructions.concepts}`,
          { heart },
        )),
      seed || studioCached(store, job.id, "seed_concepts") ? "local" : "text",
    );
    const selected = await step(
      "selected_concept",
      {
        heart,
        concepts,
        override: state.selectedConceptId ?? seed?.selectedConceptId ?? null,
      },
      async () => {
        if (state.selectedConceptId || seed)
          return concepts.concepts.find(
            (c) =>
              c.id === (state.selectedConceptId ?? seed!.selectedConceptId),
          )!;
        const review = await editorial(
          "concept_review",
          diversityPlanning
            ? ConceptReview.extend({ diversity: PremiseDiversity })
            : ConceptReview,
          instructions.conceptReview,
          { heart, concepts },
        );
        if (diversityPlanning) {
          const issues = review.diversity
            ? premiseDiversityProblems(concepts, review.diversity)
            : ["Missing premise diversity review."];
          if (issues.length) throw new EngineError(issues.join(" "));
        }
        return chooseConcept(concepts, review, heart);
      },
      "local",
    );
    const plan = await step(
      "story_plan",
      { heart, selected },
      async () =>
        seed?.plan ??
        (await provider.structured(
          "story_plan",
          readerPlanning
            ? StoryPlan.extend({ readerExperience: ReaderExperience })
            : StoryPlan,
          `${STORY_SYSTEM}\n${instructions.plan}`,
          { heart, selected },
        )),
      seed ? "local" : "text",
    );
    const planningIssues = [
      ...planProblems(plan, heart),
      ...(readerPlanning && !seed ? readerExperienceProblems(plan, heart) : []),
    ];
    if (planningIssues.length) {
      pause("needs_editor", planningIssues.join(" "));
      return true;
    }
    let continuityResolution: ContinuityResolution | undefined;
    if (request.continuity && !seed) {
      state.continuity ??= { questions: [], responses: {} };
      const candidate = await step(
        "continuity_world_candidate_v1",
        { heart, plan, continuity: request.continuity },
        () =>
          provider.structured(
            "world",
            VisualWorld,
            `${ART_SYSTEM}\n${instructions.world}\nCreate a cast for THIS source and story only. Do not include absent relatives. Names, relationships and depicted ages come from the source; leave an unknown numeric age null. Approved recurring designs will be applied separately.`,
            { heart, plan },
          ),
        "text",
      );
      continuityResolution = resolveContinuity(
        store,
        project.ownerId,
        request.continuity,
        candidate,
        state.source!,
        state.continuity,
      );
      if (continuityResolution.question) {
        if (
          !state.continuity.questions.some(
            (q) => q.id === continuityResolution!.question!.id,
          )
        )
          state.continuity.questions.push(continuityResolution.question);
        pause("awaiting_continuity");
        return true;
      }
      state.continuityBindings = continuityResolution.bindings;
    }
    const inherited =
      !request.continuity && request.familyVersionId
        ? family(store, project.ownerId, request.familyVersionId)
        : null;
    const world = await step(
      "world",
      {
        heart,
        plan,
        family: request.familyVersionId,
        repair: request.repair ?? null,
      },
      async () => {
        let w =
          seed?.world ??
          continuityResolution?.world ??
          inherited?.world ??
          (await provider.structured(
            "world",
            VisualWorld,
            `${ART_SYSTEM}\n${instructions.world}`,
            { heart, plan },
          ));
        if (request.repair?.kind === "character") {
          const original = w.characters.find(
            (c) => c.id === request.repair!.characterId,
          )!;
          const changed = await editorial(
            "character_repair",
            CharacterVersion,
            instructions.characterRepair,
            { original, repair: request.repair },
          );
          if (
            [
              "id",
              "name",
              "species",
              "relationship",
              "ageState",
              "depictedAge",
            ].some(
              (k) =>
                canonical(changed[k as keyof typeof changed]) !==
                canonical(original[k as keyof typeof original]),
            )
          )
            throw new EngineError(
              "A character repair changed protected identity.",
            );
          w = {
            ...w,
            characters: w.characters.map((c) =>
              c.id === changed.id ? changed : c,
            ),
          };
        }
        return VisualWorld.parse(w);
      },
      seed || inherited || continuityResolution ? "local" : "text",
    );
    type Candidate = {
      manuscript: Snapshot["manuscript"];
      heartReview: Snapshot["heartReview"];
      editorialReview: Snapshot["editorialReview"];
      verdict: StoryVerdict;
      poeticsReview?: z.infer<typeof PoeticsReview>;
      reviewProtocol?: "picturebook-evidence-1";
    };
    const judge = async (
      manuscript: Snapshot["manuscript"],
      prefix: string,
      retainedPoetics?: z.infer<typeof PoeticsReview>,
    ): Promise<Candidate> => {
      const heartReview = await editorial(
        `${prefix}_heart`,
        HeartReview,
        instructions.auditor +
          "\nEvidence protocol 1: Judge the protected ledger rules. Omission of open or flexible incidental details is not itself a preservation failure. Authorized imagined dialogue and thoughts are inventions, not false claims about the source, when disclosed. Still reject protected contradictions or invented harmful family facts.",
        { heart, manuscript },
      );
      const editorialReview = await editorial(
        `${prefix}_craft`,
        EditorialReview,
        instructions.critic +
          "\nEvidence protocol 1: The compatibility key childAgency evaluates consequential protagonist choices that a child can understand. A protagonist may be an adult in a family-origin story; absence of a child character is not a defect. Never require a framing child or a different plot formula. Retain the demanding 1–5 standards for agency, causality, specificity and read-aloud delight. blockingIssues and repairs contain only defects that must be fixed to reach these standards, not optional alternative treatments or opportunities for a different good story. Judge quality honestly; no automatic passing score.",
        { heart, plan, manuscript, criteria: CRAFT_WEIGHTS },
      );
      const poeticsReview =
        retainedPoetics ??
        (profile?.craftRules.diagnosticVersion === "child-poetics-1"
          ? await editorial(
              `${prefix}_poetics`,
              PoeticsReview,
              profile.instructions.poetics ?? POETICS_PROMPT,
              { heart, plan, manuscript },
            )
          : undefined);
      const verdict = evaluateStory(
        heart,
        manuscript,
        heartReview,
        editorialReview,
      );
      if (poeticsReview) {
        const defects = poeticsProblems(poeticsReview, manuscript);
        verdict.craftFailures.push(...defects);
        if (defects.length) verdict.passed = false;
      }
      return {
        manuscript,
        heartReview,
        editorialReview,
        poeticsReview,
        verdict,
        reviewProtocol: "picturebook-evidence-1",
      };
    };
    let accepted = await step(
      "accepted_story",
      { heart, plan, world, repair: request.repair ?? null },
      async () => {
        let best: Candidate | undefined;
        if (seed) {
          const manuscript = structuredClone(seed.manuscript);
          if (request.repair?.kind === "wording") {
            const patch = await editorial(
              "wording_repair",
              ManuscriptPatch,
              instructions.wordingRepair,
              { manuscript, heart, repair: request.repair },
            );
            if (
              patch.changes.length !== request.repair.spreads.length ||
              new Set(patch.changes.map((c) => c.spread)).size !==
                patch.changes.length ||
              patch.changes.some(
                (c) => !request.repair!.spreads.includes(c.spread),
              )
            )
              throw new EngineError(
                "A wording repair touched an unrequested spread.",
              );
            for (const change of patch.changes)
              manuscript.spreads[change.spread - 1].text = change.text;
          }
          best = await judge(manuscript, "repair_judge");
        } else {
          for (let i = 0; i < 3; i++) {
            const manuscript = await editorial(
              `draft_${i + 1}`,
              StoryManuscript,
              instructions.compose,
              { heart, plan, world, variation: i + 1 },
            );
            const candidate = await judge(manuscript, `draft_${i + 1}`);
            if (!best || notWorse(candidate.verdict, best.verdict))
              best = candidate;
          }
        }
        for (let i = 0; !best!.verdict.passed && i < 2 && !seed; i++) {
          const manuscript = await editorial(
            `refine_${i + 1}`,
            StoryManuscript,
            instructions.refine,
            {
              heart,
              plan,
              world,
              manuscript: best!.manuscript,
              notes: [
                ...best!.verdict.heartFailures,
                ...best!.verdict.mechanical,
                ...best!.verdict.craftFailures,
                ...best!.editorialReview.repairs,
              ],
            },
          );
          const candidate = await judge(manuscript, `refine_${i + 1}`);
          if (notWorse(candidate.verdict, best!.verdict)) best = candidate;
        }
        return best!;
      },
      "local",
    );
    if (!accepted.reviewProtocol) {
      accepted = await step(
        "accepted_story_evidence_v1",
        { heart, plan, world },
        async () => {
          let best: Candidate | undefined;
          const retained = seed
            ? ["wording_repair"]
            : ["draft_1", "draft_2", "draft_3", "refine_1", "refine_2"];
          for (const name of retained) {
            const manuscript = studioCached<Snapshot["manuscript"]>(
              store,
              job.id,
              name,
            );
            if (!manuscript || !Array.isArray(manuscript.spreads)) continue;
            const candidate = await judge(
              manuscript,
              `evidence_v1_${name}`,
              studioCached<z.infer<typeof PoeticsReview>>(
                store,
                job.id,
                `${name}_poetics`,
              ) ?? undefined,
            );
            if (!best || notWorse(candidate.verdict, best.verdict))
              best = candidate;
          }
          return (
            best ??
            (await judge(
              accepted.manuscript,
              "evidence_v1_retained",
              accepted.poeticsReview,
            ))
          );
        },
        "local",
      );
    }
    const editorialInput = studioCached<{
      manuscript: Snapshot["manuscript"];
      reason: string;
    }>(store, job.id, "editorial_attention_submission_v1");
    if (editorialInput) {
      accepted = await step(
        "accepted_story_editorial_attention_v1",
        editorialInput,
        async () =>
          judge(
            StoryManuscript.parse(editorialInput.manuscript),
            "editorial_attention_v1",
          ),
        "local",
      );
    }
    // Recompute local evidence checks; stored model reviews remain unchanged.
    accepted.verdict = evaluateStory(
      heart,
      accepted.manuscript,
      accepted.heartReview,
      accepted.editorialReview,
    );
    if (accepted.poeticsReview) {
      const findings = poeticsProblems(
        accepted.poeticsReview,
        accepted.manuscript,
      );
      accepted.verdict.craftFailures.push(...findings);
      if (findings.length) accepted.verdict.passed = false;
    }
    if (
      !accepted.verdict.passed &&
      !canAssembleReviewCopy(accepted.verdict, accepted.editorialReview)
    ) {
      pause(
        "needs_editor",
        "This story needs editorial attention after its bounded reviews. The drafts and specific findings are saved; no scene illustrations have been ordered.",
      );
      return true;
    }
    if (request.lab?.lane === "story") {
      pause("lab_complete");
      return true;
    }
    const manuscript = accepted.manuscript;
    const scenes = await step(
      "scenes",
      { world, manuscript, repair: request.repair ?? null },
      async () => {
        if (!seed)
          return provider.structured(
            "scenes",
            visualPlanning
              ? ScenePlan.extend({ visualDirection: VisualDirection })
              : ScenePlan,
            `${ART_SYSTEM}\n${instructions.scenes}`,
            { heart, world, plan, manuscript },
          );
        let result = structuredClone(seed.scenes);
        if (request.repair?.kind === "scene") {
          const patch = await editorial(
            "scene_repair",
            ScenePatch,
            instructions.sceneRepair,
            { world, scenes: result, repair: request.repair },
          );
          if (
            patch.scenes.length !== request.repair.spreads.length ||
            new Set(patch.scenes.map((s) => s.spread)).size !==
              patch.scenes.length ||
            patch.scenes.some(
              (s) => !request.repair!.spreads.includes(s.spread),
            )
          )
            throw new EngineError(
              "An art repair touched an unrequested spread.",
            );
          // A scene correction invalidates its prior whole-book composition plan.
          // Keep the prior edition untouched; do not send stale staging to the renderer.
          delete result.visualDirection;
          result = {
            ...result,
            scenes: result.scenes.map(
              (s) => patch.scenes.find((n) => n.spread === s.spread) ?? s,
            ),
          };
        }
        return result;
      },
      seed ? "local" : "text",
    );
    const visualIssues = [
      ...worldProblems(world, manuscript, scenes),
      ...(visualPlanning && !seed
        ? visualDirectionProblems(scenes, world)
        : []),
    ];
    if (!visualIssues.length && scenes.visualDirection)
      await step(
        "rough_compositions",
        { scenes },
        async () => ({
          kind: "geometric-storyboard-not-art",
          svg: roughCompositionSvg(scenes),
        }),
        "local",
      );
    if (visualIssues.length) {
      pause("needs_editor", visualIssues.join(" "));
      return true;
    }
    const createImage = async (
      name: string,
      description: unknown,
      refs: Buffer[],
    ) =>
      step(
        name,
        { description, references: refs.map((b) => hash(b)) },
        async () =>
          store.putAsset(
            job.projectId,
            await provider.image(
              `${ART_SYSTEM}\n${JSON.stringify(description)}`,
              refs.length ? refs : undefined,
            ),
            "art",
          ),
        "image",
      );
    const artReviewInstruction =
      instructions.imageReview +
      "\nSeparate correctnessDefects from all defects. correctnessDefects must include missing/extra cast, wrong identity/outfits/protected objects, incorrect action, physical incoherence, unwanted letters, or age-inappropriate content. Artistic style refinements belong in defects but not correctnessDefects. Assess these independently; an attractive image cannot excuse a correctness failure." +
      "\nScore each dimension INDEPENDENTLY on this 1–5 scale: 1 unusable or wholly incorrect, 2 major visible failure, 3 adequate but a substantive repair is needed, 4 strong and requirement-compliant, 5 exceptional. A defect in one dimension must not set all scores to 1. Evidence must describe the identified candidate, not a previous attempt. Optional alternative artistic choices are not defects. Only include actual visible requirement violations in defects. The first image is the CANDIDATE unless imageOrder explicitly describes a complete book. Later images are labeled references. For a model sheet establishing first canon, inspect its visible views against the supplied world; a prior failed sheet is not authoritative canon." +
      "\nRequirements protocol 2: Judge the actual requested deliverable. A neutral multi-view identity sheet is not a narrative action scene: multiple views per character are expected and an additional consistent view is not a defect. Neutral posture is appropriate; assess actionReadability as pose/silhouette clarity. No earlier approved reference exists when first creating canon, so its absence is not a defect. Judge only visible body regions: approved clothing may cover fur patches or markings. Do not demand exposing covered anatomy or changing approved outfits. Still reject observable outfit/color/species inconsistencies across views, physical errors and visible continuity changes. Cite specific visible defects against an explicit requirement, not inability to verify an occluded detail or a preference for another treatment. Distinguish interaction studies from story scenes. Keep the score thresholds and house-style requirements unchanged.";
    await step(
      "art_meaning_protocol_v2",
      { version: 1 },
      async () => ({ version: 1 }),
      "local",
    );
    const resolveArtEvidence = async (
      name: string,
      review: z.infer<typeof ProductionImageReview>,
      description: unknown,
      images: Buffer[],
    ) => {
      if (imageAccepted(review) || imageReviewCopyEligible(review))
        return review;
      if (
        review.identity < 4 ||
        Math.min(
          review.style,
          review.actionReadability,
          review.physicalCoherence,
        ) < 3
      )
        return review;
      const desc = description as {
        scene?: {
          characterIds: string[];
          spread: number;
          action: string;
          emotion: string;
          objectIds: string[];
        };
        scenes?: unknown;
        task?: string;
        imageOrder?: string;
      };
      const expectedCharacterIds =
        desc.scene?.characterIds ?? world.characters.map((c) => c.id);
      const schema = z.object({
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
      });
      // This reviewer does not see the earlier critic's allegations. It checks
      // narrative meaning and protected particulars rather than echoing nits.
      const meaning = await editorial(
        `${name}_meaning_review_v2`,
        schema,
        "Independently inspect the ACTUAL image together with its manuscript words for a children's illustrated REVIEW COPY. Words and pictures share the storytelling: the image need not literally repeat every clause, hand gesture, or temporal beat that the words already communicate. Judge the clear relational action and emotional moment, not exact choreography. IMAGE 1 is the candidate, later images are references, unless imageOrder describes a complete sequence. Identify the required foreground cast by IDs. Anonymous subordinate background partygoers are not extra family members. Check recognizable identities, whether the main intended action and relationship are understandable, material anatomy/contact failures, child suitability, unwanted lettering, and contradictions of relevant protected source nuggets. Only report a protected contradiction if a depicted detail actually contradicts that nugget; a fact assigned to another spread need not appear here. The scene plan is generated creative direction, not testimony: incidental furnishing, clothing layers indoors, natural covered details, equivalent gestures, and plausible imaginative architecture are refinements when they preserve the scene's meaning. Do not mistake exact finger/wing placement, a small cup, a scarf, or unnamed background bustle for loss of the memory's heart. Physical coherence is false for materially broken anatomy/support or unreadable interaction; ordinary occlusion and stylization are not failures. Give specific pixel evidence. No claim of final artistic approval or audience validation. If a material point cannot be verified, mark its boolean false rather than guessing.",
        {
          world,
          expectedCharacterIds,
          narrativeBrief: desc.scene
            ? {
                spread: desc.scene.spread,
                words: manuscript.spreads[desc.scene.spread - 1].text,
                mainAction: desc.scene.action,
                emotionalRead: desc.scene.emotion,
                meaningfulObjects: world.objects.filter((o) =>
                  desc.scene!.objectIds.includes(o.id),
                ),
              }
            : desc.task
              ? {
                  task: desc.task,
                  purpose:
                    "Character reference study, not a story spread. Neutral pose clarity or the requested interaction is the intended action; do not require story events on an identity sheet.",
                }
              : {
                  words: manuscript.spreads.map((s, index) => ({
                    spread: index + 1,
                    text: s.text,
                  })),
                  scenes: scenes.scenes.map((s) => ({
                    spread: s.spread,
                    characterIds: s.characterIds,
                    action: s.action,
                    emotion: s.emotion,
                  })),
                },
          protectedHeart: heart.ledger
            .filter((l) => l.tier === "protected")
            .map((l) => ({
              rule: l,
              nugget: heart.nuggets.find((n) => n.id === l.nuggetId),
            })),
          imageOrder:
            desc.imageOrder ?? "Candidate first; canonical references follow.",
        },
        images,
      );
      const ids = new Set(meaning.visibleCharacterIds);
      const verified =
        ids.size === meaning.visibleCharacterIds.length &&
        ids.size === expectedCharacterIds.length &&
        expectedCharacterIds.every((id) => ids.has(id)) &&
        !meaning.unexpectedForegroundCharacters.length &&
        meaning.identityConsistent &&
        meaning.actionReadable &&
        meaning.physicalCoherence &&
        meaning.childAppropriate &&
        !meaning.unwantedLettering &&
        !meaning.protectedContradictions.length;
      return verified
        ? {
            ...review,
            correctnessDefects: [],
            meaningVerified: true,
            defects: [...review.defects, ...meaning.refinements],
          }
        : review;
    };
    const paint = async (
      name: string,
      description: unknown,
      refs: Buffer[],
      maxAttempts = 3,
    ) => {
      let previous: string | undefined,
        defects: string[] = [];
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const picture =
          studioCached<string>(
            store,
            job.id,
            `${name}_attempt_${attempt + 1}`,
          ) ??
          (await createImage(
            `${name}_attempt_${attempt + 1}`,
            {
              description,
              defects,
              repair: attempt
                ? "Repair named defects; preserve other regions. First references are canon; final reference is prior attempt."
                : null,
            },
            previous
              ? [...refs, store.readAsset(job.projectId, previous)]
              : refs,
          ));
        // Retain completed critiques when repair-message construction changes.
        // The enclosing scene/reference step still pins source, profile and canon.
        const review = studioCached<z.infer<typeof ProductionImageReview>>(store, job.id, `${name}_requirements_v4_review_${attempt + 1}`) ?? await editorial(
          `${name}_requirements_v4_review_${attempt + 1}`,
          ProductionImageReview,
          artReviewInstruction,
          {
            world,
            description,
            defects,
            imageOrder:
              "IMAGE 1 is the candidate to judge. Following images are canonical references, then the previous attempt when supplied. Inspect the whole candidate, including unchanged regions.",
            hasPreviousAttempt: !!previous,
          },
          [
            store.readAsset(job.projectId, picture),
            ...refs,
            ...(previous ? [store.readAsset(job.projectId, previous)] : []),
          ],
        );
        const resolved = await resolveArtEvidence(
          `${name}_attempt_${attempt + 1}`,
          review,
          description,
          [store.readAsset(job.projectId, picture), ...refs],
        );
        if (imageGood(resolved)) return picture;
        const actionableDefects = [...new Set([...resolved.correctnessDefects, ...resolved.defects])];
        defects = actionableDefects.length
          ? actionableDefects
          : [
              "Improve identity, physical coherence, house style and readable action against the supplied references.",
            ];
        previous = picture;
      }
      return null;
    };
    const buildReferences = async () => {
      if (continuityResolution) {
        for (const prior of continuityResolution.referenceFamilies)
          importFamilyReferences(
            store,
            job.projectId,
            prior.id,
            prior.references,
          );
        if (continuityResolution.reuseFamilyVersionId)
          return continuityResolution.referenceFamilies[0].references;
      }
      if (seed && !inherited && request.repair?.kind !== "character")
        return seed.references;
      if (inherited && request.repair?.kind !== "character") {
        importFamilyReferences(
          store,
          job.projectId,
          request.familyVersionId!,
          inherited.references,
        );
        return inherited.references;
      }
      const directed = studioCached<{
        instruction: string;
        referenceHash: string;
      }>(store, job.id, "canon_directed_request_v1");
      const styleDirection = studioCached<{
        instruction: string;
        referenceHash: string;
      }>(store, job.id, "canon_style_request_v1");
      const first = styleDirection
        ? await step(
            "directed_style_review_copy_v1",
            { world, styleDirection },
            async () => {
              const picture = await createImage(
                "canon_style_sheet_v1",
                { task: styleDirection.instruction },
                [store.readAsset(job.projectId, styleDirection.referenceHash)],
              );
              const review = await editorial(
                "canon_style_sheet_v1_review_copy",
                ProductionImageReview,
                artReviewInstruction,
                {
                  world,
                  task: styleDirection.instruction,
                  imageOrder:
                    "IMAGE 1 is the candidate. This is a single-pose identity sheet, one view per character, not a turnaround. Clothing states explicitly permitted by the world are valid. Ear gestures can vary with pose as the world says 'often', not a fixed anatomical deformity. Judge compliance against the house style, not the superseded stricter correction request.",
                },
                [store.readAsset(job.projectId, picture)],
              );
              return imageGood(review) ? picture : null;
            },
            "local",
          )
        : directed
          ? await step(
              "directed_identity_scope_v4",
              { world, directed },
              async () => {
                const picture = await createImage(
                  "canon_identity_directed_v1",
                  { world, task: directed.instruction },
                  [store.readAsset(job.projectId, directed.referenceHash)],
                );
                const review = await editorial(
                  "canon_identity_directed_v1_scope_v4_review",
                  ProductionImageReview,
                  artReviewInstruction,
                  {
                    world,
                    task: directed.instruction,
                    imageOrder:
                      "IMAGE 1 is the only image and is the corrected candidate. Establish its identity against the supplied world and task. Prior failed images are not canon.",
                  },
                  [store.readAsset(job.projectId, picture)],
                );
                return imageGood(review) ? picture : null;
              },
              "local",
            )
          : await paint(
              "canon_identity",
              {
                world,
                task: "Original family model sheet. Neutral full body, side and three-quarter views for every listed individual on cream. Consistent ages and colors; no labels.",
              },
              seed && request.repair?.kind === "character"
                ? seed.references.map((ref) =>
                    store.readAsset(job.projectId, ref.hash),
                  )
                : continuityResolution
                  ? [
                      ...new Set(
                        continuityResolution.referenceFamilies.flatMap((f) =>
                          f.references.map((r) => r.hash),
                        ),
                      ),
                    ].map((digest) => store.readAsset(job.projectId, digest))
                  : [],
            );
      if (!first) return [];
      const second = await paint(
        "canon_interaction",
        {
          world,
          task: "Original family interaction study: seated and reaching gestures around the meaningful objects, keeping the exact same animal identities. No labels.",
        },
        [store.readAsset(job.projectId, first)],
      );
      return second
        ? [
            { hash: first, role: "identity" as const, approved: false },
            { hash: second, role: "interaction" as const, approved: false },
          ]
        : [];
    };
    const referenceInput = {
      world,
      family: request.familyVersionId,
      characterRepair: request.repair?.kind === "character",
    };
    let references = await step(
      "references",
      referenceInput,
      buildReferences,
      "local",
    );
    if (
      !references.length &&
      store.one(
        "SELECT stage FROM studio_steps WHERE jobId=? AND stage LIKE 'canon_identity_review_%'",
        job.id,
      )
    )
      references = await step(
        "references_requirements_v2",
        referenceInput,
        buildReferences,
        "local",
      );

    if (
      !references.length &&
      studioCached(store, job.id, "canon_directed_request_v1")
    )
      references = await step(
        "references_art_direction_v1",
        referenceInput,
        buildReferences,
        "local",
      );
    if (
      !references.length &&
      studioCached(store, job.id, "canon_directed_request_v1")
    )
      references = await step(
        "references_scope_v3",
        referenceInput,
        buildReferences,
        "local",
      );
    if (
      !references.length &&
      studioCached(store, job.id, "canon_style_request_v1")
    )
      references = await step(
        "references_style_v1",
        referenceInput,
        buildReferences,
        "local",
      );
    if (
      !references.length &&
      studioCached(store, job.id, "canon_style_request_v1")
    )
      references = await step(
        "references_review_copy_v1",
        referenceInput,
        buildReferences,
        "local",
      );
    // Cached reference orchestration may bypass review callbacks on resume.
    for (const row of store.all<{ result: string }>(
      "SELECT result FROM studio_steps WHERE jobId=? AND state='completed' AND (stage LIKE '%requirements_v4_review_%' OR stage='canon_style_sheet_v1_review_copy')",
      job.id,
    )) {
      const parsed = ProductionImageReview.safeParse(JSON.parse(row.result));
      if (
        parsed.success &&
        !imageAccepted(parsed.data) &&
        imageReviewCopyEligible(parsed.data)
      )
        artNotes.push(...parsed.data.defects);
    }
    if (!references.length) {
      pause(
        "needs_editor",
        "The original character references need art direction. All attempts and findings are saved.",
      );
      return true;
    }
    if (inherited && request.repair?.kind !== "character") {
      state.castApproved = true;
      state.familyVersionId = request.familyVersionId;
    }
    if (continuityResolution?.reuseFamilyVersionId) {
      state.castApproved = true;
      state.familyVersionId = continuityResolution.reuseFamilyVersionId;
    }
    if (request.autonomous && !state.castApproved && !artNotes.length) {
      state.castApproved = true;
      const familyId = id(),
        refs = references.map((r) => ({
          ...r,
          approved: true,
          approval: "machine" as const,
        }));
      store.transaction(() => {
        store.run(
          "INSERT INTO family_versions VALUES(?,?,?,?,?,?)",
          familyId,
          project.ownerId,
          world.name,
          JSON.stringify(world),
          JSON.stringify(refs),
          now(),
        );
        for (const ref of refs)
          store.run(
            "INSERT INTO family_assets VALUES(?,?)",
            familyId,
            ref.hash,
          );
        rememberContinuityCast(
          store,
          project.ownerId,
          familyId,
          world,
          state.source!,
          state.continuityBindings ??
            inheritedContinuityBindings(
              store,
              state.familyVersionId,
              world,
              state.source!,
            ),
        );
        state.familyVersionId = familyId;
        store.run(
          "UPDATE studio_jobs SET state=? WHERE id=?",
          JSON.stringify(state),
          job.id,
        );
      });
    }
    if (request.autonomous && artNotes.length) state.castApproved = true;
    if (!state.castApproved) {
      pause("awaiting_cast");
      return true;
    }
    const refs = references.map((r) => ({
      ...r,
      approved: !artNotes.length,
      approval: request.autonomous ? ("machine" as const) : ("human" as const),
    }));
    const oldBook = seed
      ? Book.parse(
          JSON.parse(
            store.one<{ book: string }>(
              "SELECT book FROM revisions WHERE projectId=? AND revision=?",
              job.projectId,
              job.baseRevision,
            )!.book,
          ),
        )
      : null;
    const changed = new Set(
      request.repair?.kind === "character"
        ? scenes.scenes
            .filter((s) =>
              s.characterIds.includes(request.repair!.characterId!),
            )
            .map((s) => s.spread)
        : request.repair?.kind === "scene" ||
            request.repair?.kind === "resolution"
          ? request.repair.spreads
          : [],
    );
    const originalPicture = (i: number) =>
      Promise.resolve(
        studioCached<string>(
          store,
          job.id,
          `accepted_picture_meaning_v1_${i + 1}`,
        ) ??
          studioCached<string>(
            store,
            job.id,
            `accepted_picture_evidence_v1_${i + 1}`,
          ) ??
          null,
      ).then(
        (saved) =>
          saved ??
          step(
            `accepted_picture_meaning_v2_${i + 1}`,
            {
              scene: scenes.scenes[i],
              world,
              references: refs,
              repair: request.repair ?? null,
            },
            async () => {
              if (oldBook && !changed.has(i + 1))
                return oldBook.spreads[i].artHash;
              return paint(
                `picture_${i + 1}`,
                {
                  world,
                  scene: scenes.scenes[i],
                  visualDirection: scenes.visualDirection
                    ? {
                        colorProgression:
                          scenes.visualDirection.emotionalColorProgression,
                        motifs: scenes.visualDirection.recurringMotifs,
                        composition: scenes.visualDirection.spreads.find(
                          (s) => s.spread === i + 1,
                        ),
                      }
                    : null,
                  repair: request.repair ?? null,
                  ...(request.repair?.kind === "resolution"
                    ? {
                        resolutionTask:
                          "Create original native-resolution print artwork. Preserve the saved spread's composition, action, characters and protected particulars. Canonical references come first; the final initial reference is the prior saved spread. Repaint detail rather than enlarging pixels. Repair the retained art refinements without changing the story.",
                        priorRefinements: request.seed?.artNotes ?? [],
                      }
                    : {}),
                },
                [
                  ...refs.map((r) => store.readAsset(job.projectId, r.hash)),
                  ...(request.repair?.kind === "resolution" && oldBook
                    ? [
                        store.readAsset(
                          job.projectId,
                          oldBook.spreads[i].artHash,
                        ),
                      ]
                    : []),
                ],
              );
            },
            "local",
          ),
      );
    const picture = async (i: number) => {
      const saved = await originalPicture(i);
      if (saved) return saved;
      const raw = studioCached(store, job.id, `scene_attempt_authorization_v1_${i + 1}`);
      if (!raw) return null;
      const authorization = SceneAttemptAuthorization.parse(raw);
      if (authorization.spread !== i + 1 || authorization.baseRevision !== job.baseRevision ||
          authorization.priorHash !== studioCached(store, job.id, `picture_${i + 1}_attempt_3`))
        throw new EngineError("The illustration authorization no longer matches this checkpoint.");
      const directed = await step(`authorized_picture_v1_${i + 1}`, { authorization, scene: scenes.scenes[i], world, references: refs },
        () => paint(`picture_${i + 1}_authorized_extra_v1`, {
          world, scene: scenes.scenes[i],
          direction: authorization.instruction,
          preservation: "Preserve canonical identities, source particulars, scene action and the whole book's painted visual language. The explicit direction clarifies staging, not remembered facts.",
        }, refs.map(r => store.readAsset(job.projectId, r.hash)), 1), "local");
      if (directed) return directed;
      const name = `picture_${i + 1}_authorized_extra_v1`;
      const review = studioCached<z.infer<typeof ProductionImageReview>>(store, job.id, `${name}_requirements_v4_review_1`);
      const meaning = studioCached<{ visibleCharacterIds: string[]; unexpectedForegroundCharacters: string[]; identityConsistent: boolean; actionReadable: boolean; physicalCoherence: boolean; childAppropriate: boolean; unwantedLettering: boolean; protectedContradictions: unknown[] }>(store, job.id, `${name}_attempt_1_meaning_review_v2`);
      const expected = scenes.scenes[i].characterIds;
      // One narrowly scoped adjudication for conflicting identity findings only.
      // It cannot rescue bad action, unsafe content, extra cast or source violations.
      if (!review || !meaning || review.identity < 4 || review.style < 3 ||
          review.actionReadability < 4 || review.physicalCoherence < 4 ||
          meaning.identityConsistent || !meaning.actionReadable || !meaning.physicalCoherence ||
          !meaning.childAppropriate || meaning.unwantedLettering || meaning.protectedContradictions.length ||
          meaning.unexpectedForegroundCharacters.length || meaning.visibleCharacterIds.length !== expected.length ||
          expected.some(id => !meaning.visibleCharacterIds.includes(id))) return null;
      const digest = studioCached<string>(store, job.id, `${name}_attempt_1`)!;
      const scoped = await step(`authorized_picture_scope_v1_${i + 1}`, { authorization, digest, scene: scenes.scenes[i], world, references: refs }, async () => {
        const finding = await editorial(`${name}_identity_scope_v1`, IdentityScopeReview,
          "Inspect actual pixels against canonical references. Return one evidence-linked identity finding for EACH required character ID, and no other ID. Recognizable means consistent species, silhouette, characteristic colors and face; permitted wardrobe states and natural pose changes are valid. Evaluate material action, anatomy, child suitability and protected source contradictions separately. Anonymous officiants or distant witnesses are not named cast. Kinship that the manuscript supplies cannot be proved from pixels alone and is not an identity defect; do not demand a reference design for an unlisted anonymous person. Do not excuse a changed required character, unexpected recognizable family member or material contradiction. Style preferences remain separate refinements. If a required identity cannot be verified, mark it false. This is one scope adjudication, not final art approval.",
          { expectedCharacters: world.characters.filter(c => expected.includes(c.id)), scene: scenes.scenes[i], words: manuscript.spreads[i].text, protectedHeart: heart, imageOrder: "Candidate first; stable canonical references follow." },
          [store.readAsset(job.projectId, digest), ...refs.map(r => store.readAsset(job.projectId, r.hash))]);
        return identityScopePasses(finding, expected) ? digest : null;
      }, "local");
      if (scoped) artNotes.push("Identity scope checked separately; original critiques and artistic refinements retained.", ...review.defects);
      return scoped;
    };
    for (const i of [0, 5, 10])
      if (!(await picture(i))) {
        pause(
          "needs_editor",
          "A preview illustration needs art direction after two corrections. Your accepted work is saved.",
        );
        return true;
      }
    if (request.autonomous) state.artApproved = true;
    if (!state.artApproved) {
      pause("awaiting_art");
      return true;
    }
    const artHashes: string[] = [];
    for (let i = 0; i < 12; i++) {
      const h = await picture(i);
      // One exhausted scene must not discard the chance to complete independent
      // pages. Keep its null checkpoint; do not request a fourth render.
      artHashes.push(h ?? "");
    }
    const blockedSpreads = artHashes.flatMap((h, i) => h ? [] : [i + 1]);
    if (blockedSpreads.length) {
      pause("needs_editor", `Spreads ${blockedSpreads.join(", ")} need art direction after two corrections. Other completed illustrations are saved.`);
      return true;
    }
    if (new Set(artHashes).size !== 12)
      throw new EngineError("Repeated scene files need editorial review.");
    // Whole-book inspection gets exactly twelve story images. Reference sheets
    // are deliberately excluded: they are not additional pages of the book.
    const whole = await editorial(
      "whole_book_sequence_review_v2", ProductionImageReview,
      artReviewInstruction + " This is a complete book, not one candidate image. There are exactly TWELVE images: IMAGE N is spread N. No reference sheets are included. Review every spread and the sequence. An identity sheet or interaction study must never be counted as a story page. Cite spread numbers for each material concern. Distinguish style refinements from actual correctness defects.",
      { world, scenes, manuscript, imageOrder: "Exactly twelve story spreads, 1 through 12, with no reference sheets." },
      artHashes.map(h => store.readAsset(job.projectId,h)),
    );
    let resolvedWhole: z.infer<typeof ProductionImageReview> & {meaningVerified?:boolean} = whole;
    if (!imageAccepted(whole) && !imageReviewCopyEligible(whole) && whole.identity >= 4 &&
        Math.min(whole.style,whole.actionReadability,whole.physicalCoherence) >= 3) {
      const sequenceSchema = z.object({ spreads: z.array(z.object({
        spread:z.number().int().min(1).max(12), identityConsistent:z.boolean(),
        actionReadable:z.boolean(), physicalCoherence:z.boolean(), childAppropriate:z.boolean(),
        unwantedLettering:z.boolean(), protectedContradictions:z.array(z.string()),
        evidence:z.array(z.string().min(1)).min(1), refinements:z.array(z.string()),
      })).length(12) });
      const sequence = await editorial("whole_book_sequence_meaning_v3",sequenceSchema,
        "Inspect ALL TWELVE actual story images, one per numbered spread; IMAGE N is spread N. There are NO character reference sheets in this request. Return exactly one finding per spread 1–12. Compare each image with its own words and scene, and identities across the sequence. Words and pictures share meaning: images need not prove family relationships or every clause already supplied by the words. Anonymous witnesses are not new named relatives. Physical coherence fails for material broken anatomy, support or unreadable interaction, not normal occlusion or stylization. Clothing options and meaningful motifs supplied by canon are allowed. Cite specific visible evidence; preserve uncertainty for materially unverifiable required identities or actions. List genuine contradictions of protected source separately from harmless scene refinements. Inspect every image; do not evaluate only IMAGE 1 or shift numbering. No claim of audience validation or final art approval.",
        { world, scenes, manuscript, protectedHeart:heart, imageOrder:"IMAGE 1 = spread 1 through IMAGE 12 = spread 12." },
        artHashes.map(h=>store.readAsset(job.projectId,h)),
      );
      if (new Set(sequence.spreads.map(x=>x.spread)).size===12 && sequence.spreads.every(x=>
          x.identityConsistent && x.actionReadable && x.physicalCoherence && x.childAppropriate &&
          !x.unwantedLettering && !x.protectedContradictions.length))
        resolvedWhole = { ...whole, meaningVerified:true, correctnessDefects:[], defects:[...whole.defects,...sequence.spreads.flatMap(x=>x.refinements)] };
    }
    const reviewCopyRaw = studioCached(store,job.id,"digital_review_copy_authorization_v1");
    const reviewCopyAuthorization = reviewCopyRaw ? DigitalReviewCopyAuthorization.parse(reviewCopyRaw) : null;
    if (reviewCopyAuthorization && (reviewCopyAuthorization.baseRevision !== job.baseRevision ||
        reviewCopyAuthorization.manuscriptHash !== hash(canonical(manuscript)) ||
        canonical(reviewCopyAuthorization.artHashes) !== canonical(artHashes)))
      throw new EngineError("The review-copy approval no longer matches this book.");
    if (!imageGood(resolvedWhole)) {
      if (!reviewCopyAuthorization) {
        pause("needs_editor", "The whole-book continuity review found issues. All accepted art is saved for targeted correction.");
        return true;
      }
      artNotes.push("Operator authorized this exact digital review copy for feedback; automatic whole-book review remains unresolved. Not approved for printing.", ...resolvedWhole.defects, ...resolvedWhole.correctnessDefects);
    }
    const production = ProductionSnapshot.parse({
      version: 2,
      engineVersion: STUDIO_VERSION,
      engineProfile: profile ?? undefined,
      automation: request.autonomous ? "autonomous" : "guided",
      styleVersion: STYLE_VERSION,
      heart,
      concepts,
      selectedConceptId: selected.id,
      plan,
      world,
      familyVersionId: state.familyVersionId ?? null,
      references: refs,
      manuscript,
      scenes,
      heartReview: accepted.heartReview,
      editorialReview: accepted.editorialReview,
      humanReview: "pending",
      ...(reviewCopyAuthorization ? {reviewCopyException: {id:reviewCopyAuthorization.id,approvedAt:reviewCopyAuthorization.approvedAt,scope:reviewCopyAuthorization.scope}} : {}),
      artStatus: artNotes.length ? "revision_recommended" : "passed",
      artNotes: [...new Set(artNotes)],
      editorialStatus: accepted.verdict.passed
        ? "passed"
        : "revision_recommended",
      editorialNotes: [
        ...accepted.verdict.craftFailures,
        ...accepted.editorialReview.repairs,
      ],
      poeticsReview: accepted.poeticsReview,
    });
    const book = await finalizeBook(
      Book.parse({
        version: 1,
        revision: job.baseRevision + 1,
        title: manuscript.title,
        byline: manuscript.byline,
        mode: "live",
        artMode: "generated",
        ageBand: "4–7",
        transcript: state.source,
        ledger: heart.nuggets.map((n) => ({
          id: n.id,
          type: ["object", "quote", "lesson", "confessed_flaw"].includes(n.kind)
            ? "event"
            : n.kind,
          text: n.text,
          sourceIds: [n.sourceId],
          certainty: n.certainty,
          clarification: null,
        })),
        people: world.characters.map((c) => ({
          id: c.id,
          name: c.name,
          relationship: c.relationship,
          depictedAge: c.depictedAge,
          appearance: `${c.species}; ${c.ageState}; ${c.silhouette}; ${c.bodyColors}; ${c.outfit}`,
          appearanceSource: "artistic_design",
        })),
        adaptation: {
          version: STUDIO_VERSION,
          emotionalInheritance: heart.emotionalInheritance,
          premise: plan.premise,
          inventions: manuscript.inventions,
          disclosure: "An imaginative story inspired by a family memory.",
        },
        production,
        spreads: manuscript.spreads.map((s, i) => ({
          id: `spread-${i + 1}`,
          text: s.text,
          claimIds: s.nuggetIds,
          scene: i,
          artHash: artHashes[i],
          artDescription: scenes.scenes[i].action,
          characterIds: s.characterIds,
          lines: [],
        })),
        sourceHash: "",
        contentHash: "",
        printReady: false,
        reviewFlags: accepted.verdict.passed
          ? [
              "Automated editorial checks completed. Family feedback is optional; audience response is unverified.",
            ]
          : [
              "Illustrated review copy: editorial refinements remain. Preservation, age suitability and structural checks passed; this is not a claim of final literary approval.",
              ...accepted.verdict.craftFailures,
            ],
        layout: {
          version: 1,
          width: 1200,
          height: 600,
          fontSize: 24,
          lineHeight: 38,
          textX: 680,
          textWidth: 450,
          textY: 0,
        },
      }),
    );
    // An autonomous family job delivers its digital review PDF with the book.
    // Render before publishing so a layout failure cannot masquerade as completion.
    const editionBytes =
      request.autonomous && !request.lab
        ? await renderPdf(book, store, job.projectId)
        : null;
    store.transaction(() => {
      const current = store.one<ProjectRow>(
        "SELECT * FROM projects WHERE id=?",
        job.projectId,
      );
      if (!owns() || current?.revision !== job.baseRevision)
        throw new EngineError(
          "The book changed while this revision was being prepared.",
        );
      store.run(
        "INSERT INTO revisions VALUES(?,?,?,?)",
        job.projectId,
        book.revision,
        JSON.stringify(book),
        book.contentHash,
      );
      store.run(
        "UPDATE projects SET revision=?,title=?,mode='live',status='ready_for_review' WHERE id=?",
        book.revision,
        book.title,
        job.projectId,
      );
      if (state.familyVersionId)
        rememberStoryContinuity(
          store,
          job.projectId,
          book.revision,
          state.familyVersionId,
          world,
        );
      if (editionBytes) {
        const pdfHash = store.putAsset(job.projectId, editionBytes, "pdf");
        store.run(
          "INSERT INTO editions VALUES(?,?,?,?,?,?,?)",
          id(),
          job.projectId,
          book.revision,
          book.contentHash,
          pdfHash,
          JSON.stringify(book),
          now(),
        );
        store.run(
          "UPDATE projects SET status='edition_saved' WHERE id=?",
          job.projectId,
        );
      }
      store.run(
        "UPDATE studio_jobs SET status='complete',stage='family_review',state=?,leaseToken=NULL,leaseUntil=0 WHERE id=?",
        JSON.stringify(state),
        job.id,
      );
    });
  } catch (error) {
    if (owns())
      pause(
        error instanceof LabPaused ||
          (request.lab && error instanceof StudioPreDispatchPause)
          ? "lab_paused"
          : "needs_attention",
        error instanceof EngineError ||
          error instanceof StudioPreDispatchPause ||
          error instanceof ProviderRequestError ||
          error instanceof AccessError
          ? error.message
          : "The studio stopped at a saved checkpoint. Inspect the recorded stage before retrying; no paid request will repeat automatically.",
      );
  } finally {
    clearInterval(heartbeat);
    settleStudioReservations(store);
  }
  return true;
}

class LabPaused extends EngineError {
  constructor() {
    super("Experiment paused at a durable checkpoint.");
  }
}
// Internal only: synthetic/consented Lab inputs, a separate experiment allowance, no family-book reservation.
export function queueLabStudio(
  store: Store,
  project: ProjectRow,
  source: TranscriptDocument,
  heart: Heart,
  profile: Profile,
  runId: string,
  lane: "story" | "book",
  allowance: number,
) {
  const jobId = id();
  const request: RequestData = {
    consent: {
      processWithOpenAI: true,
      imaginativeAdaptation: true,
      legacyWish: heart.emotionalInheritance,
    },
    familyVersionId: null,
    engineProfile: verifyProfile(profile),
    autonomous: true,
    lab: { runId, lane },
  };
  const problems = heartProblems(heart, source);
  if (problems.length) throw new EngineError(problems.join(" "));
  store.run(
    "INSERT INTO studio_jobs(id,projectId,baseRevision,kind,status,stage,request,state,profile,allowance,createdAt) VALUES(?,?,0,'lab','queued','concepts',?,?,?,?,?)",
    jobId,
    project.id,
    JSON.stringify(request),
    JSON.stringify({ source, sourceApproved: true, heart }),
    profile.hash,
    allowance,
    now(),
  );
  return jobId;
}
