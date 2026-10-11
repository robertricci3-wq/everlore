import { authorizeSceneAttempt } from "../src/server/engine/scene-attempt.js";
import { configureAccess } from "../src/server/access.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Store,
  now,
  canonical,
  hash,
  type ProjectRow,
} from "../src/server/store.js";
import { Book, Transcript } from "../src/shared/contracts.js";
import {
  queueStudio,
  familyVersions,
  runStudio,
  studioView,
  confirmStudioSource,
  confirmStudioHeart,
  approveStudioCast,
  approveStudioArt,
  queueRepair,
  studioAllowance,
} from "../src/server/engine/studio.js";
import {
  heartProblems,
  reconcileHeartCues,
  evaluateStory,
  notWorse,
  chooseConcept,
} from "../src/server/engine/editorial.js";
import { explicitAudioCues } from "../src/server/engine/craft.js";
import {
  saveStudioConnection,
  setupView,
  loadStudioConnection,
} from "../src/server/engine/setup.js";
import { engineConfig } from "../src/server/engine/provider.js";
import {
  fixtureSource,
  fixtureHeart,
  fixtureManuscript,
  fixtureAudit,
  fixtureCritic,
  fixtureConcepts,
  StudioFake,
  testConfig,
} from "./support/studio-fixtures.js";
const consent = {
  autonomous: false,
  processWithOpenAI: true,
  imaginativeAdaptation: true,
  legacyWish: "Patient love",
};
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "everlore-v2-")),
    store = new Store(dir);
  store.run(
    "INSERT INTO users VALUES('owner','owner','unused','private',?)",
    now(),
  );
  store.run(
    "INSERT INTO projects VALUES('memory','owner','Test','unavailable','awaiting_transcription',0,NULL,?,?)",
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
    dir,
    store,
    project: () =>
      store.one<ProjectRow>("SELECT * FROM projects WHERE id='memory'")!,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
async function heartGate(store: Store, provider: StudioFake) {
  await runStudio(store, provider, testConfig);
  assert.equal(studioView(store, "memory")!.status, "awaiting_source");
  confirmStudioSource(store, "memory", {
    confirmed: true,
    rawText: fixtureSource,
  });
  await runStudio(store, provider, testConfig);
  const view = studioView(store, "memory")!;
  assert.equal(view.status, "awaiting_heart");
  confirmStudioHeart(store, "memory", {
    heartHash: view.heartHash,
    summary: fixtureHeart.summary,
    emotionalInheritance: fixtureHeart.emotionalInheritance,
    protectedIds: ["n1"],
    adultNotes: "",
    answers: [],
  });
}
async function finish(store: Store, provider: StudioFake) {
  await runStudio(store, provider, testConfig);
  let view = studioView(store, "memory")!;
  if (view.status === "awaiting_cast") {
    approveStudioCast(store, "memory", { approved: true });
    await runStudio(store, provider, testConfig);
    view = studioView(store, "memory")!;
  }
  assert.equal(view.status, "awaiting_art", view.error ?? view.stage);
  approveStudioArt(store, "memory", { approved: true });
  await runStudio(store, provider, testConfig);
  view = studioView(store, "memory")!;
  assert.equal(view.status, "complete", view.error ?? view.stage);
}
test("v2 source → editable heart → three judged drafts → approved cast → book, without replaying completed calls", async () => {
  const t = setup(),
    p = new StudioFake();
  p.firstWeak = true;
  try {
    queueStudio(t.store, t.project(), consent, testConfig);
    await heartGate(t.store, p);
    await finish(t.store, p);
    assert.equal(p.calls.filter((n) => /^draft_\d$/.test(n)).length, 3);
    assert.equal(p.calls.filter((n) => /^refine_\d$/.test(n)).length, 0);
    assert.equal(p.calls.filter((n) => n === "image_new").length, 1);
    assert.equal(
      p.calls.filter((n) => n === "image_with_references").length,
      13,
    );
    const row = t.store.one<{ book: string }>(
      "SELECT book FROM revisions WHERE projectId='memory'",
    )!;
    const book = Book.parse(JSON.parse(row.book));
    assert.equal(book.production!.selectedConceptId, "idea-2");
    assert.equal(
      book.production!.references.every((r) => r.approved),
      true,
    );
    assert.equal(book.production!.humanReview, "pending");
    assert.equal(t.store.all("SELECT * FROM family_versions").length, 1);
    assert.equal(await runStudio(t.store, p, testConfig), false);
    const calls = t.store.all<{ status: string }>(
      "SELECT status FROM studio_calls",
    );
    assert(calls.every((c) => c.status === "completed"));
  } finally {
    t.close();
  }
});
test("heart validation rejects false quotes, invented cues and duplicate ledger entries", () => {
  const source = Transcript.parse({
    version: 1,
    mode: "manual",
    recordingId: "r",
    rawText: fixtureSource,
    segments: [{ id: "s1", text: fixtureSource, startMs: null, endMs: null }],
  });
  assert.deepEqual(heartProblems(fixtureHeart, source), []);
  assert(
    heartProblems(
      {
        ...fixtureHeart,
        nuggets: [{ ...fixtureHeart.nuggets[0], quote: "invented" }],
      },
      source,
    ).length,
  );
  assert(
    heartProblems(
      {
        ...fixtureHeart,
        nuggets: [{ ...fixtureHeart.nuggets[0], emphasis: "explicit_cue" }],
      },
      source,
    ).length,
  );
  assert(
    heartProblems(
      {
        ...fixtureHeart,
        ledger: [...fixtureHeart.ledger, ...fixtureHeart.ledger],
      },
      source,
    ).length,
  );
  const unsupported = {
    ...fixtureHeart,
    nuggets: [
      { ...fixtureHeart.nuggets[0], emphasis: "explicit_cue" as const },
    ],
  };
  const repaired = reconcileHeartCues(unsupported, source);
  assert.deepEqual(heartProblems(repaired.heart, source), []);
  assert.deepEqual(repaired.heart.ledger, unsupported.ledger);
  assert.equal(repaired.heart.nuggets[0].quote, unsupported.nuggets[0].quote);
  assert(
    heartProblems(
      reconcileHeartCues(
        {
          ...unsupported,
          nuggets: [{ ...unsupported.nuggets[0], quote: "invented" }],
        },
        source,
      ).heart,
      source,
    ).length,
  );
  const annotated = {
    ...source,
    segments: [{ ...source.segments[0], text: source.rawText + " [pause]" }],
  };
  assert.equal(
    reconcileHeartCues(unsupported, annotated).correctedIds.length,
    0,
  );
  assert.equal(
    explicitAudioCues("A laugh is not an audio annotation. [long pause]")
      .length,
    1,
  );
});
test("software verdict cannot be charmed by duplicate scores, missing checks or missing literal phrases", () => {
  const good = evaluateStory(
    fixtureHeart,
    fixtureManuscript,
    fixtureAudit,
    fixtureCritic,
  );
  assert(good.passed);
  assert.equal(good.weightedMean, 4);
  for (const audit of [
    { ...fixtureAudit, checks: [] },
    {
      ...fixtureAudit,
      checks: [{ ...fixtureAudit.checks[0], contradicted: true }],
    },
  ])
    assert(
      !evaluateStory(fixtureHeart, fixtureManuscript, audit, fixtureCritic)
        .passed,
    );
  assert(
    !evaluateStory(
      { ...fixtureHeart, protectedPhrases: ["A protected phrase"] },
      fixtureManuscript,
      fixtureAudit,
      fixtureCritic,
    ).passed,
  );
  assert(
    !evaluateStory(fixtureHeart, fixtureManuscript, fixtureAudit, {
      ...fixtureCritic,
      scores: [...fixtureCritic.scores, fixtureCritic.scores[0]],
    }).passed,
  );
  assert(
    !evaluateStory(fixtureHeart, fixtureManuscript, fixtureAudit, {
      ...fixtureCritic,
      scores: fixtureCritic.scores.slice(1),
    }).passed,
  );
  assert(
    !evaluateStory(fixtureHeart, fixtureManuscript, fixtureAudit, {
      ...fixtureCritic,
      genericStory: true,
    }).passed,
  );
  assert(
    !notWorse(
      { ...good, passed: false, heartFailures: ["wrong family"] },
      good,
    ),
  );
});
test("concept selection rejects a flattering duplicate assessment", () => {
  assert.throws(() =>
    chooseConcept(
      fixtureConcepts,
      {
        assessments: Array.from({ length: 3 }, () => ({
          conceptId: "idea-1",
          heartViolations: [],
          childAppeal: 5,
          familySpecificity: 5,
          imaginativePotential: 5,
          evidence: "same",
        })),
      },
      fixtureHeart,
    ),
  );
});
test("weak manuscripts stop after two repair passes before any images", async () => {
  const t = setup(),
    p = new StudioFake();
  p.weak = true;
  p.regress = true;
  try {
    queueStudio(t.store, t.project(), consent, testConfig);
    await heartGate(t.store, p);
    await runStudio(t.store, p, testConfig);
    assert.equal(studioView(t.store, "memory")!.status, "needs_editor");
    assert.equal(p.calls.filter((n) => /^refine_\d$/.test(n)).length, 2);
    assert(!p.calls.some((n) => n.startsWith("image_")));
    const accepted = t.store.one<{ result: string }>(
      "SELECT result FROM studio_steps WHERE stage='accepted_story'",
    )!;
    assert.equal(JSON.parse(accepted.result).verdict.minimum, 3);
  } finally {
    t.close();
  }
});
test("art correction is bounded and never becomes automatic human approval", async () => {
  const t = setup(),
    p = new StudioFake();
  p.weakImages = true;
  try {
    queueStudio(t.store, t.project(), consent, testConfig);
    await heartGate(t.store, p);
    await runStudio(t.store, p, testConfig);
    assert.equal(studioView(t.store, "memory")!.status, "needs_editor");
    assert.equal(p.calls.filter((n) => n.startsWith("image_")).length, 3);
    assert.equal(t.store.all("SELECT * FROM family_versions").length, 0);
  } finally {
    t.close();
  }
});
test("a paid failure is never replayed through a resumed local orchestration stage", async () => {
  const t = setup(),
    p = new StudioFake();
  p.failAt = "draft_1";
  try {
    queueStudio(t.store, t.project(), consent, testConfig);
    await heartGate(t.store, p);
    await runStudio(t.store, p, testConfig);
    assert.equal(studioView(t.store, "memory")!.status, "needs_attention");
    t.store.run("UPDATE studio_jobs SET status='running',leaseUntil=0");
    await runStudio(t.store, p, testConfig);
    assert.equal(p.calls.filter((n) => n === "draft_1").length, 1);
    assert.match(studioView(t.store, "memory")!.error!, /Reconcile/);
    assert.doesNotMatch(
      studioView(t.store, "memory")!.error!,
      /Private response/,
    );
  } finally {
    t.close();
  }
});
test("a wording revision reuses all images, rejects stale requests, and preserves the original revision", async () => {
  const t = setup(),
    p = new StudioFake();
  try {
    queueStudio(t.store, t.project(), consent, testConfig);
    await heartGate(t.store, p);
    await finish(t.store, p);
    const original = t.store.one<{ book: string }>(
        "SELECT book FROM revisions WHERE revision=1",
      )!.book,
      beforeImages = p.calls.filter((n) => n.startsWith("image_")).length;
    const repair = {
      key: crypto.randomUUID(),
      baseRevision: 1,
      kind: "wording",
      spreads: [1],
      characterId: null,
      defect: "Too flat",
      intendedChange: "More warmth",
      preserve: "All events",
    };
    const first = queueRepair(t.store, t.project(), repair, testConfig);
    assert.equal(queueRepair(t.store, t.project(), repair, testConfig), first);
    await finish(t.store, p);
    assert.equal(
      t.store.one<{ book: string }>(
        "SELECT book FROM revisions WHERE revision=1",
      )!.book,
      original,
    );
    assert.equal(
      p.calls.filter((n) => n.startsWith("image_")).length,
      beforeImages,
    );
    const next = Book.parse(
      JSON.parse(
        t.store.one<{ book: string }>(
          "SELECT book FROM revisions WHERE revision=2",
        )!.book,
      ),
    );
    assert.notEqual(next.spreads[0].text, JSON.parse(original).spreads[0].text);
    assert.equal(next.spreads[1].text, JSON.parse(original).spreads[1].text);
    assert.throws(
      () =>
        queueRepair(
          t.store,
          t.project(),
          { ...repair, key: crypto.randomUUID() },
          testConfig,
        ),
      /changed/,
    );
  } finally {
    t.close();
  }
});
test("reservations cover bounded v2 requests and release unattempted work when a project is removed", () => {
  const t = setup();
  try {
    assert.throws(() =>
      queueStudio(t.store, t.project(), consent, {
        ...testConfig,
        budgetCents: studioAllowance(testConfig) - 1,
      }),
    );
    queueStudio(t.store, t.project(), consent, testConfig);
    t.store.deleteProject("memory");
    assert.equal(
      t.store.one<{ allowance: number }>("SELECT allowance FROM engine_budget")!
        .allowance,
      0,
    );
  } finally {
    t.close();
  }
});
test("local connection requires explicit operator authorization, redacts its key and persists privately", () => {
  const t = setup(),
    config = engineConfig({});
  try {
    configureAccess(t.store, false, "owner");
    const body = {
      apiKey: "sk-test-private-never-return",
      budgetUsd: 100,
      audioReserveUsd: 3,
      textReserveUsd: 0.5,
      imageReserveUsd: 0.75,
      authorizeCosts: true,
    };
    assert.throws(() =>
      saveStudioConnection(
        t.store,
        "owner",
        { ...body, authorizeCosts: false },
        config,
      ),
    );
    const view = saveStudioConnection(t.store, "owner", body, config);
    assert(view.ready);
    assert.doesNotMatch(canonical(view), /sk-test/);
    assert.equal(setupView(t.store, "someone-else", config).canManage, false);
    assert.throws(() =>
      saveStudioConnection(t.store, "someone-else", body, config),
    );
    const loaded = engineConfig({});
    loadStudioConnection(t.store, loaded);
    assert.equal(hash(loaded.apiKey), hash(body.apiKey));
  } finally {
    t.close();
  }
});

test("verified archive restore preserves source and editions without restoring paid jobs or secrets", async () => {
  const t = setup(),
    p = new StudioFake();
  try {
    queueStudio(t.store, t.project(), consent, testConfig);
    await heartGate(t.store, p);
    await finish(t.store, p);
    const { exportArchive, restoreArchive } =
      await import("../src/server/archive.js");
    const { renderPdf } = await import("../src/server/layout.js");
    const book = Book.parse(
      JSON.parse(
        t.store.one<{ book: string }>("SELECT book FROM revisions")!.book,
      ),
    );
    const pdf = await renderPdf(book, t.store, "memory"),
      pdfHash = t.store.putAsset("memory", pdf, "pdf");
    t.store.run(
      "INSERT INTO editions VALUES('ed','memory',?,?,?,?,?)",
      book.revision,
      book.contentHash,
      pdfHash,
      JSON.stringify(book),
      now(),
    );
    const archive = exportArchive(t.store, t.project());
    const restored = restoreArchive(t.store, "owner", archive);
    assert.notEqual(restored.id, "memory");
    assert.equal(restored.editions, 1);
    assert.equal(
      t.store.one<{ contentHash: string }>(
        "SELECT contentHash FROM editions WHERE projectId=?",
        restored.id,
      )!.contentHash,
      book.contentHash,
    );
    assert.deepEqual(t.store.readAsset(restored.id, pdfHash), pdf);
    assert.equal(
      t.store.all("SELECT id FROM studio_jobs WHERE projectId=?", restored.id)
        .length,
      0,
    );
    const { gunzipSync, gzipSync } = await import("node:zlib");
    const payload = JSON.parse(gunzipSync(archive).toString());
    assert(!JSON.stringify(payload).includes("apiKey"));
    payload.assets[0].base64 = Buffer.from("tampered").toString("base64");
    const count = t.store.all("SELECT id FROM projects").length;
    assert.throws(() =>
      restoreArchive(t.store, "owner", gzipSync(JSON.stringify(payload))),
    );
    assert.equal(t.store.all("SELECT id FROM projects").length, count);
  } finally {
    t.close();
  }
});

test("a scene repair regenerates only the requested scene and retains canonical references", async () => {
  const t = setup(),
    p = new StudioFake();
  try {
    queueStudio(t.store, t.project(), consent, testConfig);
    await heartGate(t.store, p);
    await finish(t.store, p);
    const before = Book.parse(
      JSON.parse(
        t.store.one<{ book: string }>(
          "SELECT book FROM revisions WHERE revision=1",
        )!.book,
      ),
    );
    const count = p.imageReferenceCounts.length;
    queueRepair(
      t.store,
      t.project(),
      {
        key: crypto.randomUUID(),
        baseRevision: 1,
        kind: "scene",
        spreads: [4],
        characterId: null,
        defect: "Unclear gesture",
        intendedChange: "Show the button clearly",
        preserve: "All characters and other scenes",
      },
      testConfig,
    );
    await finish(t.store, p);
    const after = Book.parse(
      JSON.parse(
        t.store.one<{ book: string }>(
          "SELECT book FROM revisions WHERE revision=2",
        )!.book,
      ),
    );
    assert.equal(p.imageReferenceCounts.length, count + 1);
    assert.equal(p.imageReferenceCounts.at(-1), 2);
    for (let i = 0; i < 12; i++) {
      assert.equal(after.spreads[i].text, before.spreads[i].text);
      assert.equal(
        after.spreads[i].artHash === before.spreads[i].artHash,
        i !== 3,
      );
    }
  } finally {
    t.close();
  }
});

test("a character repair uses the old canon, approves a new version and refreshes all dependent scenes", async () => {
  const t = setup(),
    p = new StudioFake();
  try {
    queueStudio(t.store, t.project(), consent, testConfig);
    await heartGate(t.store, p);
    await finish(t.store, p);
    const before = Book.parse(
      JSON.parse(
        t.store.one<{ book: string }>(
          "SELECT book FROM revisions WHERE revision=1",
        )!.book,
      ),
    );
    const characterId = before.production!.world.characters[0].id,
      count = p.imageReferenceCounts.length;
    queueRepair(
      t.store,
      t.project(),
      {
        key: crypto.randomUUID(),
        baseRevision: 1,
        kind: "character",
        spreads: before.spreads.flatMap((s, i) =>
          s.characterIds.includes(characterId) ? [i + 1] : [],
        ),
        characterId,
        defect: "Wrong outfit",
        intendedChange: "A green apron",
        preserve: "Identity, ages and other family members",
      },
      testConfig,
    );
    await finish(t.store, p);
    const after = Book.parse(
      JSON.parse(
        t.store.one<{ book: string }>(
          "SELECT book FROM revisions WHERE revision=2",
        )!.book,
      ),
    );
    assert.equal(p.imageReferenceCounts[count], 2);
    assert.equal(
      p.imageReferenceCounts.length - count,
      2 +
        before.spreads.filter((s) => s.characterIds.includes(characterId))
          .length,
    );
    assert.equal(t.store.all("SELECT id FROM family_versions").length, 2);
    assert.notEqual(
      before.production!.familyVersionId,
      after.production!.familyVersionId,
    );
    for (let i = 0; i < 12; i++)
      assert.equal(
        after.spreads[i].artHash === before.spreads[i].artHash,
        !before.spreads[i].characterIds.includes(characterId),
      );
    assert.equal(after.production!.world.characters[0].outfit, "Green apron");
  } finally {
    t.close();
  }
});

test("a late studio result cannot publish or change the status of a newer book", async () => {
  const t = setup(),
    p = new StudioFake();
  try {
    queueStudio(t.store, t.project(), consent, testConfig);
    await heartGate(t.store, p);
    await runStudio(t.store, p, testConfig);
    approveStudioCast(t.store, "memory", { approved: true });
    await runStudio(t.store, p, testConfig);
    approveStudioArt(t.store, "memory", { approved: true });
    p.onStructured = (name) => {
      if (name === "whole_book_sequence_review_v2")
        t.store.run(
          "UPDATE projects SET revision=7,title='Newer work',status='ready_for_review' WHERE id='memory'",
        );
    };
    await runStudio(t.store, p, testConfig);
    assert.equal(t.project().revision, 7);
    assert.equal(t.project().title, "Newer work");
    assert.equal(t.project().status, "ready_for_review");
    assert.equal(t.store.all("SELECT * FROM revisions").length, 0);
    assert.equal(studioView(t.store, "memory")!.status, "needs_attention");
  } finally {
    t.close();
  }
});

test("style refinements produce a labeled twelve-image review copy without approving reusable canon", async () => {
  const t = setup(),
    p = new StudioFake();
  p.artRefinements = true;
  try {
    queueStudio(
      t.store,
      t.project(),
      { ...consent, autonomous: true },
      testConfig,
    );
    await runStudio(t.store, p, testConfig);
    assert.equal(studioView(t.store, "memory")!.status, "complete");
    const book = Book.parse(
      JSON.parse(
        t.store.one<{ book: string }>("SELECT book FROM revisions")!.book,
      ),
    );
    assert.equal(book.spreads.length, 12);
    assert.equal(book.production!.artStatus, "revision_recommended");
    assert.deepEqual(book.production!.artNotes, ["Simplify brushwork"]);
    assert(book.production!.references.every((r) => !r.approved));
    assert.equal(t.store.all("SELECT * FROM family_versions").length, 0);
    const reviews = t.store.all<{ result: string }>(
      "SELECT result FROM studio_steps WHERE stage LIKE '%requirements_v4_review_%'",
    );
    assert(reviews.every((r) => JSON.parse(r.result).style === 3));
  } finally {
    t.close();
  }
});

test("a review copy cannot conceal a correctness defect behind generous image scores", async () => {
  const t = setup(),
    p = new StudioFake();
  p.incorrectArt = true;
  try {
    queueStudio(
      t.store,
      t.project(),
      { ...consent, autonomous: true },
      testConfig,
    );
    await runStudio(t.store, p, testConfig);
    assert.equal(studioView(t.store, "memory")!.status, "needs_editor");
    assert.equal(p.calls.filter((n) => n.startsWith("image_")).length, 3);
    assert.equal(t.store.all("SELECT * FROM revisions").length, 0);
    assert.equal(t.store.all("SELECT * FROM family_versions").length, 0);
  } finally {
    t.close();
  }
});

test("one independent art evidence review resolves an unsupported allegation while preserving the original critic", async () => {
  const t = setup(),
    p = new StudioFake();
  p.incorrectArt = true;
  p.dismissArtAllegation = true;
  try {
    queueStudio(
      t.store,
      t.project(),
      { ...consent, autonomous: true },
      testConfig,
    );
    await runStudio(t.store, p, testConfig);
    assert.equal(studioView(t.store, "memory")!.status, "complete");
    assert.equal(p.calls.filter((n) => n.startsWith("image_")).length, 14);
    assert.equal(
      p.calls.filter((n) => n.endsWith("_meaning_review_v2")).length,
      14,
    );
    const raw = JSON.parse(
      t.store.one<{ result: string }>(
        "SELECT result FROM studio_steps WHERE stage='picture_1_requirements_v4_review_1'",
      )!.result,
    );
    assert.deepEqual(raw.correctnessDefects, ["Missing family member"]);
    const resolved = JSON.parse(
      t.store.one<{ result: string }>(
        "SELECT result FROM studio_steps WHERE stage='picture_1_attempt_1_meaning_review_v2'",
      )!.result,
    );
    assert(resolved.actionReadable);
    assert.deepEqual(resolved.protectedContradictions, []);
  } finally {
    t.close();
  }
});

test("autonomous completion atomically saves a downloadable twelve-spread PDF edition", async () => {
  const t = setup(),
    p = new StudioFake();
  try {
    queueStudio(
      t.store,
      t.project(),
      { ...consent, autonomous: true },
      testConfig,
    );
    await runStudio(t.store, p, testConfig);
    assert.equal(studioView(t.store, "memory")!.status, "complete");
    assert.equal(t.project().status, "edition_saved");
    const editions = t.store.all<{
      book: string;
      pdfHash: string;
      contentHash: string;
    }>("SELECT book,pdfHash,contentHash FROM editions");
    assert.equal(editions.length, 1);
    const book = Book.parse(JSON.parse(editions[0].book));
    assert.equal(book.spreads.length, 12);
    assert.equal(book.contentHash, editions[0].contentHash);
    const pdf = t.store.readAsset("memory", editions[0].pdfHash);
    assert.equal(hash(pdf), editions[0].pdfHash);
    const { PDFDocument } = await import("pdf-lib");
    assert((await PDFDocument.load(pdf)).getPageCount() >= 15);
    assert.equal(await runStudio(t.store, p, testConfig), false);
    assert.equal(t.store.all("SELECT * FROM editions").length, 1);
  } finally {
    t.close();
  }
});

test("an autonomous family book draws on its existing total allowance without a second per-book top-up", async () => {
  const t = setup(),
    p = new StudioFake();
  try {
    queueStudio(
      t.store,
      t.project(),
      { ...consent, autonomous: true },
      testConfig,
    );
    t.store.run("UPDATE studio_jobs SET allowance=100");
    t.store.run("UPDATE engine_budget SET allowance=100");
    await runStudio(t.store, p, testConfig);
    assert.equal(studioView(t.store, "memory")!.status, "complete");
    const events = t.store.all<{ result: string }>(
      "SELECT result FROM studio_steps WHERE stage LIKE 'budget_allocation_%'",
    );
    assert(events.length > 0);
    assert(
      events.every(
        (e) =>
          JSON.parse(e.result).totalAuthorizedCents === testConfig.budgetCents,
      ),
    );
    const held = t.store.one<{ total: number }>(
      "SELECT sum(allowance) total FROM engine_budget",
    )!.total;
    assert(held <= testConfig.budgetCents);
  } finally {
    t.close();
  }
});

test("drawing from existing allowance never exceeds the authorized total or dispatches the blocked request", async () => {
  const t = setup(),
    p = new StudioFake();
  try {
    queueStudio(
      t.store,
      t.project(),
      { ...consent, autonomous: true },
      testConfig,
    );
    t.store.run("UPDATE studio_jobs SET allowance=100");
    t.store.run("UPDATE engine_budget SET allowance=100");
    await runStudio(t.store, p, { ...testConfig, budgetCents: 100 });
    assert.equal(studioView(t.store, "memory")!.status, "needs_attention");
    assert.deepEqual(p.calls, ["transcription"]);
    assert.equal(
      t.store.one<{ total: number }>(
        "SELECT sum(estimatedCents) total FROM studio_calls",
      )!.total,
      100,
    );
    assert.equal(
      t.store.all(
        "SELECT * FROM studio_steps WHERE stage LIKE 'budget_allocation_%'",
      ).length,
      0,
    );
  } finally {
    t.close();
  }
});

// Suggest the last cast this family actually used, without rewriting any edition.
test("saved animal families prefer recent use over recent creation and stay owner-scoped", () => {
  const f = setup();
  try {
    for (const cast of ["familiar", "newer"])
      f.store.run(
        "INSERT INTO family_versions VALUES(?, 'owner', ?, '{}', '[]', ?)",
        cast,
        cast,
        now(),
      );
    f.store.run(
      "INSERT INTO users VALUES('other','other','unused','private',?)",
      now(),
    );
    f.store.run(
      "INSERT INTO family_versions VALUES('private','other','Private','{}','[]',?)",
      now(),
    );
    assert.deepEqual(
      familyVersions(f.store, "owner").map((c) => c.id),
      ["newer", "familiar"],
    );
    f.store.run(
      "INSERT INTO studio_jobs VALUES('used','memory',0,'generation','completed','done','{}',?,'{}',0,0,NULL,NULL,?)",
      JSON.stringify({ familyVersionId: "familiar" }),
      now(),
    );
    assert.deepEqual(
      familyVersions(f.store, "owner").map((c) => c.id),
      ["familiar", "newer"],
    );
  } finally {
    f.close();
  }
});


test("an exhausted non-preview scene retains its failure while independent pages finish", async () => {
  const t = setup(), p = new StudioFake();
  p.onStructured = (name) => { p.incorrectArt = name.startsWith("picture_7_"); };
  try {
    queueStudio(t.store, t.project(), { ...consent, autonomous: true }, testConfig);
    await runStudio(t.store, p, testConfig);
    assert.equal(studioView(t.store, "memory")!.status, "needs_editor");
    const pages = t.store.all<{ stage: string; result: string }>(
      "SELECT stage,result FROM studio_steps WHERE stage LIKE 'accepted_picture_meaning_v2_%' AND state='completed'",
    );
    assert.equal(pages.length, 12);
    assert.equal(pages.filter(r => r.result !== "null").length, 11);
    assert.equal(pages.find(r => r.stage.endsWith("_7"))!.result, "null");
    assert.equal(t.store.all("SELECT * FROM revisions").length, 0);
    assert.equal(p.calls.filter(n => n.startsWith("image_")).length, 16);
    const before = p.calls.length;
    t.store.run("UPDATE studio_jobs SET status='queued'");
    await runStudio(t.store, p, testConfig);
    assert.equal(p.calls.length, before);
    assert.equal(studioView(t.store, "memory")!.status, "needs_editor");
  } finally { t.close(); }
});

for (const resolves of [false, true]) test(`one explicitly authorized scene attempt stays bounded (resolves=${resolves})`, async () => {
  const t = setup(), p = new StudioFake();
  p.onStructured = name => { p.incorrectArt = name.startsWith("picture_7_"); };
  try {
    configureAccess(t.store, false, "owner");
    queueStudio(t.store, t.project(), { ...consent, autonomous: true }, testConfig);
    await runStudio(t.store, p, testConfig);
    const job = t.store.one<{ id: string }>("SELECT id FROM studio_jobs")!;
    const direction = "Show two unmistakably separate homes, retaining the scene action and canonical characters.";
    assert.throws(() => authorizeSceneAttempt(t.store, job.id, "other", 7, direction));
    assert.throws(() => authorizeSceneAttempt(t.store, job.id, "owner", 8, direction));
    const approval = authorizeSceneAttempt(t.store, job.id, "owner", 7, direction);
    assert.deepEqual(authorizeSceneAttempt(t.store, job.id, "owner", 7, direction), approval);
    assert.throws(() => authorizeSceneAttempt(t.store, job.id, "owner", 7, direction + " changed"));
    if (resolves) p.onStructured = () => { p.incorrectArt = false; };
    const before = p.calls.filter(n => n.startsWith("image_")).length;
    t.store.run("UPDATE studio_jobs SET status='queued'");
    await runStudio(t.store, p, testConfig);
    assert.equal(p.calls.filter(n => n.startsWith("image_")).length, before + 1);
    assert.equal(studioView(t.store, "memory")!.status, resolves ? "complete" : "needs_editor");
    assert.equal(t.store.one<{ result: string }>("SELECT result FROM studio_steps WHERE stage='accepted_picture_meaning_v2_7'")!.result, "null");
    assert.equal(t.store.all("SELECT * FROM revisions").length, resolves ? 1 : 0);
    if (!resolves) {
      const calls = p.calls.length;
      t.store.run("UPDATE studio_jobs SET status='queued'");
      await runStudio(t.store, p, testConfig);
      assert.equal(p.calls.length, calls);
    }
  } finally { t.close(); }
});


test("semantic correction forwards correctness findings separately from artistic notes", async () => {
  const t = setup(), p = new StudioFake();
  const original = p.structured.bind(p);
  p.structured = async (name, schema, instructions, data, images) => {
    if (name.includes("requirements_v4_review")) p.incorrectArt = true;
    const result = await original(name, schema, instructions, data, images);
    if (name.includes("requirements_v4_review")) return { ...result, defects: ["Simplify brushwork"], correctnessDefects: ["Remove the invented extra child"] };
    return result;
  };
  try {
    queueStudio(t.store, t.project(), { ...consent, autonomous: true }, testConfig);
    await runStudio(t.store, p, testConfig);
    assert.equal(p.imagePrompts.length, 3);
    for (const prompt of p.imagePrompts.slice(1)) {
      assert(prompt.includes("Remove the invented extra child"));
      assert(prompt.includes("Simplify brushwork"));
    }
  } finally { t.close(); }
});

for (const matches of [false, true]) test(`identity-scope adjudication is bounded and never renders another image (matches=${matches})`, async () => {
  const t = setup(), p = new StudioFake(), original = p.structured.bind(p);
  p.onStructured = name => { p.incorrectArt = name.startsWith("picture_7_"); };
  p.structured = async (name, schema, instructions, data, images) => {
    if (name.endsWith("_identity_scope_v1")) {
      p.calls.push(name);
      const d = data as { expectedCharacters: { id:string }[] };
      return schema.parse({characters:d.expectedCharacters.map(c=>({id:c.id,recognizable:matches,evidence:"Synthetic canonical comparison"})),unexpectedNamedCharacters:[],materialContradictions:[],actionReadable:true,physicalCoherence:true,childAppropriate:true});
    }
    const result = await original(name,schema,instructions,data,images);
    if (name.includes("authorized_extra") && name.endsWith("_meaning_review_v2")) {
      const d = data as {expectedCharacterIds:string[]};
      return schema.parse({...result,visibleCharacterIds:d.expectedCharacterIds,unexpectedForegroundCharacters:[],identityConsistent:false,protectedContradictions:[]});
    }
    return result;
  };
  try {
    configureAccess(t.store,false,"owner");
    queueStudio(t.store,t.project(),{...consent,autonomous:true},testConfig);
    await runStudio(t.store,p,testConfig);
    const job=t.store.one<{id:string}>("SELECT id FROM studio_jobs")!;
    authorizeSceneAttempt(t.store,job.id,"owner",7,"One targeted correction with stable canonical identities.");
    t.store.run("UPDATE studio_jobs SET status='queued'");
    await runStudio(t.store,p,testConfig);
    assert.equal(p.calls.filter(n=>n.endsWith("_identity_scope_v1")).length,1);
    assert.equal(p.calls.filter(n=>n.startsWith("image_")).length,17);
    assert.equal(studioView(t.store,"memory")!.status,matches?"complete":"needs_editor");
    if (!matches) {
      const count=p.calls.length;
      t.store.run("UPDATE studio_jobs SET status='queued'");
      await runStudio(t.store,p,testConfig);
      assert.equal(p.calls.length,count);
    }
  } finally { t.close(); }
});

for (const completeCoverage of [false,true]) test(`whole-book inspection uses twelve story images and requires complete evidence (${completeCoverage})`,async()=>{
 const t=setup(),p=new StudioFake(),original=p.structured.bind(p);
 p.structured=async(name,schema,instructions,data,images)=>{
  if(name.startsWith("whole_book_sequence_")) {
   assert.equal(images!.length,12);
   const expected=Array.from({length:12},(_,i)=>JSON.parse(t.store.one<{result:string}>("SELECT result FROM studio_steps WHERE stage=?",`accepted_picture_meaning_v2_${i+1}`)!.result));
   assert.deepEqual(images!.map(hash),expected);
  }
  const result=await original(name,schema,instructions,data,images);
  if(name==="whole_book_sequence_review_v2") return schema.parse({...result,physicalCoherence:3,defects:["Inspect contact at read-aloud size"],correctnessDefects:["Possible contact ambiguity"]});
  if(name==="whole_book_sequence_meaning_v3"&&!completeCoverage){const r=result as {spreads:{spread:number}[]};r.spreads[11].spread=1;return schema.parse(r);}
  return result;
 };
 try {
  queueStudio(t.store,t.project(),{...consent,autonomous:true},testConfig);
  await runStudio(t.store,p,testConfig);
  assert.equal(studioView(t.store,"memory")!.status,completeCoverage?"complete":"needs_editor");
  const raw=JSON.parse(t.store.one<{result:string}>("SELECT result FROM studio_steps WHERE stage=?","whole_book_sequence_review_v2")!.result);
  assert.equal(raw.physicalCoherence,3);
 }finally{t.close();}
});
