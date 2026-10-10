import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest, type Server } from "node:http";
import { z } from "zod";
import { Store, canonical, hash, now } from "../src/server/store.js";
import { configureAccess, setOperator } from "../src/server/access.js";
import { createApp } from "../src/server/app.js";
import {
  startJourney,
  createJourney,
  journeySetup,
  journeyView,
  advanceCreationRequest,
  recordJourneyStarted,
  journeyMetrics,
} from "../src/server/almanac/journey.js";
import {
  saveTurnAudio,
  saveTurnText,
  sessionView,
  setSessionStatus,
  startTurn,
} from "../src/server/almanac/service.js";
import { runInterviewTranscription } from "../src/server/almanac/transcription.js";
import { runStudio, latestStudio } from "../src/server/engine/studio.js";
import { engineConfig, OpenAIProvider } from "../src/server/engine/provider.js";
import { FAMILY_CONSENT_VERSION } from "../src/shared/journey.js";
import { MEMORY_INVITATIONS } from "../src/shared/invitations.js";
import { activeProfile, saveProfile } from "../src/server/lab/profiles.js";
import {
  StudioFake,
  fixtureHeart,
  fixtureSource,
} from "./support/studio-fixtures.js";

const consent = {
  consent: true,
  consentVersion: FAMILY_CONSENT_VERSION,
  processWithOpenAI: true,
  imaginativeAdaptation: true,
} as const;
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "everlore-journey-"));
  const t = {
    dir,
    store: new Store(dir),
    owner: "owner",
    other: "other",
    config: {
      ...engineConfig({}),
      enabled: true,
      apiKey: "synthetic-key-never-sent",
      budgetCents: 100000,
      audioReserve: 100,
      textReserve: 100,
      imageReserve: 100,
    },
    restart() {
      t.store.close();
      t.store = new Store(dir);
    },
    close() {
      t.store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  configureAccess(t.store, false);
  for (const owner of [t.owner, t.other])
    t.store.run(
      "INSERT INTO users VALUES(?,?,?,'private',?)",
      owner,
      owner,
      "unused",
      now(),
    );
  return t;
}
type Setup = ReturnType<typeof setup>;
function begin(t: Setup, key = "start") {
  return startJourney(t.store, t.owner, { key, ...consent }, t.config).session
    .session;
}
function make(t: Setup, sessionId: string, key = "create") {
  return createJourney(
    t.store,
    t.owner,
    sessionId,
    { key, ...consent },
    t.config,
  );
}
function wav() {
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
  bytes.writeUInt16LE(1, 44);
  return bytes;
}
function savedAudio(t: Setup, sessionId: string, turnId: string) {
  return saveTurnAudio(
    t.store,
    t.owner,
    sessionId,
    turnId,
    wav(),
    "audio/wav",
    "microphone",
  );
}
class JourneyFake extends StudioFake {
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
        nuggets: fixtureHeart.nuggets.map((n) => ({ ...n, sourceId: "t1-s1" })),
      });
    }
    return super.structured(name, schema, instructions, data, images);
  }
}

test("freeform capture is idempotent, consent is versioned, and saving for later never creates a book", () => {
  const t = setup();
  try {
    assert.equal(journeySetup(t.store, t.owner, t.config).consented, false);
    assert.throws(
      () => startJourney(t.store, t.owner, { key: "missing" }, t.config),
      /Agree/,
    );
    assert.throws(() =>
      startJourney(
        t.store,
        t.owner,
        { key: "old", consent: true, consentVersion: "old" },
        t.config,
      ),
    );
    const session = begin(t),
      turn = session.turns[0];
    assert.equal(session.turns.length, 1);
    assert.match(turn.promptText, /Start wherever/);
    assert.equal(begin(t).id, session.id);
    assert.equal(begin(t).turns[0].id, turn.id);
    savedAudio(t, session.id, turn.id);
    setSessionStatus(t.store, t.owner, session.id, "finished");
    t.restart();
    assert.equal(journeySetup(t.store, t.owner, t.config).consented, true);
    assert.equal(
      startJourney(t.store, t.owner, { key: "start" }, t.config).session.session
        .id,
      session.id,
    );
    assert.equal(
      startJourney(t.store, t.owner, { key: "next" }, t.config).session.session
        .turns.length,
      1,
    );
    assert.equal(advanceCreationRequest(t.store, t.config), false);
    for (const table of [
      "almanac_creation_requests",
      "almanac_sources",
      "studio_jobs",
      "studio_calls",
    ])
      assert.equal(t.store.all(`SELECT * FROM ${table}`).length, 0);
    const consents = t.store.all<{
      version: string;
      scope: string;
      text: string;
    }>("SELECT * FROM almanac_consents");
    assert.deepEqual(consents.map((c) => c.scope).sort(), [
      "adaptation",
      "collection",
      "processing",
    ]);
    assert(
      consents.every(
        (c) => c.version === FAMILY_CONSENT_VERSION && c.text.length > 20,
      ),
    );
    assert.equal(journeySetup(t.store, t.other, t.config).consented, false);
    assert.throws(
      () => journeyView(t.store, t.other, session.id, t.config),
      /not on your shelf/,
    );
  } finally {
    t.close();
  }
});

test("an optional authored invitation is frozen without requiring a topic choice", () => {
  const t = setup();
  try {
    const invitation = MEMORY_INVITATIONS[3];
    const started = startJourney(
      t.store,
      t.owner,
      { key: "help", invitationId: invitation.id, ...consent },
      t.config,
    );
    assert.equal(
      started.session.session.turns[0].promptText,
      invitation.opening,
    );
    assert.equal(
      started.session.session.invitationVersion,
      invitation.revision,
    );
    const row = t.store.one<{ invitation: string }>(
      "SELECT invitation FROM almanac_sessions WHERE id=?",
      started.session.session.id,
    )!;
    assert.deepEqual(JSON.parse(row.invitation), invitation);
    assert.throws(
      () =>
        startJourney(t.store, t.owner, { key: "help", ...consent }, t.config),
      /another memory/,
    );
  } finally {
    t.close();
  }
});

test("the capture path saves multiple untranscribed segments without creating paid work", async () => {
  const t = setup();
  let calls = 0;
  try {
    const session = begin(t);
    assert.equal(
      journeyView(t.store, t.owner, session.id, t.config).canCreate,
      true,
    );
    assert.throws(() => make(t, session.id), /Save a recording/);
    assert.throws(
      () =>
        startTurn(
          t.store,
          t.owner,
          session.id,
          { key: "empty", promptId: "additional-memory" },
          true,
        ),
      /question has changed/,
    );
    savedAudio(t, session.id, session.turns[0].id);
    const second = startTurn(
      t.store,
      t.owner,
      session.id,
      { key: "second", promptId: "additional-memory" },
      true,
    );
    savedAudio(t, session.id, second.id);
    setSessionStatus(t.store, t.owner, session.id, "finished");
    assert.equal(t.store.all("SELECT * FROM studio_jobs").length, 0);
    make(t, session.id);
    const provider = new OpenAIProvider(t.config, async () => {
      calls++;
      return Response.json({ text: `Synthetic answer ${calls}.` });
    });
    advanceCreationRequest(t.store, t.config);
    await runInterviewTranscription(t.store, provider, t.config);
    advanceCreationRequest(t.store, t.config);
    await runInterviewTranscription(t.store, provider, t.config);
    advanceCreationRequest(t.store, t.config);
    assert.equal(calls, 2);
    assert.equal(
      JSON.parse(
        t.store.one<{ body: string }>("SELECT body FROM almanac_sources")!.body,
      ).turns.length,
      2,
    );
    assert.equal(
      t.store.all("SELECT * FROM studio_jobs WHERE kind='generation'").length,
      1,
    );
  } finally {
    t.close();
  }
});

test("operator journey measures retain missing observations and never reveal memory content", () => {
  const t = setup();
  try {
    setOperator(t.store, t.owner);
    assert.equal(
      journeyMetrics(t.store, t.owner).timeToFirstRecording.medianMs,
      null,
    );
    const session = begin(t);
    recordJourneyStarted(t.store, t.owner, session.id);
    recordJourneyStarted(t.store, t.owner, session.id);
    savedAudio(t, session.id, session.turns[0].id);
    make(t, session.id);
    make(t, session.id, "retry-key");
    const result = journeyMetrics(t.store, t.owner);
    assert.equal(result.timeToFirstRecording.samples, 1);
    assert.equal(result.requests, 1);
    assert.equal(result.repeatedCreateActions, 1);
    assert.equal(result.requestToFirstAcceptedImage.medianMs, null);
    assert.equal(result.requestToBook.medianMs, null);
    assert(!JSON.stringify(result).includes(session.id));
    assert.throws(
      () => journeyMetrics(t.store, t.other),
      /operator|administrator/i,
    );
  } finally {
    t.close();
  }
});

test("explicit written creation survives restart, pins its profile, and completes through the existing book worker once", async () => {
  const t = setup(),
    provider = new JourneyFake();
  try {
    const session = begin(t);
    saveTurnText(t.store, t.owner, session.id, session.turns[0].id, {
      rawText: fixtureSource,
    });
    setSessionStatus(t.store, t.owner, session.id, "finished");
    const requested = make(t, session.id);
    assert.equal(requested.status, "creating");
    assert.equal(t.store.all("SELECT * FROM studio_jobs").length, 0);
    assert.equal(make(t, session.id).requestId, requested.requestId);
    assert.equal(
      make(t, session.id, "second-click").requestId,
      requested.requestId,
    );
    const pinned = activeProfile(t.store, t.config);
    const changed = saveProfile(t.store, {
      ...pinned,
      name: "Changed after the request",
    });
    t.store.run(
      "UPDATE lab_settings SET value=? WHERE key='active_profile'",
      changed.hash,
    );
    t.restart();
    advanceCreationRequest(t.store, t.config);
    const view = journeyView(t.store, t.owner, session.id, t.config);
    assert(view.projectId);
    assert.equal(latestStudio(t.store, view.projectId)!.profile, pinned.hash);
    assert.equal(t.store.all("SELECT * FROM almanac_sources").length, 1);
    await runStudio(t.store, provider, t.config);
    assert.equal(
      latestStudio(t.store, view.projectId)!.status,
      "complete",
      latestStudio(t.store, view.projectId)!.error ?? "",
    );
    advanceCreationRequest(t.store, t.config);
    assert.equal(
      journeyView(t.store, t.owner, session.id, t.config).status,
      "ready",
    );
    assert.equal(
      sessionView(t.store, t.owner, session.id).session.status,
      "finished",
    );
    const calls = provider.calls.length;
    make(t, session.id, "after-reload");
    advanceCreationRequest(t.store, t.config);
    await runStudio(t.store, provider, t.config);
    assert.equal(provider.calls.length, calls);
    assert.equal(t.store.all("SELECT * FROM editions").length, 1);
    assert.equal(
      t.store.all("SELECT * FROM almanac_creation_requests").length,
      1,
    );
    assert.equal(t.store.all("SELECT * FROM almanac_creation_keys").length, 3);
  } finally {
    t.close();
  }
});

test("voice creation transcribes saved turns once and resumes at the frozen handoff after browser/server loss", async () => {
  const t = setup();
  let calls = 0;
  try {
    const session = begin(t),
      first = session.turns[0];
    savedAudio(t, session.id, first.id);
    make(t, session.id);
    t.restart();
    advanceCreationRequest(t.store, t.config);
    const provider = new OpenAIProvider(t.config, async () => {
      calls++;
      return Response.json({ text: fixtureSource });
    });
    await runInterviewTranscription(t.store, provider, t.config);
    t.restart();
    advanceCreationRequest(t.store, t.config);
    const view = journeyView(t.store, t.owner, session.id, t.config);
    assert.equal(view.status, "creating");
    assert(view.projectId);
    assert.equal(calls, 1);
    assert.equal(t.store.all("SELECT * FROM almanac_sources").length, 1);
    // Simulate a crash after queueStudio committed but before recording its ID.
    t.store.run(
      "UPDATE almanac_creation_requests SET studioJobId=NULL,status='queued'",
    );
    t.restart();
    advanceCreationRequest(t.store, t.config);
    assert.equal(
      t.store.all("SELECT * FROM studio_jobs WHERE kind='generation'").length,
      1,
    );
    assert.equal(
      await runInterviewTranscription(t.store, provider, t.config),
      false,
    );
    assert.equal(calls, 1);
  } finally {
    t.close();
  }
});

test("unavailable configuration or budget pauses saved creation, with a reusable source and no dispatch", () => {
  const t = setup();
  try {
    const session = begin(t);
    saveTurnText(t.store, t.owner, session.id, session.turns[0].id, {
      rawText: fixtureSource,
    });
    const disabled = { ...t.config, enabled: false };
    const requested = createJourney(
      t.store,
      t.owner,
      session.id,
      { key: "disabled", ...consent },
      disabled,
    );
    assert.equal(requested.status, "paused");
    advanceCreationRequest(t.store, disabled);
    assert.equal(t.store.all("SELECT * FROM almanac_sources").length, 1);
    advanceCreationRequest(t.store, { ...t.config, budgetCents: 1 });
    assert.equal(t.store.all("SELECT * FROM studio_jobs").length, 0);
    assert.equal(t.store.all("SELECT * FROM studio_calls").length, 0);
    t.restart();
    advanceCreationRequest(t.store, t.config);
    assert.equal(
      journeyView(t.store, t.owner, session.id, t.config).status,
      "creating",
    );
    assert.equal(t.store.all("SELECT * FROM almanac_sources").length, 1);
    assert.equal(t.store.all("SELECT * FROM studio_jobs").length, 1);
    assert.equal(
      journeyView(t.store, t.owner, session.id, disabled).status,
      "paused",
    );
  } finally {
    t.close();
  }
});

test("an ambiguous paid transcription never retries and exposes only a plain saved-work status", async () => {
  const t = setup();
  let calls = 0;
  try {
    const session = begin(t);
    savedAudio(t, session.id, session.turns[0].id);
    make(t, session.id);
    advanceCreationRequest(t.store, t.config);
    const provider = new OpenAIProvider(t.config, async () => {
      calls++;
      throw new Error("private provider detail");
    });
    await runInterviewTranscription(t.store, provider, t.config);
    t.restart();
    for (let i = 0; i < 3; i++) {
      make(t, session.id);
      advanceCreationRequest(t.store, t.config);
      await runInterviewTranscription(t.store, provider, t.config);
    }
    const view = journeyView(t.store, t.owner, session.id, t.config);
    assert.equal(view.status, "paused");
    assert.match(view.message, /recording is saved/);
    assert(!JSON.stringify(view).includes("private provider"));
    assert.equal(calls, 1);
    assert.equal(t.store.all("SELECT * FROM almanac_sources").length, 0);
    assert.equal(
      t.store.one<{ status: string }>("SELECT status FROM studio_calls")!
        .status,
      "ambiguous_failure",
    );
  } finally {
    t.close();
  }
});

test("deleting an in-progress or completed book cancels its durable request without deleting the memory or regenerating", async () => {
  for (const complete of [false, true]) {
    const t = setup(),
      provider = new JourneyFake();
    try {
      const session = begin(t),
        audio = savedAudio(t, session.id, session.turns[0].id);
      saveTurnText(t.store, t.owner, session.id, session.turns[0].id, {
        rawText: fixtureSource,
      });
      const requested = make(t, session.id);
      advanceCreationRequest(t.store, t.config);
      const projectId = journeyView(
        t.store,
        t.owner,
        session.id,
        t.config,
      ).projectId!;
      if (complete) {
        await runStudio(t.store, provider, t.config);
        advanceCreationRequest(t.store, t.config);
        assert.equal(
          journeyView(t.store, t.owner, session.id, t.config).bookReady,
          true,
        );
      }
      const calls = provider.calls.length;
      t.store.run("DELETE FROM projects WHERE id=?", projectId);
      t.restart();
      assert.equal(advanceCreationRequest(t.store, t.config), false);
      assert.equal(advanceCreationRequest(t.store, t.config), false);
      assert.equal(await runStudio(t.store, provider, t.config), false);
      const view = journeyView(t.store, t.owner, session.id, t.config);
      assert.equal(view.status, "saved");
      assert.equal(view.requestId, null);
      assert.equal(view.canCreate, true);
      assert.equal(view.projectId, null);
      assert.equal(t.store.all("SELECT * FROM studio_jobs").length, 0);
      assert.equal(t.store.all("SELECT * FROM almanac_sources").length, 0);
      assert.equal(
        t.store.one<{ status: string }>(
          "SELECT status FROM almanac_creation_requests WHERE id=?",
          requested.requestId!,
        )!.status,
        "cancelled",
      );
      assert.equal(
        sessionView(t.store, t.owner, session.id).session.turns[0].transcript!
          .rawText,
        fixtureSource,
      );
      assert.equal(
        hash(t.store.readAsset(session.projectId, audio.audio!.sha256)),
        audio.audio!.sha256,
      );
      // Replaying the original creation key still cannot recreate a deleted book.
      assert.equal(make(t, session.id).requestId, null);
      assert.equal(provider.calls.length, calls);
      const next = make(t, session.id, "explicit-new-book");
      assert(next.requestId);
      assert.notEqual(next.requestId, requested.requestId);
      advanceCreationRequest(t.store, t.config);
      assert.notEqual(
        journeyView(t.store, t.owner, session.id, t.config).projectId,
        projectId,
      );
      assert.equal(
        t.store.all("SELECT * FROM studio_jobs WHERE kind='generation'").length,
        1,
      );
    } finally {
      t.close();
    }
  }
});

test("a disabled worker or unavailable complete cost plan cannot start a voice creation request", () => {
  const t = setup(),
    previous = process.env.DISABLE_WORKER;
  try {
    const session = begin(t);
    savedAudio(t, session.id, session.turns[0].id);
    process.env.DISABLE_WORKER = "1";
    assert.equal(journeySetup(t.store, t.owner, t.config).canCreate, false);
    make(t, session.id);
    advanceCreationRequest(t.store, t.config);
    assert.equal(t.store.all("SELECT * FROM studio_jobs").length, 0);
    delete process.env.DISABLE_WORKER;
    const strict = { ...t.config, strictCostGuard: true };
    assert.equal(journeySetup(t.store, t.owner, strict).canCreate, false);
    advanceCreationRequest(t.store, strict);
    assert.equal(
      journeyView(t.store, t.owner, session.id, strict).status,
      "paused",
    );
    assert.equal(t.store.all("SELECT * FROM studio_jobs").length, 0);
    assert.equal(t.store.all("SELECT * FROM studio_calls").length, 0);
  } finally {
    if (previous === undefined) delete process.env.DISABLE_WORKER;
    else process.env.DISABLE_WORKER = previous;
    t.close();
  }
});

test("creation pins selected turns, refuses changed source text, and checks source again after freeze", () => {
  const t = setup();
  try {
    const session = begin(t);
    saveTurnText(t.store, t.owner, session.id, session.turns[0].id, {
      rawText: fixtureSource,
    });
    make(t, session.id);
    const additional = startTurn(t.store, t.owner, session.id, {
      key: "later",
      promptId: "additional-memory",
    });
    saveTurnText(t.store, t.owner, session.id, additional.id, {
      rawText: "An unrelated later memory.",
    });
    const disabled = { ...t.config, enabled: false };
    advanceCreationRequest(t.store, disabled);
    const source = t.store.one<{ body: string; generationProjectId: string }>(
      "SELECT * FROM almanac_sources",
    )!;
    assert.equal(JSON.parse(source.body).turns.length, 1);
    t.store.run(
      "UPDATE projects SET transcript=? WHERE id=?",
      canonical({ rawText: "Changed after freezing", segments: [] }),
      source.generationProjectId,
    );
    advanceCreationRequest(t.store, t.config);
    assert.equal(
      journeyView(t.store, t.owner, session.id, t.config).status,
      "paused",
    );
    assert.equal(t.store.all("SELECT * FROM studio_jobs").length, 0);
    const second = begin(t, "second");
    saveTurnText(t.store, t.owner, second.id, second.turns[0].id, {
      rawText: fixtureSource,
    });
    make(t, second.id, "second-request");
    saveTurnText(t.store, t.owner, second.id, second.turns[0].id, {
      rawText: "A corrected memory.",
    });
    advanceCreationRequest(t.store, t.config);
    assert.equal(
      journeyView(t.store, t.owner, second.id, t.config).status,
      "paused",
    );
    assert.equal(t.store.all("SELECT * FROM studio_jobs").length, 0);
  } finally {
    t.close();
  }
});

async function http(
  server: Server,
  path: string,
  method = "GET",
  cookie = "",
  body?: unknown,
) {
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No test server");
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: address.port,
        path,
        method,
        headers: {
          Cookie: cookie,
          "X-Evermore-Client": "1",
          "Content-Type": "application/json",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode!,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
test("journey HTTP endpoints require the private owner and explicit valid creation consent", async () => {
  const t = setup(),
    server = createApp(t.store, t.config).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    for (const owner of [t.owner, t.other])
      t.store.run(
        "INSERT INTO sessions VALUES(?,?,?)",
        hash(owner + "-token"),
        owner,
        Date.now() + 60000,
      );
    assert.equal((await http(server, "/api/journey/setup")).status, 401);
    const response = await http(
      server,
      "/api/journey/start",
      "POST",
      "evermore=owner-token",
      { key: "http", ...consent },
    );
    assert.equal(response.status, 201);
    const session = JSON.parse(response.body).session.session;
    saveTurnText(t.store, t.owner, session.id, session.turns[0].id, {
      rawText: fixtureSource,
    });
    assert.equal(
      (
        await http(
          server,
          `/api/journey/${session.id}`,
          "GET",
          "evermore=other-token",
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await http(
          server,
          `/api/journey/${session.id}/create`,
          "POST",
          "evermore=other-token",
          { key: "other", ...consent },
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await http(
          server,
          `/api/journey/${session.id}/create`,
          "POST",
          "evermore=owner-token",
          { key: "missing" },
        )
      ).status,
      400,
    );
    const created = await http(
      server,
      `/api/journey/${session.id}/create`,
      "POST",
      "evermore=owner-token",
      { key: "http-create", ...consent },
    );
    assert.equal(created.status, 202);
    assert.equal(JSON.parse(created.body).status, "creating");
    assert.equal(t.store.all("SELECT * FROM studio_jobs").length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    t.close();
  }
});
