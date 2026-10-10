import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, id, now, hash, type ProjectRow } from "../src/server/store.js";
import { exportArchive, restoreArchive } from "../src/server/archive.js";
import { migrateAlmanac } from "../src/server/almanac/schema.js";
import { configureAccess, createOperator } from "../src/server/access.js";
import {
  engineConfig,
  OpenAIProvider,
  type Provider,
} from "../src/server/engine/provider.js";
import {
  almanacView,
  pageView,
  addPage,
  editPage,
  associateMemory,
  startSession,
  sessionView,
  startTurn,
  saveTurnAudio,
  saveTurnText,
  freezeSource,
  skipTurn,
  setSessionStatus,
  readTurn,
  startTitleSession,
  applyPageTitle,
} from "../src/server/almanac/service.js";
import {
  queueInterviewTranscription,
  runInterviewTranscription,
  interviewRecovery,
  retryInterviewTranscription,
} from "../src/server/almanac/transcription.js";
import { ALMANAC_PAGES } from "../src/shared/almanac.js";
import { sampleBook } from "../src/shared/fixture.js";
import { createApp } from "../src/server/app.js";
import { request as httpRequest, type Server } from "node:http";
import { issueInvitation, redeemInvitation } from "../src/server/access.js";
import {
  exportInterviewArchive,
  importInterviewArchive,
  validateInterviewArchive,
} from "../src/server/almanac/archive.js";
import { requestStudioPause } from "../src/server/engine/budget.js";
import { gzipSync, gunzipSync } from "node:zlib";
import { canonical } from "../src/server/store.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "everlore-almanac-")),
    store = new Store(dir);
  migrateAlmanac(store.db);
  configureAccess(store, false);
  const owner = createOperator(store, "almanac-owner", "synthetic-passphrase"),
    other = id();
  store.run(
    "INSERT INTO users VALUES(?,?,?,?,?)",
    other,
    "other-family",
    "unused",
    "private",
    now(),
  );
  const config = {
    ...engineConfig({}),
    enabled: true,
    apiKey: "synthetic-key-never-sent",
    budgetCents: 1000,
    audioReserve: 100,
    textReserve: 100,
    imageReserve: 100,
    strictCostGuard: true,
  };
  return {
    store,
    owner,
    other,
    config,
    dir,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
type Setup = ReturnType<typeof setup>;
function session(t: Setup) {
  return startSession(t.store, t.owner, ALMANAC_PAGES[0].id, { consent: true })
    .session;
}
function turn(t: Setup, sessionId: string, key: string = id()) {
  const view = sessionView(t.store, t.owner, sessionId);
  return startTurn(t.store, t.owner, sessionId, {
    key,
    promptId:
      view.nextPrompt.action === "ask"
        ? view.nextPrompt.promptId
        : "additional-memory",
  });
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
function audio(t: Setup, sessionId: string, turnId: string) {
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
const fixtureText =
  "One day we carried the blue cup to the garden. I loved that we always shared the last sip.";

test("private Almanac seeds 32 topics idempotently and keeps page edits, hiding and order family-specific", () => {
  const t = setup();
  try {
    assert.equal(almanacView(t.store, t.owner).pages.length, 32);
    migrateAlmanac(t.store.db);
    const pageId = ALMANAC_PAGES[0].id;
    editPage(t.store, t.owner, pageId, {
      title: "Our special beginnings",
      hidden: true,
      position: 8,
    });
    const own = almanacView(t.store, t.owner),
      other = almanacView(t.store, t.other);
    assert.equal(own.pages[8].id, pageId);
    assert.equal(own.pages[8].hidden, true);
    assert.equal(other.pages[0].title, ALMANAC_PAGES[0].title);
    assert.equal(other.pages[0].hidden, false);
    editPage(t.store, t.owner, pageId, { hidden: false });
    const custom = addPage(t.store, t.owner, {
      title: "Our tiny telescope",
    }).page;
    assert.equal(custom.custom, true);
    assert.equal(custom.chapterId, null);
    assert.throws(
      () => pageView(t.store, t.other, custom.id),
      /not on your shelf/,
    );
    assert.deepEqual(
      almanacView(t.store, t.owner).pages.map((p) => p.position),
      Array.from({ length: 33 }, (_, i) => i),
    );
  } finally {
    t.close();
  }
});

test("multi-turn audio upload is idempotent, immutable and isolated; interrupted sessions resume", () => {
  const t = setup();
  try {
    const s = session(t),
      first = turn(t, s.id, "first-answer");
    assert.equal(session(t).id, s.id);
    assert.equal(
      startTurn(t.store, t.owner, s.id, {
        key: "first-answer",
        promptId: first.promptId,
      }).id,
      first.id,
    );
    const saved = audio(t, s.id, first.id);
    assert.deepEqual(audio(t, s.id, first.id), saved);
    assert.throws(
      () =>
        startTurn(t.store, t.owner, s.id, {
          key: "other",
          promptId: "additional-memory",
        }),
      /question has changed/,
    );
    const changed = wav();
    changed[44] = 2;
    assert.throws(
      () =>
        saveTurnAudio(
          t.store,
          t.owner,
          s.id,
          first.id,
          changed,
          "audio/wav",
          "upload",
        ),
      /already has a saved/,
    );
    assert.throws(
      () =>
        saveTurnText(t.store, t.other, s.id, first.id, {
          rawText: fixtureText,
        }),
      /not on your shelf/,
    );
    saveTurnText(t.store, t.owner, s.id, first.id, { rawText: fixtureText });
    const second = startTurn(t.store, t.owner, s.id, {
      key: "another",
      promptId: "additional-memory",
    });
    audio(t, s.id, second.id);
    assert.equal(
      sessionView(t.store, t.owner, s.id).session.turns[0].transcript?.rawText,
      fixtureText,
    );
    assert.equal(
      t.store.all("SELECT * FROM assets WHERE projectId=?", s.projectId).length,
      1,
    );
    const otherSession = startSession(t.store, t.other, ALMANAC_PAGES[0].id, {
      consent: true,
    }).session;
    assert.throws(
      () => readTurn(t.store, otherSession.id, first.id),
      /not in this memory/,
    );
    assert.throws(
      () =>
        saveTurnAudio(
          t.store,
          t.owner,
          s.id,
          second.id,
          Buffer.alloc(44),
          "audio/wav",
          "upload",
        ),
      /complete recording/,
    );
    const empty = wav();
    empty.writeUInt32LE(0, 40);
    assert.throws(
      () =>
        saveTurnAudio(
          t.store,
          t.owner,
          s.id,
          second.id,
          empty,
          "audio/wav",
          "upload",
        ),
      /no audio/,
    );
  } finally {
    t.close();
  }
});

test("freezes are idempotent source revisions, preserve transcript history and omit no pending audio silently", () => {
  const t = setup();
  try {
    const s = session(t),
      first = turn(t, s.id);
    audio(t, s.id, first.id);
    saveTurnText(t.store, t.owner, s.id, first.id, { rawText: fixtureText });
    const frozen = freezeSource(t.store, t.owner, s.id, { consent: true });
    assert.deepEqual(
      freezeSource(t.store, t.owner, s.id, { consent: true }),
      frozen,
    );
    const original = t.store.one<{ body: string }>(
      "SELECT body FROM almanac_sources WHERE id=?",
      frozen.id,
    )!.body;
    const oldTranscript = t.store.one<{ transcript: string }>(
      "SELECT transcript FROM projects WHERE id=?",
      frozen.projectId,
    )!.transcript;
    saveTurnText(t.store, t.owner, s.id, first.id, {
      rawText: fixtureText + " Actually, the cup was green.",
    });
    assert.equal(
      t.store.all(
        "SELECT * FROM almanac_transcript_versions WHERE turnId=?",
        first.id,
      ).length,
      2,
    );
    const revised = freezeSource(t.store, t.owner, s.id, { consent: true });
    assert.equal(revised.revision, 2);
    assert.notEqual(revised.projectId, frozen.projectId);
    assert.equal(
      t.store.one<{ body: string }>(
        "SELECT body FROM almanac_sources WHERE id=?",
        frozen.id,
      )!.body,
      original,
    );
    assert.equal(
      t.store.one<{ transcript: string }>(
        "SELECT transcript FROM projects WHERE id=?",
        frozen.projectId,
      )!.transcript,
      oldTranscript,
    );
    assert.equal(
      hash(t.store.readAsset(frozen.projectId, hash(wav()))),
      hash(wav()),
    );
    const second = turn(t, s.id);
    audio(t, s.id, second.id);
    assert.throws(
      () => freezeSource(t.store, t.owner, s.id, { consent: true }),
      /still needs its transcript/,
    );
    assert.equal(
      freezeSource(t.store, t.owner, s.id, {
        consent: true,
        turnIds: [first.id],
      }).id,
      revised.id,
    );
    assert.throws(
      () =>
        freezeSource(t.store, t.owner, s.id, {
          consent: true,
          turnIds: ["foreign"],
        }),
      /Choose saved answers/,
    );
    assert.throws(
      () => freezeSource(t.store, t.other, s.id, { consent: true }),
      /not on your shelf/,
    );
    const book = sampleBook();
    book.spreads[0].artHash = t.store.putAsset(
      frozen.projectId,
      "<svg xmlns='http://www.w3.org/2000/svg'/>",
      "art",
    );
    t.store.run(
      "INSERT INTO revisions VALUES(?,?,?,?)",
      frozen.projectId,
      1,
      JSON.stringify(book),
      hash(JSON.stringify(book)),
    );
    t.store.run(
      "UPDATE projects SET revision=1,status='ready' WHERE id=?",
      frozen.projectId,
    );
    const cover = almanacView(t.store, t.owner).pages.find(
      (p) => p.id === s.pageId,
    )!;
    assert.equal(
      cover.coverUrl,
      `/api/projects/${frozen.projectId}/art/${book.spreads[0].artHash}`,
    );
    associateMemory(t.store, t.owner, ALMANAC_PAGES[1].id, frozen.projectId);
    assert.equal(
      almanacView(t.store, t.owner).books.find(
        (b) => b.projectId === frozen.projectId,
      )!.pageIds.length,
      2,
    );
    assert.throws(
      () =>
        associateMemory(
          t.store,
          t.other,
          ALMANAC_PAGES[1].id,
          frozen.projectId,
        ),
      /not on your shelf/,
    );
  } finally {
    t.close();
  }
});

test("manual-only answers and explicit skips need no fabricated recording and persist after finish", () => {
  const t = setup();
  try {
    const s = session(t),
      first = turn(t, s.id);
    skipTurn(t.store, t.owner, s.id, first.id);
    const next = turn(t, s.id);
    saveTurnText(t.store, t.owner, s.id, next.id, { rawText: fixtureText });
    const frozen = freezeSource(t.store, t.owner, s.id, { consent: true });
    assert.equal(
      t.store.one(
        "SELECT id FROM recordings WHERE projectId=?",
        frozen.projectId,
      ),
      undefined,
    );
    setSessionStatus(t.store, t.owner, s.id, "finished");
    assert.throws(() => turn(t, s.id), /Reopen/);
    setSessionStatus(t.store, t.owner, s.id, "open");
    assert.equal(turn(t, s.id).status, "awaiting_audio");
    assert.equal(
      sessionView(t.store, t.owner, s.id).session.turns[0].status,
      "skipped",
    );
  } finally {
    t.close();
  }
});

test("voice transcription reuses guarded provider dispatch, persists receipts and never repeats a completed request", async () => {
  const t = setup();
  let calls = 0;
  try {
    const s = session(t),
      first = turn(t, s.id);
    audio(t, s.id, first.id);
    assert.throws(() =>
      queueInterviewTranscription(
        t.store,
        t.owner,
        s.id,
        first.id,
        {},
        t.config,
      ),
    );
    const queued = queueInterviewTranscription(
      t.store,
      t.owner,
      s.id,
      first.id,
      { processWithOpenAI: true },
      t.config,
    );
    assert.equal(
      queueInterviewTranscription(
        t.store,
        t.owner,
        s.id,
        first.id,
        { processWithOpenAI: true },
        t.config,
      ).jobId,
      queued.jobId,
    );
    const provider = new OpenAIProvider(t.config, async () => {
      calls++;
      return Response.json(
        { text: fixtureText },
        { headers: { "x-request-id": "fixture-request-1" } },
      );
    });
    assert.equal(
      await runInterviewTranscription(t.store, provider, t.config),
      true,
    );
    assert.equal(
      await runInterviewTranscription(t.store, provider, t.config),
      false,
    );
    assert.equal(calls, 1);
    assert.equal(readTurn(t.store, s.id, first.id).transcript?.mode, "live");
    assert.equal(
      readTurn(t.store, s.id, first.id).transcript?.rawText,
      fixtureText,
    );
    assert.equal(
      t.store.one<{
        status: string;
        requestId: string;
        actualCents: number | null;
      }>("SELECT * FROM studio_calls WHERE jobId=?", queued.jobId)!.status,
      "completed",
    );
    assert.equal(
      t.store.one<{ actualCents: number | null }>(
        "SELECT actualCents FROM studio_calls WHERE jobId=?",
        queued.jobId,
      )!.actualCents,
      null,
    );
    assert.equal(t.store.all("SELECT * FROM studio_request_bounds").length, 1);
    assert.equal(
      t.store.one<{ allowance: number }>(
        "SELECT allowance FROM engine_budget WHERE runId=?",
        queued.jobId,
      )!.allowance,
      19,
    );
  } finally {
    t.close();
  }
});

test("uncertain paid transcription survives restart without replay and safe rejection needs explicit retry", async () => {
  const t = setup();
  let calls = 0;
  try {
    const s = session(t),
      first = turn(t, s.id);
    audio(t, s.id, first.id);
    const queued = queueInterviewTranscription(
      t.store,
      t.owner,
      s.id,
      first.id,
      { processWithOpenAI: true },
      t.config,
    );
    const provider = new OpenAIProvider(t.config, async () => {
      calls++;
      throw new Error("synthetic disconnected response");
    });
    await runInterviewTranscription(t.store, provider, t.config);
    assert.equal(readTurn(t.store, s.id, first.id).status, "needs_attention");
    t.store.run(
      "UPDATE studio_jobs SET error=? WHERE id=?",
      "private-provider-diagnostic-do-not-show",
      queued.jobId,
    );
    const familyView = sessionView(t.store, t.owner, s.id);
    assert.equal(
      JSON.stringify(familyView).includes(
        "private-provider-diagnostic-do-not-show",
      ),
      false,
    );
    assert.match(
      familyView.transcriptionJobs[0].error!,
      /Your recording is saved/,
    );
    assert.throws(
      () =>
        queueInterviewTranscription(
          t.store,
          t.owner,
          s.id,
          first.id,
          { processWithOpenAI: true },
          t.config,
        ),
      /may already/,
    );
    t.store.run(
      "UPDATE studio_jobs SET status='running',leaseUntil=0 WHERE id=?",
      queued.jobId,
    );
    await runInterviewTranscription(t.store, provider, t.config);
    assert.equal(calls, 1);
    assert.equal(
      t.store.one<{ status: string }>(
        "SELECT status FROM studio_calls WHERE jobId=?",
        queued.jobId,
      )!.status,
      "ambiguous_failure",
    );
    assert.equal(
      t.store.one<{ allowance: number }>(
        "SELECT allowance FROM engine_budget WHERE runId=?",
        queued.jobId,
      )!.allowance,
      19,
    );
    const s2 = startSession(t.store, t.owner, ALMANAC_PAGES[1].id, {
      consent: true,
      key: "second",
    }).session;
    const next = turn(t, s2.id);
    audio(t, s2.id, next.id);
    const job2 = queueInterviewTranscription(
      t.store,
      t.owner,
      s2.id,
      next.id,
      { processWithOpenAI: true },
      t.config,
    );
    await runInterviewTranscription(
      t.store,
      new OpenAIProvider(t.config, async () =>
        Response.json({ error: { code: "invalid_api_key" } }, { status: 401 }),
      ),
      t.config,
    );
    assert.equal(
      t.store.one<{ status: string }>(
        "SELECT status FROM studio_calls WHERE jobId=?",
        job2.jobId,
      )!.status,
      "rejected",
    );
    assert.equal(
      await runInterviewTranscription(t.store, provider, t.config),
      false,
    );
    queueInterviewTranscription(
      t.store,
      t.owner,
      s2.id,
      next.id,
      { processWithOpenAI: true },
      t.config,
    );
    await runInterviewTranscription(
      t.store,
      new OpenAIProvider(t.config, async () =>
        Response.json({ text: fixtureText }),
      ),
      t.config,
    );
    assert.equal(
      t.store.all("SELECT * FROM studio_calls WHERE jobId=?", job2.jobId)
        .length,
      2,
    );
    assert.equal(readTurn(t.store, s2.id, next.id).status, "complete");
  } finally {
    t.close();
  }
});

test("disabled access, exhausted allowance, missing guard and changed source stop before paid dispatch", async () => {
  const t = setup();
  let calls = 0;
  try {
    const s = session(t),
      first = turn(t, s.id);
    audio(t, s.id, first.id);
    assert.throws(
      () =>
        queueInterviewTranscription(
          t.store,
          t.owner,
          s.id,
          first.id,
          { processWithOpenAI: true },
          { ...t.config, enabled: false },
        ),
      /not available/,
    );
    assert.throws(
      () =>
        queueInterviewTranscription(
          t.store,
          t.owner,
          s.id,
          first.id,
          { processWithOpenAI: true },
          { ...t.config, budgetCents: 18 },
        ),
      /allowance/,
    );
    assert.equal(t.store.all("SELECT * FROM studio_jobs").length, 0);
    const queued = queueInterviewTranscription(
      t.store,
      t.owner,
      s.id,
      first.id,
      { processWithOpenAI: true },
      t.config,
    );
    const unguarded = {
      transcribe: async () => {
        calls++;
        return fixtureText;
      },
    } as unknown as Provider;
    await runInterviewTranscription(t.store, unguarded, t.config);
    assert.equal(calls, 0);
    assert.equal(t.store.all("SELECT * FROM studio_checkpoints").length, 1);
    queueInterviewTranscription(
      t.store,
      t.owner,
      s.id,
      first.id,
      { processWithOpenAI: true },
      t.config,
    );
    t.store.run(
      "UPDATE almanac_transcriptions SET audioHash=? WHERE jobId=?",
      "0".repeat(64),
      queued.jobId,
    );
    await runInterviewTranscription(
      t.store,
      new OpenAIProvider(t.config, async () => {
        calls++;
        return Response.json({ text: fixtureText });
      }),
      t.config,
    );
    assert.equal(calls, 0);
    assert.equal(t.store.all("SELECT * FROM studio_calls").length, 0);
  } finally {
    t.close();
  }
});

test("hosted transcription draws once from its own invitation, counts no book and preserves grant limits", async () => {
  const t = setup();
  try {
    configureAccess(t.store, true);
    t.config.audioReserve = 1;
    t.config.textReserve = 1;
    t.config.imageReserve = 1;
    const invite = issueInvitation(
      t.store,
      t.owner,
      { label: "One family", bookCount: 1, creditCents: 200, expiresDays: 7 },
      t.config,
    );
    redeemInvitation(t.store, invite.code, t.other);
    t.store.run(
      "INSERT INTO access_jobs VALUES(?,?,0)",
      "previous-test-spend",
      t.other,
    );
    t.store.run(
      "INSERT INTO engine_budget VALUES(?,?,?)",
      "previous-test-spend",
      180,
      now(),
    );
    const s = startSession(t.store, t.other, ALMANAC_PAGES[0].id, {
      consent: true,
    }).session;
    const prompt = sessionView(t.store, t.other, s.id).nextPrompt;
    assert.equal(prompt.action, "ask");
    const first = startTurn(t.store, t.other, s.id, {
      key: "one",
      promptId: prompt.promptId,
    });
    saveTurnAudio(
      t.store,
      t.other,
      s.id,
      first.id,
      wav(),
      "audio/wav",
      "upload",
    );
    const queued = queueInterviewTranscription(
      t.store,
      t.other,
      s.id,
      first.id,
      { processWithOpenAI: true },
      t.config,
    );
    assert.equal(
      t.store.one<{ isBook: number }>(
        "SELECT isBook FROM access_jobs WHERE jobId=?",
        queued.jobId,
      )!.isBook,
      0,
    );
    await runInterviewTranscription(
      t.store,
      new OpenAIProvider(t.config, async () =>
        Response.json({ text: fixtureText }),
      ),
      t.config,
    );
    const second = startTurn(t.store, t.other, s.id, {
      key: "two",
      promptId: "additional-memory",
    });
    saveTurnAudio(
      t.store,
      t.other,
      s.id,
      second.id,
      wav(),
      "audio/wav",
      "upload",
    );
    assert.throws(
      () =>
        queueInterviewTranscription(
          t.store,
          t.other,
          s.id,
          second.id,
          { processWithOpenAI: true },
          t.config,
        ),
      /not available|cannot cover/,
    );
    assert.equal(
      t.store.all("SELECT * FROM access_jobs WHERE ownerId=?", t.other).length,
      2,
    );
  } finally {
    t.close();
  }
});

test("portable interview archives preserve selected source, all prior transcripts and recovery without importing paid jobs", () => {
  const t = setup();
  try {
    const s = session(t),
      first = turn(t, s.id);
    audio(t, s.id, first.id);
    saveTurnText(t.store, t.owner, s.id, first.id, { rawText: fixtureText });
    const frozen = freezeSource(t.store, t.owner, s.id, { consent: true });
    saveTurnText(t.store, t.owner, s.id, first.id, {
      rawText: fixtureText + " A later correction.",
    });
    const later = turn(t, s.id);
    saveTurnText(t.store, t.owner, s.id, later.id, {
      rawText:
        "This later private answer does not belong to the previous book.",
    });
    const bookArchive = exportInterviewArchive(t.store, frozen.projectId)!;
    assert.equal(bookArchive.kind, "frozen_source");
    assert.equal(bookArchive.session.turns.length, 1);
    assert.equal(
      JSON.stringify(bookArchive).includes("later private answer"),
      false,
    );
    assert.equal(
      JSON.stringify(bookArchive).includes("later correction"),
      false,
    );
    const all = exportInterviewArchive(t.store, s.projectId)!;
    assert.equal(all.session.turns.length, 2);
    assert.equal(all.transcriptHistory.length, 3);
    assert.throws(
      () =>
        validateInterviewArchive(
          {
            ...all,
            sources: [{ ...all.sources[0], sourceHash: "0".repeat(64) }],
          },
          () => {},
        ),
      /integrity/,
    );
    assert.throws(
      () =>
        validateInterviewArchive(all, () => {
          throw new Error("missing audio");
        }),
      /missing audio/,
    );
    const restoredId = id();
    t.store.transaction(() => {
      t.store.run(
        "INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?)",
        restoredId,
        t.other,
        "Restored interview",
        "unavailable",
        "draft",
        0,
        null,
        now(),
        now(),
      );
      t.store.putAsset(restoredId, wav(), "audio");
      const restored = importInterviewArchive(
        t.store,
        t.other,
        restoredId,
        all,
      );
      const view = sessionView(t.store, t.other, restored.sessionId);
      assert.equal(view.aiProcessingConsented, false);
      assert.equal(view.session.turns.length, 2);
      assert.equal(view.transcriptHistory.length, 3);
      assert.notEqual(view.session.id, s.id);
      assert.notEqual(view.session.turns[0].id, first.id);
      assert.equal(view.session.turns[0].audio?.sha256, hash(wav()));
    });
    assert.equal(t.store.all("SELECT * FROM studio_jobs").length, 0);
    const again = exportInterviewArchive(t.store, restoredId)!;
    assert.equal(again.provenance[0].sources[0].sourceHash, frozen.sourceHash);
    assert.doesNotThrow(() => validateInterviewArchive(again, () => {}));
    const restoredBook = id();
    t.store.transaction(() => {
      t.store.run(
        "INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?)",
        restoredBook,
        t.other,
        "Restored book",
        "manual",
        "ready",
        0,
        null,
        now(),
        now(),
      );
      t.store.putAsset(restoredBook, wav(), "audio");
      const restored = importInterviewArchive(
        t.store,
        t.other,
        restoredBook,
        bookArchive,
      );
      assert.notEqual(restored.sourceProjectId, restoredBook);
      assert.equal(
        sessionView(t.store, t.other, restored.sessionId).sourceRevisions
          .length,
        1,
      );
      assert.equal(
        hash(t.store.readAsset(restored.sourceProjectId, hash(wav()))),
        hash(wav()),
      );
    });
    assert.doesNotThrow(() =>
      validateInterviewArchive(
        exportInterviewArchive(t.store, restoredBook),
        () => {},
      ),
    );
  } finally {
    t.close();
  }
});

test("the complete compressed family archive restores interview recordings and frozen book provenance", () => {
  const t = setup();
  try {
    const s = session(t),
      first = turn(t, s.id);
    audio(t, s.id, first.id);
    saveTurnText(t.store, t.owner, s.id, first.id, { rawText: fixtureText });
    const frozen = freezeSource(t.store, t.owner, s.id, { consent: true });
    for (const projectId of [s.projectId, frozen.projectId]) {
      const project = t.store.one<ProjectRow>(
        "SELECT * FROM projects WHERE id=?",
        projectId,
      )!;
      const zip = exportArchive(t.store, project);
      const restored = restoreArchive(t.store, t.other, zip);
      const extension = exportInterviewArchive(t.store, restored.id)!;
      assert.equal(extension.session.turns[0].transcript!.rawText, fixtureText);
      assert.equal(extension.session.turns[0].audio!.sha256, hash(wav()));
      assert.equal(
        t.store.all("SELECT * FROM studio_jobs WHERE projectId=?", restored.id)
          .length,
        0,
      );
      assert.equal(
        sessionView(t.store, t.other, extension.session.id)
          .aiProcessingConsented,
        false,
      );
    }
  } finally {
    t.close();
  }
});

test("consent persists across a pause, operator safe recovery is idempotent and a short spoken answer is valid", async () => {
  const t = setup();
  let calls = 0;
  try {
    const view = startSession(t.store, t.owner, ALMANAC_PAGES[0].id, {
      consent: true,
      processWithOpenAI: true,
    });
    assert.equal(view.aiProcessingConsented, true);
    setSessionStatus(t.store, t.owner, view.session.id, "finished");
    assert.equal(
      setSessionStatus(t.store, t.owner, view.session.id, "open")
        .aiProcessingConsented,
      true,
    );
    const first = turn(t, view.session.id);
    audio(t, view.session.id, first.id);
    const job = queueInterviewTranscription(
      t.store,
      t.owner,
      view.session.id,
      first.id,
      { processWithOpenAI: true },
      t.config,
    );
    requestStudioPause(t.store, job.jobId);
    const provider = new OpenAIProvider(t.config, async () => {
      calls++;
      return Response.json({ text: "My dad." });
    });
    await runInterviewTranscription(t.store, provider, t.config);
    assert.equal(calls, 0);
    assert.equal(
      interviewRecovery(t.store, t.owner, view.session.id, first.id).resumable,
      true,
    );
    assert.throws(
      () => interviewRecovery(t.store, t.other, view.session.id, first.id),
      /Only the configured/,
    );
    const retry = retryInterviewTranscription(
      t.store,
      t.owner,
      view.session.id,
      first.id,
      { retry: true },
      t.config,
    );
    assert.equal(retry.jobId, job.jobId);
    assert.equal(
      retryInterviewTranscription(
        t.store,
        t.owner,
        view.session.id,
        first.id,
        { retry: true },
        t.config,
      ).jobId,
      job.jobId,
    );
    assert.equal(
      t.store.all("SELECT * FROM almanac_recovery_actions").length,
      1,
    );
    const restarted = new Store(t.dir);
    try {
      await runInterviewTranscription(restarted, provider, t.config);
    } finally {
      restarted.close();
    }
    assert.equal(calls, 1);
    assert.equal(
      readTurn(t.store, view.session.id, first.id).transcript?.rawText,
      "My dad.",
    );
    assert.equal(
      interviewRecovery(t.store, t.owner, view.session.id, first.id).resumable,
      false,
    );
  } finally {
    t.close();
  }
});

test("manual fallback releases the active slot while retaining the uncertain request and source audio", async () => {
  const t = setup();
  try {
    const s = session(t),
      first = turn(t, s.id);
    audio(t, s.id, first.id);
    const job = queueInterviewTranscription(
      t.store,
      t.owner,
      s.id,
      first.id,
      { processWithOpenAI: true },
      t.config,
    );
    await runInterviewTranscription(
      t.store,
      new OpenAIProvider(t.config, async () => {
        throw new Error("no response");
      }),
      t.config,
    );
    assert.equal(
      interviewRecovery(t.store, t.owner, s.id, first.id).uncertain,
      true,
    );
    assert.throws(
      () =>
        retryInterviewTranscription(
          t.store,
          t.owner,
          s.id,
          first.id,
          { retry: true },
          t.config,
        ),
      /uncertain/,
    );
    saveTurnText(t.store, t.owner, s.id, first.id, { rawText: fixtureText });
    assert.equal(
      t.store.one<{ status: string }>(
        "SELECT status FROM studio_jobs WHERE id=?",
        job.jobId,
      )!.status,
      "superseded",
    );
    assert.equal(
      t.store.one<{ allowance: number }>(
        "SELECT allowance FROM engine_budget WHERE runId=?",
        job.jobId,
      )!.allowance,
      19,
    );
    const next = turn(t, s.id);
    audio(t, s.id, next.id);
    assert.equal(
      queueInterviewTranscription(
        t.store,
        t.owner,
        s.id,
        next.id,
        { processWithOpenAI: true },
        t.config,
      ).status,
      "queued",
    );
    assert.equal(readTurn(t.store, s.id, first.id).audio?.sha256, hash(wav()));
  } finally {
    t.close();
  }
});

test("spoken page naming uses the guarded audio flow and explicit edited title without becoming story material", async () => {
  const t = setup();
  let calls = 0;
  try {
    const pageId = ALMANAC_PAGES[0].id,
      before = pageView(t.store, t.owner, pageId).page;
    const view = startTitleSession(t.store, t.owner, pageId, {
      consent: true,
      processWithOpenAI: true,
      key: "first-title",
    });
    assert.equal(view.session.purpose, "page_title");
    assert.equal(view.aiProcessingConsented, true);
    assert.equal(
      almanacView(t.store, t.owner).titleDrafts[0].id,
      view.session.id,
    );
    assert.equal(almanacView(t.store, t.owner).drafts.length, 0);
    assert.equal(almanacView(t.store, t.other).titleDrafts.length, 0);
    assert.equal(
      pageView(t.store, t.owner, pageId).titleSessions[0].id,
      view.session.id,
    );
    assert.equal(
      startTitleSession(t.store, t.owner, pageId, {
        consent: true,
        processWithOpenAI: true,
        key: "resumed-title-click",
      }).session.id,
      view.session.id,
    );
    assert.equal(
      view.nextPrompt.promptText,
      "What would you like to call this page? A few words are enough.",
    );
    assert.equal(
      startTitleSession(t.store, t.owner, pageId, {
        consent: true,
        processWithOpenAI: true,
        key: "first-title",
      }).session.id,
      view.session.id,
    );
    const answer = startTurn(t.store, t.owner, view.session.id, {
      key: "title-answer",
      promptId: view.nextPrompt.promptId,
    });
    assert.throws(
      () =>
        applyPageTitle(t.store, t.owner, view.session.id, {
          title: "New name",
        }),
      /Finish the page-name/,
    );
    audio(t, view.session.id, answer.id);
    queueInterviewTranscription(
      t.store,
      t.owner,
      view.session.id,
      answer.id,
      { processWithOpenAI: true },
      t.config,
    );
    await runInterviewTranscription(
      t.store,
      new OpenAIProvider(t.config, async () => {
        calls++;
        return Response.json({ text: "Our kitchen table." });
      }),
      t.config,
    );
    assert.equal(calls, 1);
    assert.equal(
      sessionView(t.store, t.owner, view.session.id).nextPrompt.action,
      "finish",
    );
    assert.throws(
      () =>
        startTurn(t.store, t.owner, view.session.id, {
          key: "more",
          promptId: "additional-memory",
        }),
      /question has changed/,
    );
    assert.throws(
      () => freezeSource(t.store, t.owner, view.session.id, { consent: true }),
      /page name cannot be used as a story/,
    );
    assert.throws(
      () =>
        applyPageTitle(t.store, t.other, view.session.id, {
          title: "Other family's name",
        }),
      /not on your shelf/,
    );
    const applied = applyPageTitle(t.store, t.owner, view.session.id, {
      title: "At our kitchen table",
    });
    assert.equal(applied.page.page.title, "At our kitchen table");
    assert.equal(applied.page.page.description, before.description);
    assert.equal(applied.page.page.position, before.position);
    assert.equal(applied.page.page.memoryCount, 0);
    assert.equal(applied.page.page.bookCount, 0);
    assert.equal(
      sessionView(t.store, t.owner, view.session.id).session.status,
      "finished",
    );
    assert.equal(almanacView(t.store, t.owner).titleDrafts.length, 0);
    assert.equal(pageView(t.store, t.owner, pageId).titleSessions.length, 0);
    assert.equal(
      startTitleSession(t.store, t.owner, pageId, {
        consent: true,
        processWithOpenAI: true,
        key: "resumed-title-click",
      }).session.id,
      view.session.id,
    );
    assert.throws(
      () =>
        startSession(t.store, t.owner, pageId, {
          consent: true,
          key: "resumed-title-click",
        }),
      /another memory/,
    );
    assert.equal(
      readTurn(t.store, view.session.id, answer.id).transcript!.rawText,
      "Our kitchen table.",
    );
    assert.equal(
      readTurn(t.store, view.session.id, answer.id).audio!.sha256,
      hash(wav()),
    );
    assert.deepEqual(
      applyPageTitle(t.store, t.owner, view.session.id, {
        title: "At our kitchen table",
      }),
      applied,
    );
    assert.throws(
      () =>
        applyPageTitle(t.store, t.owner, view.session.id, {
          title: "Different name",
        }),
      /already been applied/,
    );
    assert.equal(
      t.store.all(
        "SELECT * FROM almanac_sources WHERE sessionId=?",
        view.session.id,
      ).length,
      0,
    );
    const project = t.store.one<ProjectRow>(
      "SELECT * FROM projects WHERE id=?",
      view.session.projectId,
    )!;
    const restored = restoreArchive(
      t.store,
      t.other,
      exportArchive(t.store, project),
    );
    const restoredSession = exportInterviewArchive(
      t.store,
      restored.id,
    )!.session;
    assert.equal(restoredSession.purpose, "page_title");
    assert.throws(
      () =>
        freezeSource(t.store, t.other, restoredSession.id, { consent: true }),
      /page name cannot be used as a story/,
    );
  } finally {
    t.close();
  }
});

test("page naming cannot consume an ordinary memory and older schemas and archives default to memory", () => {
  const t = setup();
  try {
    const s = session(t),
      answer = turn(t, s.id);
    audio(t, s.id, answer.id);
    saveTurnText(t.store, t.owner, s.id, answer.id, { rawText: fixtureText });
    assert.throws(
      () =>
        applyPageTitle(t.store, t.owner, s.id, {
          title: "Not chosen for naming",
        }),
      /Memory recordings are not reused/,
    );
    t.store.db.exec("ALTER TABLE almanac_sessions DROP COLUMN purpose");
    migrateAlmanac(t.store.db);
    migrateAlmanac(t.store.db);
    assert.equal(sessionView(t.store, t.owner, s.id).session.purpose, "memory");
    const project = t.store.one<ProjectRow>(
      "SELECT * FROM projects WHERE id=?",
      s.projectId,
    )!;
    const payload = JSON.parse(
      gunzipSync(exportArchive(t.store, project)).toString(),
    );
    delete payload.interview.session.purpose;
    delete payload.checksum;
    const older = gzipSync(
      JSON.stringify({ ...payload, checksum: hash(canonical(payload)) }),
    );
    const restored = restoreArchive(t.store, t.other, older);
    assert.equal(
      exportInterviewArchive(t.store, restored.id)!.session.purpose,
      "memory",
    );
  } finally {
    t.close();
  }
});

test("an explicit manual page-name answer can be applied without audio or book generation", () => {
  const t = setup();
  try {
    const naming = startTitleSession(t.store, t.owner, ALMANAC_PAGES[0].id, {
      consent: true,
      processWithOpenAI: true,
      key: "text-only-name",
    });
    const typed = startTurn(t.store, t.owner, naming.session.id, {
      key: "typed",
      promptId: naming.nextPrompt.promptId,
    });
    saveTurnText(t.store, t.owner, naming.session.id, typed.id, {
      rawText: "Our kitchen table",
    });
    const applied = applyPageTitle(t.store, t.owner, naming.session.id, {
      title: "Around our kitchen table",
    });
    assert.equal(applied.title, "Around our kitchen table");
    const after = sessionView(t.store, t.owner, naming.session.id);
    assert.equal(after.session.status, "finished");
    assert.equal(after.session.turns[0].audio, null);
    assert.equal(after.session.turns[0].transcript!.mode, "manual");
    assert.equal(
      after.session.turns[0].transcript!.rawText,
      "Our kitchen table",
    );
    assert.equal(after.session.turns[0].transcript!.recordingId, null);
    assert.equal(after.transcriptHistory.length, 1);
    assert.deepEqual(
      applyPageTitle(t.store, t.owner, naming.session.id, {
        title: "Around our kitchen table",
      }),
      applied,
    );
    for (const table of [
      "recordings",
      "studio_jobs",
      "studio_calls",
      "almanac_sources",
      "revisions",
      "editions",
    ])
      assert.equal(t.store.all(`SELECT * FROM ${table}`).length, 0);
    assert.throws(
      () =>
        freezeSource(t.store, t.owner, naming.session.id, { consent: true }),
      /page name cannot be used as a story/,
    );
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
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    request.on("error", reject);
    if (body !== undefined) request.write(JSON.stringify(body));
    request.end();
  });
}
test("real authenticated routes deny anonymous and other-family interview/audio/source access", async () => {
  const t = setup();
  const server = createApp(t.store, t.config).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    t.store.run(
      "INSERT INTO sessions VALUES(?,?,?)",
      hash("owner-token"),
      t.owner,
      Date.now() + 60000,
    );
    t.store.run(
      "INSERT INTO sessions VALUES(?,?,?)",
      hash("other-token"),
      t.other,
      Date.now() + 60000,
    );
    const first = await http(server, "/api/almanac");
    assert.equal(first.status, 401);
    const created = await http(
      server,
      `/api/almanac/pages/${ALMANAC_PAGES[0].id}/sessions`,
      "POST",
      "evermore=owner-token",
      { consent: true },
    );
    assert.equal(created.status, 201);
    const view = JSON.parse(created.body);
    const s = view.session;
    const item = turn(t, s.id);
    audio(t, s.id, item.id);
    saveTurnText(t.store, t.owner, s.id, item.id, { rawText: fixtureText });
    for (const path of [
      `/api/interviews/${s.id}`,
      `/api/interviews/${s.id}/turns/${item.id}/audio`,
    ]) {
      assert.equal(
        (await http(server, path, "GET", "evermore=other-token")).status,
        404,
      );
      assert.equal((await http(server, path)).status, 401);
    }
    assert.equal(
      (
        await http(
          server,
          `/api/interviews/${s.id}/freeze`,
          "POST",
          "evermore=other-token",
          { consent: true },
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await http(
          server,
          `/api/interviews/${s.id}/turns/${item.id}/text`,
          "POST",
          "evermore=other-token",
          { rawText: "tampered" },
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await http(
          server,
          `/api/interviews/${s.id}/turns/${item.id}/audio`,
          "GET",
          "evermore=owner-token",
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await http(
          server,
          `/api/interviews/${s.id}/freeze`,
          "POST",
          "evermore=owner-token",
          { consent: true },
        )
      ).status,
      200,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    t.close();
  }
});
