import { readFileSync } from "node:fs";
import {
  buildMemoryBrief,
  GuideDecision,
  InterviewSession,
  nextMemoryPrompt,
} from "../../shared/almanac.js";
import {
  COMPLETE_RITUAL_MEMORY_GUIDE,
  LEGACY_MEMORY_GUIDE,
  MemoryGuideProfile,
} from "../../shared/memoryGuide.js";
import type {
  MemoryComparisonSummary,
  MemoryExperimentView,
  MemoryPolicyCase,
  MemoryPolicyPlan,
  MemoryPolicyRun,
} from "../../shared/memoryLab.js";
import { AccessError } from "../access.js";
import { canonical, hash, id, now, type Store } from "../store.js";
import {
  memoryPolicyCases,
  MEMORY_POLICY_CASE_VERSION,
} from "./memory-cases.js";
import { migrateMemoryLab } from "./memory-schema.js";

interface Row {
  id: string;
  ownerId: string;
  status: MemoryExperimentView["status"];
  plan: string;
  planHash: string;
  createdAt: string;
  error: string | null;
}
function authorize(store: Store, ownerId: string) {
  if (
    store.one<{ value: string }>(
      "SELECT value FROM lab_settings WHERE key='owner_id'",
    )?.value !== ownerId
  )
    throw new AccessError(
      403,
      "Memory comparisons are available only to the configured Lab operator.",
    );
  migrateMemoryLab(store.db);
}
function implementationHash() {
  return hash(
    canonical([
      hash(readFileSync(new URL("../../shared/almanac.ts", import.meta.url))),
      hash(
        readFileSync(new URL("../../shared/memoryGuide.ts", import.meta.url)),
      ),
      hash(readFileSync(new URL("./memory.ts", import.meta.url))),
    ]),
  );
}
function owned(store: Store, ownerId: string, experimentId: string) {
  authorize(store, ownerId);
  const row = store.one<Row>(
    "SELECT * FROM lab_memory_experiments WHERE id=? AND ownerId=?",
    experimentId,
    ownerId,
  );
  if (!row) throw new AccessError(404, "Memory comparison unavailable.");
  return row;
}
function parsePlan(row: Row): MemoryPolicyPlan {
  const plan = JSON.parse(row.plan) as MemoryPolicyPlan;
  if (
    hash(canonical(plan)) !== row.planHash ||
    hash(canonical(MemoryGuideProfile.parse(plan.baseline))) !==
      plan.baselineHash ||
    hash(canonical(MemoryGuideProfile.parse(plan.candidate))) !==
      plan.candidateHash
  )
    throw new AccessError(
      409,
      "The frozen memory comparison changed. Start a new comparison.",
    );
  for (const c of plan.cases) InterviewSession.parse(c.session);
  return plan;
}
export function createMemoryExperiment(
  store: Store,
  ownerId: string,
  requestedId: string = id(),
): string {
  authorize(store, ownerId);
  const existing = store.one<Row>(
    "SELECT * FROM lab_memory_experiments WHERE id=?",
    requestedId,
  );
  if (existing) {
    if (existing.ownerId !== ownerId)
      throw new AccessError(404, "Memory comparison unavailable.");
    parsePlan(existing);
    return existing.id;
  }
  const plan: MemoryPolicyPlan = {
    version: 1,
    hypothesis:
      "When a recurring ritual already supplies a distinctive detail and stated meaning, omit the extra request for a single occasion.",
    risk: "Stopping sooner may omit an occasion the narrator wanted to share; Add something remains available.",
    criterion:
      "Reduce only the redundant occasion prompt in authored complete-ritual cases while retaining all source, boundary, uncertainty, relationship and follow-up-limit assertions.",
    caseVersion: MEMORY_POLICY_CASE_VERSION,
    replicates: 3,
    baseline: LEGACY_MEMORY_GUIDE,
    candidate: COMPLETE_RITUAL_MEMORY_GUIDE,
    baselineHash: hash(canonical(LEGACY_MEMORY_GUIDE)),
    candidateHash: hash(canonical(COMPLETE_RITUAL_MEMORY_GUIDE)),
    implementationHash: implementationHash(),
    cases: structuredClone(memoryPolicyCases),
  };
  store.run(
    "INSERT INTO lab_memory_experiments VALUES(?,?,?,?,?,?,NULL)",
    requestedId,
    ownerId,
    "planned",
    canonical(plan),
    hash(canonical(plan)),
    now(),
  );
  return requestedId;
}
function evaluate(
  c: MemoryPolicyCase,
  plan: MemoryPolicyPlan,
  arm: MemoryPolicyRun["arm"],
  replicate: number,
): MemoryPolicyRun {
  const source = structuredClone(c.session),
    sourceHash = hash(canonical(source));
  const brief = buildMemoryBrief(source);
  const output = nextMemoryPrompt(c.invitation, brief, source.turns, plan[arm]);
  const expected = c.expected[arm],
    failures: string[] = [],
    assertions: string[] = [];
  function check(pass: boolean, message: string) {
    (pass ? assertions : failures).push(message);
  }
  check(
    hash(canonical(source)) === sourceHash,
    "Original transcript and turn records remain unchanged.",
  );
  check(
    output.action === expected.action &&
      (!expected.promptSuffix ||
        output.promptId === `${c.invitation.id}:${expected.promptSuffix}`),
    "Decision matches the frozen authored policy expectation.",
  );
  check(
    output.evidence.every(
      (e) =>
        source.turns
          .find((t) => t.id === e.turnId)
          ?.transcript?.rawText.slice(e.start, e.end) === e.quote,
    ),
    "Every cited passage is an exact source span.",
  );
  check(
    output.action !== "ask" ||
      c.invitation.followUps.some(
        (p) => p.id === output.promptId && p.text === output.promptText,
      ) ||
      output.promptText === c.invitation.opening,
    "Every offered question comes from the frozen authored invitation.",
  );
  check(
    !output.promptId ||
      !source.turns.some((t) => t.promptId === output.promptId),
    "No answered or skipped prompt is repeated.",
  );
  check(
    output.action !== "ask" ||
      source.turns.filter((t) =>
        c.invitation.followUps.some((p) => p.id === t.promptId),
      ).length < 3,
    "At most three optional follow-ups are offered.",
  );
  return {
    caseId: c.id,
    replicate,
    arm,
    profileHash: arm === "baseline" ? plan.baselineHash : plan.candidateHash,
    sourceHash,
    output,
    assertions,
    failures,
  };
}
function summarize(
  plan: MemoryPolicyPlan,
  runs: MemoryPolicyRun[],
): MemoryComparisonSummary {
  let candidateWins = 0,
    baselineWins = 0,
    ties = 0,
    pairCount = 0;
  for (const c of plan.cases)
    for (let replicate = 1; replicate <= plan.replicates; replicate++) {
      const baseline = runs.find(
        (r) =>
          r.caseId === c.id &&
          r.replicate === replicate &&
          r.arm === "baseline",
      );
      const candidate = runs.find(
        (r) =>
          r.caseId === c.id &&
          r.replicate === replicate &&
          r.arm === "candidate",
      );
      if (!baseline || !candidate) continue;
      pairCount++;
      if (baseline.failures.length || candidate.failures.length) continue;
      if (
        baseline.output.action === "ask" &&
        candidate.output.action === "finish"
      )
        candidateWins++;
      else if (
        candidate.output.action === "ask" &&
        baseline.output.action === "finish"
      )
        baselineWins++;
      else ties++;
    }
  const total = plan.cases.length * plan.replicates * 2;
  const failures = runs.filter((r) => r.failures.length > 0).length;
  return {
    pairCount,
    complete: runs.length,
    total,
    candidateWins,
    baselineWins,
    ties,
    failures,
    providerCalls: 0,
    engineeringOnly: true,
    promotionEligible: false,
    verdict:
      runs.length !== total
        ? "incomplete"
        : failures || baselineWins || !candidateWins
          ? "inconclusive"
          : "policy_supported",
    limitation:
      "Authored synthetic policy checks only. Repeated deterministic runs test reproducibility, not independent audience evidence. No model, real grandparent, child, generated book or production release was evaluated.",
  };
}
export function memoryExperimentView(
  store: Store,
  ownerId: string,
  experimentId: string,
): MemoryExperimentView {
  const row = owned(store, ownerId, experimentId),
    plan = parsePlan(row);
  const runs = store
    .all<{ body: string }>(
      "SELECT body FROM lab_memory_runs WHERE experimentId=? ORDER BY caseId,replicate,arm",
      row.id,
    )
    .map((r) => {
      const result = JSON.parse(r.body) as MemoryPolicyRun;
      GuideDecision.parse(result.output);
      return result;
    });
  return {
    id: row.id,
    status: row.status,
    planHash: row.planHash,
    plan,
    runs,
    summary: summarize(plan, runs),
    createdAt: row.createdAt,
    error: row.error,
  };
}
export function listMemoryExperiments(
  store: Store,
  ownerId: string,
): MemoryExperimentView[] {
  authorize(store, ownerId);
  return store
    .all<{ id: string }>(
      "SELECT id FROM lab_memory_experiments WHERE ownerId=? ORDER BY createdAt DESC,rowid DESC",
      ownerId,
    )
    .map((r) => memoryExperimentView(store, ownerId, r.id));
}
/** Local deterministic computation only. A pair limit provides a safe resumable checkpoint. */
export function runMemoryExperiment(
  store: Store,
  ownerId: string,
  experimentId?: string,
  options: { maxPairs?: number } = {},
): MemoryExperimentView {
  const eid = experimentId ?? createMemoryExperiment(store, ownerId);
  const row = owned(store, ownerId, eid),
    plan = parsePlan(row);
  if (row.status === "complete" || row.status === "needs_attention")
    return memoryExperimentView(store, ownerId, eid);
  if (plan.implementationHash !== implementationHash())
    throw new AccessError(
      409,
      "The guide implementation changed after this comparison was frozen. Start a new comparison.",
    );
  const maxPairs = options.maxPairs ?? Number.POSITIVE_INFINITY;
  if (!(maxPairs > 0))
    throw new AccessError(400, "Choose a positive pair limit.");
  let pairs = 0;
  for (const c of plan.cases)
    for (let replicate = 1; replicate <= plan.replicates; replicate++) {
      if (pairs >= maxPairs) {
        store.run(
          "UPDATE lab_memory_experiments SET status='paused' WHERE id=?",
          eid,
        );
        return memoryExperimentView(store, ownerId, eid);
      }
      let computed = false;
      for (const arm of ["baseline", "candidate"] as const) {
        if (
          store.one(
            "SELECT 1 FROM lab_memory_runs WHERE experimentId=? AND caseId=? AND replicate=? AND arm=?",
            eid,
            c.id,
            replicate,
            arm,
          )
        )
          continue;
        const result = evaluate(c, plan, arm, replicate);
        store.run(
          "INSERT OR IGNORE INTO lab_memory_runs VALUES(?,?,?,?,?,?)",
          eid,
          c.id,
          replicate,
          arm,
          canonical(result),
          now(),
        );
        computed = true;
      }
      if (computed) pairs++;
    }
  const view = memoryExperimentView(store, ownerId, eid);
  store.run(
    "UPDATE lab_memory_experiments SET status=?,error=? WHERE id=?",
    view.summary.failures ? "needs_attention" : "complete",
    view.summary.failures
      ? "One or more authored policy assertions failed; all results are retained."
      : null,
    eid,
  );
  return memoryExperimentView(store, ownerId, eid);
}
