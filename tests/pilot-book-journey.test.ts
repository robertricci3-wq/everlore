import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { z } from "zod";
import { createApp } from "../src/server/app.js";
import { Store, hash, now, type ProjectRow } from "../src/server/store.js";
import { engineConfig, OpenAIProvider } from "../src/server/engine/provider.js";
import { advanceCreationRequest } from "../src/server/almanac/journey.js";
import { runInterviewTranscription } from "../src/server/almanac/transcription.js";
import { latestStudio, runStudio } from "../src/server/engine/studio.js";
import { resumeStudio, studioRecovery } from "../src/server/engine/recovery.js";
import { renderPdf } from "../src/server/layout.js";
import { setOperator } from "../src/server/access.js";
import {
  runPilotTick,
  scopedPilotConfig,
} from "../src/server/pilot/integration.js";
import {
  makePilotPolicy,
  createPilotCampaign,
  authorizePilotCampaign,
  issuePilotInvitation,
  redeemPilotInvitation,
  pilotCampaignSummary,
  setPilotCampaignState,
} from "../src/server/pilot/service.js";
import {
  FAMILY_CONSENT_VERSION,
  type JourneyView,
} from "../src/shared/journey.js";
import {
  Book,
  type BookDocument,
  type ProjectView,
} from "../src/shared/contracts.js";
import {
  StudioFake,
  fixtureHeart,
  fixtureSource,
} from "./support/studio-fixtures.js";

// This is real application orchestration with scripted model responses and
// synthetic pixel squares. It proves recovery and delivery, never live model
// access, artistic quality, speech accuracy, print readiness or child response.
class PilotFixtureProvider extends StudioFake {
  override async structured<T>(
    name: string,
    schema: z.ZodType<T>,
    instructions: string,
    data: unknown,
    images: Buffer[] = [],
  ): Promise<T> {
    if (name === "heart") {
      this.calls.push(name);
      return schema.parse({
        ...fixtureHeart,
        nuggets: fixtureHeart.nuggets.map((nugget) => ({
          ...nugget,
          sourceId: "t1-s1",
        })),
      });
    }
    // Force a genuine bounded art correction in the first scene, then let the
    // next result pass the unchanged rubric. Failed pixels/critique stay saved.
    this.weakImages = name === "picture_1_requirements_v4_review_1";
    try {
      return await super.structured(name, schema, instructions, data, images);
    } finally {
      this.weakImages = false;
    }
  }
}
const consent = {
  consent: true,
  consentVersion: FAMILY_CONSENT_VERSION,
  processWithOpenAI: true,
  imaginativeAdaptation: true,
} as const;

function wav(seed: number) {
  const bytes = Buffer.alloc(48);
  bytes.write("RIFF");
  bytes.writeUInt32LE(40, 4);
  bytes.write("WAVE", 8);
  bytes.write("fmt ", 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(4, 40);
  bytes.writeUInt16LE(seed, 44);
  return bytes;
}
async function fixture(
  configOverrides: Partial<ReturnType<typeof engineConfig>> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "everlore-pilot-complete-"));
  const config = {
    ...engineConfig({}),
    enabled: true,
    apiKey: "offline-never-sent",
    strictCostGuard: false,
    budgetCents: 100000,
    audioReserve: 100,
    textReserve: 100,
    imageReserve: 100,
    ...configOverrides,
  };
  let store = new Store(dir),
    server: Server,
    base = "";
  for (const owner of ["family", "other-family"])
    store.run(
      "INSERT INTO users VALUES(?,?,?,'private',?)",
      owner,
      owner,
      "unused",
      now(),
    );
  for (const owner of ["family", "other-family"])
    store.run(
      "INSERT INTO sessions VALUES(?,?,?)",
      hash(`${owner}-session`),
      owner,
      Date.now() + 600000,
    );
  async function listen() {
    const app = createApp(
      store,
      config,
      async () => {
        throw new Error("Unexpected external request");
      },
      null,
    );
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  }
  await listen();
  return {
    get store() {
      return store;
    },
    config,
    async request(path: string, body?: unknown, owner = "family") {
      const audio = body instanceof Uint8Array;
      return fetch(base + path, {
        method: body === undefined ? "GET" : audio ? "PUT" : "POST",
        headers: {
          "X-Evermore-Client": "1",
          Cookie: `evermore=${owner}-session`,
          "Content-Type": audio ? "audio/wav" : "application/json",
          "X-Capture-Mode": "microphone",
        },
        ...(body === undefined
          ? {}
          : { body: audio ? new Uint8Array(body) : JSON.stringify(body) }),
      });
    },
    async restart() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      store = new Store(dir);
      await listen();
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const checkpoint of [false, true]) {
  test(`voice pilot delivers twelve images and an immutable PDF ${checkpoint ? "after a safe art checkpoint" : "without routine creative approval"}`, async () => {
    const t = await fixture();
    const painter = new PilotFixtureProvider();
    const audioCalls: { bytes: string; text: string }[] = [];
    const tellings = [
      fixtureSource,
      "I still remember the quiet doorway. This second recording is synthetic.",
    ];
    const transcriber = new OpenAIProvider(t.config, async (url, init) => {
      assert.equal(
        String(url),
        "https://api.openai.com/v1/audio/transcriptions",
      );
      assert(init?.body instanceof FormData);
      const file = init.body.get("file");
      assert(file instanceof Blob);
      const text = tellings[audioCalls.length];
      assert(text, "A completed recording must never be transcribed twice.");
      audioCalls.push({
        bytes: hash(new Uint8Array(await file.arrayBuffer())),
        text,
      });
      return Response.json(
        { text },
        { headers: { "x-request-id": `fixture-audio-${audioCalls.length}` } },
      );
    });
    try {
      const started = await t.request("/journey/start", {
        key: "record",
        ...consent,
      });
      assert.equal(started.status, 201);
      const { session: initial } = await started.json();
      const session = initial.session;
      const first = session.turns[0];
      const firstAudio = wav(1),
        secondAudio = wav(2);
      const firstPath = `/interviews/${session.id}/turns/${first.id}/audio`;
      assert.equal((await t.request(firstPath, firstAudio)).status, 200);
      // A response lost after upload is safe to replay; bytes cannot be replaced.
      assert.equal((await t.request(firstPath, firstAudio)).status, 200);
      await t.restart();
      assert.equal(
        hash(new Uint8Array(await (await t.request(firstPath)).arrayBuffer())),
        hash(firstAudio),
      );
      const secondResponse = await t.request(`/journey/${session.id}/turns`, {
        key: "one-more",
        promptId: "additional-memory",
      });
      assert.equal(secondResponse.status, 201);
      const second = await secondResponse.json();
      const secondPath = `/interviews/${session.id}/turns/${second.id}/audio`;
      assert.equal((await t.request(secondPath, secondAudio)).status, 200);
      assert.equal(t.store.all("SELECT id FROM studio_jobs").length, 0);

      const createPath = `/journey/${session.id}/create`;
      const creation = await t.request(createPath, { key: "make", ...consent });
      assert.equal(creation.status, 202);
      const requested = (await creation.json()) as JourneyView;
      assert.equal(
        (
          await (
            await t.request(createPath, { key: "repeated-click", ...consent })
          ).json()
        ).requestId,
        requested.requestId,
      );
      await t.restart();
      advanceCreationRequest(t.store, t.config);
      assert.equal(
        await runInterviewTranscription(t.store, transcriber, t.config),
        true,
      );
      await t.restart();
      advanceCreationRequest(t.store, t.config);
      assert.equal(
        await runInterviewTranscription(t.store, transcriber, t.config),
        true,
      );
      advanceCreationRequest(t.store, t.config);
      const journey = (await (
        await t.request(`/journey/${session.id}`)
      ).json()) as JourneyView;
      assert(journey.projectId);
      assert.equal(journey.status, "creating");
      assert.deepEqual(
        audioCalls.map((call) => call.bytes),
        [hash(firstAudio), hash(secondAudio)],
      );
      const job = latestStudio(t.store, journey.projectId)!;
      const request = JSON.parse(job.request);
      assert.equal(request.autonomous, true);
      const frozen = t.store.one<{ body: string }>(
        "SELECT body FROM almanac_sources",
      )!.body;
      assert.equal(JSON.parse(frozen).turns.length, 2);

      const shouldContinue = () =>
        !checkpoint ||
        !t.store.one(
          "SELECT result FROM studio_steps WHERE jobId=? AND stage='accepted_picture_meaning_v2_1' AND state='completed'",
          job.id,
        );
      await runStudio(t.store, painter, t.config, { shouldContinue });
      if (checkpoint) {
        const paused = latestStudio(t.store, journey.projectId)!;
        assert.equal(paused.status, "needs_attention", paused.error ?? "");
        const recovery = studioRecovery(t.store, job.id)!;
        assert(recovery?.preDispatch);
        assert.equal(recovery.uncertain, false);
        const completed = t.store.all<{ stage: string; result: string }>(
          "SELECT stage,result FROM studio_steps WHERE jobId=? AND state='completed' ORDER BY stage",
          job.id,
        );
        const requestsBefore = t.store.all<{ stage: string }>(
          "SELECT stage FROM studio_calls WHERE jobId=?",
          job.id,
        );
        await t.restart();
        const p = t.store.one<ProjectRow>(
          "SELECT * FROM projects WHERE id=?",
          journey.projectId,
        )!;
        const answer = {
          jobId: job.id,
          callId: recovery.callId,
          acknowledgePossibleCharge: false,
        };
        resumeStudio(t.store, p, answer, t.config);
        resumeStudio(t.store, p, answer, t.config);
        await runStudio(t.store, painter, t.config);
        for (const old of completed)
          assert.equal(
            t.store.one<{ result: string }>(
              "SELECT result FROM studio_steps WHERE jobId=? AND stage=?",
              job.id,
              old.stage,
            )!.result,
            old.result,
          );
        for (const old of requestsBefore)
          assert.equal(
            t.store.all(
              "SELECT id FROM studio_calls WHERE jobId=? AND stage=?",
              job.id,
              old.stage,
            ).length,
            1,
          );
      }
      const finished = latestStudio(t.store, journey.projectId)!;
      assert.equal(
        finished.status,
        "complete",
        finished.error ?? finished.stage,
      );
      advanceCreationRequest(t.store, t.config);
      const ready = (await (
        await t.request(`/journey/${session.id}`)
      ).json()) as JourneyView;
      assert.equal(ready.status, "ready");
      assert.equal(ready.bookReady, true);
      const project = (await (
        await t.request(`/projects/${journey.projectId}`)
      ).json()) as ProjectView;
      const book = Book.parse(project.book);
      assert.equal(book.spreads.length, 12);
      const words = book.spreads.flatMap((spread) =>
        spread.text.trim().split(/\s+/),
      ).length;
      assert(words >= 250 && words <= 450, `Word count ${words}`);
      assert(
        book.production?.world.characters.every(
          (character) => character.species === "beaver",
        ),
      );
      assert.equal(book.production?.automation, "autonomous");
      assert(book.production?.familyVersionId);
      assert.equal(t.store.all("SELECT id FROM family_versions").length, 1);
      assert.equal(book.production?.references.length, 2);
      assert.equal(
        new Set(book.spreads.map((spread) => spread.artHash)).size,
        12,
      );
      for (const spread of book.spreads) {
        const image = await t.request(
          `/projects/${journey.projectId}/art/${spread.artHash}`,
        );
        assert.equal(image.status, 200);
        const bytes = new Uint8Array(await image.arrayBuffer());
        assert.equal(hash(bytes), spread.artHash);
        const dimensions = await sharp(bytes).metadata();
        assert.equal(dimensions.width, 1024);
        assert.equal(dimensions.height, 1024);
      }
      assert.equal(
        t.store.all(
          "SELECT stage FROM studio_steps WHERE jobId=? AND stage LIKE 'picture_1_attempt_%'",
          job.id,
        ).length,
        2,
      );
      assert(painter.imageReferenceCounts.slice(1).every((count) => count > 0));
      assert.equal(project.editions.length, 1);
      const edition = project.editions[0];
      const saved = (await (
        await t.request(`/projects/${journey.projectId}/editions/${edition.id}`)
      ).json()) as { book: BookDocument };
      assert.deepEqual(saved.book, book);
      const pdfResponse = await t.request(
        `/projects/${journey.projectId}/editions/${edition.id}/pdf`,
      );
      assert.equal(pdfResponse.status, 200);
      const pdfBytes = new Uint8Array(await pdfResponse.arrayBuffer());
      assert.equal(hash(pdfBytes), edition.pdfHash);
      assert.equal(
        hash(await renderPdf(book, t.store, journey.projectId)),
        edition.pdfHash,
      );
      const pdf = await PDFDocument.load(pdfBytes);
      // Cover + twelve spreads + The True Parts + the preserved colophon.
      assert.equal(pdf.getPageCount(), 15);
      assert(pdf.getSubject()?.includes(book.contentHash));
      assert.equal(
        (await t.request(firstPath, undefined, "other-family")).status,
        404,
      );
      assert.equal(
        (
          await t.request(
            `/projects/${journey.projectId}`,
            undefined,
            "other-family",
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await t.request(
            `/projects/${journey.projectId}/editions/${edition.id}/pdf`,
            undefined,
            "other-family",
          )
        ).status,
        404,
      );

      const counted = painter.calls.length;
      const receipts = t.store.all("SELECT * FROM studio_calls ORDER BY rowid");
      await t.restart();
      assert.equal(
        (
          await (
            await t.request(createPath, { key: "after-finish", ...consent })
          ).json()
        ).requestId,
        requested.requestId,
      );
      advanceCreationRequest(t.store, t.config);
      assert.equal(
        await runInterviewTranscription(t.store, transcriber, t.config),
        false,
      );
      assert.equal(await runStudio(t.store, painter, t.config), false);
      assert.equal(painter.calls.length, counted);
      assert.equal(audioCalls.length, 2);
      assert.deepEqual(
        t.store.all("SELECT * FROM studio_calls ORDER BY rowid"),
        receipts,
      );
      assert.equal(
        t.store.one<{ body: string }>("SELECT body FROM almanac_sources")!.body,
        frozen,
      );
      assert.equal(
        t.store.all("SELECT id FROM almanac_creation_requests").length,
        1,
      );
      assert.equal(t.store.all("SELECT id FROM editions").length, 1);
      assert.equal(t.store.all("SELECT id FROM book_orders").length, 0);
      assert.equal(
        t.store.all("SELECT id FROM studio_calls WHERE status!='completed'")
          .length,
        0,
      );
    } finally {
      await t.close();
    }
  });
}

function preserveLegacyQueues(s: Store) {
  for (const [jobId, projectId, allowance] of [
    ["rosa-job", "rosa-fixture", 7500],
    ["lab-job", "lab-fixture", 0],
  ] as const) {
    s.run(
      "INSERT INTO projects VALUES(?,?,?,?,?,0,NULL,?,?)",
      projectId,
      "other-family",
      "Separate synthetic authorization",
      "unavailable",
      "creating_legacy",
      now(),
      now(),
    );
    s.run(
      "INSERT INTO studio_jobs(id,projectId,baseRevision,kind,status,stage,request,state,profile,allowance,createdAt) VALUES(?,?,0,'generation','queued','heart','{}','{}',?,?,?)",
      jobId,
      projectId,
      hash(jobId),
      allowance,
      now(),
    );
  }
  s.run("INSERT INTO engine_budget VALUES('rosa-job',7500,?)", now());
  s.run(
    "INSERT INTO lab_experiments(id,ownerId,plan,planHash,status,createdAt) VALUES('separate-lab','other-family','{}',?,'queued',?)",
    hash("lab-policy"),
    now(),
  );
  s.run(
    "INSERT INTO lab_runs(id,experimentId,caseId,replicate,arm,side,status,projectId,jobId) VALUES('separate-lab-run','separate-lab','synthetic',1,'baseline','left','queued','lab-fixture','lab-job')",
  );
  return {
    jobs: s.all("SELECT * FROM studio_jobs ORDER BY id"),
    budget: s.all("SELECT * FROM engine_budget"),
    lab: s.all("SELECT * FROM lab_runs"),
  };
}
function pilotInvitation(
  t: Awaited<ReturnType<typeof fixture>>,
  totalCents = 25000,
) {
  setOperator(t.store, "other-family");
  const campaign = createPilotCampaign(t.store, "other-family", {
    key: "synthetic-campaign",
    totalCents,
    maxHouseholds: 5,
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
  assert.equal(campaign.state, "draft");
  assert.throws(() =>
    issuePilotInvitation(t.store, "other-family", campaign.id, {
      key: "before-authorization",
      label: "Synthetic family",
    }),
  );
  const authorized = authorizePilotCampaign(
    t.store,
    "other-family",
    campaign.id,
    {
      authorizationReference:
        "Synthetic test authorization only; no live spending",
      acknowledgeEstimatedCosts: true,
    },
  );
  const invitation = issuePilotInvitation(
    t.store,
    "other-family",
    campaign.id,
    { key: "invitation", label: "Synthetic family", expiresDays: 7 },
  );
  assert(invitation.code);
  assert.equal(redeemPilotInvitation(t.store, invitation.code, "family"), true);
  assert.equal(redeemPilotInvitation(t.store, invitation.code, "family"), true);
  return authorized;
}
async function pilotRecording(t: Awaited<ReturnType<typeof fixture>>) {
  const started = await (
    await t.request("/journey/start", { key: "pilot-record", ...consent })
  ).json();
  const session = started.session.session;
  const path = `/interviews/${session.id}/turns/${session.turns[0].id}/audio`;
  assert.equal((await t.request(path, wav(3))).status, 200);
  const response = await t.request(`/journey/${session.id}/create`, {
    key: "pilot-make",
    ...consent,
  });
  assert.equal(
    response.status,
    202,
    JSON.stringify(await response.clone().json()),
  );
  return { session, path, request: (await response.json()) as JourneyView };
}

/** The actual OpenAI adapter serializes and prices every request. Only its HTTP
 * transport is replaced, so both strict-audio and estimated-pilot guards run. */
function pilotTransport(
  s: () => Store,
  painter: PilotFixtureProvider,
  fault?: "ambiguous" | "rejected",
) {
  const sent: string[] = [];
  const request: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    sent.push(path);
    const outstanding = s().all<{ id: string }>(
      "SELECT id FROM pilot_attempts WHERE status='dispatched'",
    );
    assert.equal(
      outstanding.length,
      1,
      "Every transport dispatch needs one durable pilot reservation first.",
    );
    if (fault === "ambiguous")
      throw new Error("Synthetic lost provider response");
    if (fault === "rejected")
      return Response.json(
        { error: { message: "Synthetic rejection", code: "invalid_api_key" } },
        { status: 401 },
      );
    const headers = { "x-request-id": `fixture-provider-${sent.length}` };
    if (path.endsWith("/audio/transcriptions"))
      return Response.json({ text: fixtureSource }, { headers });
    if (path.endsWith("/responses")) {
      assert.equal(typeof init?.body, "string");
      const body = JSON.parse(init!.body as string);
      const content = body.input[0].content as {
        type: string;
        text?: string;
        image_url?: string;
      }[];
      const data = JSON.parse(content[0].text!);
      const pictures = content
        .filter((item) => item.type === "input_image")
        .map((item) => Buffer.from(item.image_url!.split(",")[1], "base64"));
      const result = await painter.structured(
        body.text.format.name,
        z.unknown(),
        body.instructions,
        data,
        pictures,
      );
      return Response.json(
        {
          status: "completed",
          usage: { input_tokens: 200, output_tokens: 80 },
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: JSON.stringify(result) }],
            },
          ],
        },
        { headers },
      );
    }
    assert(
      path.endsWith("/images/edits") || path.endsWith("/images/generations"),
    );
    let prompt: string, refs: Buffer[] | undefined;
    if (init?.body instanceof FormData) {
      prompt = String(init.body.get("prompt"));
      refs = await Promise.all(
        init.body.getAll("image[]").map(async (item) => {
          assert(item instanceof Blob);
          return Buffer.from(await item.arrayBuffer());
        }),
      );
    } else {
      prompt = JSON.parse(String(init?.body)).prompt;
    }
    const pixels = await painter.image(prompt, refs);
    return Response.json(
      {
        data: [{ b64_json: pixels.toString("base64") }],
        usage: {
          input_tokens: 100,
          input_tokens_details: { text_tokens: 80, image_tokens: 20 },
          output_tokens: 7000,
        },
      },
      { headers },
    );
  };
  return { request, sent };
}

test("the separate invited pilot resumes expired worker leases and completes a book while Rosa and Lab remain untouched", async () => {
  const previous = process.env.EVERLORE_PILOT_WORKER;
  process.env.EVERLORE_PILOT_WORKER = "1";
  const t = await fixture({
    enabled: false,
    strictCostGuard: true,
    budgetCents: 7500,
  });
  try {
    const legacy = preserveLegacyQueues(t.store);
    const campaign = pilotInvitation(t);
    const captured = await pilotRecording(t);
    assert.equal(captured.request.status, "transcribing");
    assert.equal(t.store.all("SELECT * FROM pilot_creations").length, 1);
    setPilotCampaignState(t.store, "other-family", campaign.id, "paused");
    assert.equal(
      await runPilotTick(t.store, t.config, () => {
        throw new Error("Paused campaigns cannot dispatch");
      }),
      false,
    );
    setPilotCampaignState(t.store, "other-family", campaign.id, "active");
    const painter = new PilotFixtureProvider();
    const transport = pilotTransport(() => t.store, painter);
    const factory = (config: ReturnType<typeof engineConfig>) =>
      new OpenAIProvider(config, transport.request);
    assert(captured.request.requestId);
    advanceCreationRequest(
      t.store,
      scopedPilotConfig(t.config, campaign, captured.request.requestId),
      { creationId: captured.request.requestId },
    );
    const audioJob = t.store.one<{ id: string }>(
      "SELECT j.id FROM studio_jobs j JOIN pilot_jobs p ON p.jobId=j.id WHERE j.kind='interview_transcription'",
    );
    assert(audioJob);
    // A still-owned worker lease is not stealable. A process dying before
    // dispatch can be reclaimed after its lease expires, with no paid replay.
    t.store.run(
      "UPDATE studio_jobs SET status='running',leaseToken='old-worker',leaseUntil=? WHERE id=?",
      Date.now() + 60000,
      audioJob.id,
    );
    assert.equal(await runPilotTick(t.store, t.config, factory), false);
    assert.equal(transport.sent.length, 0);
    t.store.run(
      "UPDATE studio_jobs SET leaseUntil=? WHERE id=?",
      Date.now() - 1,
      audioJob.id,
    );
    await t.restart();
    assert.equal(await runPilotTick(t.store, t.config, factory), true);
    assert.equal(transport.sent.length, 1);
    advanceCreationRequest(
      t.store,
      scopedPilotConfig(t.config, campaign, captured.request.requestId),
      { creationId: captured.request.requestId },
    );
    const artJob = t.store.one<{ id: string }>(
      "SELECT j.id FROM studio_jobs j JOIN pilot_jobs p ON p.jobId=j.id WHERE j.kind!='interview_transcription'",
    );
    assert(artJob);
    t.store.run(
      "UPDATE studio_jobs SET status='running',leaseToken='old-worker',leaseUntil=? WHERE id=?",
      Date.now() - 1,
      artJob.id,
    );
    await t.restart();
    for (let tick = 0; tick < 8; tick++) {
      await runPilotTick(t.store, t.config, factory);
      const view = (await (
        await t.request(`/journey/${captured.session.id}`)
      ).json()) as JourneyView;
      if (view.status === "ready") break;
      assert.notEqual(
        view.status,
        "paused",
        JSON.stringify(
          t.store.all(
            "SELECT status,stage,error FROM studio_jobs WHERE id NOT IN ('rosa-job','lab-job')",
          ),
        ),
      );
    }
    const ready = (await (
      await t.request(`/journey/${captured.session.id}`)
    ).json()) as JourneyView;
    assert.equal(ready.status, "ready", JSON.stringify(ready));
    assert(ready.projectId);
    const project = (await (
      await t.request(`/projects/${ready.projectId}`)
    ).json()) as ProjectView;
    assert.equal(project.book?.spreads.length, 12);
    assert.equal(project.editions.length, 1);
    const pdf = await t.request(
      `/projects/${ready.projectId}/editions/${project.editions[0].id}/pdf`,
    );
    assert.equal(pdf.status, 200);
    assert.equal(
      hash(new Uint8Array(await pdf.arrayBuffer())),
      project.editions[0].pdfHash,
    );
    const summary = pilotCampaignSummary(t.store, "other-family", campaign.id);
    assert.equal(summary.costConfidence, "estimate");
    assert.equal(summary.verifiedBilledCents, null);
    assert(
      summary.accountedCents > 0 &&
        summary.accountedCents <= campaign.totalCents,
    );
    assert.equal(summary.attempts.length, transport.sent.length);
    assert(
      summary.attempts.every(
        (attempt) =>
          attempt.status === "completed" &&
          attempt.reservedCents > 0 &&
          attempt.policyHash === campaign.policyHash,
      ),
    );
    assert.equal(
      summary.attempts.filter((attempt) => attempt.kind === "audio").length,
      1,
    );
    assert.equal(
      summary.attempts.filter((attempt) => attempt.kind === "image").length,
      15,
    );
    assert(
      summary.attempts
        .filter((attempt) => attempt.kind === "image")
        .every((attempt) => attempt.usageEstimatedCents !== null),
    );
    assert.equal(t.store.all("SELECT * FROM studio_image_renders").length, 15);
    assert.equal(summary.ambiguousAttempts, 0);
    assert.deepEqual(
      t.store.all(
        "SELECT * FROM studio_jobs WHERE id IN ('rosa-job','lab-job') ORDER BY id",
      ),
      legacy.jobs,
    );
    assert.deepEqual(t.store.all("SELECT * FROM engine_budget"), legacy.budget);
    assert.deepEqual(t.store.all("SELECT * FROM lab_runs"), legacy.lab);
    assert.equal(t.store.all("SELECT id FROM book_orders").length, 0);
    const attempts = transport.sent.length;
    await t.restart();
    assert.equal(await runPilotTick(t.store, t.config, factory), false);
    assert.equal(transport.sent.length, attempts);
    assert.deepEqual(
      pilotCampaignSummary(t.store, "other-family", campaign.id).attempts,
      summary.attempts,
    );
  } finally {
    await t.close();
    if (previous === undefined) delete process.env.EVERLORE_PILOT_WORKER;
    else process.env.EVERLORE_PILOT_WORKER = previous;
  }
});

for (const fault of ["budget", "ambiguous", "rejected"] as const) {
  test(`pilot ${fault} stops preserve the recording and never replay a potentially paid request`, async () => {
    const previous = process.env.EVERLORE_PILOT_WORKER;
    process.env.EVERLORE_PILOT_WORKER = "1";
    const t = await fixture({
      enabled: false,
      strictCostGuard: true,
      budgetCents: 7500,
    });
    try {
      const legacy = preserveLegacyQueues(t.store);
      const campaign = pilotInvitation(t, fault === "budget" ? 1 : 10000);
      const captured = await pilotRecording(t);
      const transport = pilotTransport(
        () => t.store,
        new PilotFixtureProvider(),
        fault === "budget" ? undefined : fault,
      );
      const factory = (config: ReturnType<typeof engineConfig>) =>
        new OpenAIProvider(config, transport.request);
      await runPilotTick(t.store, t.config, factory);
      await t.restart();
      for (let count = 0; count < 3; count++)
        await runPilotTick(t.store, t.config, factory);
      assert.equal(transport.sent.length, fault === "budget" ? 0 : 1);
      const summary = pilotCampaignSummary(
        t.store,
        "other-family",
        campaign.id,
      );
      assert.equal(summary.attempts.length, fault === "budget" ? 0 : 1);
      if (fault === "ambiguous") {
        assert.equal(summary.attempts[0].status, "ambiguous");
        assert.equal(
          summary.attempts[0].accountedCents,
          summary.attempts[0].reservedCents,
        );
        assert.equal(summary.ambiguousAttempts, 1);
      } else if (fault === "rejected") {
        assert.equal(summary.attempts[0].status, "not_processed");
        assert.equal(summary.accountedCents, 0);
      }
      const audio = await t.request(captured.path);
      assert.equal(audio.status, 200);
      assert.equal(
        hash(new Uint8Array(await audio.arrayBuffer())),
        hash(wav(3)),
      );
      assert.equal(
        (await (await t.request(`/journey/${captured.session.id}`)).json())
          .status,
        "paused",
      );
      assert.deepEqual(
        t.store.all(
          "SELECT * FROM studio_jobs WHERE id IN ('rosa-job','lab-job') ORDER BY id",
        ),
        legacy.jobs,
      );
      assert.deepEqual(
        t.store.all("SELECT * FROM engine_budget"),
        legacy.budget,
      );
      assert.equal(t.store.all("SELECT id FROM editions").length, 0);
    } finally {
      await t.close();
      if (previous === undefined) delete process.env.EVERLORE_PILOT_WORKER;
      else process.env.EVERLORE_PILOT_WORKER = previous;
    }
  });
}
