import { isRecoveryLocked } from "../recovery-lock.js";
import { allocateGeneration } from "../access.js";
import { reservedBudget } from "./budget.js";
import { z } from "zod";
import {
  Book,
  Transcript,
  wordCount,
  type BookDocument,
} from "../../shared/contracts.js";
import {
  ArtReview,
  CraftReview,
  ENGINE_VERSION,
  EngineConsent,
  Kernel,
  Manuscript,
  Outline,
  type EngineView,
} from "../../shared/engine.js";
import { canonical, id, now, type ProjectRow, type Store } from "../store.js";
import { finalizeBook } from "../layout.js";
import { availability, type EngineConfig, type Provider } from "./provider.js";
import { ART_CONSTITUTION, STORY_CONSTITUTION, stages } from "./prompts.js";

interface Run {
  id: string;
  projectId: string;
  baseRevision: number;
  status: string;
  stage: string;
  consent: string;
  profile: string;
  allowance: number;
  leaseUntil: number;
  leaseToken: string | null;
  error: string | null;
  transcript: string | null;
  sourceApproved: number;
  artApproved: number;
}
const profile = (c: EngineConfig) =>
  canonical({
    version: ENGINE_VERSION,
    textModel: c.textModel,
    imageModel: c.imageModel,
    audioModel: c.audioModel,
  });
export class EngineError extends Error {}
export function queueEngine(
  store: Store,
  project: ProjectRow,
  input: unknown,
  config: EngineConfig,
) {
  const consent = EngineConsent.parse(input);
  if (!availability(config).ready)
    throw new EngineError(availability(config).message);
  if (project.mode === "synthetic_fixture" || project.revision)
    throw new EngineError("Start with an unadapted family memory.");
  const recording = store.one<{ mime: string }>(
    "SELECT mime FROM recordings WHERE projectId=?",
    project.id,
  );
  if (!recording) throw new EngineError("Save your recording first.");
  if (recording.mime === "audio/ogg" && !project.transcript)
    throw new EngineError(
      "Your OGG recording is safely saved. Add and confirm a manual transcript before using the story studio, or start a new memory with WAV, MP3, M4A or WebM audio.",
    );
  return store.transaction(() => {
    const previous = store.one<Run>(
      "SELECT * FROM engine_runs WHERE projectId=?",
      project.id,
    );
    if (previous) return previous.id;
    // 1 transcription + at most 10 editorial/vision calls + 1 reference + 12 scenes.
    const allowance =
      config.audioReserve + 10 * config.textReserve + 13 * config.imageReserve;
    const used = reservedBudget(store);
    if (used + allowance > config.budgetCents)
      throw new EngineError(
        "The approved studio allowance is too small for another complete book. Your memory is safe.",
      );
    const runId = id();
    allocateGeneration(store, project.ownerId, runId, allowance, config, true);
    store.run(
      "INSERT INTO engine_budget VALUES(?,?,?)",
      runId,
      allowance,
      now(),
    );
    store.run(
      "INSERT INTO engine_runs(id,projectId,baseRevision,status,stage,consent,profile,allowance,transcript,sourceApproved,createdAt) VALUES(?,?,?,'queued','transcription',?,?,?,?,?,?)",
      runId,
      project.id,
      project.revision,
      JSON.stringify({ ...consent, at: now() }),
      profile(config),
      allowance,
      project.transcript,
      project.status === "awaiting_editorial" ? 1 : 0,
      now(),
    );
    store.run(
      "UPDATE projects SET status='creating_legacy' WHERE id=?",
      project.id,
    );
    return runId;
  });
}
export function confirmEngineSource(
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
  store.transaction(() => {
    const run = store.one<Run>(
      "SELECT * FROM engine_runs WHERE projectId=? AND status='awaiting_source'",
      projectId,
    );
    if (!run || !run.transcript)
      throw new EngineError("This transcript is not waiting for confirmation.");
    const source = Transcript.parse(JSON.parse(run.transcript));
    const p = store.one<ProjectRow>(
      "SELECT * FROM projects WHERE id=?",
      projectId,
    )!;
    if (p.transcript && body.rawText !== source.rawText)
      throw new EngineError(
        "The original transcript is already stored. Confirm it here; the adaptation can still be imaginative.",
      );
    const transcript = p.transcript
      ? Transcript.parse(JSON.parse(p.transcript))
      : makeTranscript(
          body.rawText,
          source.recordingId!,
          body.rawText === source.rawText && source.mode === "live"
            ? "live"
            : "manual",
        );
    store.run(
      "UPDATE engine_runs SET transcript=?,sourceApproved=1,status='queued',stage='heart' WHERE id=?",
      JSON.stringify(transcript),
      run.id,
    );
    store.run(
      "UPDATE projects SET transcript=?,mode='live',status='creating_legacy' WHERE id=?",
      JSON.stringify(transcript),
      projectId,
    );
  });
}
export function approveEngineArt(
  store: Store,
  projectId: string,
  input: unknown,
) {
  z.object({ approved: z.literal(true) }).parse(input);
  const result = store.run(
    "UPDATE engine_runs SET artApproved=1,status='queued' WHERE projectId=? AND status='awaiting_art'",
    projectId,
  );
  if (!result.changes)
    throw new EngineError("These illustrations are not waiting for approval.");
  store.run(
    "UPDATE projects SET status='creating_legacy' WHERE id=?",
    projectId,
  );
}
function makeTranscript(
  rawText: string,
  recordingId: string,
  mode: "live" | "manual",
) {
  return Transcript.parse({
    version: 1,
    mode,
    rawText,
    recordingId,
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
}
function cached<T>(store: Store, runId: string, stage: string): T | null {
  const row = store.one<{ result: string }>(
    "SELECT result FROM engine_steps WHERE runId=? AND stage=? AND state='completed'",
    runId,
    stage,
  );
  return row ? (JSON.parse(row.result) as T) : null;
}
export function engineView(store: Store, projectId: string): EngineView | null {
  const run = store.one<Run>(
    "SELECT * FROM engine_runs WHERE projectId=?",
    projectId,
  );
  if (!run) return null;
  const manuscript = cached<z.infer<typeof Manuscript>>(
    store,
    run.id,
    "accepted_manuscript",
  );
  const kernel = cached<z.infer<typeof Kernel>>(store, run.id, "heart");
  const preview =
    manuscript && kernel && run.status === "awaiting_art"
      ? {
          title: manuscript.title,
          heart: kernel.emotionalInheritance,
          inventions: manuscript.inventions,
          spreads: [0, 5, 10].map((i) => ({
            text: manuscript.spreads[i].text,
            artHash: cached<string>(store, run.id, `picture_${i + 1}`)!,
            artDescription: manuscript.spreads[i].artDirection,
          })),
        }
      : null;
  return {
    id: run.id,
    status: run.status,
    stage: run.stage,
    error: run.error,
    transcript: run.transcript
      ? Transcript.parse(JSON.parse(run.transcript)).rawText
      : null,
    preview,
  };
}
export function manuscriptProblems(
  draft: z.infer<typeof Manuscript>,
  kernel: z.infer<typeof Kernel>,
) {
  const issues: string[] = [],
    count = wordCount(draft.spreads.map((s) => s.text).join(" "));
  if (count < 250 || count > 450)
    issues.push(`Total ${count} words; require 250–450.`);
  const anchors = new Set(kernel.anchors.map((a) => a.id)),
    people = new Set(draft.people.map((p) => p.id));
  if (people.size !== draft.people.length)
    issues.push("Duplicate character IDs.");
  for (const [i, spread] of draft.spreads.entries()) {
    if (wordCount(spread.text) > 45)
      issues.push(`Spread ${i + 1} exceeds 45 words.`);
    if (
      spread.anchorIds.some((a) => !anchors.has(a)) ||
      spread.characterIds.some((p) => !people.has(p))
    )
      issues.push(`Spread ${i + 1} has an invalid anchor or character ID.`);
  }
  if (new Set(draft.spreads.map((s) => s.text)).size !== 12)
    issues.push("Repeated spread text.");
  if (new Set(draft.spreads.map((s) => s.composition)).size < 3)
    issues.push("Use at least three distinct camera compositions.");
  return issues;
}
function goodArt(review: z.infer<typeof ArtReview>) {
  return (
    !review.blockingIssues.length &&
    Math.min(
      review.characterContinuity,
      review.childReadability,
      review.visualCraft,
    ) >= 4
  );
}

export async function runEngine(
  store: Store,
  provider: Provider,
  config: EngineConfig,
) {
  if (isRecoveryLocked(store) || !availability(config).ready) return false;
  const token = id();
  const run = store.transaction(() => {
    const row = store.one<Run>(
      "SELECT * FROM engine_runs WHERE status='queued' OR (status='running' AND leaseUntil<?) ORDER BY rowid LIMIT 1",
      Date.now(),
    );
    if (!row) return null;
    store.run(
      "UPDATE engine_runs SET status='running',leaseToken=?,leaseUntil=? WHERE id=?",
      token,
      Date.now() + 240000,
      row.id,
    );
    return row;
  });
  if (!run) return false;
  const owns = () =>
    !!store.one(
      "SELECT id FROM engine_runs WHERE id=? AND leaseToken=? AND status='running' AND leaseUntil>?",
      run.id,
      token,
      Date.now(),
    );
  const heartbeat = setInterval(() => {
    store.run(
      "UPDATE engine_runs SET leaseUntil=? WHERE id=? AND leaseToken=? AND status='running'",
      Date.now() + 240000,
      run.id,
      token,
    );
  }, 15000);
  const pause = (status: string, error: string | null = null) =>
    store.transaction(() => {
      if (!owns()) throw new EngineError("The studio session has changed.");
      store.run(
        "UPDATE engine_runs SET status=?,error=?,leaseUntil=0,leaseToken=NULL WHERE id=?",
        status,
        error,
        run.id,
      );
      store.run(
        "UPDATE projects SET status=? WHERE id=?",
        status === "complete" ? "ready_for_review" : "legacy_review",
        run.projectId,
      );
    });
  const step = async <T>(
    name: string,
    fn: () => Promise<T>,
    paid = true,
  ): Promise<T> => {
    if (!owns()) throw new EngineError("The studio session has changed.");
    const previous = cached<T>(store, run.id, name);
    if (previous !== null) return previous;
    store.transaction(() => {
      if (!owns()) throw new EngineError("The studio session has changed.");
      if (
        store.one(
          "SELECT stage FROM engine_steps WHERE runId=? AND stage=?",
          run.id,
          name,
        )
      )
        throw new EngineError(
          "A provider request may have completed before the connection stopped. An operator must reconcile it before any paid retry.",
        );
      store.run("UPDATE engine_runs SET stage=? WHERE id=?", name, run.id);
      store.run(
        "INSERT INTO engine_steps VALUES(?,?,?,NULL)",
        run.id,
        name,
        paid ? "request_started" : "local_started",
      );
    });
    const result = await fn();
    if (!owns()) throw new EngineError("The studio session has changed.");
    store.run(
      "UPDATE engine_steps SET state='completed',result=? WHERE runId=? AND stage=?",
      JSON.stringify(result),
      run.id,
      name,
    );
    return result;
  };
  const editorial = <T>(
    name: string,
    schema: z.ZodType<T>,
    instruction: string,
    data: unknown,
    images?: Buffer[],
  ) =>
    step(name, () =>
      provider.structured(
        name,
        schema,
        `${STORY_CONSTITUTION}\n\n${instruction}`,
        data,
        images,
      ),
    );
  try {
    if (run.profile !== profile(config))
      throw new EngineError(
        "The studio configuration changed. Review this run before continuing.",
      );
    let source = run.transcript
      ? Transcript.parse(JSON.parse(run.transcript))
      : null;
    if (!source) {
      const rec = store.one<{ id: string; assetHash: string; mime: string }>(
        "SELECT * FROM recordings WHERE projectId=?",
        run.projectId,
      )!;
      const rawText = await step("transcription", () =>
        provider.transcribe(
          store.readAsset(run.projectId, rec.assetHash),
          rec.mime,
        ),
      );
      source = makeTranscript(rawText, rec.id, "live");
      store.run(
        "UPDATE engine_runs SET transcript=? WHERE id=?",
        JSON.stringify(source),
        run.id,
      );
    }
    if (!run.sourceApproved) {
      pause("awaiting_source");
      return true;
    }
    const consent = EngineConsent.parse(JSON.parse(run.consent));
    const kernel = Kernel.parse(
      await editorial("heart", Kernel, stages.kernel, {
        source,
        legacyWish: consent.legacyWish,
      }),
    );
    const sourceIds = new Set(source.segments.map((s) => s.id));
    if (
      new Set(kernel.anchors.map((a) => a.id)).size !== kernel.anchors.length ||
      kernel.anchors.some((a) => a.sourceIds.some((s) => !sourceIds.has(s)))
    )
      throw new EngineError("The editor needs to repair the memory anchors.");
    const outline = Outline.parse(
      await editorial("architecture", Outline, stages.outline, {
        kernel,
        legacyWish: consent.legacyWish,
      }),
    );
    if (new Set(outline.beats.map((b) => b.spread)).size !== 12)
      throw new EngineError("The story outline needs editorial repair.");
    let manuscript = Manuscript.parse(
      await editorial("manuscript", Manuscript, stages.manuscript, {
        kernel,
        outline,
      }),
    );
    let accepted = false;
    for (let pass = 0; pass < 3; pass++) {
      const mechanical = manuscriptProblems(manuscript, kernel);
      const review = CraftReview.parse(
        await editorial(`craft_${pass}`, CraftReview, stages.critic, {
          kernel,
          outline,
          manuscript,
          mechanical,
        }),
      );
      if (
        !mechanical.length &&
        !review.blockingIssues.length &&
        !review.repairs.length &&
        Object.values(review.scores).every((score) => score >= 4)
      ) {
        accepted = true;
        break;
      }
      if (pass < 2)
        manuscript = Manuscript.parse(
          await editorial(`revision_${pass + 1}`, Manuscript, stages.revise, {
            kernel,
            outline,
            manuscript,
            review,
            mechanical,
          }),
        );
    }
    if (!accepted) {
      pause(
        "needs_editor",
        "The story has had two revision passes and still needs an editor’s attention. No illustrations have been ordered.",
      );
      return true;
    }
    await step("accepted_manuscript", async () => manuscript, false);
    // Exercise layout before any illustration expense.
    const makeBook = (artHashes: string[]): BookDocument =>
      Book.parse({
        version: 1,
        revision: run.baseRevision + 1,
        title: manuscript.title,
        byline: manuscript.byline,
        mode: "live",
        artMode: "generated",
        ageBand: "4–7",
        transcript: source,
        ledger: kernel.anchors,
        people: manuscript.people,
        adaptation: {
          version: ENGINE_VERSION,
          emotionalInheritance: kernel.emotionalInheritance,
          premise: outline.premise,
          inventions: manuscript.inventions,
          disclosure: "An imaginative story inspired by a family memory.",
        },
        spreads: manuscript.spreads.map((s, i) => ({
          id: `spread-${i + 1}`,
          text: s.text,
          claimIds: s.anchorIds,
          scene: i,
          artHash: artHashes[i] ?? "",
          artDescription: s.artDirection,
          characterIds: s.characterIds,
          lines: [],
        })),
        sourceHash: "",
        contentHash: "",
        printReady: false,
        reviewFlags: [
          "Family review required; automated craft scores are not evidence of child engagement.",
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
      });
    await finalizeBook(makeBook([]));
    const reference = await step("character_reference", async () =>
      store.putAsset(
        run.projectId,
        await provider.image(
          `${ART_CONSTITUTION}\nMake a character reference sheet with all named characters in clear full-body and expressive close-up views, NO text. ${JSON.stringify({ people: manuscript.people, bible: manuscript.artBible })}`,
        ),
        "art",
      ),
    );
    const picture = (i: number) =>
      step(`picture_${i + 1}`, async () =>
        store.putAsset(
          run.projectId,
          await provider.image(
            `${ART_CONSTITUTION}\nIllustrate this one square page. ${JSON.stringify({ bible: manuscript.artBible, people: manuscript.people, scene: manuscript.spreads[i] })}`,
            store.readAsset(run.projectId, reference),
          ),
          "art",
        ),
      );
    const sampleIndices = [0, 5, 10],
      sampleHashes: string[] = [];
    for (const i of sampleIndices) sampleHashes.push(await picture(i));
    const previewReview = ArtReview.parse(
      await editorial(
        "art_review_preview",
        ArtReview,
        stages.artCritic,
        {
          bible: manuscript.artBible,
          scenes: sampleIndices.map((i) => manuscript.spreads[i]),
        },
        sampleHashes.map((h) => store.readAsset(run.projectId, h)),
      ),
    );
    if (!goodArt(previewReview)) {
      pause(
        "needs_editor",
        "The first illustrations need art direction before the remaining pages are commissioned.",
      );
      return true;
    }
    if (!run.artApproved) {
      pause("awaiting_art");
      return true;
    }
    const artHashes: string[] = [];
    for (let i = 0; i < 12; i++) artHashes.push(await picture(i));
    if (new Set(artHashes).size !== 12) {
      pause(
        "needs_editor",
        "Some illustration files repeat. An editor needs to check the scene sequence.",
      );
      return true;
    }
    const fullReview = ArtReview.parse(
      await editorial(
        "art_review_book",
        ArtReview,
        stages.artCritic,
        { bible: manuscript.artBible, scenes: manuscript.spreads },
        artHashes.map((h) => store.readAsset(run.projectId, h)),
      ),
    );
    if (!goodArt(fullReview)) {
      pause(
        "needs_editor",
        "The complete art sequence needs a continuity review. Your story and illustrations are saved.",
      );
      return true;
    }
    const book = await finalizeBook(makeBook(artHashes));
    store.transaction(() => {
      if (!owns()) throw new EngineError("The studio session has changed.");
      const p = store.one<ProjectRow>(
        "SELECT * FROM projects WHERE id=?",
        run.projectId,
      );
      if (!p || p.revision !== run.baseRevision)
        throw new EngineError(
          "This memory changed while the book was being created.",
        );
      store.run(
        "INSERT INTO revisions VALUES(?,?,?,?)",
        run.projectId,
        book.revision,
        JSON.stringify(book),
        book.contentHash,
      );
      store.run(
        "UPDATE projects SET revision=?,title=?,mode='live',status='ready_for_review' WHERE id=?",
        book.revision,
        book.title,
        run.projectId,
      );
      store.run(
        "UPDATE engine_runs SET status='complete',stage='family_review',leaseToken=NULL,leaseUntil=0 WHERE id=?",
        run.id,
      );
    });
  } catch (error) {
    if (owns())
      pause(
        "needs_attention",
        error instanceof EngineError
          ? error.message
          : "The studio stopped at a saved checkpoint. An operator must inspect the request before retrying; no paid request will be repeated automatically.",
      );
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}
