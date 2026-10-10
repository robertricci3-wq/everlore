import { heldOutCases, seedReleaseCases } from "./release-cases.js";
import { z } from "zod";
import { randomInt } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Store, canonical, hash, id, now } from "../store.js";
import { EngineError } from "../engine/pipeline.js";
import type { EngineConfig } from "../engine/provider.js";
import { activeProfile, loadProfile, saveProfile } from "./profiles.js";
import { agenda, artCases, seedLibrary } from "./library.js";
import {
  CraftPrinciple,
  ExperimentPlan,
  LabCase,
  ObservationInput,
  type LabView,
  type LabExperimentView,
  type EvaluationCase,
} from "../../shared/lab.js";

export const RULE_VERSION = "matched-3";
export const acceptance = {
  version: RULE_VERSION,
  judgment: "provisional-model-evidence",
  minWins: 0.6,
  maxLosses: 0,
  noUnresolvedPreservationDefects: true,
  replicates: 3,
  fullSuite: true,
  reversedOrderAgreement: true,
  engineering: ["typecheck", "lint", "test", "build", "test:e2e"],
  humanGate: false,
  heldOutStoryRelease: true,
};
export interface FrozenPlan extends z.infer<typeof ExperimentPlan> {
  baselineHash: string;
  cases: EvaluationCase[];
  visualCases: typeof artCases;
  acceptance: typeof acceptance;
  rubricHash: string;
  codeHash: string;
}
export interface ExperimentRow {
  id: string;
  ownerId: string;
  plan: string;
  planHash: string;
  status: string;
  maxCents: number;
  authorization: string | null;
  engineering: string;
  error: string | null;
  canon: string | null;
  createdAt: string;
}
export interface RunRow {
  id: string;
  experimentId: string;
  caseId: string;
  replicate: number;
  arm: "baseline" | "candidate";
  side: "A" | "B";
  status: string;
  stage: string;
  projectId: string | null;
  jobId: string | null;
  leaseToken: string | null;
  leaseUntil: number;
  output: string | null;
  error: string | null;
}
export const PairReview = z.object({
  preference: z.enum(["first", "second", "tie", "inconclusive"]),
  evidence: z
    .array(
      z.object({
        side: z.enum(["first", "second"]),
        spread: z.number().int().min(1).max(12).nullable(),
        quote: z.string().max(800),
        finding: z.string().min(8).max(2000),
      }),
    )
    .min(2)
    .max(12),
  regressions: z.array(z.string().min(5)).max(12),
  preservationPassed: z.boolean(),
  uncertainty: z.string().max(2000),
});
export interface Comparison {
  pairKey: string;
  winner: "baseline" | "candidate" | "tie" | "inconclusive";
  reviews: z.infer<typeof PairReview>[];
  disagreement: boolean;
  preservationPassed: boolean;
  simulated: boolean;
}
export function codeHash(root = process.cwd()): string {
  const files: string[] = [];
  function walk(dir: string) {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  }
  walk("src");
  walk("tests");
  files.push("package.json", "pnpm-lock.yaml");
  return hash(
    canonical(files.sort().map((p) => [p, hash(readFileSync(join(root, p)))])),
  );
}
export function labOwner(store: Store) {
  return (
    store.one<{ value: string }>(
      "SELECT value FROM lab_settings WHERE key='owner_id'",
    )?.value ?? null
  );
}
export function setLabOwner(store: Store, userId: string) {
  if (!store.one("SELECT id FROM users WHERE id=? AND kind='private'", userId))
    throw new EngineError("Choose an existing private shelf as Lab owner.");
  store.run(
    "INSERT INTO lab_settings VALUES('owner_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    userId,
  );
}
export function candidateProfile(
  store: Store,
  c: EngineConfig,
  mechanismId: string,
) {
  const a = agenda.find((a) => a.id === mechanismId);
  if (!a)
    throw new EngineError(
      "Choose a versioned craft experiment from the agenda.",
    );
  const base = activeProfile(store, c);
  return saveProfile(store, {
    ...base,
    name: `${a.title} · candidate`,
    parentHash: base.hash,
    craftRules: {
      ...base.craftRules,
      ...(a.id === "reader-experience" ? { readerExperienceVersion: 1 } : {}),
      ...(a.id === "premise-diversity" ? { premiseDiversityVersion: 1 } : {}),
      ...(a.id === "visual-direction" ? { visualDirectionVersion: 1 } : {}),
    },
    artSystem:
      a.target === "art"
        ? `${base.artSystem}\n\nCANDIDATE MECHANISM:\n${a.amendment}`
        : base.artSystem,
    instructions:
      a.target === "art"
        ? base.instructions
        : {
            ...base.instructions,
            [a.target]: `${base.instructions[a.target]}\n\nCANDIDATE MECHANISM:\n${a.amendment}`,
          },
    ...(a.id === "premise-diversity"
      ? {
          instructions: {
            ...base.instructions,
            concepts: `${base.instructions.concepts}\n${a.amendment}`,
            conceptReview: `${base.instructions.conceptReview}\nSupply diversity version 1. Compare every unordered pair of the three concept IDs exactly once. Cite the concrete difference in action and payoff. Set distinct false for cosmetic variation; this is a provisional model judgment.`,
          },
        }
      : {}),
    ...(a.id === "visual-direction"
      ? {
          instructions: {
            ...base.instructions,
            scenes: `${base.instructions.scenes}\nSupply visualDirection version 1 for all twelve spreads before artwork. Plan emotional color progression and recurring motifs; for each spread specify density, focal point and normalized geometric staging (0..1) for exactly its scene character IDs, with posture and scale. Explain emotional purpose, color intent, word-picture relationship and visual discovery. These rough compositions are layout plans, not evidence that artwork has been inspected.`,
          },
        }
      : {}),
    change: { target: a.target, mechanism: a.id, amendment: a.amendment },
  });
}
export function parsePlan(e: ExperimentRow): FrozenPlan {
  if (hash(canonical(JSON.parse(e.plan))) !== e.planHash)
    throw new EngineError(
      "The frozen experiment plan failed its integrity check.",
    );
  const plan = JSON.parse(e.plan) as FrozenPlan;
  ExperimentPlan.parse(plan);
  for (const c of plan.cases) LabCase.parse(c);
  if (
    hash(canonical(plan.acceptance)) !== plan.rubricHash ||
    !["matched-2", RULE_VERSION].includes(plan.acceptance.version)
  )
    throw new EngineError("The frozen rubric changed. Start a new comparison.");
  return plan;
}
export function experiment(store: Store, experimentId: string): ExperimentRow {
  const e = store.one<ExperimentRow>(
    "SELECT * FROM lab_experiments WHERE id=?",
    experimentId,
  );
  if (!e) throw new EngineError("This experiment is unavailable.");
  return e;
}
export function createExperiment(
  store: Store,
  ownerId: string,
  input: unknown,
  c: EngineConfig,
  requestedId?: string,
) {
  seedLibrary(store);
  const body = z
      .object({
        plan: ExperimentPlan,
        maxCents: z.number().int().min(0).max(1000000).default(0),
        authorizeCosts: z.boolean().default(false),
      })
      .parse(input),
    plan = body.plan,
    base = activeProfile(store, c),
    candidate = loadProfile(store, plan.candidateHash);
  if (requestedId) {
    const existing = store.one<ExperimentRow>(
      "SELECT * FROM lab_experiments WHERE id=?",
      requestedId,
    );
    if (existing) {
      const prior = parsePlan(existing);
      if (
        existing.ownerId !== ownerId ||
        canonical(ExperimentPlan.parse(prior)) !== canonical(plan) ||
        existing.maxCents !== (plan.mode === "live" ? body.maxCents : 0)
      )
        throw new EngineError(
          "This experiment identity already has different frozen inputs.",
        );
      return existing.id;
    }
  }
  if (candidate.parentHash !== base.hash)
    throw new EngineError(
      "Compare a candidate derived from the current active profile.",
    );
  if (candidate.hash === base.hash)
    throw new EngineError("Choose a distinct candidate.");
  if (
    (candidate.change.target === "art") !== (plan.lane === "art") &&
    plan.lane !== "book"
  )
    throw new EngineError(
      "Match the experiment lane to the changed mechanism.",
    );
  if (plan.mode === "live" && (!body.authorizeCosts || !body.maxCents))
    throw new EngineError(
      "A live experiment needs its own explicit allowance.",
    );
  if (
    plan.evaluationPhase !== "release" &&
    plan.caseIds.some((cid) => heldOutCases.some((c) => c.id === cid))
  )
    throw new EngineError(
      "Keep development and held-out release cases separate.",
    );
  if (plan.evaluationPhase === "release") seedReleaseCases(store);
  const suite =
    plan.lane === "art"
      ? artCases
      : store
          .all<{ body: string }>("SELECT body FROM lab_cases")
          .map((r) => LabCase.parse(JSON.parse(r.body)));
  if (
    new Set(plan.caseIds).size !== plan.caseIds.length ||
    plan.caseIds.some((cid) => !suite.some((c) => c.id === cid))
  )
    throw new EngineError("Use unique available cases.");
  const caseInputs =
    plan.lane === "art"
      ? [
          LabCase.parse(
            JSON.parse(
              store.one<{ body: string }>(
                "SELECT body FROM lab_cases WHERE id='ordinary'",
              )!.body,
            ),
          ),
        ]
      : plan.caseIds.map((cid) =>
          LabCase.parse(
            JSON.parse(
              store.one<{ body: string }>(
                "SELECT body FROM lab_cases WHERE id=?",
                cid,
              )!.body,
            ),
          ),
        );
  if (
    plan.lane !== "art" &&
    caseInputs.some(
      (x) =>
        (x.partition === "held_out") !== (plan.evaluationPhase === "release"),
    )
  )
    throw new EngineError(
      "Keep development and held-out release cases separate.",
    );
  if (plan.evaluationPhase === "release" && plan.lane !== "art") {
    const prior = plan.prerequisiteIds.map((eid) => experiment(store, eid));
    if (
      !prior.some((e) => {
        const p = parsePlan(e);
        return (
          e.ownerId === ownerId &&
          p.evaluationPhase !== "release" &&
          p.candidateHash === candidate.hash &&
          p.baselineHash === base.hash &&
          p.lane === plan.lane &&
          p.mode === plan.mode &&
          ["complete", "inconclusive"].includes(e.status)
        );
      })
    )
      throw new EngineError(
        "Run a matched development comparison of this exact candidate before held-out release evaluation.",
      );
  }
  if (
    caseInputs.some(
      (x) =>
        !x.synthetic &&
        (!x.consentAt ||
          !x.projectId ||
          !store.one(
            "SELECT id FROM projects WHERE id=? AND ownerId=?",
            x.projectId,
            ownerId,
          )),
    )
  )
    throw new EngineError(
      "Family material needs specific evaluation consent and ownership.",
    );
  if (plan.mode === "live" && plan.lane === "book") {
    const prior = plan.prerequisiteIds.map((eid) => experiment(store, eid));
    if (
      !prior.some((e) => parsePlan(e).lane === "story") ||
      !prior.some((e) => parsePlan(e).lane === "art") ||
      prior.some(
        (e) =>
          e.ownerId !== ownerId ||
          parsePlan(e).mode !== "live" ||
          !["complete", "promoted"].includes(e.status),
      )
    )
      throw new EngineError(
        "Complete retained live story and art stage comparisons before commissioning a book comparison.",
      );
  }
  const frozen: FrozenPlan = {
      ...plan,
      baselineHash: base.hash,
      cases: caseInputs,
      visualCases: artCases,
      acceptance: { ...acceptance },
      rubricHash: hash(canonical(acceptance)),
      codeHash: codeHash(),
    },
    experimentId = requestedId ?? id();
  store.transaction(() => {
    store.run(
      "INSERT INTO lab_experiments(id,ownerId,plan,planHash,status,maxCents,authorization,createdAt) VALUES(?,?,?,?,?,?,?,?)",
      experimentId,
      ownerId,
      JSON.stringify(frozen),
      hash(canonical(frozen)),
      "planned",
      plan.mode === "live" ? body.maxCents : 0,
      plan.mode === "live"
        ? JSON.stringify({
            by: ownerId,
            at: now(),
            maxCents: body.maxCents,
            scope: "this experiment only",
          })
        : null,
      now(),
    );
    for (const caseId of plan.caseIds)
      for (let rep = 1; rep <= plan.replicates; rep++) {
        const flip = randomInt(2);
        for (const [index, arm] of ["baseline", "candidate"].entries())
          store.run(
            "INSERT INTO lab_runs(id,experimentId,caseId,replicate,arm,side,status) VALUES(?,?,?,?,?,?,?)",
            id(),
            experimentId,
            caseId,
            rep,
            arm,
            index === flip ? "A" : "B",
            "queued",
          );
      }
  });
  return experimentId;
}
export function engineeringPassed(store: Store, plan: FrozenPlan) {
  const receipt = store.one<{ value: string }>(
    "SELECT value FROM lab_settings WHERE key='engineering_receipt'",
  );
  if (!receipt) return false;
  const r = JSON.parse(receipt.value);
  return (
    r.codeHash === plan.codeHash &&
    r.codeHash === codeHash() &&
    acceptance.engineering.every((k) => r.results?.[k] === true)
  );
}
export function summary(store: Store, e: ExperimentRow) {
  const p = parsePlan(e),
    runs = store.all<RunRow>(
      "SELECT * FROM lab_runs WHERE experimentId=?",
      e.id,
    ),
    comparisons = store
      .all<{ body: string }>(
        "SELECT body FROM lab_comparisons WHERE experimentId=?",
        e.id,
      )
      .map((r) => JSON.parse(r.body) as Comparison),
    expected = p.caseIds.length * p.replicates,
    complete = runs.filter((r) => r.status === "complete").length,
    failures = runs.filter((r) =>
      ["failed", "needs_attention", "budget_exhausted"].includes(r.status),
    ).length,
    wins = comparisons.filter((r) => r.winner === "candidate").length,
    losses = comparisons.filter((r) => r.winner === "baseline").length,
    ties = comparisons.filter((r) => r.winner === "tie").length,
    inconclusive = comparisons.filter(
      (r) => r.winner === "inconclusive",
    ).length;
  const blockers: string[] = [];
  if (p.mode !== "live" || comparisons.some((c) => c.simulated))
    blockers.push(
      "Offline fixtures verify behavior only; no creative promotion.",
    );
  if (complete !== runs.length || comparisons.length !== expected)
    blockers.push("The matched comparison is incomplete.");
  const required =
    p.lane === "art"
      ? artCases.map((c) => c.id)
      : heldOutCases.map((c) => c.id);
  if (p.lane !== "art" && p.evaluationPhase !== "release")
    blockers.push("Promotion requires a separate held-out release evaluation.");
  if (p.replicates !== 3 || required.some((cid) => !p.caseIds.includes(cid)))
    blockers.push(
      "Promotion needs the entire fixed suite and three retained runs per case.",
    );
  if (wins / expected < acceptance.minWins || losses > 0)
    blockers.push(
      "The declared improvement criterion is not met (≥60% wins; no losses).",
    );
  if (
    p.mode === "live" &&
    comparisons.some(
      (c) =>
        c.reviews.length !== 2 ||
        c.reviews.some((r) => !PairReview.safeParse(r).success),
    )
  )
    blockers.push(
      "Both independently retained comparison orders are required.",
    );
  if (inconclusive || comparisons.some((c) => c.disagreement))
    blockers.push("Conflicting or insufficient model evidence.");
  if (
    failures ||
    comparisons.some(
      (c) =>
        !c.preservationPassed || c.reviews.some((r) => r.regressions.length),
    )
  )
    blockers.push("Unresolved failures, preservation defects or regressions.");
  if (!engineeringPassed(store, p))
    blockers.push(
      "Current engineering verification, including browser tests, is incomplete.",
    );
  const current = store.one<{ value: string }>(
    "SELECT value FROM lab_settings WHERE key='active_profile'",
  )?.value;
  if (current !== p.baselineHash && e.status !== "promoted")
    blockers.push(
      "The active baseline changed; run a fresh matched comparison.",
    );
  const costs = store.one<{ estimated: number; actual: number | null }>(
    "SELECT COALESCE(SUM(estimatedCents),0) AS estimated, CASE WHEN COUNT(*)=COUNT(actualCents) THEN COALESCE(SUM(actualCents),0) ELSE NULL END AS actual FROM lab_calls WHERE runId IN(SELECT id FROM lab_runs WHERE experimentId=?)",
    e.id,
  )!;
  const repairs =
    store.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM studio_calls WHERE jobId IN(SELECT jobId FROM lab_runs WHERE experimentId=?) AND (stage LIKE 'refine_%' OR stage LIKE '%_render_2' OR stage LIKE '%_render_3')",
      e.id,
    )!.n +
    store.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM lab_calls WHERE runId IN(SELECT id FROM lab_runs WHERE experimentId=?) AND stage LIKE 'art_render_%' AND stage NOT LIKE '%_1'",
      e.id,
    )!.n;
  return {
    complete,
    total: runs.length,
    wins,
    losses,
    ties,
    inconclusive,
    failures,
    repairs,
    reviewed: comparisons.length,
    eligible: !blockers.length,
    blockers,
    worstCases: comparisons
      .filter((c) => c.winner !== "candidate")
      .map((c) => `${c.pairKey}: ${c.winner}`),
    costPerCompletedCents: complete ? costs.estimated / complete : null,
    actualCents: costs.actual,
    machineDisagreements: comparisons.filter((c) => c.disagreement).length,
    reveal: comparisons.length === expected,
    reservedCents: costs.estimated,
  };
}
export function considerRelease(store: Store, eid: string) {
  const e = experiment(store, eid),
    p = parsePlan(e),
    s = summary(store, e);
  if (e.status === "promoted") return true;
  if (!s.eligible) return false;
  return store.transaction(() => {
    const current = store.one<{ value: string }>(
      "SELECT value FROM lab_settings WHERE key='active_profile'",
    )?.value;
    if (current !== p.baselineHash) return false;
    store.run(
      "UPDATE lab_settings SET value=? WHERE key='active_profile'",
      p.candidateHash,
    );
    store.run(
      "INSERT INTO lab_releases VALUES(?,?,?,?,?,?,?)",
      id(),
      eid,
      "automatic_promotion",
      p.candidateHash,
      p.baselineHash,
      JSON.stringify({
        acceptance: p.acceptance,
        summary: s,
        claim: "Provisional automated evidence; no child engagement claim",
      }),
      now(),
    );
    store.run("UPDATE lab_experiments SET status='promoted' WHERE id=?", eid);
    return true;
  });
}
export function rollback(store: Store, releaseId: string) {
  store.transaction(() => {
    const release = store.one<{ profileHash: string; previousHash: string }>(
      "SELECT * FROM lab_releases WHERE id=?",
      releaseId,
    );
    if (
      !release ||
      store.one<{ value: string }>(
        "SELECT value FROM lab_settings WHERE key='active_profile'",
      )?.value !== release.profileHash
    )
      throw new EngineError("Only the current release can be rolled back.");
    loadProfile(store, release.previousHash);
    store.run(
      "UPDATE lab_settings SET value=? WHERE key='active_profile'",
      release.previousHash,
    );
    store.run(
      "INSERT INTO lab_releases VALUES(?,NULL,?,?,?,?,?)",
      id(),
      "rollback",
      release.previousHash,
      release.profileHash,
      "Operator rollback; existing jobs and editions remain pinned.",
      now(),
    );
  });
}
export function addObservation(store: Store, eid: string, input: unknown) {
  const body = ObservationInput.parse(input);
  if (
    !store.one(
      "SELECT id FROM lab_runs WHERE experimentId=? AND caseId || ':' || replicate=?",
      eid,
      body.pairKey,
    )
  )
    throw new EngineError("Choose a pair from this experiment.");
  store.run(
    "INSERT INTO lab_observations VALUES(?,?,?,?)",
    id(),
    eid,
    JSON.stringify(body),
    now(),
  );
}
export function labView(
  store: Store,
  c: EngineConfig,
  ownerId: string,
): LabView {
  seedLibrary(store);
  const active = activeProfile(store, c),
    allowed = labOwner(store) === ownerId;
  if (!allowed)
    return {
      allowed: false,
      ownerConfigured: !!labOwner(store),
      activeHash: "",
      profiles: [],
      principles: [],
      cases: [],
      artCases: [],
      experiments: [],
      releases: [],
      providerConfigured: false,
      reserves: { text: 0, image: 0 },
      message: "Creative Lab is private to its configured operator.",
    };
  return {
    allowed: true,
    ownerConfigured: true,
    activeHash: active.hash,
    profiles: store
      .all<{ body: string }>(
        "SELECT body FROM lab_profiles ORDER BY rowid DESC",
      )
      .map((r) => loadProfile(store, JSON.parse(r.body).hash)),
    principles: store
      .all<{ body: string }>("SELECT body FROM lab_principles")
      .map((r) => CraftPrinciple.parse(JSON.parse(r.body))),
    cases: store
      .all<{ body: string }>(
        "SELECT body FROM lab_cases WHERE ownerId IS NULL OR ownerId=?",
        ownerId,
      )
      .map((r) => LabCase.parse(JSON.parse(r.body)))
      .filter((c) => c.partition !== "held_out"),
    artCases,
    experiments: store
      .all<ExperimentRow>(
        "SELECT * FROM lab_experiments WHERE ownerId=? ORDER BY rowid DESC",
        ownerId,
      )
      .map((e) => {
        const p = parsePlan(e),
          s = summary(store, e);
        return {
          id: e.id,
          title: p.title,
          hypothesis: p.hypothesis,
          risk: p.risk,
          lane: p.lane,
          mode: p.mode,
          criterion: p.criterion,
          evaluationPhase: p.evaluationPhase,
          baselineHash: p.baselineHash,
          candidateHash: p.candidateHash,
          replicates: p.replicates,
          caseIds: p.evaluationPhase === "release" ? [] : p.caseIds,
          planHash: e.planHash,
          status: e.status,
          maxCents: e.maxCents,
          reservedCents: s.reservedCents,
          engineering: engineeringPassed(store, p) ? "passed" : "unverified",
          createdAt: e.createdAt,
          error:
            p.evaluationPhase === "release" && e.error
              ? "Release evaluation stopped; individual evidence is retained privately."
              : e.error,
          canon:
            p.evaluationPhase === "release"
              ? null
              : e.canon
                ? JSON.parse(e.canon)
                : null,
          runs:
            p.evaluationPhase === "release"
              ? []
              : store
                  .all<RunRow>(
                    "SELECT * FROM lab_runs WHERE experimentId=? ORDER BY caseId,replicate,side",
                    e.id,
                  )
                  .map((r) => ({
                    id: r.id,
                    pairKey: `${r.caseId}:${r.replicate}`,
                    side: r.side,
                    caseTitle:
                      artCases.find((c) => c.id === r.caseId)?.title ??
                      p.cases.find((c) => c.id === r.caseId)?.title ??
                      r.caseId,
                    replicate: r.replicate,
                    status: r.status,
                    stage: r.stage,
                    error: r.error,
                    projectId: r.projectId,
                    jobId: r.jobId,
                    output: r.output ? JSON.parse(r.output) : null,
                    attempts: store
                      .all<{
                        stage: string;
                        state: string;
                        result: string | null;
                      }>(
                        "SELECT stage,state,result FROM lab_steps WHERE runId=?",
                        r.id,
                      )
                      .map((a) => ({
                        stage: a.stage,
                        status: a.state,
                        result: a.result ? JSON.parse(a.result) : null,
                      })),
                    calls: store.all(
                      "SELECT stage,status,latencyMs,estimatedCents,actualCents,usage FROM lab_calls WHERE runId=?",
                      r.id,
                    ),
                  })),
          observations:
            p.evaluationPhase === "release"
              ? []
              : store
                  .all<{ id: string; body: string; createdAt: string }>(
                    "SELECT * FROM lab_observations WHERE experimentId=?",
                    e.id,
                  )
                  .map((o) => ({
                    ...ObservationInput.parse(JSON.parse(o.body)),
                    id: o.id,
                    createdAt: o.createdAt,
                  })),
          summary:
            p.evaluationPhase === "release" ? { ...s, worstCases: [] } : s,
        } as LabExperimentView;
      }),
    releases: store
      .all<LabView["releases"][number]>(
        "SELECT id,action,profileHash,previousHash,notes,createdAt FROM lab_releases ORDER BY rowid DESC",
      )
      .map((r) => ({
        ...r,
        notes:
          r.action === "rollback"
            ? "Operator rollback; saved editions remain unchanged."
            : "Automated release; consult aggregate evaluation evidence.",
      })),
    providerConfigured: c.enabled && !!c.apiKey,
    reserves: { text: c.textReserve, image: c.imageReserve },
    message:
      "Autonomous generation, criticism and release gates. Optional human feedback is separate. Model judgments do not establish child engagement.",
  };
}
