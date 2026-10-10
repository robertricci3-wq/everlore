import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, hash, id, now, Store } from "../src/server/store.js";
import { configureAccess, createOperator } from "../src/server/access.js";
import { setLabOwner } from "../src/server/lab/service.js";
import {
  createMemoryExperiment,
  listMemoryExperiments,
  memoryExperimentView,
  runMemoryExperiment,
} from "../src/server/lab/memory.js";
import { memoryPolicyCases } from "../src/server/lab/memory-cases.js";
import {
  LEGACY_MEMORY_GUIDE,
  COMPLETE_RITUAL_MEMORY_GUIDE,
  MemoryGuideProfile,
} from "../src/shared/memoryGuide.js";
import { buildMemoryBrief, nextMemoryPrompt } from "../src/shared/almanac.js";
import { sessionView, startSession } from "../src/server/almanac/service.js";
import {
  exportInterviewArchive,
  importInterviewArchive,
} from "../src/server/almanac/archive.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "everlore-memory-lab-")),
    store = new Store(dir);
  configureAccess(store, false);
  const owner = createOperator(store, "memory-lab-owner", "synthetic-password");
  setLabOwner(store, owner);
  return {
    store,
    owner,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("memory guide profiles are immutable policies and only complete rituals change", () => {
  assert(
    !MemoryGuideProfile.safeParse({
      ...LEGACY_MEMORY_GUIDE,
      suppressCompleteRitualPrompt: true,
    }).success,
  );
  for (const c of memoryPolicyCases) {
    const original = canonical(c.session),
      brief = buildMemoryBrief(c.session);
    const a = nextMemoryPrompt(c.invitation, brief, c.session.turns);
    const b = nextMemoryPrompt(
      c.invitation,
      brief,
      c.session.turns,
      COMPLETE_RITUAL_MEMORY_GUIDE,
    );
    assert.equal(a.action, c.expected.baseline.action, c.id);
    assert.equal(b.action, c.expected.candidate.action, c.id);
    assert.equal(canonical(c.session), original);
    if (a.action !== b.action) {
      assert.equal(a.promptId, `${c.invitation.id}:occasion`);
      assert.equal(b.action, "finish");
      assert(b.evidence.length >= 3);
      for (const span of b.evidence)
        assert.equal(
          c.session.turns
            .find((t) => t.id === span.turnId)!
            .transcript!.rawText.slice(span.start, span.end),
          span.quote,
        );
    } else assert.deepEqual({ ...a, guideVersion: b.guideVersion }, b);
  }
});
test("failed policy expectations remain in reports and cannot promote a candidate", () => {
  const t = setup();
  try {
    const eid = createMemoryExperiment(t.store, t.owner);
    // Freeze an intentionally failing test oracle before any evaluation starts.
    const plan = memoryExperimentView(t.store, t.owner, eid).plan;
    plan.cases[0].expected.candidate = {
      action: "ask",
      promptSuffix: "occasion",
    };
    t.store.run(
      "UPDATE lab_memory_experiments SET plan=?,planHash=? WHERE id=?",
      canonical(plan),
      hash(canonical(plan)),
      eid,
    );
    const result = runMemoryExperiment(t.store, t.owner, eid);
    assert.equal(result.status, "needs_attention");
    assert.equal(result.summary.failures, 3);
    assert.equal(result.summary.verdict, "inconclusive");
    assert.equal(result.summary.promotionEligible, false);
    assert.equal(result.runs.length, result.summary.total);
    assert.deepEqual(runMemoryExperiment(t.store, t.owner, eid), result);
  } finally {
    t.close();
  }
});
test("offline memory comparison retains all cases and reproducible runs without promoting an engine", () => {
  const t = setup();
  try {
    const beforeProjects = t.store.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM projects",
    )!.n;
    const result = runMemoryExperiment(t.store, t.owner);
    assert.equal(result.status, "complete");
    assert.equal(result.summary.total, memoryPolicyCases.length * 3 * 2);
    assert.equal(result.summary.complete, result.summary.total);
    assert.equal(result.summary.failures, 0);
    assert.equal(result.summary.candidateWins, 12);
    assert.equal(result.summary.baselineWins, 0);
    assert.equal(result.summary.promotionEligible, false);
    assert.equal(result.summary.providerCalls, 0);
    assert.equal(result.summary.verdict, "policy_supported");
    assert.equal(
      t.store.one<{ n: number }>("SELECT COUNT(*) AS n FROM projects")!.n,
      beforeProjects,
    );
    assert.equal(
      t.store.one<{ n: number }>("SELECT COUNT(*) AS n FROM lab_releases")!.n,
      0,
    );
    assert.equal(
      t.store.one<{ n: number }>("SELECT COUNT(*) AS n FROM studio_calls")!.n,
      0,
    );
    for (const run of result.runs) {
      assert(run.assertions.length >= 6);
      assert.deepEqual(run.failures, []);
    }
    assert.deepEqual(runMemoryExperiment(t.store, t.owner, result.id), result);
    assert.equal(listMemoryExperiments(t.store, t.owner).length, 1);
  } finally {
    t.close();
  }
});
test("memory comparisons resume retained pairs and reject changed frozen input or another owner", () => {
  const t = setup();
  try {
    const eid = id();
    assert.equal(createMemoryExperiment(t.store, t.owner, eid), eid);
    assert.equal(createMemoryExperiment(t.store, t.owner, eid), eid);
    const first = runMemoryExperiment(t.store, t.owner, eid, { maxPairs: 1 });
    assert.equal(first.status, "paused");
    assert.equal(first.runs.length, 2);
    const persisted = t.store.all(
      "SELECT * FROM lab_memory_runs WHERE experimentId=?",
      eid,
    );
    const final = runMemoryExperiment(t.store, t.owner, eid);
    assert.equal(final.status, "complete");
    assert.deepEqual(
      t.store.all(
        "SELECT * FROM lab_memory_runs WHERE experimentId=? AND caseId=? AND replicate=1",
        eid,
        first.runs[0].caseId,
      ),
      persisted,
    );
    assert.throws(
      () => memoryExperimentView(t.store, "other-owner", eid),
      /configured Lab operator/,
    );
    t.store.run(
      "UPDATE lab_memory_experiments SET plan=replace(plan,'complete-ritual-cases-v1','changed-cases') WHERE id=?",
      eid,
    );
    assert.throws(
      () => runMemoryExperiment(t.store, t.owner, eid),
      /frozen memory comparison changed/,
    );
  } finally {
    t.close();
  }
});
test("new interviews pin legacy policy and archives retain a different pinned policy without changing defaults", () => {
  const t = setup();
  try {
    const page = "particular-family-language";
    const first = startSession(t.store, t.owner, page, {
      consent: true,
      key: "first",
    }).session;
    assert.deepEqual(first.guideProfile, LEGACY_MEMORY_GUIDE);
    assert.equal(
      JSON.parse(
        t.store.one<{ guideProfile: string }>(
          "SELECT guideProfile FROM almanac_sessions WHERE id=?",
          first.id,
        )!.guideProfile,
      ).id,
      LEGACY_MEMORY_GUIDE.id,
    );
    // A historically pinned candidate remains that policy through archive round-trip.
    t.store.run(
      "UPDATE almanac_sessions SET guideProfile=? WHERE id=?",
      canonical(COMPLETE_RITUAL_MEMORY_GUIDE),
      first.id,
    );
    const archive = exportInterviewArchive(t.store, first.projectId)!;
    assert.deepEqual(
      archive.session.guideProfile,
      COMPLETE_RITUAL_MEMORY_GUIDE,
    );
    const restoredProject = id(),
      at = now();
    t.store.run(
      "INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?)",
      restoredProject,
      t.owner,
      "Restored fixture",
      "unavailable",
      "interview",
      0,
      null,
      at,
      at,
    );
    importInterviewArchive(t.store, t.owner, restoredProject, archive);
    const restoredId = t.store.one<{ id: string }>(
      "SELECT id FROM almanac_sessions WHERE projectId=?",
      restoredProject,
    )!.id;
    assert.deepEqual(
      sessionView(t.store, t.owner, restoredId).session.guideProfile,
      COMPLETE_RITUAL_MEMORY_GUIDE,
    );
    const second = startSession(t.store, t.owner, page, {
      consent: true,
      key: "second",
    }).session;
    assert.deepEqual(second.guideProfile, LEGACY_MEMORY_GUIDE);
    t.store.run(
      "UPDATE almanac_sessions SET guideProfile=NULL WHERE id=?",
      second.id,
    );
    assert.deepEqual(
      sessionView(t.store, t.owner, second.id).session.guideProfile,
      LEGACY_MEMORY_GUIDE,
    );
  } finally {
    t.close();
  }
});
