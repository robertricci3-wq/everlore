import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
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
} from "../src/server/pilot/service.js";
import { FAMILY_CONSENT_VERSION } from "../src/shared/journey.js";
import { runStudio, studioView } from "../src/server/engine/studio.js";
import { requestStudioPause } from "../src/server/engine/budget.js";
import { resumeStudio, studioRecovery } from "../src/server/engine/recovery.js";
import {
  applyOperatorEditorialRevision,
  readOperatorEditorialRevision,
  OPERATOR_EDITORIAL_REVISION_STAGE,
} from "../src/server/engine/operator-editorial-revision.js";
import {
  StudioFake,
  fixtureHeart,
  fixtureSource,
} from "./support/studio-fixtures.js";

// Synthetic source and injected transport only; the real request ledger still runs.
async function fixture() {
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
    totalCents: 10000,
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
