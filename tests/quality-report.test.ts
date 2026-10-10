import { createApp } from "../src/server/app.js";
import { configureAccess } from "../src/server/access.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, now, hash } from "../src/server/store.js";
import {
  candidateProfile,
  createExperiment,
  setLabOwner,
  labView,
  experiment,
  parsePlan,
} from "../src/server/lab/service.js";
import { seedLibrary } from "../src/server/lab/library.js";
import { heldOutCases } from "../src/server/lab/release-cases.js";
import { runExperiment } from "../src/server/lab/runner.js";
import { experimentReport } from "../src/server/lab/report.js";
import { testConfig, StudioFake } from "./support/studio-fixtures.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "everlore-quality-report-")),
    store = new Store(dir);
  store.run(
    "INSERT INTO users VALUES('operator','Synthetic operator','unused','private',?)",
    now(),
  );
  setLabOwner(store, "operator");
  seedLibrary(store);
  const candidate = candidateProfile(store, testConfig, "particulars");
  const input = {
    plan: {
      title: "Quality report fixture",
      hypothesis: "Keep source and comparison evidence separated.",
      risk: "Held-out inputs must not reach development reports.",
      lane: "story",
      candidateHash: candidate.hash,
      caseIds: ["ordinary"],
      replicates: 1,
      mode: "offline",
      criterion: "family_specificity",
      principleIds: ["specificity"],
      prerequisiteIds: [],
    },
    maxCents: 0,
    authorizeCosts: false,
  };
  return {
    store,
    input,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("quality reports retain failures and distinguish missing creative evidence from zero scores", async () => {
  const t = setup();
  try {
    const eid = createExperiment(
      t.store,
      "operator",
      t.input,
      testConfig,
      "requested-report-id",
    );
    assert.equal(
      createExperiment(
        t.store,
        "operator",
        t.input,
        testConfig,
        "requested-report-id",
      ),
      eid,
    );
    assert.throws(
      () =>
        createExperiment(
          t.store,
          "operator",
          {
            ...t.input,
            plan: { ...t.input.plan, title: "Different frozen intent" },
          },
          testConfig,
          eid,
        ),
      /different frozen/,
    );
    await runExperiment(t.store, eid, new StudioFake(), testConfig);
    const report = experimentReport(t.store, eid);
    assert.equal(report.evidenceKind, "control_flow_fixture");
    assert.ok("dimensions" in report);
    assert.deepEqual(report.dimensions, []);
    assert.equal(report.audienceValidation, false);
    assert.equal(report.coverage.retainedArtifacts, 2);
    assert.deepEqual(
      report.reviewPacket,
      experimentReport(t.store, eid).reviewPacket,
    );
    t.store.run(
      "UPDATE lab_runs SET status='failed',error='Retained synthetic failure' WHERE id=(SELECT id FROM lab_runs WHERE experimentId=? LIMIT 1)",
      eid,
    );
    const failed = experimentReport(t.store, eid);
    assert.ok("coverage" in failed);
    assert.equal(failed.coverage?.failures, 1);
    assert.equal(failed.release?.eligible, false);
    assert.ok(failed.reviewPacket?.weakestRunId);
  } finally {
    t.close();
  }
});

test("held-out inputs and individual outputs never appear in Lab development views or reports", async () => {
  const t = setup();
  try {
    assert.equal(
      t.store.one<{ n: number }>(
        "SELECT count(*) AS n FROM lab_cases WHERE id LIKE 'heldout-%'",
      )!.n,
      0,
    );
    const dev = createExperiment(t.store, "operator", t.input, testConfig);
    await runExperiment(t.store, dev, new StudioFake(), testConfig);
    const release = createExperiment(
      t.store,
      "operator",
      {
        ...t.input,
        plan: {
          ...t.input.plan,
          evaluationPhase: "release",
          caseIds: heldOutCases.map((c) => c.id),
          prerequisiteIds: [dev],
        },
      },
      testConfig,
    );
    await runExperiment(t.store, release, new StudioFake(), testConfig);
    const internal = parsePlan(experiment(t.store, release));
    assert.equal(internal.cases.length, 6);
    const view = labView(t.store, testConfig, "operator").experiments.find(
      (e) => e.id === release,
    )!;
    const report = experimentReport(t.store, release);
    const serialized = JSON.stringify({ view, report });
    for (const c of heldOutCases) {
      assert.ok(!serialized.includes(c.source));
      assert.ok(!serialized.includes(c.title));
      assert.ok(!serialized.includes(c.id));
    }
    assert.deepEqual(view.runs, []);
    assert.deepEqual(view.caseIds, []);
    assert.ok(!("cases" in view));
    assert.ok(!("acceptance" in view));
    assert.ok("heldOutRedacted" in report && report.heldOutRedacted);
    assert.equal(report.reviewPacket, null);
    assert.equal(view.summary.complete, 12);
    // The retained evidence still exists internally for reproducibility.
    assert.equal(
      t.store.one<{ n: number }>(
        "SELECT count(*) AS n FROM lab_runs WHERE experimentId=? AND output IS NOT NULL",
        release,
      )!.n,
      12,
    );
  } finally {
    t.close();
  }
});

test("known release project IDs cannot bypass aggregate views through project, archive, evidence or cost APIs", async () => {
  const t = setup();
  let server: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;
  try {
    configureAccess(t.store, false, "operator");
    t.store.run(
      "INSERT INTO sessions VALUES(?,?,?)",
      hash("quality-session"),
      "operator",
      Date.now() + 60000,
    );
    const dev = createExperiment(t.store, "operator", t.input, testConfig);
    await runExperiment(t.store, dev, new StudioFake(), testConfig);
    const release = createExperiment(
      t.store,
      "operator",
      {
        ...t.input,
        plan: {
          ...t.input.plan,
          evaluationPhase: "release",
          caseIds: heldOutCases.map((c) => c.id),
          prerequisiteIds: [dev],
        },
      },
      testConfig,
    );
    t.store.run(
      "INSERT INTO projects VALUES('hidden-release','operator','PRIVATE RELEASE TITLE','manual','needs_attention',0,NULL,?,?)",
      now(),
      now(),
    );
    t.store.run(
      "UPDATE lab_runs SET projectId='hidden-release' WHERE experimentId=?",
      release,
    );
    t.store.run(
      "INSERT INTO lab_releases VALUES('release-evidence',?,'automatic_promotion','candidate','baseline',?,?)",
      release,
      JSON.stringify({ summary: { worstCases: ["PRIVATE CASE FINDING"] } }),
      now(),
    );
    server = createApp(
      t.store,
      testConfig,
      async () => {
        throw new Error("No network generation permitted");
      },
      null,
    ).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    for (const path of [
      "/api/projects/hidden-release",
      "/api/projects/hidden-release/archive",
      "/api/projects/hidden-release/art/unknown",
      "/api/projects/hidden-release/engine/evidence",
      "/api/operator/projects/hidden-release/recovery",
    ]) {
      const response = await fetch(base + path, {
        headers: { Cookie: "evermore=quality-session" },
      });
      assert.equal(response.status, 404, path);
      assert.ok(!(await response.text()).includes("PRIVATE"));
    }
    for (const path of [
      "/api/lab",
      "/api/operator/costs",
      `/api/lab/experiments/${release}/evidence`,
    ]) {
      const response = await fetch(base + path, {
        headers: { Cookie: "evermore=quality-session" },
      });
      assert.equal(response.status, 200, path);
      const body = await response.text();
      assert.ok(!body.includes("PRIVATE"), path);
      assert.ok(!body.includes("hidden-release"), path);
      for (const c of heldOutCases) assert.ok(!body.includes(c.source), path);
    }
  } finally {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
    t.close();
  }
});
