import { hash, type Store } from "../store.js";
import { EditorialReview } from "../../shared/studio.js";
import { experiment, parsePlan, summary, type RunRow } from "./service.js";
import { memoryExperimentView } from "./memory.js";

/** Public-to-the-improvement-loop projection. Raw held-out evidence stays in storage. */
export function experimentReport(store: Store, experimentId: string) {
  if (
    store.one(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='lab_memory_experiments'",
    )
  ) {
    const memory = store.one<{ ownerId: string }>(
      "SELECT ownerId FROM lab_memory_experiments WHERE id=?",
      experimentId,
    );
    if (memory) {
      const view = memoryExperimentView(store, memory.ownerId, experimentId);
      return {
        version: 1,
        id: view.id,
        status: view.status,
        planHash: view.planHash,
        hypothesis: view.plan.hypothesis,
        risk: view.plan.risk,
        baselineHash: view.plan.baselineHash,
        candidateHash: view.plan.candidateHash,
        caseVersion: view.plan.caseVersion,
        implementationHash: view.plan.implementationHash,
        summary: view.summary,
        error: view.error,
        evidencePath: `/api/lab/memory/${view.id}`,
        evidenceKind: "deterministic_policy_check",
        audienceValidation: false,
        costs: {
          reservedCents: 0,
          usageDerivedCents: 0,
          verifiedBilledCents: 0,
          providerCalls: 0,
        },
      };
    }
  }
  const e = experiment(store, experimentId),
    p = parsePlan(e),
    s = summary(store, e);
  const heldOut = p.evaluationPhase === "release";
  const runs = store.all<RunRow>(
    "SELECT * FROM lab_runs WHERE experimentId=? ORDER BY id",
    e.id,
  );
  const dimensions = new Map<string, number[]>();
  const scored: Array<{ id: string; mean: number }> = [];
  for (const r of runs) {
    if (!r.output) continue;
    const output = JSON.parse(r.output);
    const review = EditorialReview.safeParse(output.editorialReview);
    if (!review.success || output.mode !== "live") continue;
    for (const x of review.data.scores) {
      const key = `${r.arm}:${x.criterion}`;
      dimensions.set(key, [...(dimensions.get(key) ?? []), x.score]);
    }
    scored.push({
      id: r.id,
      mean:
        review.data.scores.reduce((n, x) => n + x.score, 0) /
        Math.max(1, review.data.scores.length),
    });
  }
  const calls = store.all<{
    status: string;
    estimatedCents: number;
    actualCents: number | null;
  }>(
    "SELECT status,estimatedCents,actualCents FROM lab_calls WHERE runId IN(SELECT id FROM lab_runs WHERE experimentId=?)",
    e.id,
  );
  const seed = hash(`review-packet-v1:${e.planHash}`);
  const ordered = [...runs].sort((a, b) =>
    hash(seed + a.id).localeCompare(hash(seed + b.id)),
  );
  const weakest =
    runs.find((r) => r.status === "failed" || r.status === "needs_attention")
      ?.id ??
    scored.sort((a, b) => a.mean - b.mean)[0]?.id ??
    null;
  const hasBounds = !!store.one(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='lab_request_bounds'",
  );
  const hasMetered = !!store.one(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='lab_metered_costs'",
  );
  const metered = hasMetered
    ? store
        .all<{ body: string }>(
          "SELECT m.body FROM lab_metered_costs m JOIN lab_calls c ON c.id=m.callId JOIN lab_runs r ON r.id=c.runId WHERE r.experimentId=?",
          e.id,
        )
        .map((r) => JSON.parse(r.body))
    : [];
  return {
    version: 1,
    id: e.id,
    title: p.title,
    lane: p.lane,
    status: e.status,
    phase: p.evaluationPhase,
    mode: p.mode,
    planHash: e.planHash,
    baselineHash: p.baselineHash,
    candidateHash: p.candidateHash,
    rubricHash: p.rubricHash,
    evidenceKind:
      p.mode === "offline"
        ? "control_flow_fixture"
        : "provisional_model_judgment",
    audienceValidation: false,
    coverage: {
      expectedArtifacts: p.caseIds.length * p.replicates * 2,
      retainedArtifacts: runs.length,
      completed: s.complete,
      failures: s.failures,
      repairs: s.repairs,
    },
    comparison: {
      wins: s.wins,
      losses: s.losses,
      ties: s.ties,
      inconclusive: s.inconclusive,
      disagreements: s.machineDisagreements,
    },
    release: { eligible: s.eligible, blockers: s.blockers },
    dimensions: [...dimensions].map(([key, values]) => ({
      key,
      count: values.length,
      mean: values.reduce((a, b) => a + b, 0) / values.length,
      lowestObserved: Math.min(...values),
      distribution: [1, 2, 3, 4, 5].map((score) => ({
        score,
        count: values.filter((v) => v === score).length,
      })),
    })),
    scoreLimit:
      "Lowest observed is a sample minimum, not a guarantee about future families. Missing scores and failed runs are not excluded from coverage.",
    costs: {
      reservedCents: s.reservedCents,
      verifiedBilledCents: s.actualCents,
      unknownBillingCalls: calls.filter((c) => c.actualCents === null).length,
      usageDerivedCents:
        calls.length === metered.length
          ? metered.reduce((n, r) => n + r.estimatedCostCents, 0)
          : null,
      usageEstimatedCalls: metered.length,
      requestBoundsRecorded: hasBounds,
    },
    reviewPacket: heldOut
      ? null
      : {
          seed,
          representativeRunIds: ordered
            .filter((r) => r.id !== weakest)
            .slice(0, 9)
            .map((r) => r.id),
          weakestRunId: weakest,
          selection:
            "Seeded sample of retained attempts, plus a failure or lowest-scored output; no selection based on preference.",
        },
    observationCounts: heldOut
      ? null
      : store.all<{ role: string; count: number }>(
          "SELECT json_extract(body,'$.role') AS role,count(*) AS count FROM lab_observations WHERE experimentId=? GROUP BY role",
          e.id,
        ),
    heldOutRedacted: heldOut,
  };
}

export function sessionReport(store: Store, sessionId: string) {
  const session = store.one<{
    id: string;
    status: string;
    iteration: number;
    noProgress: number;
    checkpoint: string;
    plan: string;
  }>(
    "SELECT id,status,iteration,noProgress,checkpoint,plan FROM lab_sessions WHERE id=?",
    sessionId,
  );
  if (!session) throw new Error("Session unavailable.");
  const hasJournal = !!store.one(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='lab_session_experiments'",
  );
  const ids = hasJournal
    ? store.all<{ experimentId: string }>(
        "SELECT experimentId FROM lab_session_experiments WHERE sessionId=? ORDER BY rowid",
        sessionId,
      )
    : [];
  return {
    version: 1,
    ...session,
    checkpoint: publicSessionCheckpoint(store, sessionId, session.checkpoint),
    plan: JSON.parse(session.plan),
    experiments: ids.map((r) =>
      store.one("SELECT id FROM lab_experiments WHERE id=?", r.experimentId) ||
      store.one(
        "SELECT id FROM lab_memory_experiments WHERE id=?",
        r.experimentId,
      )
        ? experimentReport(store, r.experimentId)
        : {
            id: r.experimentId,
            status: "pending_creation",
            checkpoint:
              "The reserved experiment identity will be reused on resume.",
          },
    ),
    audienceValidation: false,
  };
}

export function publicSessionCheckpoint(
  store: Store,
  sessionId: string,
  checkpoint: string,
) {
  const current = store.one<{ plan: string }>(
    "SELECT e.plan FROM lab_sessions s JOIN lab_experiments e ON e.id=s.currentExperiment WHERE s.id=?",
    sessionId,
  );
  const hasJournal = store.one(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='lab_session_experiments'",
  );
  const released =
    hasJournal &&
    store.one(
      "SELECT experimentId FROM lab_session_experiments WHERE sessionId=? AND phase='release'",
      sessionId,
    );
  return released ||
    (current && JSON.parse(current.plan).evaluationPhase === "release")
    ? "Held-out release evaluation retained. See the aggregate report; individual evidence remains outside development views."
    : checkpoint;
}
