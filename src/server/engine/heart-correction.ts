import { z } from "zod";
import { Transcript } from "../../shared/contracts.js";
import { HeartContract } from "../../shared/studio.js";
import { requireOperator } from "../access.js";
import { verifyProfile } from "../lab/profiles.js";
import { isRecoveryLocked } from "../recovery-lock.js";
import { canonical, hash, id, now, type Store } from "../store.js";
import { heartProblems, reconcileHeartCues } from "./editorial.js";
import { explicitAudioCues } from "./craft.js";
import { EngineError } from "./pipeline.js";
import { instructions } from "./studio-prompts.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const SourceEvidence = z
  .object({
    nuggetId: z.string().min(1),
    sourceId: z.string().min(1),
    quote: z.string().trim().min(1),
    reason: z.string().trim().min(10).max(3000),
  })
  .strict();
export const HeartCorrectionInput = z
  .object({
    ownerId: z.string().min(1),
    projectId: z.string().min(1),
    jobId: z.string().min(1),
    originalHeartHash: digest,
    // Hash of the complete canonical Transcript, including segment IDs.
    sourceHash: digest,
    heart: HeartContract,
    sourceEvidence: z.array(SourceEvidence).max(30).default([]),
    reason: z.string().trim().min(10).max(3000),
  })
  .strict();
export const HEART_CORRECTION_STAGE = "operator_heart_correction_v1";
const ledgerError = "Every source nugget needs exactly one ledger entry.";
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** Only repairs a rejected, pre-concepts Heart. No provider or budget operation. */
export function correctPausedStudioHeart(
  store: Store,
  actorId: string,
  input: unknown,
) {
  const body = HeartCorrectionInput.parse(input);
  return store.transaction(() => {
    requireOperator(store, actorId);
    const job = store.one<{
      id: string;
      projectId: string;
      baseRevision: number;
      kind: string;
      status: string;
      stage: string;
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
    const project = store.one<{
      ownerId: string;
      revision: number;
      transcript: string | null;
    }>(
      "SELECT ownerId,revision,transcript FROM projects WHERE id=? AND ownerId=?",
      body.projectId,
      body.ownerId,
    );
    if (!job || !project || job.kind !== "generation")
      throw new EngineError(
        "This owner's original story job could not be found.",
      );
    const state = JSON.parse(job.state),
      request = JSON.parse(job.request);
    const source = Transcript.parse(state.source);
    if (
      !project.transcript ||
      !equal(source, Transcript.parse(JSON.parse(project.transcript))) ||
      hash(canonical(source)) !== body.sourceHash
    )
      throw new EngineError("The frozen source changed. Reopen its evidence.");
    const profile = verifyProfile(request.engineProfile);
    if (job.profile !== profile.hash || request.lab)
      throw new EngineError("The pinned story profile changed.");
    const originalStep = store.one<{
      state: string;
      result: string | null;
      inputHash: string;
    }>(
      "SELECT state,result,inputHash FROM studio_steps WHERE jobId=? AND stage='heart'",
      job.id,
    );
    if (originalStep?.state !== "completed" || !originalStep.result)
      throw new EngineError(
        "A completed original Heart extraction is required.",
      );
    const original = HeartContract.parse(JSON.parse(originalStep.result));
    if (hash(canonical(original)) !== body.originalHeartHash)
      throw new EngineError("The original Heart changed. Reopen its evidence.");
    const expectedInputHash = hash(
      canonical({
        input: {
          instruction: profile.instructions.heart ?? instructions.heart,
          data: {
            source,
            explicitAudioCues: explicitAudioCues(source.rawText),
            legacyWish: request.consent?.legacyWish,
          },
          images: [],
        },
        profile: job.profile,
      }),
    );
    if (originalStep.inputHash !== expectedInputHash)
      throw new EngineError(
        "The extraction's source, profile or request binding changed.",
      );

    // Bind to the same creation and source snapshot when using the journey path.
    const creation = store.one<{
      id: string;
      ownerId: string;
      projectId: string;
      sourceId: string;
      profile: string;
      continuity: string;
    }>(
      "SELECT id,ownerId,projectId,sourceId,profile,continuity FROM almanac_creation_requests WHERE studioJobId=?",
      job.id,
    );
    let frozenSourceHash: string | null = null;
    if (creation) {
      const frozen = store.one<{ body: string; sourceHash: string }>(
        "SELECT body,sourceHash FROM almanac_sources WHERE id=? AND generationProjectId=?",
        creation.sourceId,
        body.projectId,
      );
      if (
        creation.ownerId !== body.ownerId ||
        creation.projectId !== body.projectId ||
        !frozen ||
        !equal(JSON.parse(creation.profile), profile) ||
        !equal(JSON.parse(creation.continuity), request.continuity)
      )
        throw new EngineError("The original creation binding changed.");
      const frozenBody = JSON.parse(frozen.body);
      const turns = z
        .array(z.object({ sequence: z.number(), transcript: Transcript }))
        .parse(frozenBody.turns);
      if (
        hash(canonical(frozenBody)) !== frozen.sourceHash ||
        source.rawText !==
          turns.map((t) => t.transcript.rawText).join("\n\n") ||
        !equal(
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
      frozenSourceHash = frozen.sourceHash;
    }
    const requestHash = hash(canonical(request));
    const inputHash = hash(
      canonical({
        actorId,
        ...body,
        profileHash: job.profile,
        requestHash,
        frozenSourceHash,
      }),
    );
    const prior = store.one<{ inputHash: string; result: string }>(
      "SELECT inputHash,result FROM studio_steps WHERE jobId=? AND stage=? AND state='completed'",
      job.id,
      HEART_CORRECTION_STAGE,
    );
    if (prior) {
      if (prior.inputHash !== inputHash)
        throw new EngineError(
          "This Heart correction is immutable; the retry differs.",
        );
      return JSON.parse(prior.result) as HeartCorrectionRecord;
    }
    if (
      isRecoveryLocked(store) ||
      job.status !== "needs_editor" ||
      job.stage !== "heart_cue_evidence_v1" ||
      job.leaseToken !== null ||
      job.leaseUntil !== 0 ||
      job.baseRevision !== 0 ||
      project.revision !== 0 ||
      state.heart ||
      Object.keys(state).some(
        (key) => !["source", "sourceApproved"].includes(key),
      ) ||
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
        "Only the stopped original pre-concepts Heart can be corrected.",
      );
    const steps = store.all<{
      stage: string;
      state: string;
      result: string | null;
    }>("SELECT stage,state,result FROM studio_steps WHERE jobId=?", job.id);
    if (
      steps.some(
        (s) =>
          !["transcription", "heart", "heart_cue_evidence_v1"].includes(
            s.stage,
          ) && !s.stage.startsWith("budget_allocation_"),
      ) ||
      store.one(
        "SELECT id FROM studio_calls WHERE jobId=? AND (stage NOT IN ('transcription','heart') OR status NOT IN ('completed','rejected'))",
        job.id,
      ) ||
      !store.one(
        "SELECT id FROM studio_calls WHERE jobId=? AND stage='heart' AND status='completed'",
        job.id,
      ) ||
      store.one("SELECT jobId FROM studio_approvals WHERE jobId=?", job.id) ||
      store.one("SELECT jobId FROM studio_pause_requests WHERE jobId=?", job.id)
    )
      throw new EngineError(
        "Downstream work, an unresolved request or a separate pause prevents Heart correction.",
      );
    const cue = steps.find((s) => s.stage === "heart_cue_evidence_v1");
    const reconciled = reconcileHeartCues(original, source);
    if (
      cue?.state !== "completed" ||
      !cue.result ||
      !equal(JSON.parse(cue.result), reconciled) ||
      !equal(heartProblems(reconciled.heart, source), [ledgerError])
    )
      throw new EngineError(
        "This recovery requires the retained incomplete-ledger failure.",
      );
    const base = reconciled.heart,
      corrected = body.heart;
    for (const key of Object.keys(base) as (keyof typeof base)[])
      if (
        !["nuggets", "ledger", "questions"].includes(key) &&
        !equal(base[key], corrected[key])
      )
        throw new EngineError(`This narrow recovery cannot change ${key}.`);
    if (
      !equal(
        base.nuggets.map((n) => n.id),
        corrected.nuggets.slice(0, base.nuggets.length).map((n) => n.id),
      ) ||
      base.ledger.some(
        (entry) =>
          !equal(
            entry,
            corrected.ledger.find((e) => e.nuggetId === entry.nuggetId),
          ),
      )
    )
      throw new EngineError(
        "Original nugget IDs and every existing ledger rule must remain unchanged.",
      );
    const changed = corrected.nuggets.filter(
      (n, i) => !equal(n, base.nuggets[i]),
    );
    if (
      new Set(body.sourceEvidence.map((e) => e.nuggetId)).size !==
        body.sourceEvidence.length ||
      changed.length !== body.sourceEvidence.length ||
      changed.some(
        (n) =>
          !body.sourceEvidence.some(
            (e) =>
              e.nuggetId === n.id &&
              e.sourceId === n.sourceId &&
              e.quote === n.quote,
          ),
      )
    )
      throw new EngineError(
        "Every changed or added nugget needs its exact source citation and reason.",
      );
    if (
      base.questions.length !== corrected.questions.length ||
      corrected.questions.some((q, i) => {
        const { answer: _oldAnswer, ...oldQuestion } = base.questions[i] ?? {};
        const { answer, ...question } = q;
        return (
          !equal(oldQuestion, question) ||
          !/^Operator editorial decision: \S/.test(answer)
        );
      })
    )
      throw new EngineError(
        "Retain each question and explicitly label every operator editorial decision.",
      );
    const problems = heartProblems(corrected, source);
    if (problems.length) throw new EngineError(problems.join(" "));
    const record: HeartCorrectionRecord = {
      version: 1,
      id: id(),
      actorId,
      appliedAt: now(),
      ...body,
      creationId: creation?.id ?? null,
      frozenSourceHash,
      profileHash: job.profile,
      requestHash,
      correctedHeartHash: hash(canonical(corrected)),
      changes: {
        addedLedgerEntries: corrected.ledger.filter(
          (e) => !base.ledger.some((old) => old.nuggetId === e.nuggetId),
        ),
        nuggets: changed.map((n) => ({
          before: base.nuggets.find((old) => old.id === n.id) ?? null,
          after: n,
        })),
        questions: corrected.questions.map((q, i) => ({
          before: base.questions[i],
          after: q,
        })),
      },
    };
    store.run(
      "INSERT INTO studio_steps VALUES(?,?,?,'completed',?)",
      job.id,
      HEART_CORRECTION_STAGE,
      inputHash,
      canonical(record),
    );
    store.run(
      "UPDATE studio_jobs SET state=?,status='queued',error=NULL,leaseToken=NULL,leaseUntil=0 WHERE id=?",
      canonical({ ...state, heart: corrected }),
      job.id,
    );
    return record;
  });
}

export interface HeartCorrectionRecord extends z.infer<
  typeof HeartCorrectionInput
> {
  version: 1;
  id: string;
  actorId: string;
  appliedAt: string;
  creationId: string | null;
  frozenSourceHash: string | null;
  profileHash: string;
  requestHash: string;
  correctedHeartHash: string;
  changes: {
    addedLedgerEntries: z.infer<typeof HeartContract>["ledger"];
    nuggets: {
      before: z.infer<typeof HeartContract>["nuggets"][number] | null;
      after: z.infer<typeof HeartContract>["nuggets"][number];
    }[];
    questions: {
      before: z.infer<typeof HeartContract>["questions"][number];
      after: z.infer<typeof HeartContract>["questions"][number];
    }[];
  };
}
