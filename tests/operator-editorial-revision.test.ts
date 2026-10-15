import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import sharp from "sharp";
import {
  Store,
  canonical,
  hash,
  now,
  type ProjectRow,
} from "../src/server/store.js";
import { configureAccess, setOperator } from "../src/server/access.js";
import { engineConfig, OpenAIProvider } from "../src/server/engine/provider.js";
import {
  startJourney,
  createJourney,
  advanceCreationRequest,
} from "../src/server/almanac/journey.js";
import { saveTurnText } from "../src/server/almanac/service.js";
import { scopedPilotConfig } from "../src/server/pilot/integration.js";
import {
  makePilotPolicy,
  createPilotCampaign,
  authorizePilotCampaign,
  issuePilotInvitation,
  redeemPilotInvitation,
  setPilotCampaignState,
  reservePilotRequest,
  markPilotDispatched,
  settlePilotRequest,
} from "../src/server/pilot/service.js";
import {
  authorizePilotReviewSlots,
  PILOT_REVIEW_EXTENSION_STAGES,
} from "../src/server/pilot/review-slots.js";
import { authorizeSceneAttempt } from "../src/server/engine/scene-attempt.js";
import {
  authorizeSceneRevalidation,
  readSceneRevalidation,
  SCENE_REVALIDATION_REVIEW,
  SCENE_REVALIDATION_ACCEPTED,
} from "../src/server/pilot/scene-revalidation.js";
import { REQUEST_RATE_CARD } from "../src/server/engine/request-cost.js";
import { FAMILY_CONSENT_VERSION } from "../src/shared/journey.js";
import { Book } from "../src/shared/contracts.js";
import { preparePrint } from "../src/server/commerce/print.js";
import { authorizeDigitalReviewCopy } from "../src/server/engine/review-copy-authorization.js";
import {
  authorizeStoryReviewEdition,
  readStoryReviewEditionAuthorization,
  STORY_REVIEW_EDITION_STAGE,
} from "../src/server/engine/story-review-edition.js";
import { runStudio, studioView } from "../src/server/engine/studio.js";
import { requestStudioPause } from "../src/server/engine/budget.js";
import { resumeStudio, studioRecovery } from "../src/server/engine/recovery.js";
import {
  applyOperatorEditorialRevision,
  applyOperatorEditorialRevisionV2,
  readOperatorEditorialRevision,
  readOperatorEditorialRevisionV2,
  currentReviewedStory,
  OPERATOR_EDITORIAL_REVISION_STAGE,
  OPERATOR_EDITORIAL_REVISION_V2_STAGE,
  OPERATOR_EDITORIAL_ACCEPTED_STAGE,
  OPERATOR_EDITORIAL_ACCEPTED_V2_STAGE,
} from "../src/server/engine/operator-editorial-revision.js";
import {
  StudioFake,
  fixtureHeart,
  fixtureSource,
} from "./support/studio-fixtures.js";

// Synthetic source and injected transport only; the real request ledger still runs.
async function fixture(totalCents = 10000) {
  const previous = process.env.EVERLORE_PILOT_WORKER;
  process.env.EVERLORE_PILOT_WORKER = "1";
  const dir = mkdtempSync(join(tmpdir(), "everlore-operator-revision-")),
    store = new Store(dir);
  configureAccess(store, false);
  for (const owner of ["operator", "family", "other"])
    store.run(
      "INSERT INTO users VALUES(?,?,?,'private',?)",
      owner,
      owner,
      "unused",
      now(),
    );
  setOperator(store, "operator");
  const base = {
    ...engineConfig({}),
    apiKey: "offline-unused",
    enabled: false,
    strictCostGuard: true,
    budgetCents: 0,
  };
  const campaign = createPilotCampaign(store, "operator", {
    key: "synthetic-revision",
    totalCents,
    maxHouseholds: 1,
    policy: makePilotPolicy({
      version: 1,
      mode: "estimated_pilot",
      textInputTokensPerByte: 1,
      imagePromptTokensPerByte: 1,
      imageInputTokensPerReference: 6000,
      imageInputOverheadTokens: 1000,
      safetyMultiplier: 2,
    }),
  });
  authorizePilotCampaign(store, "operator", campaign.id, {
    authorizationReference: "Synthetic local fixture only",
    acknowledgeEstimatedCosts: true,
  });
  const invitation = issuePilotInvitation(store, "operator", campaign.id, {
    key: "family",
    label: "Synthetic family",
  });
  redeemPilotInvitation(store, invitation.code!, "family");
  const consent = {
    consent: true,
    consentVersion: FAMILY_CONSENT_VERSION,
    processWithOpenAI: true,
    imaginativeAdaptation: true,
  };
  const session = startJourney(
    store,
    "family",
    { key: "start", ...consent },
    base,
  ).session.session;
  saveTurnText(store, "family", session.id, session.turns[0].id, {
    rawText: fixtureSource,
  });
  const created = createJourney(
    store,
    "family",
    session.id,
    { key: "book", ...consent },
    base,
  );
  const config = scopedPilotConfig(base, campaign, created.requestId!);
  advanceCreationRequest(store, config, { creationId: created.requestId! });
  const job = store.one<{ id: string; projectId: string; profile: string }>(
    "SELECT j.id,j.projectId,j.profile FROM studio_jobs j JOIN pilot_jobs p ON p.jobId=j.id WHERE p.creationId=?",
    created.requestId!,
  )!;
  const seen: { name: string; data: unknown }[] = [];
  class Scripted extends StudioFake {
    override async structured<T>(
      name: string,
      schema: z.ZodType<T>,
      instructions: string,
      data: unknown,
      images: Buffer[] = [],
    ) {
      seen.push({ name, data: structuredClone(data) });
      if (name === "heart") {
        this.calls.push(name);
        return schema.parse({
          ...fixtureHeart,
          nuggets: fixtureHeart.nuggets.map((n) => ({
            ...n,
            sourceId: "t1-s1",
          })),
        });
      }
      return super.structured(name, schema, instructions, data, images);
    }
  }
  const painter = new Scripted();
  painter.weak = true;
  const provider = new OpenAIProvider(config, async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (
      path.endsWith("/images/edits") ||
      path.endsWith("/images/generations")
    ) {
      const form = init!.body;
      const params =
        form instanceof FormData
          ? {
              prompt: String(form.get("prompt")),
              size: String(form.get("size")),
            }
          : JSON.parse(form as string);
      const references =
        form instanceof FormData
          ? await Promise.all(
              form
                .getAll("image[]")
                .map(async (value) =>
                  Buffer.from(await (value as Blob).arrayBuffer()),
                ),
            )
          : [];
      const pixels = await painter.image(
        params.prompt,
        references.length ? references : undefined,
      );
      const [width, height] = params.size.split("x").map(Number);
      const png = await sharp(pixels).resize(width, height).png().toBuffer();
      return Response.json({
        data: [{ b64_json: png.toString("base64") }],
        usage: { input_tokens: 200, output_tokens: 80 },
      });
    }
    assert(
      new URL(String(url)).pathname.endsWith("/responses"),
      "No audio, images, token counting or external transport in this test",
    );
    assert.equal(
      store.all("SELECT id FROM pilot_attempts WHERE status='dispatched'")
        .length,
      1,
    );
    const body = JSON.parse(init!.body as string),
      data = JSON.parse(body.input[0].content[0].text);
    const result = await painter.structured(
      body.text.format.name,
      z.unknown(),
      body.instructions,
      data,
      body.input[0].content
        .filter((c: { type: string }) => c.type === "input_image")
        .map((c: { image_url: string }) =>
          Buffer.from(c.image_url.split(",")[1], "base64"),
        ),
    );
    return Response.json({
      status: "completed",
      usage: { input_tokens: 200, output_tokens: 80 },
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(result) }],
        },
      ],
    });
  });
  await runStudio(store, provider, config, { jobId: job.id });
  assert.equal(
    store.one<{ status: string }>(
      "SELECT status FROM studio_jobs WHERE id=?",
      job.id,
    )!.status,
    "needs_editor",
  );
  const read = (stage: string) =>
    JSON.parse(
      store.one<{ result: string }>(
        "SELECT result FROM studio_steps WHERE jobId=? AND stage=? AND state='completed'",
        job.id,
        stage,
      )!.result,
    );
  const copyedit = structuredClone(read("accepted_story").manuscript);
  copyedit.byline = "A synthetic reviewed copy edit";
  const submission = {
    manuscript: copyedit,
    reason: "Synthetic first manual copy edit",
  };
  store.run(
    "INSERT INTO studio_steps VALUES(?, 'editorial_attention_submission_v1', ?, 'completed', ?)",
    job.id,
    hash(canonical(submission)),
    canonical(submission),
  );
  store.run("UPDATE studio_jobs SET status='queued' WHERE id=?", job.id);
  await runStudio(store, provider, config, { jobId: job.id });
  assert.equal(
    store.one<{ stage: string }>(
      "SELECT stage FROM studio_jobs WHERE id=?",
      job.id,
    )!.stage,
    "editorial_attention_v1_poetics",
  );
  const manuscript = structuredClone(copyedit);
  manuscript.title = "A revised synthetic story";
  const source = JSON.parse(
    store.one<{ state: string }>(
      "SELECT state FROM studio_jobs WHERE id=?",
      job.id,
    )!.state,
  ).source;
  const input = {
    ownerId: "family",
    projectId: job.projectId,
    jobId: job.id,
    sourceHash: hash(canonical(source)),
    baseManuscriptHash: hash(canonical(copyedit)),
    profileHash: job.profile,
    manuscriptHash: hash(canonical(manuscript)),
    manuscript,
    reason:
      "One explicitly approved synthetic revision, not an extra writer call.",
    approval: {
      quote:
        "Please finish this synthetic test book with the proposed revision.",
      receivedAt: now(),
    },
  };
  const close = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.EVERLORE_PILOT_WORKER;
    else process.env.EVERLORE_PILOT_WORKER = previous;
  };
  return {
    store,
    job,
    input,
    base,
    config,
    campaign,
    provider,
    painter,
    seen,
    read,
    source,
    close,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function secondRevision(t: Fixture) {
  applyOperatorEditorialRevision(t.store, "operator", t.input, t.base);
  await runStudio(t.store, t.provider, t.config, { jobId: t.job.id });
  const previous = t.read(OPERATOR_EDITORIAL_ACCEPTED_STAGE);
  assert.equal(previous.verdict.passed, false);
  const manuscript = structuredClone(previous.manuscript);
  manuscript.title = "A second explicitly approved synthetic story";
  return {
    ...t.input,
    baseManuscriptHash: hash(canonical(previous.manuscript)),
    baseCandidateHash: hash(canonical(previous)),
    manuscript,
    manuscriptHash: hash(canonical(manuscript)),
    approval: {
      quote: "I approve this exact second synthetic revision for this test.",
      receivedAt: now(),
    },
  };
}
const retained = (t: Fixture) =>
  canonical({
    steps: t.store.all(
      "SELECT * FROM studio_steps WHERE jobId=? AND stage!=? ORDER BY stage",
      t.job.id,
      OPERATOR_EDITORIAL_REVISION_STAGE,
    ),
    calls: t.store.all(
      "SELECT * FROM studio_calls WHERE jobId=? ORDER BY id",
      t.job.id,
    ),
    pilot: t.store.all("SELECT * FROM pilot_attempts ORDER BY id"),
    budget: t.store.all("SELECT * FROM engine_budget"),
    source: t.store.all("SELECT * FROM almanac_sources"),
    request: t.store.one(
      "SELECT request,profile,state,allowance FROM studio_jobs WHERE id=?",
      t.job.id,
    ),
  });

test("approved operator revision retains two repairs and copy-edit reviews, then adds only three reviews before scenes", async (ctx) => {
  const network = ctx.mock.method(globalThis, "fetch", async () => {
    throw new Error("No network allowed");
  });
  const t = await fixture();
  try {
    const before = retained(t),
      previousCalls = [...t.painter.calls];
    const oldSteps = t.store.all<{
      stage: string;
      inputHash: string;
      state: string;
      result: string;
    }>(
      "SELECT stage,inputHash,state,result FROM studio_steps WHERE jobId=? ORDER BY stage",
      t.job.id,
    );
    const record = applyOperatorEditorialRevision(
      t.store,
      "operator",
      t.input,
      t.base,
    );
    assert.equal(retained(t), before);
    assert.deepEqual(
      applyOperatorEditorialRevision(t.store, "operator", t.input, t.base),
      record,
    );
    assert.equal(t.store.all("SELECT id FROM studio_jobs").length, 1);
    assert.equal(
      t.store.all("SELECT id FROM almanac_creation_requests").length,
      1,
    );
    t.painter.weak = false;
    t.painter.onStructured = (name) => {
      if (name === "operator_revision_v1_poetics")
        requestStudioPause(t.store, t.job.id);
    };
    await runStudio(t.store, t.provider, t.config, { jobId: t.job.id });
    assert.deepEqual(t.painter.calls.slice(previousCalls.length), [
      "operator_revision_v1_heart",
      "operator_revision_v1_craft",
      "operator_revision_v1_poetics",
    ]);
    assert.equal(
      t.store.one<{ stage: string }>(
        "SELECT stage FROM studio_jobs WHERE id=?",
        t.job.id,
      )!.stage,
      "scenes",
    );
    assert.deepEqual(
      t.read("accepted_story_operator_revision_v1").manuscript,
      t.input.manuscript,
    );
    const viewStatus = t.store.one<{ status: string }>(
      "SELECT status FROM studio_jobs WHERE id=?",
      t.job.id,
    )!.status;
    t.store.run(
      "UPDATE studio_jobs SET status='awaiting_art' WHERE id=?",
      t.job.id,
    );
    assert.equal(
      studioView(t.store, t.job.projectId)!.preview!.title,
      t.input.manuscript.title,
    );
    t.store.run(
      "UPDATE studio_jobs SET status=? WHERE id=?",
      viewStatus,
      t.job.id,
    );
    const recovery = studioRecovery(t.store, t.job.id)!;
    resumeStudio(
      t.store,
      t.store.one<ProjectRow>(
        "SELECT * FROM projects WHERE id=?",
        t.job.projectId,
      )!,
      {
        jobId: t.job.id,
        callId: recovery.callId,
        acknowledgePossibleCharge: false,
      },
      t.base,
    );
    t.painter.onStructured = (name) => {
      if (name === "scenes") requestStudioPause(t.store, t.job.id);
    };
    await runStudio(t.store, t.provider, t.config, { jobId: t.job.id });
    assert.deepEqual(
      (t.seen.find((r) => r.name === "scenes")!.data as { manuscript: unknown })
        .manuscript,
      t.input.manuscript,
    );
    for (const stage of previousCalls)
      assert.equal(t.painter.calls.filter((s) => s === stage).length, 1, stage);
    for (const step of oldSteps)
      assert.deepEqual(
        t.store.one(
          "SELECT stage,inputHash,state,result FROM studio_steps WHERE jobId=? AND stage=?",
          t.job.id,
          step.stage,
        ),
        step,
      );
    const status = t.store.one(
      "SELECT status,stage FROM studio_jobs WHERE id=?",
      t.job.id,
    );
    assert.deepEqual(
      applyOperatorEditorialRevision(t.store, "operator", t.input, t.base),
      record,
    );
    assert.deepEqual(
      t.store.one("SELECT status,stage FROM studio_jobs WHERE id=?", t.job.id),
      status,
      "retry never requeues",
    );
    assert.equal(network.mock.callCount(), 0);
  } finally {
    t.close();
  }
});

test("operator revision rejects stale authorization, source, earlier manuscript, unsafe state and inactive funding atomically", async () => {
  const t = await fixture();
  try {
    const before = retained(t);
    for (const change of [
      { ownerId: "other" },
      { sourceHash: hash("stale") },
      { profileHash: hash("stale") },
      {
        baseManuscriptHash: hash(
          canonical(t.read("accepted_story").manuscript),
        ),
      },
      { manuscriptHash: hash("different proposal") },
    ]) {
      assert.throws(() =>
        applyOperatorEditorialRevision(
          t.store,
          "operator",
          { ...t.input, ...change },
          t.base,
        ),
      );
      assert.equal(retained(t), before);
    }
    assert.throws(() =>
      applyOperatorEditorialRevision(t.store, "family", t.input, t.base),
    );
    t.store.run(
      "UPDATE studio_jobs SET leaseToken='active',leaseUntil=? WHERE id=?",
      Date.now() + 1000,
      t.job.id,
    );
    assert.throws(
      () =>
        applyOperatorEditorialRevision(t.store, "operator", t.input, t.base),
      /stopped original/,
    );
    t.store.run(
      "UPDATE studio_jobs SET leaseToken=NULL,leaseUntil=0 WHERE id=?",
      t.job.id,
    );
    setPilotCampaignState(t.store, "operator", t.campaign.id, "paused");
    assert.throws(
      () =>
        applyOperatorEditorialRevision(t.store, "operator", t.input, t.base),
      /funded pilot/,
    );
    setPilotCampaignState(t.store, "operator", t.campaign.id, "active");
    t.store.run(
      "INSERT INTO studio_steps VALUES(?, 'scenes', ?, 'started', NULL)",
      t.job.id,
      hash("scene"),
    );
    assert.throws(
      () =>
        applyOperatorEditorialRevision(t.store, "operator", t.input, t.base),
      /Unfinished/,
    );
    t.store.run(
      "DELETE FROM studio_steps WHERE jobId=? AND stage='scenes'",
      t.job.id,
    );
    const call = t.store.one<{ id: string }>(
      "SELECT id FROM studio_calls WHERE jobId=? LIMIT 1",
      t.job.id,
    )!;
    t.store.run(
      "UPDATE studio_calls SET status='ambiguous_failure' WHERE id=?",
      call.id,
    );
    assert.throws(
      () =>
        applyOperatorEditorialRevision(t.store, "operator", t.input, t.base),
      /ambiguous/,
    );
    t.store.run(
      "UPDATE studio_calls SET status='completed' WHERE id=?",
      call.id,
    );
    const projectSource = t.store.one<{ transcript: string }>(
      "SELECT transcript FROM projects WHERE id=?",
      t.job.projectId,
    )!.transcript;
    t.store.run(
      "UPDATE projects SET transcript=? WHERE id=?",
      canonical({ ...t.source, rawText: "Changed" }),
      t.job.projectId,
    );
    assert.throws(
      () =>
        applyOperatorEditorialRevision(t.store, "operator", t.input, t.base),
      /source changed/,
    );
    t.store.run(
      "UPDATE projects SET transcript=? WHERE id=?",
      projectSource,
      t.job.projectId,
    );
    applyOperatorEditorialRevision(t.store, "operator", t.input, t.base);
    assert.throws(
      () =>
        applyOperatorEditorialRevision(
          t.store,
          "operator",
          { ...t.input, reason: "A different revision attempt" },
          t.base,
        ),
      /immutable/,
    );
    const approved = t.store.one<{ result: string }>(
      "SELECT result FROM studio_steps WHERE jobId=? AND stage=?",
      t.job.id,
      OPERATOR_EDITORIAL_REVISION_STAGE,
    )!.result;
    const tampered = JSON.parse(approved);
    tampered.manuscript.title = "Unapproved drift";
    t.store.run(
      "UPDATE studio_steps SET result=? WHERE jobId=? AND stage=?",
      canonical(tampered),
      t.job.id,
      OPERATOR_EDITORIAL_REVISION_STAGE,
    );
    assert.throws(
      () => readOperatorEditorialRevision(t.store, t.job.id),
      /binding changed/,
    );
  } finally {
    t.close();
  }
});

test("a failed new review remains authoritative and cannot fall back to the older manuscript", async () => {
  const t = await fixture();
  try {
    applyOperatorEditorialRevision(t.store, "operator", t.input, t.base);
    await runStudio(t.store, t.provider, t.config, { jobId: t.job.id });
    assert.equal(
      t.store.one<{ status: string }>(
        "SELECT status FROM studio_jobs WHERE id=?",
        t.job.id,
      )!.status,
      "needs_editor",
    );
    const viewStatus = t.store.one<{ status: string }>(
      "SELECT status FROM studio_jobs WHERE id=?",
      t.job.id,
    )!.status;
    t.store.run(
      "UPDATE studio_jobs SET status='awaiting_art' WHERE id=?",
      t.job.id,
    );
    assert.equal(
      studioView(t.store, t.job.projectId)!.preview!.title,
      t.input.manuscript.title,
    );
    t.store.run(
      "UPDATE studio_jobs SET status=? WHERE id=?",
      viewStatus,
      t.job.id,
    );
    assert.equal(studioRecovery(t.store, t.job.id), null);
    assert.equal(
      t.store.one(
        "SELECT stage FROM studio_steps WHERE jobId=? AND stage='scenes'",
        t.job.id,
      ),
      undefined,
    );
  } finally {
    t.close();
  }
});

test("post-approval source snapshot drift stops before any new review call", async () => {
  const t = await fixture();
  try {
    applyOperatorEditorialRevision(t.store, "operator", t.input, t.base);
    const before = [...t.painter.calls];
    const source = t.store.one<{ id: string; body: string }>(
      "SELECT id,body FROM almanac_sources WHERE generationProjectId=?",
      t.job.projectId,
    )!;
    const changed = JSON.parse(source.body);
    changed.turns[0].transcript.rawText += " Unapproved drift.";
    t.store.run(
      "UPDATE almanac_sources SET body=? WHERE id=?",
      canonical(changed),
      source.id,
    );
    await runStudio(t.store, t.provider, t.config, { jobId: t.job.id });
    assert.deepEqual(t.painter.calls, before);
    assert.equal(
      t.store.one(
        "SELECT stage FROM studio_steps WHERE jobId=? AND stage='operator_revision_v1_heart'",
        t.job.id,
      ),
      undefined,
    );
    assert.throws(
      () => readOperatorEditorialRevision(t.store, t.job.id),
      /binding changed/,
    );
    t.store.run(
      "UPDATE almanac_sources SET body=? WHERE id=?",
      source.body,
      source.id,
    );
    t.store.run(
      "UPDATE projects SET transcript=? WHERE id=?",
      canonical({ ...t.source, rawText: "Unapproved source" }),
      t.job.projectId,
    );
    assert.throws(
      () => readOperatorEditorialRevision(t.store, t.job.id),
      /binding changed/,
    );
  } finally {
    t.close();
  }
});

test("second approved revision retains v1 and all prior calls, adds three distinct reviews, and resumes scenes once", async (ctx) => {
  const network = ctx.mock.method(globalThis, "fetch", async () => {
    throw new Error("No network allowed");
  });
  const t = await fixture();
  try {
    const input = await secondRevision(t);
    const oldSteps = t.store.all<{
      stage: string;
      inputHash: string;
      state: string;
      result: string;
    }>(
      "SELECT stage,inputHash,state,result FROM studio_steps WHERE jobId=? ORDER BY stage",
      t.job.id,
    );
    const oldCalls = t.store.all<{ id: string }>(
      "SELECT * FROM studio_calls WHERE jobId=? ORDER BY id",
      t.job.id,
    );
    const oldSource = canonical(t.store.all("SELECT * FROM almanac_sources"));
    const oldRequest = canonical(
      t.store.one(
        "SELECT request,profile,state,allowance FROM studio_jobs WHERE id=?",
        t.job.id,
      ),
    );
    const previousCalls = [...t.painter.calls];
    const receipt = applyOperatorEditorialRevisionV2(
      t.store,
      "operator",
      input,
      t.base,
    );
    assert.equal(receipt.version, 2);
    assert.equal(receipt.baseCandidateHash, input.baseCandidateHash);
    assert.equal(
      currentReviewedStory(t.store, t.job.id),
      null,
      "pending v2 cannot expose an older acceptance",
    );
    assert.deepEqual(
      readOperatorEditorialRevisionV2(t.store, t.job.id),
      receipt,
    );
    assert.deepEqual(
      applyOperatorEditorialRevisionV2(t.store, "operator", input, t.base),
      receipt,
    );
    assert.equal(
      canonical(t.store.all("SELECT * FROM almanac_sources")),
      oldSource,
    );
    assert.equal(
      canonical(
        t.store.one(
          "SELECT request,profile,state,allowance FROM studio_jobs WHERE id=?",
          t.job.id,
        ),
      ),
      oldRequest,
    );
    assert.equal(t.store.all("SELECT id FROM studio_jobs").length, 1);
    assert.equal(
      t.store.all("SELECT id FROM almanac_creation_requests").length,
      1,
    );
    t.painter.weak = false;
    t.painter.onStructured = (name) => {
      if (name === "operator_revision_v2_poetics")
        requestStudioPause(t.store, t.job.id);
    };
    await runStudio(t.store, t.provider, t.config, { jobId: t.job.id });
    assert.deepEqual(t.painter.calls.slice(previousCalls.length), [
      "operator_revision_v2_heart",
      "operator_revision_v2_craft",
      "operator_revision_v2_poetics",
    ]);
    assert.deepEqual(
      t.read(OPERATOR_EDITORIAL_ACCEPTED_V2_STAGE).manuscript,
      input.manuscript,
    );
    assert.deepEqual(
      currentReviewedStory(t.store, t.job.id),
      t.read(OPERATOR_EDITORIAL_ACCEPTED_V2_STAGE),
    );
    const recovery = studioRecovery(t.store, t.job.id)!;
    resumeStudio(
      t.store,
      t.store.one<ProjectRow>(
        "SELECT * FROM projects WHERE id=?",
        t.job.projectId,
      )!,
      {
        jobId: t.job.id,
        callId: recovery.callId,
        acknowledgePossibleCharge: false,
      },
      t.base,
    );
    t.painter.onStructured = (name) => {
      if (name === "scenes") requestStudioPause(t.store, t.job.id);
    };
    await runStudio(t.store, t.provider, t.config, { jobId: t.job.id });
    assert.deepEqual(
      (t.seen.find((r) => r.name === "scenes")!.data as { manuscript: unknown })
        .manuscript,
      input.manuscript,
    );
    for (const stage of previousCalls)
      assert.equal(t.painter.calls.filter((s) => s === stage).length, 1, stage);
    for (const step of oldSteps)
      assert.deepEqual(
        t.store.one(
          "SELECT stage,inputHash,state,result FROM studio_steps WHERE jobId=? AND stage=?",
          t.job.id,
          step.stage,
        ),
        step,
      );
    for (const call of oldCalls)
      assert.deepEqual(
        t.store.one("SELECT * FROM studio_calls WHERE id=?", call.id),
        call,
      );
    const status = t.store.one(
      "SELECT status,stage FROM studio_jobs WHERE id=?",
      t.job.id,
    );
    assert.deepEqual(
      applyOperatorEditorialRevisionV2(t.store, "operator", input, t.base),
      receipt,
    );
    assert.deepEqual(
      t.store.one("SELECT status,stage FROM studio_jobs WHERE id=?", t.job.id),
      status,
    );
    assert.deepEqual(
      applyOperatorEditorialRevision(t.store, "operator", t.input, t.base)
        .version,
      1,
    );
    assert.equal(network.mock.callCount(), 0);
  } finally {
    t.close();
  }
});

test("v2 requires the exact failed v1 candidate, unchanged scope, and safe stopped job; differing retries reject", async () => {
  const t = await fixture();
  try {
    assert.throws(
      () =>
        applyOperatorEditorialRevisionV2(
          t.store,
          "operator",
          { ...t.input, baseCandidateHash: hash("missing") },
          t.base,
        ),
      /stopped original/,
    );
    const input = await secondRevision(t);
    const before = retained(t);
    for (const change of [
      { baseCandidateHash: hash("stale review") },
      { baseManuscriptHash: t.input.baseManuscriptHash },
      { sourceHash: hash("different source") },
      { profileHash: hash("different profile") },
      { ownerId: "other" },
    ]) {
      assert.throws(() =>
        applyOperatorEditorialRevisionV2(
          t.store,
          "operator",
          { ...input, ...change },
          t.base,
        ),
      );
      assert.equal(retained(t), before);
    }
    assert.throws(() =>
      applyOperatorEditorialRevisionV2(t.store, "family", input, t.base),
    );
    const candidate = t.read(OPERATOR_EDITORIAL_ACCEPTED_STAGE);
    t.store.run(
      "UPDATE studio_steps SET result=? WHERE jobId=? AND stage=?",
      canonical({
        ...candidate,
        verdict: { ...candidate.verdict, passed: true },
      }),
      t.job.id,
      OPERATOR_EDITORIAL_ACCEPTED_STAGE,
    );
    assert.throws(
      () =>
        applyOperatorEditorialRevisionV2(t.store, "operator", input, t.base),
      /exact failed/,
    );
    t.store.run(
      "UPDATE studio_steps SET result=? WHERE jobId=? AND stage=?",
      canonical(candidate),
      t.job.id,
      OPERATOR_EDITORIAL_ACCEPTED_STAGE,
    );
    t.store.run(
      "UPDATE studio_jobs SET leaseToken='active',leaseUntil=? WHERE id=?",
      Date.now() + 1000,
      t.job.id,
    );
    assert.throws(
      () =>
        applyOperatorEditorialRevisionV2(t.store, "operator", input, t.base),
      /stopped original/,
    );
    t.store.run(
      "UPDATE studio_jobs SET leaseToken=NULL,leaseUntil=0 WHERE id=?",
      t.job.id,
    );
    t.store.run(
      "INSERT INTO studio_steps VALUES(?,'scenes','unapproved','started',NULL)",
      t.job.id,
    );
    assert.throws(
      () =>
        applyOperatorEditorialRevisionV2(t.store, "operator", input, t.base),
      /Unfinished/,
    );
    t.store.run(
      "DELETE FROM studio_steps WHERE jobId=? AND stage='scenes'",
      t.job.id,
    );
    setPilotCampaignState(t.store, "operator", t.campaign.id, "paused");
    assert.throws(
      () =>
        applyOperatorEditorialRevisionV2(t.store, "operator", input, t.base),
      /funded pilot/,
    );
    setPilotCampaignState(t.store, "operator", t.campaign.id, "active");
    const receipt = applyOperatorEditorialRevisionV2(
      t.store,
      "operator",
      input,
      t.base,
    );
    assert.throws(
      () =>
        applyOperatorEditorialRevisionV2(
          t.store,
          "operator",
          { ...input, baseCandidateHash: hash("changed retry") },
          t.base,
        ),
      /immutable/,
    );
    assert.throws(
      () =>
        applyOperatorEditorialRevisionV2(
          t.store,
          "operator",
          {
            ...input,
            approval: { ...input.approval, quote: "A changed approval" },
          },
          t.base,
        ),
      /immutable/,
    );
    assert.deepEqual(
      readOperatorEditorialRevisionV2(t.store, t.job.id),
      receipt,
    );
    assert.equal(
      t.store.all(
        "SELECT stage FROM studio_steps WHERE jobId=? AND stage=?",
        t.job.id,
        OPERATOR_EDITORIAL_REVISION_V2_STAGE,
      ).length,
      1,
    );
  } finally {
    t.close();
  }
});

test("v1 verdict-only drift after v2 approval stops before any second-revision review", async () => {
  const t = await fixture();
  try {
    const input = await secondRevision(t);
    applyOperatorEditorialRevisionV2(t.store, "operator", input, t.base);
    const before = [...t.painter.calls];
    const candidate = t.read(OPERATOR_EDITORIAL_ACCEPTED_STAGE);
    candidate.verdict.craftFailures.push(
      "An unapproved alteration to the original failed review",
    );
    t.store.run(
      "UPDATE studio_steps SET result=? WHERE jobId=? AND stage=?",
      canonical(candidate),
      t.job.id,
      OPERATOR_EDITORIAL_ACCEPTED_STAGE,
    );
    assert.throws(
      () => readOperatorEditorialRevisionV2(t.store, t.job.id),
      /binding changed/,
    );
    await runStudio(t.store, t.provider, t.config, { jobId: t.job.id });
    assert.deepEqual(t.painter.calls, before);
    assert.equal(
      t.store.one(
        "SELECT stage FROM studio_steps WHERE jobId=? AND stage='operator_revision_v2_heart'",
        t.job.id,
      ),
      undefined,
    );
  } finally {
    t.close();
  }
});

test("failed v2 stays authoritative in the view and recovery without falling back to v1", async () => {
  const t = await fixture();
  try {
    const input = await secondRevision(t);
    applyOperatorEditorialRevisionV2(t.store, "operator", input, t.base);
    await runStudio(t.store, t.provider, t.config, { jobId: t.job.id });
    const accepted = t.read(OPERATOR_EDITORIAL_ACCEPTED_V2_STAGE);
    assert.equal(accepted.verdict.passed, false);
    assert.deepEqual(currentReviewedStory(t.store, t.job.id), accepted);
    assert.equal(studioRecovery(t.store, t.job.id), null);
    t.store.run(
      "UPDATE studio_jobs SET status='awaiting_art' WHERE id=?",
      t.job.id,
    );
    assert.equal(
      studioView(t.store, t.job.projectId)!.preview!.title,
      input.manuscript.title,
    );
    t.store.run(
      "UPDATE studio_jobs SET status='needs_editor' WHERE id=?",
      t.job.id,
    );
    assert.equal(
      t.store.one(
        "SELECT stage FROM studio_steps WHERE jobId=? AND stage='scenes'",
        t.job.id,
      ),
      undefined,
    );
    t.store.run(
      "UPDATE studio_steps SET state='started',result=NULL WHERE jobId=? AND stage=?",
      t.job.id,
      OPERATOR_EDITORIAL_ACCEPTED_V2_STAGE,
    );
    assert.equal(currentReviewedStory(t.store, t.job.id), null);
    assert.equal(studioRecovery(t.store, t.job.id), null);
  } finally {
    t.close();
  }
});

async function reviewEditionFixture(totalCents = 10000) {
  const t = await fixture(totalCents),
    v2 = await secondRevision(t);
  applyOperatorEditorialRevisionV2(t.store, "operator", v2, t.base);
  await runStudio(t.store, t.provider, t.config, { jobId: t.job.id });
  const candidate = t.read(OPERATOR_EDITORIAL_ACCEPTED_V2_STAGE);
  assert.equal(candidate.verdict.passed, false);
  return {
    ...t,
    v2,
    authorization: {
      ownerId: v2.ownerId,
      projectId: v2.projectId,
      jobId: v2.jobId,
      sourceHash: v2.sourceHash,
      profileHash: v2.profileHash,
      manuscriptHash: v2.manuscriptHash,
      reviewedCandidateHash: hash(canonical(candidate)),
      scope: "private_illustrated_story_review_only" as const,
      reason:
        "Explicit synthetic permission for this exact private review edition; all image checks stay active.",
      approval: {
        quote: "Yes—finish the illustrated review edition",
        receivedAt: now(),
      },
    },
  };
}

test("exact story-review permission creates one labeled PDF edition without new writing or judging and blocks printing", async (ctx) => {
  const network = ctx.mock.method(globalThis, "fetch", async () => {
    throw new Error("No network allowed");
  });
  const t = await reviewEditionFixture();
  try {
    const steps = t.store.all<{ stage: string }>(
      "SELECT * FROM studio_steps WHERE jobId=? ORDER BY stage",
      t.job.id,
    );
    const calls = [...t.painter.calls],
      candidate = t.read(OPERATOR_EDITORIAL_ACCEPTED_V2_STAGE);
    const source = canonical(t.store.all("SELECT * FROM almanac_sources"));
    const receipt = authorizeStoryReviewEdition(
      t.store,
      "operator",
      t.authorization,
      t.base,
    );
    assert.deepEqual(
      readStoryReviewEditionAuthorization(t.store, t.job.id),
      receipt,
    );
    assert.deepEqual(
      authorizeStoryReviewEdition(t.store, "operator", t.authorization, t.base),
      receipt,
    );
    t.painter.weak = false;
    await runStudio(t.store, t.provider, t.config, { jobId: t.job.id });
    assert.equal(
      studioView(t.store, t.job.projectId)!.status,
      "complete",
      JSON.stringify(
        t.store.one("SELECT stage,error FROM studio_jobs WHERE id=?", t.job.id),
      ),
    );
    const edition = t.store.one<{ id: string; book: string; pdfHash: string }>(
      "SELECT id,book,pdfHash FROM editions WHERE projectId=?",
      t.job.projectId,
    )!;
    const book = Book.parse(JSON.parse(edition.book));
    assert.equal(book.spreads.length, 12);
    assert.equal(book.production!.editorialStatus, "revision_recommended");
    assert.equal(book.production!.storyReviewEditionException!.id, receipt.id);
    assert.equal(book.production!.reviewCopyException, undefined);
    assert.deepEqual(book.production!.manuscript, t.v2.manuscript);
    assert.deepEqual(
      book.production!.editorialReview,
      candidate.editorialReview,
    );
    assert.ok(
      book.reviewFlags.some((x) => x.includes("Illustrated review copy")),
    );
    assert.equal(
      hash(t.store.readAsset(t.job.projectId, edition.pdfHash)),
      edition.pdfHash,
    );
    assert.equal(
      canonical(t.store.all("SELECT * FROM almanac_sources")),
      source,
    );
    for (const step of steps)
      assert.deepEqual(
        t.store.one(
          "SELECT * FROM studio_steps WHERE jobId=? AND stage=?",
          t.job.id,
          step.stage,
        ),
        step,
      );
    for (const name of calls)
      assert.equal(t.painter.calls.filter((n) => n === name).length, 1, name);
    assert.equal(
      t.painter.calls
        .slice(calls.length)
        .filter((n) =>
          /draft_|refine_|operator_revision_|editorial_attention_/.test(n),
        ).length,
      0,
    );
    assert.equal(t.store.all("SELECT id FROM studio_jobs").length, 1);
    assert.equal(
      t.store.all("SELECT id FROM almanac_creation_requests").length,
      1,
    );
    const print = await preparePrint(t.store, t.job.projectId, edition.id);
    assert.equal(print.ready, false);
    assert.ok(
      print.issues.some((i) => i.includes("not approved for printing")),
    );
    const status = t.store.one(
      "SELECT status,stage FROM studio_jobs WHERE id=?",
      t.job.id,
    );
    assert.deepEqual(
      authorizeStoryReviewEdition(t.store, "operator", t.authorization, t.base),
      receipt,
    );
    assert.deepEqual(
      t.store.one("SELECT status,stage FROM studio_jobs WHERE id=?", t.job.id),
      status,
    );
    assert.equal(
      await runStudio(t.store, t.provider, t.config, { jobId: t.job.id }),
      false,
    );
    assert.equal(t.store.all("SELECT id FROM editions").length, 1);
    assert.equal(network.mock.callCount(), 0);
  } finally {
    t.close();
  }
});

test("story-review permission rejects stale scope, unsafe state, protected failures and changed retries", async () => {
  const t = await reviewEditionFixture();
  try {
    const before = canonical(
      t.store.all("SELECT * FROM studio_steps WHERE jobId=?", t.job.id),
    );
    for (const change of [
      { ownerId: "other" },
      { sourceHash: hash("stale") },
      { profileHash: hash("stale") },
      { manuscriptHash: hash("stale") },
      { reviewedCandidateHash: hash("stale") },
      { scope: "digital_feedback_only" },
    ])
      assert.throws(() =>
        authorizeStoryReviewEdition(
          t.store,
          "operator",
          { ...t.authorization, ...change },
          t.base,
        ),
      );
    assert.throws(() =>
      authorizeStoryReviewEdition(t.store, "family", t.authorization, t.base),
    );
    assert.equal(
      canonical(
        t.store.all("SELECT * FROM studio_steps WHERE jobId=?", t.job.id),
      ),
      before,
    );
    t.store.run(
      "UPDATE studio_jobs SET leaseToken='active',leaseUntil=? WHERE id=?",
      Date.now() + 10000,
      t.job.id,
    );
    assert.throws(
      () =>
        authorizeStoryReviewEdition(
          t.store,
          "operator",
          t.authorization,
          t.base,
        ),
      /stopped original/,
    );
    t.store.run(
      "UPDATE studio_jobs SET leaseToken=NULL,leaseUntil=0 WHERE id=?",
      t.job.id,
    );
    t.store.run(
      "INSERT INTO studio_steps VALUES(?,'scenes','unapproved','started',NULL)",
      t.job.id,
    );
    assert.throws(
      () =>
        authorizeStoryReviewEdition(
          t.store,
          "operator",
          t.authorization,
          t.base,
        ),
      /Unfinished/,
    );
    t.store.run(
      "DELETE FROM studio_steps WHERE jobId=? AND stage='scenes'",
      t.job.id,
    );
    setPilotCampaignState(t.store, "operator", t.campaign.id, "paused");
    assert.throws(
      () =>
        authorizeStoryReviewEdition(
          t.store,
          "operator",
          t.authorization,
          t.base,
        ),
      /funded pilot/,
    );
    setPilotCampaignState(t.store, "operator", t.campaign.id, "active");
    const candidate = t.read(OPERATOR_EDITORIAL_ACCEPTED_V2_STAGE);
    const unsafe = structuredClone(candidate);
    unsafe.editorialReview.ageAppropriate = false;
    t.store.run(
      "UPDATE studio_steps SET result=? WHERE jobId=? AND stage=?",
      canonical(unsafe),
      t.job.id,
      OPERATOR_EDITORIAL_ACCEPTED_V2_STAGE,
    );
    assert.throws(
      () =>
        authorizeStoryReviewEdition(
          t.store,
          "operator",
          {
            ...t.authorization,
            reviewedCandidateHash: hash(canonical(unsafe)),
          },
          t.base,
        ),
      /Protected source/,
    );
    for (const scores of [
      candidate.editorialReview.scores.slice(1),
      [
        candidate.editorialReview.scores[0],
        ...candidate.editorialReview.scores.slice(0, -1),
      ],
    ]) {
      const malformed = {
        ...candidate,
        editorialReview: { ...candidate.editorialReview, scores },
      };
      t.store.run(
        "UPDATE studio_steps SET result=? WHERE jobId=? AND stage=?",
        canonical(malformed),
        t.job.id,
        OPERATOR_EDITORIAL_ACCEPTED_V2_STAGE,
      );
      assert.throws(
        () =>
          authorizeStoryReviewEdition(
            t.store,
            "operator",
            {
              ...t.authorization,
              reviewedCandidateHash: hash(canonical(malformed)),
            },
            t.base,
          ),
        /complete, unique score/,
      );
    }
    t.store.run(
      "UPDATE studio_steps SET result=? WHERE jobId=? AND stage=?",
      canonical(candidate),
      t.job.id,
      OPERATOR_EDITORIAL_ACCEPTED_V2_STAGE,
    );
    authorizeStoryReviewEdition(t.store, "operator", t.authorization, t.base);
    assert.throws(
      () =>
        authorizeStoryReviewEdition(
          t.store,
          "operator",
          { ...t.authorization, reason: "A different permission or new book" },
          t.base,
        ),
      /immutable/,
    );
    assert.throws(
      () =>
        authorizeDigitalReviewCopy(
          t.store,
          t.job.id,
          "operator",
          "Attempt to waive artwork too",
        ),
      /art-review waiver/,
    );
    assert.equal(
      t.store.all(
        "SELECT stage FROM studio_steps WHERE jobId=? AND stage=?",
        t.job.id,
        STORY_REVIEW_EDITION_STAGE,
      ).length,
      1,
    );
  } finally {
    t.close();
  }
});

test("story-review permission cannot bypass failed illustration checks", async () => {
  const t = await reviewEditionFixture();
  try {
    authorizeStoryReviewEdition(t.store, "operator", t.authorization, t.base);
    t.painter.weak = false;
    t.painter.incorrectArt = true;
    await runStudio(t.store, t.provider, t.config, { jobId: t.job.id });
    assert.equal(
      studioView(t.store, t.job.projectId)!.status,
      "needs_editor",
      JSON.stringify(
        t.store.one("SELECT stage,error FROM studio_jobs WHERE id=?", t.job.id),
      ),
    );
    assert.equal(t.store.all("SELECT id FROM editions").length, 0);
    assert.equal(
      t.store.one(
        "SELECT stage FROM studio_steps WHERE jobId=? AND stage='digital_review_copy_authorization_v1'",
        t.job.id,
      ),
      undefined,
    );
  } finally {
    t.close();
  }
});

test("story-review permission revalidates source before any scene or image work", async () => {
  const t = await reviewEditionFixture();
  try {
    authorizeStoryReviewEdition(t.store, "operator", t.authorization, t.base);
    const before = [...t.painter.calls];
    t.store.run(
      "UPDATE projects SET transcript=? WHERE id=?",
      canonical({ ...t.source, rawText: "Changed source" }),
      t.job.projectId,
    );
    assert.throws(
      () => readStoryReviewEditionAuthorization(t.store, t.job.id),
      /binding changed/,
    );
    await runStudio(t.store, t.provider, t.config, { jobId: t.job.id });
    assert.deepEqual(t.painter.calls, before);
    assert.equal(
      t.store.one(
        "SELECT stage FROM studio_steps WHERE jobId=? AND stage='scenes'",
        t.job.id,
      ),
      undefined,
    );
  } finally {
    t.close();
  }
});

test("story-review permission cannot bypass the final whole-book image gate", async () => {
  const t = await reviewEditionFixture();
  try {
    authorizeStoryReviewEdition(t.store, "operator", t.authorization, t.base);
    t.painter.weak = false;
    t.painter.onStructured = (name) => {
      if (name === "whole_book_sequence_review_v2") {
        t.painter.weakImages = true;
        t.painter.incorrectArt = true;
      }
    };
    await runStudio(t.store, t.provider, t.config, { jobId: t.job.id });
    const job = t.store.one<{ status: string; stage: string }>(
      "SELECT status,stage FROM studio_jobs WHERE id=?",
      t.job.id,
    )!;
    assert.equal(job.status, "needs_editor");
    assert.equal(job.stage, "whole_book_sequence_review_v2");
    assert.equal(t.store.all("SELECT id FROM editions").length, 0);
    assert.equal(
      t.painter.calls.filter((name) => name === "whole_book_sequence_review_v2")
        .length,
      1,
    );
    assert.throws(
      () =>
        authorizeDigitalReviewCopy(
          t.store,
          t.job.id,
          "operator",
          "Attempt to waive the final image gate",
        ),
      /art-review waiver/,
    );
  } finally {
    t.close();
  }
});

async function reviewSlotsFixture() {
  const t = await reviewEditionFixture(2500);
  const story = authorizeStoryReviewEdition(
    t.store,
    "operator",
    t.authorization,
    t.base,
  );
  const scenes = await t.painter.structured("scenes", z.unknown(), "", {});
  t.store.run(
    "INSERT INTO studio_steps VALUES(?, 'scenes', ?, 'completed', ?)",
    t.job.id,
    hash("synthetic scenes"),
    canonical(scenes),
  );
  const reservation = (kind: "text" | "image" = "text", cents = 1) => ({
    version: 1 as const,
    costConfidence: "estimate" as const,
    policyHash: t.campaign.policyHash,
    rateCardVersion: REQUEST_RATE_CARD.version,
    model: t.campaign.policy.models[kind],
    kind,
    reservationCents: cents,
    evidence: { measuredInputBytes: 1, declaredEstimateOnly: 1 },
  });
  let serial = 0;
  const reserve = (
    stage: string,
    kind: "text" | "image" = "text",
    cents = 1,
    store = t.store,
  ) =>
    reservePilotRequest(store, {
      jobId: t.job.id,
      attemptId: `slot-test-${++serial}`,
      stage,
      inputHash: hash(stage),
      reservation: reservation(kind, cents),
    });
  const complete = (attemptId: string) => {
    markPilotDispatched(t.store, attemptId);
    settlePilotRequest(t.store, attemptId, {
      outcome: "completed",
      usageEstimatedCents: 1,
      evidenceHash: hash(attemptId),
      evidenceKind: "provider_usage",
    });
  };
  const before = t.store.one<{ n: number }>(
    "SELECT COUNT(*) n FROM pilot_attempts WHERE creationId=? AND kind='text' AND status!='not_processed'",
    story.creationId,
  )!.n;
  for (let i = before; i < 70; i++)
    complete(reserve(`synthetic_history_${i}`).attempt.id);
  const checkpointId = "synthetic-review-limit",
    checkpointInputHash = hash("review checkpoint");
  t.store.run(
    "INSERT INTO studio_checkpoints VALUES(?,?,?,?,?,?,?,?,NULL)",
    checkpointId,
    t.job.id,
    PILOT_REVIEW_EXTENSION_STAGES[0],
    checkpointInputHash,
    "request_cost",
    "Synthetic quota pause",
    null,
    now(),
  );
  t.store.run(
    "UPDATE studio_jobs SET status='needs_attention',stage=?,leaseToken=NULL,leaseUntil=0 WHERE id=?",
    PILOT_REVIEW_EXTENSION_STAGES[0],
    t.job.id,
  );
  const slotInput = {
    ownerId: "family",
    projectId: t.job.projectId,
    jobId: t.job.id,
    creationId: story.creationId,
    campaignId: t.campaign.id,
    policyHash: t.campaign.policyHash,
    sourceHash: t.authorization.sourceHash,
    manuscriptHash: t.authorization.manuscriptHash,
    profileHash: t.job.profile,
    checkpointId,
    checkpointInputHash,
    scope: "remaining_illustration_reviews_only" as const,
    originalTextLimit: 70 as const,
    maxAdditionalReviews: 18 as const,
    amountCents: 2500 as const,
    reason:
      "Synthetic explicit permission for eighteen named reviews within unchanged funding.",
    approval: {
      quote:
        "I approve these eighteen additional reviews only, with the same amount and image limits.",
      receivedAt: now(),
    },
  };
  return { ...t, slotInput, reserve, complete, reservation };
}

test("review slots require exact operator approval, retain immutable policy, and never resume automatically", async () => {
  const t = await reviewSlotsFixture();
  try {
    const unchanged = canonical(t.store.all("SELECT * FROM pilot_campaigns"));
    assert(PILOT_REVIEW_EXTENSION_STAGES.every((stage) => stage.length <= 64));
    assert.throws(() =>
      authorizePilotReviewSlots(t.store, "family", t.slotInput),
    );
    for (const patch of [
      { sourceHash: hash("wrong") },
      { manuscriptHash: hash("wrong") },
      { profileHash: hash("wrong") },
      { ownerId: "other" },
      { checkpointInputHash: hash("wrong") },
      { maxAdditionalReviews: 19 },
      { amountCents: 2501 },
      { approval: undefined },
    ])
      assert.throws(() =>
        authorizePilotReviewSlots(t.store, "operator", {
          ...t.slotInput,
          ...patch,
        }),
      );
    t.store.run(
      "UPDATE studio_jobs SET leaseToken='busy',leaseUntil=? WHERE id=?",
      Date.now() + 1000,
      t.job.id,
    );
    assert.throws(() =>
      authorizePilotReviewSlots(t.store, "operator", t.slotInput),
    );
    t.store.run(
      "UPDATE studio_jobs SET leaseToken=NULL,leaseUntil=0 WHERE id=?",
      t.job.id,
    );
    const receipt = authorizePilotReviewSlots(t.store, "operator", t.slotInput);
    assert.deepEqual(
      authorizePilotReviewSlots(t.store, "operator", t.slotInput),
      receipt,
    );
    assert.throws(() =>
      authorizePilotReviewSlots(t.store, "operator", {
        ...t.slotInput,
        reason: "Different approval request",
      }),
    );
    assert.equal(
      t.store.one<{ status: string }>(
        "SELECT status FROM studio_jobs WHERE id=?",
        t.job.id,
      )!.status,
      "needs_attention",
    );
    assert.equal(
      canonical(t.store.all("SELECT * FROM pilot_campaigns")),
      unchanged,
    );
    assert.throws(
      () => t.store.run("UPDATE pilot_review_slot_extensions SET body='{}'"),
      /immutable/,
    );
    assert.throws(
      () => t.store.run("DELETE FROM pilot_review_slot_extensions"),
      /append-only/,
    );
    assert.equal(t.store.all("SELECT * FROM pilot_review_slot_uses").length, 0);
  } finally {
    t.close();
  }
});

test("exactly eighteen named review slots share existing money, preserve image caps and require separate scene-eight approval", async () => {
  const t = await reviewSlotsFixture();
  try {
    t.store.run("UPDATE studio_jobs SET status='queued' WHERE id=?", t.job.id);
    assert.throws(
      () => t.reserve(PILOT_REVIEW_EXTENSION_STAGES[0]),
      /request limit/,
    );
    t.store.run(
      "UPDATE studio_jobs SET status='needs_attention' WHERE id=?",
      t.job.id,
    );
    authorizePilotReviewSlots(t.store, "operator", t.slotInput);
    t.store.run("UPDATE studio_jobs SET status='queued' WHERE id=?", t.job.id);
    for (const stage of [
      "draft_4",
      "picture_9_attempt_4_meaning_review_v2",
      "picture_8_authorized_extra_v1_attempt_1_meaning_review_v2",
    ])
      assert.throws(() => t.reserve(stage), /eighteen named/);
    assert.throws(
      () => t.reserve(PILOT_REVIEW_EXTENSION_STAGES[0], "text", 2500),
      /allowance/,
    );
    assert.equal(t.store.all("SELECT * FROM pilot_review_slot_uses").length, 0);
    assert.throws(
      () => t.reserve("picture_8_authorized_extra_v1_requirements_v4_review_1"),
      /separate exact/,
    );
    t.store.run(
      "INSERT INTO studio_steps VALUES(?, 'accepted_picture_meaning_v2_8', ?, 'completed', 'null')",
      t.job.id,
      hash("exhausted"),
    );
    t.store.run(
      "INSERT INTO studio_steps VALUES(?, 'picture_8_attempt_3', ?, 'completed', ?)",
      t.job.id,
      hash("third"),
      canonical(hash("synthetic picture")),
    );
    t.store.run(
      "UPDATE studio_jobs SET status='needs_editor' WHERE id=?",
      t.job.id,
    );
    authorizeSceneAttempt(
      t.store,
      t.job.id,
      "operator",
      8,
      "A separately authorized synthetic scene attempt with stable identities.",
    );
    t.store.run("UPDATE studio_jobs SET status='queued' WHERE id=?", t.job.id);
    for (const stage of PILOT_REVIEW_EXTENSION_STAGES)
      t.complete(t.reserve(stage).attempt.id);
    assert.equal(
      t.store.all("SELECT * FROM pilot_review_slot_uses").length,
      18,
    );
    assert.equal(
      t.store.one<{ n: number }>(
        "SELECT COUNT(*) n FROM pilot_attempts WHERE kind='text'",
      )!.n,
      88,
    );
    assert.throws(
      () => t.reserve(PILOT_REVIEW_EXTENSION_STAGES[0]),
      /saved request/,
    );
    assert.throws(() => t.reserve("another_review"), /eighteen named/);
    for (let i = 0; i < 42; i++)
      t.complete(t.reserve(`synthetic_image_${i}`, "image").attempt.id);
    assert.throws(
      () => t.reserve("synthetic_image_43", "image"),
      /request limit/,
    );
    assert.equal(t.campaign.policy.maxRequests.image, 42);
    assert.equal(t.campaign.policy.maxRequests.text, 70);
  } finally {
    t.close();
  }
});

test("review-slot reservation is atomic across connections and rechecks source before dispatch", async () => {
  const t = await reviewSlotsFixture();
  let second: Store | undefined;
  try {
    authorizePilotReviewSlots(t.store, "operator", t.slotInput);
    t.store.run("UPDATE studio_jobs SET status='queued' WHERE id=?", t.job.id);
    second = new Store(t.store.dir);
    const stage = PILOT_REVIEW_EXTENSION_STAGES[0],
      attempt = t.reserve(stage).attempt;
    assert.deepEqual(
      reservePilotRequest(second, {
        jobId: t.job.id,
        attemptId: attempt.id,
        stage,
        inputHash: hash(stage),
        reservation: t.reservation(),
      }),
      { isNew: false, attempt },
    );
    assert.throws(() => t.reserve(stage, "text", 1, second), /saved request/);
    assert.equal(t.store.all("SELECT * FROM pilot_review_slot_uses").length, 1);
    t.store.run(
      "UPDATE projects SET transcript='{}' WHERE id=?",
      t.job.projectId,
    );
    assert.throws(() => markPilotDispatched(t.store, attempt.id));
    assert.equal(
      t.store.one<{ status: string }>(
        "SELECT status FROM pilot_attempts WHERE id=?",
        attempt.id,
      )!.status,
      "reserved",
    );
  } finally {
    second?.close();
    t.close();
  }
});

test("reconciled base headroom never admits unrelated text and a consumed review slot never reopens", async () => {
  const t = await reviewSlotsFixture();
  try {
    authorizePilotReviewSlots(t.store, "operator", t.slotInput);
    t.store.run("UPDATE studio_jobs SET status='queued' WHERE id=?", t.job.id);
    // Model an independently verified no-processing reconciliation of an old base request.
    t.store.run(
      "UPDATE pilot_attempts SET status='not_processed' WHERE stage='synthetic_history_69'",
    );
    assert.throws(() => t.reserve("draft_4"), /eighteen named/);
    const stage = PILOT_REVIEW_EXTENSION_STAGES[0],
      attempt = t.reserve(stage).attempt;
    settlePilotRequest(t.store, attempt.id, {
      outcome: "not_processed",
      evidenceHash: hash("verified no dispatch"),
      evidenceKind: "local_pre_dispatch",
    });
    assert.throws(() => t.reserve(stage), /already been consumed/);
    assert.equal(t.store.all("SELECT * FROM pilot_review_slot_uses").length, 1);
  } finally {
    t.close();
  }
});

async function revalidationFixture(defect = "none") {
  const t = await reviewEditionFixture(2500);
  const story = authorizeStoryReviewEdition(
    t.store,
    "operator",
    t.authorization,
    t.base,
  );
  const original = t.painter.structured.bind(t.painter);
  let filled = false;
  t.painter.onStructured = (name) => {
    t.painter.incorrectArt = name.startsWith("picture_9_");
    if (name !== "picture_9_requirements_v4_review_3" || filled) return;
    filled = true;
    const count = t.store.one<{ n: number }>(
      "SELECT COUNT(*) n FROM pilot_attempts WHERE creationId=? AND kind='text' AND status!='not_processed'",
      story.creationId,
    )!.n;
    for (let i = count; i < 70; i++) {
      const attemptId = `synthetic-review-history-${i}`;
      reservePilotRequest(t.store, {
        jobId: t.job.id,
        attemptId,
        stage: attemptId,
        inputHash: hash(attemptId),
        reservation: {
          version: 1,
          costConfidence: "estimate",
          policyHash: t.campaign.policyHash,
          rateCardVersion: REQUEST_RATE_CARD.version,
          model: t.campaign.policy.models.text,
          kind: "text",
          reservationCents: 1,
          evidence: { declaredEstimateOnly: 1 },
        },
      });
      markPilotDispatched(t.store, attemptId);
      settlePilotRequest(t.store, attemptId, {
        outcome: "completed",
        usageEstimatedCents: 1,
        evidenceKind: "provider_usage",
        evidenceHash: hash(attemptId),
      });
    }
  };
  t.painter.structured = async (name, schema, instructions, data, images) => {
    const result = await original(name, schema, instructions, data, images);
    if (
      name.startsWith("picture_9_") &&
      (name.endsWith("_meaning_review_v2") ||
        name === SCENE_REVALIDATION_REVIEW)
    ) {
      const isNew = name === SCENE_REVALIDATION_REVIEW;
      return schema.parse({
        ...result,
        visibleCharacterIds: (data as { expectedCharacterIds: string[] })
          .expectedCharacterIds,
        actionReadable: isNew && defect !== "action",
        identityConsistent: !isNew || defect !== "identity",
        physicalCoherence: !isNew || defect !== "physical",
        unexpectedForegroundCharacters:
          isNew && defect === "extra" ? ["unapproved family member"] : [],
        protectedContradictions:
          isNew && defect === "facts"
            ? [{ nuggetId: "n1", evidence: "Synthetic visible contradiction" }]
            : [],
      });
    }
    return result;
  };
  await runStudio(t.store, t.provider, t.config, { jobId: t.job.id });
  assert.equal(studioView(t.store, t.job.projectId)!.status, "needs_attention");
  const checkpoint = t.store.one<{ id: string; inputHash: string }>(
    "SELECT id,inputHash FROM studio_checkpoints WHERE jobId=? AND resumedAt IS NULL ORDER BY rowid DESC LIMIT 1",
    t.job.id,
  )!;
  authorizePilotReviewSlots(t.store, "operator", {
    ...Object.fromEntries(
      Object.entries(story).filter(([key]) =>
        [
          "ownerId",
          "projectId",
          "jobId",
          "creationId",
          "campaignId",
          "policyHash",
          "sourceHash",
          "manuscriptHash",
          "profileHash",
        ].includes(key),
      ),
    ),
    checkpointId: checkpoint.id,
    checkpointInputHash: checkpoint.inputHash,
    scope: "remaining_illustration_reviews_only",
    originalTextLimit: 70,
    maxAdditionalReviews: 18,
    amountCents: 2500,
    reason: "Synthetic remaining-review approval",
    approval: {
      quote: "I approve the eighteen specified reviews.",
      receivedAt: now(),
    },
  });
  resumeStudio(
    t.store,
    t.store.one<ProjectRow>(
      "SELECT * FROM projects WHERE id=?",
      t.job.projectId,
    )!,
    {
      jobId: t.job.id,
      callId: checkpoint.id,
      acknowledgePossibleCharge: false,
    },
    t.config,
  );
  await runStudio(t.store, t.provider, t.config, { jobId: t.job.id });
  assert.equal(studioView(t.store, t.job.projectId)!.status, "needs_editor");
  const imageHash = t.read("picture_9_attempt_3");
  const input = {
    ...Object.fromEntries(
      Object.entries(story).filter(([key]) =>
        [
          "ownerId",
          "projectId",
          "jobId",
          "creationId",
          "campaignId",
          "policyHash",
          "sourceHash",
          "manuscriptHash",
          "profileHash",
        ].includes(key),
      ),
    ),
    imageHash,
    meaningReviewHash: hash(
      canonical(t.read("picture_9_attempt_3_meaning_review_v2")),
    ),
    requirementsReviewHash: hash(
      canonical(t.read("picture_9_requirements_v4_review_3")),
    ),
    spread: 9,
    scope: "existing_image_staging_revalidation_only",
    additionalReviews: 1,
    additionalImages: 0,
    amountCents: 2500,
    instruction:
      "Keep relatives off-frame; the open seat and welcoming gesture convey the family invitation. Preserve required identities and action.",
    reason:
      "One explicitly approved existing-image staging revalidation, with no new render.",
    approval: {
      quote:
        "I approve one check of this existing image with the family off-frame, without a new image.",
      receivedAt: now(),
    },
  };
  return { ...t, revalidationInput: input };
}

for (const defect of [
  "none",
  "identity",
  "physical",
  "facts",
  "extra",
  "action",
])
  test(`one existing-image revalidation retains every material gate (${defect})`, async () => {
    const t = await revalidationFixture(defect);
    try {
      const retained = t.store.all<{
        stage: string;
        inputHash: string;
        state: string;
        result: string;
      }>(
        "SELECT stage,inputHash,state,result FROM studio_steps WHERE jobId=? AND state='completed' ORDER BY stage",
        t.job.id,
      );
      const beforeImages = t.painter.imagePrompts.length,
        beforeCalls = t.painter.calls.length;
      const oldExtension = canonical(
        t.store.all("SELECT * FROM pilot_review_slot_extensions"),
      );
      const receipt = authorizeSceneRevalidation(
        t.store,
        "operator",
        t.revalidationInput,
      );
      await runStudio(t.store, t.provider, t.config, { jobId: t.job.id });
      assert.equal(t.painter.imagePrompts.length, beforeImages);
      const newCalls = t.painter.calls.slice(beforeCalls);
      assert.equal(
        newCalls.filter((name) => name === SCENE_REVALIDATION_REVIEW).length,
        1,
      );
      assert(
        newCalls.every(
          (name) =>
            name === SCENE_REVALIDATION_REVIEW ||
            name.startsWith("whole_book_sequence_"),
        ),
      );
      assert.equal(
        canonical(t.store.all("SELECT * FROM pilot_review_slot_extensions")),
        oldExtension,
      );
      for (const row of retained)
        assert.deepEqual(
          t.store.one(
            "SELECT stage,inputHash,state,result FROM studio_steps WHERE jobId=? AND stage=?",
            t.job.id,
            row.stage,
          ),
          row,
        );
      assert.equal(
        studioView(t.store, t.job.projectId)!.status,
        defect === "none" ? "complete" : "needs_editor",
      );
      if (defect === "none") {
        const book = Book.parse(
          JSON.parse(
            t.store.one<{ book: string }>("SELECT book FROM editions")!.book,
          ),
        );
        assert.equal(book.spreads[8].artHash, t.revalidationInput.imageHash);
        const sequence = t.seen.find(
          (x) => x.name === "whole_book_sequence_review_v2",
        )!.data as {
          authorizedStagingBySpread: { spread: number; imageHash: string }[];
        };
        assert.equal(
          sequence.authorizedStagingBySpread.find((x) => x.spread === 9)!
            .imageHash,
          t.revalidationInput.imageHash,
        );
      } else assert.equal(t.read(SCENE_REVALIDATION_ACCEPTED), null);
      const count = t.painter.calls.length;
      assert.deepEqual(
        authorizeSceneRevalidation(t.store, "operator", t.revalidationInput),
        receipt,
      );
      if (defect !== "none") {
        t.store.run(
          "UPDATE studio_jobs SET status='queued' WHERE id=?",
          t.job.id,
        );
        await runStudio(t.store, t.provider, t.config, { jobId: t.job.id });
      }
      assert.equal(t.painter.calls.length, count);
    } finally {
      t.close();
    }
  });

test("existing-image authorization rejects changed scope and stale evidence before any review", async () => {
  const t = await revalidationFixture();
  try {
    const before = t.painter.calls.length;
    assert.throws(() =>
      authorizeSceneRevalidation(t.store, "family", t.revalidationInput),
    );
    for (const patch of [
      { sourceHash: hash("bad") },
      { imageHash: hash("bad") },
      { meaningReviewHash: hash("bad") },
      { requirementsReviewHash: hash("bad") },
      { campaignId: "other" },
      { spread: 8 },
      { additionalImages: 1 },
      { approval: undefined },
    ])
      assert.throws(() =>
        authorizeSceneRevalidation(t.store, "operator", {
          ...t.revalidationInput,
          ...patch,
        }),
      );
    const record = authorizeSceneRevalidation(
      t.store,
      "operator",
      t.revalidationInput,
    );
    assert.equal(readSceneRevalidation(t.store, t.job.id)!.id, record.id);
    assert.throws(() =>
      authorizeSceneRevalidation(t.store, "operator", {
        ...t.revalidationInput,
        instruction: "Different approved instruction for this image.",
      }),
    );
    assert.throws(
      () => t.store.run("UPDATE pilot_scene_revalidations SET body='{}'"),
      /immutable/,
    );
    t.store.run(
      "UPDATE projects SET transcript='{}' WHERE id=?",
      t.job.projectId,
    );
    await runStudio(t.store, t.provider, t.config, { jobId: t.job.id });
    assert.equal(t.painter.calls.length, before);
  } finally {
    t.close();
  }
});
