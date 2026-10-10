import { configureAccess } from "../src/server/access.js";
import { z } from "zod";
import { ScenePlan } from "../src/shared/studio.js";
import { canAssembleReviewCopy } from "../src/server/engine/editorial.js";
import { hasQuotedEvidence } from "../src/server/engine/poetics.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, now, hash, type ProjectRow } from "../src/server/store.js";
import {
  OpenAIProvider,
  ProviderRequestError,
  availability,
  engineConfig,
} from "../src/server/engine/provider.js";
import {
  saveStudioConnection,
  saveVerifiedStudioConnection,
  checkSavedStudioConnection,
  loadStudioConnection,
  setupView,
} from "../src/server/engine/setup.js";
import {
  queueStudio,
  runStudio,
  studioView,
  confirmStudioSource,
} from "../src/server/engine/studio.js";
import { reservedBudget } from "../src/server/engine/budget.js";
import { resumeStudio } from "../src/server/engine/recovery.js";
import {
  StudioFake,
  fixtureSource,
  fixtureHeart,
  testConfig,
} from "./support/studio-fixtures.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "everlore-recovery-")),
    store = new Store(dir);
  store.run(
    "INSERT INTO users VALUES('owner','owner','unused','private',?)",
    now(),
  );
  configureAccess(store, false, "owner");
  store.run(
    "INSERT INTO projects VALUES('memory','owner','Synthetic recovery','unavailable','awaiting_transcription',0,NULL,?,?)",
    now(),
    now(),
  );
  const digest = store.putAsset("memory", "synthetic audio only", "audio");
  store.run(
    "INSERT INTO recordings VALUES('rec','memory',?,'audio/wav',20,'upload',?)",
    digest,
    now(),
  );
  return {
    store,
    dir,
    project: () =>
      store.one<ProjectRow>("SELECT * FROM projects WHERE id='memory'")!,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const settings = {
  apiKey: "sk-synthetic-local-test-not-real",
  budgetUsd: 500,
  audioReserveUsd: 3,
  textReserveUsd: 0.5,
  imageReserveUsd: 0.75,
  authorizeCosts: true,
};
const consent = {
  autonomous: false,
  processWithOpenAI: true,
  imaginativeAdaptation: true,
  legacyWish: "",
};
const verified: typeof fetch = async (url, init) => {
  assert.match(String(url), /^https:\/\/api.openai.com\/v1\/models\//);
  assert.equal(init?.method, "GET");
  assert.equal(init?.body, undefined);
  return new Response("{}", { status: 200 });
};
const invalid: typeof fetch = async () =>
  new Response(
    JSON.stringify({
      error: {
        code: "invalid_api_key",
        message: "PRIVATE KEY AND FAMILY TEXT MUST NEVER ESCAPE",
      },
    }),
    { status: 401 },
  );

test("connection verification rejects a bad key without replacing saved settings and persists its safe diagnosis", async () => {
  const t = setup(),
    config = engineConfig({});
  try {
    await saveVerifiedStudioConnection(
      t.store,
      "owner",
      settings,
      config,
      verified,
    );
    const before = hash(readFileSync(join(t.dir, "studio-connection.json")));
    await assert.rejects(
      saveVerifiedStudioConnection(
        t.store,
        "owner",
        { ...settings, apiKey: "sk-different-synthetic-invalid-key" },
        config,
        invalid,
      ),
      /OpenAI rejected the API key/,
    );
    assert.equal(
      hash(readFileSync(join(t.dir, "studio-connection.json"))),
      before,
    );
    assert(availability(config).ready);
    const checked = await checkSavedStudioConnection(
      t.store,
      "owner",
      config,
      invalid,
    );
    assert.equal(checked.ready, false);
    assert.match(checked.message, /Replace it/);
    assert.doesNotMatch(JSON.stringify(checked), /PRIVATE|sk-/);
    const restarted = engineConfig({});
    loadStudioConnection(t.store, restarted);
    assert.equal(availability(restarted).ready, false);
    const saved = await saveVerifiedStudioConnection(
      t.store,
      "owner",
      { ...settings, apiKey: "sk-synthetic-fixed-credential" },
      config,
      verified,
    );
    assert(saved.ready);
    assert.equal(t.store.all("SELECT * FROM studio_calls").length, 0);
    await assert.rejects(
      saveVerifiedStudioConnection(
        t.store,
        "other",
        settings,
        config,
        async () => {
          throw new Error("Must not contact provider for another owner");
        },
      ),
      /Only the configured/,
    );
  } finally {
    t.close();
  }
});

test("an older connection check cannot overwrite a newer saved key or allowance", async () => {
  const t = setup(),
    config = engineConfig({});
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    saveStudioConnection(t.store, "owner", settings, config);
    const saving = saveVerifiedStudioConnection(
      t.store,
      "owner",
      { ...settings, budgetUsd: 600 },
      config,
      async () => {
        await pending;
        return new Response("{}");
      },
    );
    saveStudioConnection(
      t.store,
      "owner",
      {
        ...settings,
        apiKey: "sk-newer-synthetic-key-must-survive",
        budgetUsd: 700,
      },
      config,
    );
    release();
    await assert.rejects(saving, /connection changed/);
    assert.equal(config.budgetCents, 70000);
    assert.equal(config.apiKey, "sk-newer-synthetic-key-must-survive");
  } finally {
    t.close();
  }
});

test("provider diagnostics distinguish definite rejections from uncertain outcomes without exposing provider text", async () => {
  for (const [status, code, kind, safe] of [
    [401, "invalid_api_key", "authentication", true],
    [403, null, "permission", true],
    [404, null, "model", true],
    [429, "insufficient_quota", "quota", true],
    [429, "credit_balance_exhausted", "quota", true],
    [429, null, "rate_limit", true],
    [400, null, "request", true],
    [503, null, "server", false],
  ] as const) {
    const provider = new OpenAIProvider(
      testConfig,
      async () =>
        new Response(
          JSON.stringify({
            error: { code, message: "PRIVATE FAMILY TEXT AND API KEY" },
          }),
          { status, headers: { "x-request-id": "req_synthetic" } },
        ),
    );
    await assert.rejects(
      provider.transcribe(Buffer.from("synthetic"), "audio/wav"),
      (error) => {
        assert(error instanceof ProviderRequestError);
        assert.equal(error.failure.kind, kind);
        assert.equal(error.failure.retrySafe, safe);
        assert.doesNotMatch(error.message, /PRIVATE|API KEY/);
        return true;
      },
    );
    assert.equal(provider.takeReceipt()?.requestId, "req_synthetic");
  }
  const provider = new OpenAIProvider(testConfig, async () => {
    throw new Error("PRIVATE transport details");
  });
  await assert.rejects(
    provider.transcribe(Buffer.from("test"), "audio/wav"),
    (error) => {
      assert(error instanceof ProviderRequestError);
      assert.equal(error.failure.retrySafe, false);
      assert.doesNotMatch(error.message, /PRIVATE/);
      return true;
    },
  );
});

async function stopAtHeart(t: ReturnType<typeof setup>, provider: StudioFake) {
  queueStudio(t.store, t.project(), consent, testConfig);
  await runStudio(t.store, provider, testConfig);
  confirmStudioSource(t.store, "memory", {
    confirmed: true,
    rawText: fixtureSource,
  });
  await runStudio(t.store, provider, testConfig);
  const run = studioView(t.store, "memory")!;
  assert.equal(run.status, "needs_attention");
  return {
    jobId: run.id,
    callId: run.recovery!.callId,
    acknowledgePossibleCharge: false,
  };
}
test("known authentication rejection resumes the saved job exactly once and never repeats completed transcription", async () => {
  const t = setup(),
    provider = new StudioFake();
  provider.onStructured = (name) => {
    if (name === "heart")
      throw new ProviderRequestError({
        kind: "authentication",
        httpStatus: 401,
        retrySafe: true,
      });
  };
  try {
    const request = await stopAtHeart(t, provider),
      before = t.store.one<{ allowance: number }>(
        "SELECT allowance FROM studio_jobs",
      )!.allowance;
    const source = t.store.one<{ result: string }>(
      "SELECT result FROM studio_steps WHERE stage='transcription'",
    )!.result;
    const view = studioView(t.store, "memory")!;
    assert.match(view.error!, /OpenAI rejected the API key/);
    assert.equal(view.recovery!.uncertain, false);
    assert.equal(view.recovery!.extraReserveUsd, 0);
    assert.equal(await runStudio(t.store, provider, testConfig), false);
    const fixed = { ...testConfig, apiKey: "synthetic-replacement-key" };
    resumeStudio(t.store, t.project(), request, fixed);
    resumeStudio(t.store, t.project(), request, fixed);
    assert.equal(
      t.store.one<{ allowance: number }>("SELECT allowance FROM engine_budget")!
        .allowance,
      before,
    );
    provider.onStructured = undefined;
    await runStudio(t.store, provider, fixed);
    assert.equal(studioView(t.store, "memory")!.status, "awaiting_heart");
    assert.equal(provider.calls.filter((x) => x === "transcription").length, 1);
    assert.equal(provider.calls.filter((x) => x === "heart").length, 2);
    assert.equal(
      t.store.one<{ result: string }>(
        "SELECT result FROM studio_steps WHERE stage='transcription'",
      )!.result,
      source,
    );
    assert.equal(
      t.store.all("SELECT id FROM studio_calls WHERE status='rejected'").length,
      1,
    );
    assert.equal(t.store.all("SELECT id FROM studio_recoveries").length, 1);
  } finally {
    t.close();
  }
});

test("unknown paid outcomes require explicit acknowledgment, extra allowance and current revision; failures stay retained", async () => {
  const t = setup(),
    provider = new StudioFake();
  provider.failAt = "heart";
  try {
    const request = await stopAtHeart(t, provider),
      before = t.store.one<{ allowance: number }>(
        "SELECT allowance FROM studio_jobs",
      )!.allowance;
    assert.equal(studioView(t.store, "memory")!.recovery!.uncertain, true);
    assert.throws(
      () => resumeStudio(t.store, t.project(), request, testConfig),
      /possible earlier charge/,
    );
    const acknowledged = { ...request, acknowledgePossibleCharge: true };
    assert.throws(
      () =>
        resumeStudio(t.store, t.project(), acknowledged, {
          ...testConfig,
          budgetCents: before,
        }),
      /more reserved allowance/,
    );
    assert.throws(
      () =>
        resumeStudio(
          t.store,
          { ...t.project(), revision: 1 },
          acknowledged,
          testConfig,
        ),
      /newer story revision/,
    );
    resumeStudio(t.store, t.project(), acknowledged, testConfig);
    resumeStudio(t.store, t.project(), acknowledged, testConfig);
    assert.equal(
      t.store.one<{ allowance: number }>("SELECT allowance FROM engine_budget")!
        .allowance,
      before + testConfig.textReserve,
    );
    assert.equal(
      t.store.all(
        "SELECT id FROM studio_calls WHERE status='ambiguous_failure'",
      ).length,
      1,
    );
    provider.failAt = "";
    await runStudio(t.store, provider, testConfig);
    assert.equal(studioView(t.store, "memory")!.status, "awaiting_heart");
    assert.equal(provider.calls.filter((x) => x === "transcription").length, 1);
  } finally {
    t.close();
  }
});

test("stopped jobs release unused funds, retain uncertain estimates and reacquire remaining work atomically", async () => {
  const t = setup(),
    provider = new StudioFake();
  provider.failAt = "heart";
  try {
    const request = await stopAtHeart(t, provider);
    const ceiling = t.store.one<{ allowance: number }>(
      "SELECT allowance FROM studio_jobs",
    )!.allowance;
    const spent = testConfig.audioReserve + testConfig.textReserve;
    assert.equal(reservedBudget(t.store), spent);
    assert.equal(reservedBudget(t.store), spent, "settlement is idempotent");
    assert.equal(
      setupView(t.store, "owner", {
        ...testConfig,
        budgetCents: ceiling + spent,
      }).canStart,
      true,
    );
    assert.equal(
      setupView(t.store, "owner", {
        ...testConfig,
        budgetCents: ceiling + spent - 1,
      }).canStart,
      false,
    );
    const acknowledged = { ...request, acknowledgePossibleCharge: true };
    assert.throws(
      () =>
        resumeStudio(t.store, t.project(), acknowledged, {
          ...testConfig,
          budgetCents: ceiling,
        }),
      /remaining work/,
    );
    assert.equal(
      reservedBudget(t.store),
      spent,
      "failed resume changes no reservation",
    );
    assert.equal(t.store.all("SELECT * FROM studio_recoveries").length, 0);
    resumeStudio(t.store, t.project(), acknowledged, {
      ...testConfig,
      budgetCents: ceiling + testConfig.textReserve,
    });
    assert.equal(reservedBudget(t.store), ceiling + testConfig.textReserve);
    assert.equal(t.store.all("SELECT * FROM studio_calls").length, 2);
    t.store.run("UPDATE studio_jobs SET status='complete'");
    assert.equal(
      reservedBudget(t.store),
      spent,
      "completed jobs release unspent funds too",
    );
    t.store.run("UPDATE studio_jobs SET status='superseded'");
    assert.equal(reservedBudget(t.store), spent);
  } finally {
    t.close();
  }
});

test("settlement repairs old full reservations without touching active, legacy or unknown entries", async () => {
  const t = setup(),
    provider = new StudioFake();
  provider.failAt = "heart";
  try {
    await stopAtHeart(t, provider);
    t.store.run("UPDATE engine_budget SET allowance=99999");
    t.store.run(
      "INSERT INTO engine_budget VALUES('legacy-or-unknown',400,?)",
      now(),
    );
    assert.equal(
      reservedBudget(t.store),
      400 + testConfig.audioReserve + testConfig.textReserve,
    );
    t.store.run("UPDATE studio_jobs SET status='running'");
    t.store.run(
      "UPDATE engine_budget SET allowance=7000 WHERE runId!='legacy-or-unknown'",
    );
    assert.equal(reservedBudget(t.store), 7400);
    t.store.run("UPDATE studio_jobs SET status='needs_attention'");
    t.store.run(
      "UPDATE studio_calls SET status='rejected' WHERE stage='heart'",
    );
    assert.equal(reservedBudget(t.store), 400 + testConfig.audioReserve);
  } finally {
    t.close();
  }
});

test("deleting a stopped book retains uncertain attempts but releases all unattempted work", async () => {
  const t = setup(),
    provider = new StudioFake();
  provider.failAt = "heart";
  try {
    await stopAtHeart(t, provider);
    t.store.run("UPDATE engine_budget SET allowance=99999");
    t.store.deleteProject("memory");
    assert.equal(
      reservedBudget(t.store),
      testConfig.audioReserve + testConfig.textReserve,
    );
    assert.equal(t.store.all("SELECT * FROM studio_calls").length, 0);
  } finally {
    t.close();
  }
});

test("recover a completed heart with unsupported cue flags through all twelve illustrated spreads without replaying extraction", async () => {
  const t = setup(),
    provider = new StudioFake();
  try {
    queueStudio(
      t.store,
      t.project(),
      { ...consent, autonomous: true },
      testConfig,
    );
    let stages = 0;
    await runStudio(t.store, provider, testConfig, {
      shouldContinue: () => ++stages <= 2,
    });
    const raw = {
      ...fixtureHeart,
      questions: [
        {
          id: "species",
          question: "Choose a species?",
          whyItMatters: "Visual choice",
          essential: true,
          answer: "",
        },
        {
          id: "unknown",
          question: "What was the neighbor's name?",
          whyItMatters: "Not given",
          essential: true,
          answer: "",
        },
      ],
      nuggets: fixtureHeart.nuggets.map((n) => ({
        ...n,
        emphasis: "explicit_cue",
      })),
    };
    t.store.run(
      "UPDATE studio_steps SET result=? WHERE stage='heart'",
      JSON.stringify(raw),
    );
    t.store.run("UPDATE studio_jobs SET status='needs_editor',stage='heart'");
    let view = studioView(t.store, "memory")!;
    assert(view.recovery);
    assert.equal(view.recovery.uncertain, false);
    assert.equal(view.recovery.extraReserveUsd, 0);
    const request = {
      jobId: view.id,
      callId: view.recovery.callId,
      acknowledgePossibleCharge: false,
    };
    resumeStudio(t.store, t.project(), request, testConfig);
    resumeStudio(t.store, t.project(), request, testConfig);
    await runStudio(t.store, provider, testConfig);
    view = studioView(t.store, "memory")!;
    assert.equal(view.status, "complete", view.error ?? "");
    assert.equal(provider.calls.filter((x) => x === "heart").length, 1);
    const retained = JSON.parse(
      t.store.one<{ result: string }>(
        "SELECT result FROM studio_steps WHERE stage='heart'",
      )!.result,
    );
    assert.deepEqual(retained, raw);
    const correction = JSON.parse(
      t.store.one<{ result: string }>(
        "SELECT result FROM studio_steps WHERE stage='heart_cue_evidence_v1'",
      )!.result,
    );
    assert.deepEqual(correction.correctedIds, ["n1"]);
    assert.equal(correction.heart.nuggets[0].emphasis, "ordinary");
    const book = JSON.parse(
      t.store.one<{ book: string }>(
        "SELECT book FROM revisions WHERE projectId='memory'",
      )!.book,
    );
    assert.equal(book.spreads.length, 12);
    assert.equal(
      provider.calls.filter((x) => x === "heart_questions_v1").length,
      1,
    );
    const savedState = JSON.parse(
      t.store.one<{ state: string }>("SELECT state FROM studio_jobs")!.state,
    );
    assert(
      savedState.heart.sensitiveBoundaries.includes(
        "Leave the neighbor unnamed.",
      ),
    );
    assert(
      savedState.heart.questions.every((q: { answer: string }) =>
        q.answer.startsWith("Engine editorial decision"),
      ),
    );
    for (const spread of book.spreads)
      assert(t.store.readAsset("memory", spread.artHash).length > 0);
  } finally {
    t.close();
  }
});

test("citation evidence accepts typographic quotation wrappers but still rejects altered words", () => {
  assert(
    hasQuotedEvidence(
      "Dad went home.\nThe door was blue.",
      "“Dad went home. The door was blue.”",
    ),
  );
  assert(hasQuotedEvidence("She said “hello”.", "She said “hello”."));
  assert(!hasQuotedEvidence("Dad went home.", "“Dad stayed home.”"));
  assert(!hasQuotedEvidence("Dad went home.", ""));
});

test("legacy criticism can be re-evaluated once without new drafts or losing the original reviews", async () => {
  const t = setup(),
    p = new StudioFake();
  p.weak = true;
  try {
    queueStudio(
      t.store,
      t.project(),
      { ...consent, autonomous: true },
      testConfig,
    );
    await runStudio(t.store, p, testConfig);
    const saved = t.store.one<{ result: string }>(
      "SELECT result FROM studio_steps WHERE stage='accepted_story'",
    )!.result;
    const original = JSON.parse(saved);
    delete original.reviewProtocol;
    t.store.run(
      "UPDATE studio_steps SET result=? WHERE stage='accepted_story'",
      JSON.stringify(original),
    );
    const beforeDrafts = p.calls.filter((x) =>
      /^draft_\d$|^refine_\d$/.test(x),
    ).length;
    const view = studioView(t.store, "memory")!;
    assert(view.recovery);
    resumeStudio(
      t.store,
      t.project(),
      {
        jobId: view.id,
        callId: view.recovery.callId,
        acknowledgePossibleCharge: false,
      },
      testConfig,
    );
    p.weak = false;
    await runStudio(t.store, p, testConfig);
    assert.equal(studioView(t.store, "memory")!.status, "complete");
    assert.equal(
      p.calls.filter((x) => /^draft_\d$|^refine_\d$/.test(x)).length,
      beforeDrafts,
    );
    assert.deepEqual(
      JSON.parse(
        t.store.one<{ result: string }>(
          "SELECT result FROM studio_steps WHERE stage='accepted_story'",
        )!.result,
      ),
      original,
    );
    assert(
      t.store.one(
        "SELECT stage FROM studio_steps WHERE stage='accepted_story_evidence_v1'",
      ),
    );
  } finally {
    t.close();
  }
});

test("scene API schema uses a supported homogeneous four-number array", () => {
  const schema = JSON.parse(JSON.stringify(z.toJSONSchema(ScenePlan)));
  const box = schema.properties.scenes.items.properties.quietRegion;
  assert.deepEqual(box.items, { type: "number", minimum: 0, maximum: 1 });
  assert.equal(box.minItems, 4);
  assert.equal(box.maxItems, 4);
  assert.equal(box.prefixItems, undefined);
});

test("review-copy assembly never waives preservation, age or numeric craft gates", () => {
  const verdict = {
    heartFailures: [],
    mechanical: [],
    craftFailures: ["Optional ending refinement"],
    weightedMean: 4.1,
    minimum: 3,
    passed: false,
  };
  const critic = { ageAppropriate: true, genericStory: false } as Parameters<
    typeof canAssembleReviewCopy
  >[1];
  assert(canAssembleReviewCopy(verdict, critic));
  assert.equal(verdict.passed, false);
  for (const change of [
    { heartFailures: ["Wrong parent"] },
    { mechanical: ["Missing spread"] },
    { minimum: 2 },
    { weightedMean: 3.9 },
  ])
    assert(!canAssembleReviewCopy({ ...verdict, ...change }, critic));
  assert(!canAssembleReviewCopy(verdict, { ...critic, ageAppropriate: false }));
  assert(!canAssembleReviewCopy(verdict, { ...critic, genericStory: true }));
});

test("image review transport explicitly labels each image without reordering candidate and references", async () => {
  const candidate = Buffer.from("candidate-pixels"),
    reference = Buffer.from("canon-pixels");
  const provider = new OpenAIProvider(testConfig, async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    const content = payload.input[0].content;
    assert.equal(content[1].text, "IMAGE 1 of 2");
    assert.equal(
      content[2].image_url,
      `data:image/png;base64,${candidate.toString("base64")}`,
    );
    assert.equal(content[3].text, "IMAGE 2 of 2");
    assert.equal(
      content[4].image_url,
      `data:image/png;base64,${reference.toString("base64")}`,
    );
    return new Response(
      JSON.stringify({
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: '{"ok":true}' }],
          },
        ],
      }),
      { status: 200 },
    );
  });
  assert.deepEqual(
    await provider.structured(
      "synthetic_review",
      z.object({ ok: z.boolean() }),
      "Test only",
      { imageOrder: "Candidate first, canon second" },
      [candidate, reference],
    ),
    { ok: true },
  );
});

test("production art review never accepts contradictory correctness findings", async () => {
  const { imageAccepted, imageReviewCopyEligible } =
    await import("../src/server/engine/art-review.js");
  const r = {
    identity: 5,
    style: 5,
    actionReadability: 5,
    physicalCoherence: 5,
    evidence: ["Scripted"],
    defects: [],
    correctnessDefects: ["Wrong relative"],
  };
  assert.equal(imageAccepted(r), false);
  assert.equal(imageReviewCopyEligible(r), false);
});
