import { heldOutCases } from "../src/server/lab/release-cases.js";
import { renderBookPanels } from "../src/server/layout.js";
import sharp from "sharp";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  Store,
  now,
  hash,
  canonical,
  type ProjectRow,
} from "../src/server/store.js";
import {
  activeProfile,
  loadProfile,
  verifyProfile,
} from "../src/server/lab/profiles.js";
import {
  seedLibrary,
  cases,
  artCases,
} from "../src/server/lab/library.js";
import {
  candidateProfile,
  createExperiment,
  experiment,
  parsePlan,
  summary,
  considerRelease,
  rollback,
  codeHash,
  setLabOwner,
  labView,
  type RunRow,
  type Comparison,
  acceptance,
} from "../src/server/lab/service.js";
import {
  runExperiment,
  pauseExperiment,
  recoverExpiredLab,
} from "../src/server/lab/runner.js";
import { newSession, runSession } from "../src/server/lab/session.js";
import { heartProblems } from "../src/server/engine/editorial.js";
import { poeticsProblems } from "../src/server/engine/poetics.js";
import { lenses, POETICS_VERSION } from "../src/shared/poetics.js";
import { Transcript, Book } from "../src/shared/contracts.js";
import {
  queueStudio,
  runStudio,
  studioCached,
  latestStudio,
} from "../src/server/engine/studio.js";
import {
  StudioFake,
  fixtureSource,
  fixtureHeart,
  fixtureWorld,
  fixtureManuscript,
  testConfig,
} from "./support/studio-fixtures.js";
import { createApp } from "../src/server/app.js";
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "everlore-lab-")),
    store = new Store(dir);
  store.run(
    "INSERT INTO users VALUES('operator','Lab owner','unused','private',?)",
    now(),
  );
  store.run(
    "INSERT INTO users VALUES('family','Family','unused','private',?)",
    now(),
  );
  setLabOwner(store, "operator");
  seedLibrary(store);
  return {
    store,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function plan(
  store: Store,
  mode: "offline" | "live" = "offline",
  opts: {
    lane?: "story" | "art" | "book";
    replicates?: number;
    caseIds?: string[];
    maxCents?: number;
    mechanism?: string;
    evaluationPhase?: "development" | "release";
    prerequisiteIds?: string[];
  } = {},
) {
  const lane = opts.lane ?? "story",
    candidate = candidateProfile(
      store,
      testConfig,
      opts.mechanism ?? (lane === "art" ? "posture" : "particulars"),
    );
  return createExperiment(
    store,
    "operator",
    {
      plan: {
        evaluationPhase: opts.evaluationPhase,
        title: "Synthetic behavioral test",
        hypothesis: "Test one isolated mechanism with retained matched inputs.",
        risk: "A change may regress preserved meaning.",
        lane,
        candidateHash: candidate.hash,
        caseIds: opts.caseIds ?? (lane === "art" ? ["front"] : ["ordinary"]),
        replicates: opts.replicates ?? 1,
        mode,
        criterion: lane === "art" ? "visual_expression" : "family_specificity",
        principleIds: ["specificity"],
        prerequisiteIds: opts.prerequisiteIds ?? [],
      },
      maxCents: opts.maxCents ?? 100000,
      authorizeCosts: mode === "live",
    },
    testConfig,
  );
}
function useStudioFixture(store: Store) {
  const c = { ...cases[0], source: fixtureSource, heart: fixtureHeart };
  store.run(
    "UPDATE lab_cases SET body=? WHERE id=?",
    JSON.stringify(c),
    "ordinary",
  );
}
class LabFake extends StudioFake {
  // Synthetic accounting contract for control-flow tests, never a model rate.
  withRequestGuard(guard: (bound: import("../src/server/engine/request-cost.js").RequestCostBound) => void) {
    const reserve = (kind: "text" | "image") => guard({
      version: 1, rateCardVersion: "synthetic-test-only", kind,
      model: kind === "text" ? testConfig.textModel : testConfig.imageModel,
      maxCostCents: 100, evidence: { synthetic: 1 },
    });
    return {
      structured: async <T>(name: string, schema: z.ZodType<T>, instructions: string, data: unknown, images: Buffer[] = []) => {
        reserve("text");
        return this.structured(name, schema, instructions, data, images);
      },
      image: async (prompt: string, refs?: Buffer | Buffer[]) => {
        reserve("image");
        return this.image(prompt, refs);
      },
      transcribe: async () => { throw new Error("Not used by Lab tests"); },
    };
  }
  override async structured<T>(
    name: string,
    schema: z.ZodType<T>,
    instructions: string,
    data: unknown,
    images: Buffer[] = [],
  ): Promise<T> {
    if (name === "canon_world") return schema.parse(fixtureWorld);
    if (name.startsWith("pair_review")) {
      this.calls.push(name);
      const d = data as {
        versions: Array<{ spreads: Array<{ text: string }> }>;
      };
      return schema.parse({
        preference: "tie",
        evidence: ["first", "second"].map((side, i) => ({
          side,
          spread: d.versions[i].spreads?.length ? 1 : null,
          quote: d.versions[i].spreads?.[0]?.text ?? "",
          finding: "Scripted comparison only, not creative evidence.",
        })),
        regressions: [],
        preservationPassed: true,
        uncertainty: "Simulated comparison.",
      });
    }
    return super.structured(name, schema, instructions, data, images);
  }
}

test("fixed corpus links every synthetic heart to actual source; visual suite has twelve distinct tasks", () => {
  for (const c of cases) {
    const source = Transcript.parse({
      version: 1,
      mode: "live",
      recordingId: "test",
      rawText: c.source,
      segments: [{ id: "s1", text: c.source, startMs: null, endMs: null }],
    });
    assert.deepEqual(heartProblems(c.heart, source), []);
    assert.equal(c.synthetic, true);
  }
  assert.equal(cases.length, 6);
  assert.equal(new Set(artCases.map((c) => c.id)).size, 12);
});
test("profiles are immutable and a candidate changes only its selected mechanism", () => {
  const t = setup();
  try {
    const before = activeProfile(t.store, testConfig),
      candidate = candidateProfile(t.store, testConfig, "voice");
    assert.equal(candidate.parentHash, before.hash);
    assert.notEqual(candidate.hash, before.hash);
    assert.equal(candidate.artSystem, before.artSystem);
    for (const [key, value] of Object.entries(before.instructions))
      if (key !== "compose") assert.equal(candidate.instructions[key], value);
    assert.deepEqual(loadProfile(t.store, before.hash), before);
    assert.throws(
      () => verifyProfile({ ...candidate, storySystem: "tampered" }),
      /integrity/,
    );
  } finally {
    t.close();
  }
});
test("literary diagnosis checks seven distinct lenses and rejects fabricated quotations", () => {
  const findings = lenses.map((lens) => ({
    lens,
    status: "effective" as const,
    spread: 1,
    quote: fixtureManuscript.spreads[0].text,
    analysis: "Synthetic test diagnosis",
    repair: "",
    preserve: "The protected family details",
  }));
  assert.deepEqual(
    poeticsProblems({ version: POETICS_VERSION, findings }, fixtureManuscript),
    [],
  );
  findings[0].quote = "A line that is not there";
  assert.match(
    poeticsProblems(
      { version: POETICS_VERSION, findings },
      fixtureManuscript,
    ).join(" "),
    /absent/,
  );
  findings[0].lens = "voice";
  assert.match(
    poeticsProblems(
      { version: POETICS_VERSION, findings },
      fixtureManuscript,
    ).join(" "),
    /omitted/,
  );
});
test("offline loop retains both arms and two stopped iterations without calls or promotion", async () => {
  const t = setup(),
    p = new LabFake();
  try {
    const sid = newSession(t.store, "operator", {
      mode: "offline",
      lane: "story",
      maxIterations: 5,
      maxCents: 0,
      authorizeCosts: false,
    });
    await runSession(t.store, sid, p, testConfig);
    const session = t.store.one<{
      iteration: number;
      status: string;
      noProgress: number;
    }>("SELECT * FROM lab_sessions WHERE id=?", sid)!;
    assert.equal(session.iteration, 2);
    assert.equal(session.noProgress, 2);
    assert.equal(session.status, "complete");
    assert.equal(p.calls.length, 0);
    assert.equal(
      t.store.one<{ n: number }>("SELECT count(*) AS n FROM lab_runs")!.n,
      72,
    );
    assert.equal(
      t.store.one<{ n: number }>("SELECT count(*) AS n FROM lab_releases")!.n,
      0,
    );
    const e = t.store.one<{ id: string }>(
      "SELECT id FROM lab_experiments LIMIT 1",
    )!;
    assert(
      summary(t.store, experiment(t.store, e.id)).blockers.some((s) =>
        s.includes("Offline"),
      ),
    );
  } finally {
    t.close();
  }
});
test("autonomous production reaches a complete book without creative approvals and pins the actual profile", async () => {
  const t = setup(),
    p = new LabFake();
  try {
    t.store.run(
      "INSERT INTO projects VALUES('memory','operator','Ordinary','unavailable','awaiting_transcription',0,NULL,?,?)",
      now(),
      now(),
    );
    const asset = t.store.putAsset("memory", "synthetic audio", "audio");
    t.store.run(
      "INSERT INTO recordings VALUES('rec','memory',?,'audio/wav',20,'upload',?)",
      asset,
      now(),
    );
    const project = t.store.one<ProjectRow>(
      "SELECT * FROM projects WHERE id='memory'",
    )!;
    queueStudio(
      t.store,
      project,
      {
        processWithOpenAI: true,
        imaginativeAdaptation: true,
        legacyWish: "Patient love",
      },
      testConfig,
    );
    const pinned = activeProfile(t.store, testConfig);
    const candidate = candidateProfile(t.store, testConfig, "voice");
    t.store.run(
      "UPDATE lab_settings SET value=? WHERE key='active_profile'",
      candidate.hash,
    );
    await runStudio(t.store, p, {
      ...testConfig,
      textModel: "changed-config-model",
    });
    const job = latestStudio(t.store, "memory")!;
    assert.equal(job.status, "complete", job.error ?? job.stage);
    const book = Book.parse(
      JSON.parse(
        t.store.one<{ book: string }>(
          "SELECT book FROM revisions WHERE projectId='memory'",
        )!.book,
      ),
    );
    assert.equal(book.production?.engineProfile?.hash, pinned.hash);
    assert.equal(book.production?.automation, "autonomous");
    assert.equal(book.production?.humanReview, "pending");
    const originalHashes = book.spreads.map((s) => s.artHash);
    const panels = await renderBookPanels(book, t.store, "memory");
    assert.equal(new Set(panels).size, 12);
    const panel = await sharp(
      t.store.readAsset("memory", panels[0]),
    ).metadata();
    assert.equal(panel.width, 1200);
    assert.equal(panel.height, 600);
    assert.deepEqual(
      book.spreads.map((s) => s.artHash),
      originalHashes,
    );
    assert(book.production?.references.every((r) => r.approval === "machine"));
    assert.equal(
      t.store.one<{ n: number }>("SELECT count(*) AS n FROM studio_approvals")!
        .n,
      0,
    );
    assert.equal(p.calls.filter((c) => c.endsWith("_poetics")).length, 3);
  } finally {
    t.close();
  }
});
test("live story experiments use their separate allowance, retain three drafts and never order art", async () => {
  const t = setup(),
    p = new LabFake();
  try {
    useStudioFixture(t.store);
    const eid = plan(t.store, "live");
    await runExperiment(t.store, eid, p, { ...testConfig, budgetCents: 1 });
    assert.equal(
      experiment(t.store, eid).status,
      "complete",
      experiment(t.store, eid).error ?? "",
    );
    assert.equal(p.calls.filter((n) => n.startsWith("image")).length, 0);
    assert.equal(
      t.store.one<{ n: number }>("SELECT COUNT(*) AS n FROM engine_budget")!.n,
      0,
    );
    assert.equal(summary(t.store, experiment(t.store, eid)).ties, 1);
    for (const r of t.store.all<RunRow>(
      "SELECT * FROM lab_runs WHERE experimentId=?",
      eid,
    )) {
      assert(studioCached(t.store, r.jobId!, "draft_1"));
      assert(studioCached(t.store, r.jobId!, "draft_3"));
    }
    assert.equal(summary(t.store, experiment(t.store, eid)).actualCents, null);
    const calls = t.store.all<{stage: string; body: string | null}>("SELECT c.stage,b.body FROM lab_calls c LEFT JOIN lab_request_bounds b ON b.callId=c.id");
    assert(calls.some((c) => c.stage.startsWith("pair_")));
    assert(calls.every((c) => c.body && JSON.parse(c.body).rateCardVersion === "synthetic-test-only"));
    assert.equal(t.store.one<{ n: number }>("SELECT COUNT(*) AS n FROM studio_calls")!.n, 0);
  } finally {
    t.close();
  }
});
test("pause/resume preserves completed paid checkpoints and concurrent starts are idempotent", async () => {
  const t = setup(),
    p = new LabFake();
  try {
    useStudioFixture(t.store);
    const eid = plan(t.store, "live");
    p.onStructured = (name) => {
      if (name === "concepts") pauseExperiment(t.store, eid);
    };
    await Promise.all([
      runExperiment(t.store, eid, p, testConfig),
      runExperiment(t.store, eid, p, testConfig),
    ]);
    assert.equal(experiment(t.store, eid).status, "paused");
    assert.equal(p.calls.filter((n) => n === "concepts").length, 1);
    p.onStructured = undefined;
    await runExperiment(t.store, eid, p, testConfig);
    assert.equal(
      experiment(t.store, eid).status,
      "complete",
      experiment(t.store, eid).error ?? "",
    );
    assert.equal(p.calls.filter((n) => n === "concepts").length, 2);
  } finally {
    t.close();
  }
});
test("budget exhaustion and ambiguous failures stop rather than replay paid requests", async () => {
  for (const reason of ["budget", "ambiguous"]) {
    const t = setup(),
      p = new LabFake();
    try {
      useStudioFixture(t.store);
      const eid = plan(t.store, "live", {
        maxCents: reason === "budget" ? 100 : 100000,
      });
      if (reason === "ambiguous") p.failAt = "concept_review";
      await runExperiment(t.store, eid, p, testConfig);
      assert.equal(experiment(t.store, eid).status, reason === "budget" ? "paused" : "needs_attention");
      const before = p.calls.length;
      if (reason === "budget") {
        await runExperiment(t.store, eid, p, testConfig);
        assert.equal(experiment(t.store, eid).status, "paused");
      } else {
        await assert.rejects(
          () => runExperiment(t.store, eid, p, testConfig),
          /reconciliation/,
        );
      }
      assert.equal(p.calls.length, before);
      const calls = t.store.all<{ status: string; estimatedCents: number }>(
        "SELECT status,estimatedCents FROM lab_calls",
      );
      assert(calls.length > 0);
      if (reason === "budget")
        assert.equal(
          calls.reduce((s, c) => s + c.estimatedCents, 0),
          100,
        );
      else assert(calls.some((c) => c.status === "ambiguous_failure"));
    } finally {
      t.close();
    }
  }
});
test("art comparisons use identical canonical bytes and bounded correction checks actual images", async () => {
  const t = setup(),
    p = new LabFake();
  try {
    const eid = plan(t.store, "live", {
      lane: "art",
      caseIds: ["front", "edit"],
    });
    await runExperiment(t.store, eid, p, testConfig);
    assert.equal(
      experiment(t.store, eid).status,
      "complete",
      experiment(t.store, eid).error ?? "",
    );
    const runs = t.store.all<RunRow>(
      "SELECT * FROM lab_runs WHERE experimentId=?",
      eid,
    );
    const hashes = runs.map((r) => JSON.parse(r.output!).canonHashes);
    assert(hashes.every((h) => canonical(h) === canonical(hashes[0])));
    assert(p.imageReferenceCounts.every((n) => n >= 0));
    assert(p.imageReferenceCounts.filter((n) => n >= 2).length >= 4);
    assert.equal(summary(t.store, experiment(t.store, eid)).complete, 4);
  } finally {
    t.close();
  }
});
test("corrected art never silently bypasses the three-attempt limit", async () => {
  const t = setup(),
    p = new LabFake();
  p.weakImages = true;
  try {
    const eid = plan(t.store, "live", { lane: "art" });
    await runExperiment(t.store, eid, p, testConfig);
    assert.equal(experiment(t.store, eid).status, "needs_attention");
    assert.equal(p.calls.filter((n) => n.startsWith("image")).length, 3);
    assert.equal(
      t.store.one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM lab_calls WHERE status='completed'",
      )!.n,
      7,
    );
    assert.equal(considerRelease(t.store, eid), false);
  } finally {
    t.close();
  }
});
test("frozen rubric tampering and changed baselines cannot promote a partial or offline comparison", async () => {
  const t = setup();
  try {
    const eid = plan(t.store);
    assert.equal(considerRelease(t.store, eid), false);
    const e = experiment(t.store, eid),
      p = parsePlan(e);
    p.acceptance.minWins = 0;
    t.store.run(
      "UPDATE lab_experiments SET plan=?,planHash=? WHERE id=?",
      JSON.stringify(p),
      hash(canonical(p)),
      eid,
    );
    assert.throws(() => parsePlan(experiment(t.store, eid)), /rubric changed/);
  } finally {
    t.close();
  }
});
test("model disagreement and a loss block automatic release even with a passing engineering receipt", () => {
  const t = setup();
  try {
    const eid = plan(t.store, "live", {
      replicates: 3,
      caseIds: cases.map((c) => c.id),
    });
    const e = experiment(t.store, eid);
    t.store.run(
      "INSERT INTO lab_settings VALUES('engineering_receipt',?)",
      JSON.stringify({
        codeHash: codeHash(),
        results: Object.fromEntries(
          acceptance.engineering.map((k) => [k, true]),
        ),
      }),
    );
    t.store.run(
      "UPDATE lab_runs SET status='complete',output='{}' WHERE experimentId=?",
      eid,
    );
    for (const cid of cases.map((c) => c.id))
      for (let rep = 1; rep <= 3; rep++) {
        const v: Comparison = {
          pairKey: `${cid}:${rep}`,
          winner: "candidate",
          reviews: [
            {
              preference: "second",
              evidence: [
                {
                  side: "first",
                  spread: 1,
                  quote: "fixture",
                  finding: "Synthetic fixture evidence",
                },
                {
                  side: "second",
                  spread: 1,
                  quote: "fixture",
                  finding: "Synthetic fixture evidence",
                },
              ],
              regressions: [],
              preservationPassed: true,
              uncertainty: "",
            },
          ],
          disagreement: false,
          preservationPassed: true,
          simulated: false,
        };
        if (cid === "ordinary" && rep === 1) {
          v.winner = "inconclusive";
          v.disagreement = true;
        }
        t.store.run(
          "INSERT INTO lab_comparisons VALUES(?,?,?)",
          eid,
          v.pairKey,
          JSON.stringify(v),
        );
      }
    assert.equal(considerRelease(t.store, eid), false);
    assert(summary(t.store, e).blockers.some((b) => b.includes("Conflicting")));
  } finally {
    t.close();
  }
});
test("complete scripted gate evidence promotes atomically; rollback restores defaults without changing immutable profiles", () => {
  const t = setup();
  try {
    const development = plan(t.store, "live");
    t.store.run(
      "UPDATE lab_experiments SET status='complete' WHERE id=?",
      development,
    );
    const eid = plan(t.store, "live", {
        replicates: 3,
        evaluationPhase: "release",
        prerequisiteIds: [development],
        caseIds: heldOutCases.map((c) => c.id),
      }),
      e = experiment(t.store, eid),
      p = parsePlan(e);
    t.store.run(
      "INSERT INTO lab_settings VALUES('engineering_receipt',?)",
      JSON.stringify({
        codeHash: codeHash(),
        results: Object.fromEntries(
          acceptance.engineering.map((k) => [k, true]),
        ),
      }),
    );
    t.store.run(
      "UPDATE lab_runs SET status='complete',output='{}' WHERE experimentId=?",
      eid,
    );
    for (const cid of heldOutCases.map((c) => c.id))
      for (let rep = 1; rep <= 3; rep++) {
        const v: Comparison = {
          pairKey: `${cid}:${rep}`,
          winner: "candidate",
          reviews: [0, 1].map((order) => ({
            preference: order === 0 ? ("second" as const) : ("first" as const),
            evidence: (["first", "second"] as const).map((side) => ({
              side,
              spread: 1,
              quote: "fixture",
              finding: "Explicitly scripted gate evidence for this test.",
            })),
            regressions: [],
            preservationPassed: true,
            uncertainty: "",
          })),
          disagreement: false,
          preservationPassed: true,
          simulated: false,
        };
        t.store.run(
          "INSERT INTO lab_comparisons VALUES(?,?,?)",
          eid,
          v.pairKey,
          JSON.stringify(v),
        );
      }
    assert.equal(considerRelease(t.store, eid), true);
    assert.equal(considerRelease(t.store, eid), true);
    assert.equal(activeProfile(t.store, testConfig).hash, p.candidateHash);
    assert.equal(
      t.store.one<{ n: number }>("SELECT count(*) AS n FROM lab_releases")!.n,
      1,
    );
    const release = t.store.one<{ id: string }>("SELECT id FROM lab_releases")!;
    rollback(t.store, release.id);
    assert.equal(activeProfile(t.store, testConfig).hash, p.baselineHash);
    assert.equal(
      loadProfile(t.store, p.candidateHash).parentHash,
      p.baselineHash,
    );
  } finally {
    t.close();
  }
});
test("only configured operator can manage Lab, while family shelves cannot expose evidence or releases", async () => {
  const t = setup();
  const app = createApp(t.store, testConfig),
    server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const tokens = {
    operator: "lab-operator-session",
    family: "lab-family-session",
  };
  for (const [user, token] of Object.entries(tokens))
    t.store.run(
      "INSERT INTO sessions VALUES(?,?,?)",
      hash(token),
      user,
      Date.now() + 100000,
    );
  try {
    const eid = plan(t.store);
    for (const path of [
      `/api/lab/experiments/${eid}/start`,
      `/api/lab/experiments/${eid}/pause`,
      `/api/lab/releases/fake/rollback`,
      `/api/lab/sessions`,
    ]) {
      const res = await fetch(base + path, {
        method: "POST",
        headers: {
          "X-Evermore-Client": "1",
          "Content-Type": "application/json",
          Cookie: `evermore=${tokens.family}`,
        },
        body: "{}",
      });
      assert.equal(res.status, 403);
    }
    const view = await fetch(base + "/api/lab", {
      headers: { Cookie: `evermore=${tokens.family}` },
    }).then((r) => r.json());
    assert.equal(view.allowed, false);
    assert.deepEqual(view.profiles, []);
    assert.equal(labView(t.store, testConfig, "operator").allowed, true);
    const res = await fetch(base + `/api/lab/experiments/${eid}/evidence`, {
      headers: { Cookie: `evermore=${tokens.family}` },
    });
    assert.equal(res.status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    t.close();
  }
});

test("expired Lab ownership recovers completed checkpoints but never replays an unknown paid result", async () => {
  for (const unknown of [false, true]) {
    const t = setup(),
      p = new LabFake();
    try {
      useStudioFixture(t.store);
      const eid = plan(t.store, "live");
      p.onStructured = (n) => {
        if (n === "concepts") pauseExperiment(t.store, eid);
      };
      await runExperiment(t.store, eid, p, testConfig);
      const run = t.store.one<RunRow>(
        "SELECT * FROM lab_runs WHERE experimentId=? ORDER BY rowid LIMIT 1",
        eid,
      )!;
      t.store.run(
        "UPDATE lab_runs SET status='running',leaseToken='lost-worker',leaseUntil=0 WHERE id=?",
        run.id,
      );
      t.store.run(
        "UPDATE lab_experiments SET status='running' WHERE id=?",
        eid,
      );
      if (unknown)
        t.store.run(
          "UPDATE lab_calls SET status='started' WHERE runId=?",
          run.id,
        );
      if (!unknown) {
        t.store.run(
          "INSERT OR IGNORE INTO studio_steps VALUES(?, 'concept_review', 'predispatch-interruption', 'started', NULL)",
          run.jobId!,
        );
      }
      recoverExpiredLab(t.store);
      if (!unknown) assert.equal(t.store.one("SELECT stage FROM studio_steps WHERE jobId=? AND stage='concept_review' AND state='started'", run.jobId!), undefined);
      assert.equal(
        experiment(t.store, eid).status,
        unknown ? "needs_attention" : "paused",
      );
      p.onStructured = undefined;
      if (!unknown) {
        await runExperiment(t.store, eid, p, testConfig);
        assert.equal(experiment(t.store, eid).status, "complete");
        assert.equal(p.calls.filter((n) => n === "concepts").length, 2);
      } else assert.equal(p.calls.filter((n) => n === "concepts").length, 1);
    } finally {
      t.close();
    }
  }
});
test("a stale Lab response cannot overwrite newer ownership or retained output", async () => {
  const t = setup(),
    p = new LabFake();
  try {
    useStudioFixture(t.store);
    const eid = plan(t.store, "live");
    p.onStructured = (n) => {
      if (n === "concepts")
        t.store.run(
          "UPDATE lab_runs SET leaseToken='replacement-worker',leaseUntil=?,output='{}' WHERE experimentId=? AND status='running'",
          Date.now() + 240000,
          eid,
        );
    };
    await runExperiment(t.store, eid, p, testConfig);
    const r = t.store.one<RunRow>(
      "SELECT * FROM lab_runs WHERE experimentId=? AND leaseToken='replacement-worker'",
      eid,
    )!;
    assert(r);
    assert.equal(r.output, "{}");
    assert.equal(r.status, "running");
    assert.equal(
      t.store.one<{ n: number }>(
        "SELECT count(*) AS n FROM lab_steps WHERE runId=? AND state='completed'",
        r.id,
      )!.n,
      0,
    );
  } finally {
    t.close();
  }
});
