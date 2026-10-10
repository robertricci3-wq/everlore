import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  Store,
  now,
  canonical,
  hash,
  type ProjectRow,
} from "../src/server/store.js";
import { Transcript, Book } from "../src/shared/contracts.js";
import {
  pinStudioContinuity,
  rememberContinuityCast,
  resolveContinuity,
  indexPriorContinuity,
  continuityFamilies,
  rememberStoryContinuity,
} from "../src/server/engine/continuity.js";
import {
  queueStudio,
  runStudio,
  studioView,
  answerStudioContinuity,
} from "../src/server/engine/studio.js";
import {
  fixtureSource,
  fixtureHeart,
  fixtureWorld,
  StudioFake,
  testConfig,
} from "./support/studio-fixtures.js";
import { exportArchive, restoreArchive } from "../src/server/archive.js";
import { gunzipSync, gzipSync } from "node:zlib";

function source(rawText = fixtureSource) {
  return Transcript.parse({
    version: 1,
    mode: "manual",
    rawText,
    recordingId: null,
    segments: [{ id: "s1", text: rawText, startMs: null, endMs: null }],
  });
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "everlore-continuity-"));
  const store = new Store(dir);
  for (const owner of ["owner", "other"])
    store.run(
      "INSERT INTO users VALUES(?,?, 'unused','private',?)",
      owner,
      owner,
      now(),
    );
  function project(projectId: string, owner = "owner", text = fixtureSource) {
    store.run(
      "INSERT INTO projects VALUES(?,?,?,'manual','awaiting_editorial',0,?,?,?)",
      projectId,
      owner,
      "Test",
      JSON.stringify(source(text)),
      now(),
      now(),
    );
    return store.one<ProjectRow>(
      "SELECT * FROM projects WHERE id=?",
      projectId,
    )!;
  }
  project("memory");
  function cast(
    familyId: string,
    world = fixtureWorld,
    owner = "owner",
    text = fixtureSource,
  ) {
    const digest = store.putAsset(
      "memory",
      `approved reference ${familyId}`,
      "art",
    );
    store.run(
      "INSERT INTO family_versions VALUES(?,?,?,?,?,?)",
      familyId,
      owner,
      world.name,
      JSON.stringify(world),
      JSON.stringify([
        { hash: digest, role: "identity", approved: true, approval: "machine" },
      ]),
      now(),
    );
    store.run("INSERT INTO family_assets VALUES(?,?)", familyId, digest);
    rememberContinuityCast(store, owner, familyId, world, source(text));
    return familyId;
  }
  return {
    store,
    project,
    cast,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const consent = {
  processWithOpenAI: true,
  imaginativeAdaptation: true,
  continuityMode: "auto",
};

test("server automatic reuse is frozen, owner scoped, and legacy omitted mode stays explicit", () => {
  const t = setup();
  try {
    t.cast("first");
    t.cast("private", fixtureWorld, "other");
    const pin = pinStudioContinuity(t.store, "owner", "auto");
    assert.deepEqual(pin.familyVersionIds, ["first"]);
    const jobId = queueStudio(
      t.store,
      t.store.one<ProjectRow>("SELECT * FROM projects WHERE id='memory'")!,
      consent,
      testConfig,
      undefined,
      pin,
    );
    t.cast("later");
    const request = JSON.parse(
      t.store.one<{ request: string }>(
        "SELECT request FROM studio_jobs WHERE id=?",
        jobId,
      )!.request,
    );
    assert.deepEqual(request.continuity.familyVersionIds, ["first"]);
    assert.equal(
      queueStudio(
        t.store,
        t.store.one<ProjectRow>("SELECT * FROM projects WHERE id='memory'")!,
        consent,
        testConfig,
      ),
      jobId,
    );
    assert.throws(
      () => pinStudioContinuity(t.store, "owner", "specific", "private"),
      /not available/,
    );
    const legacy = queueStudio(
      t.store,
      t.project("legacy"),
      { processWithOpenAI: true, imaginativeAdaptation: true },
      testConfig,
    );
    const old = JSON.parse(
      t.store.one<{ request: string }>(
        "SELECT request FROM studio_jobs WHERE id=?",
        legacy,
      )!.request,
    );
    assert.equal(old.continuity, undefined);
    assert.equal(old.familyVersionId, null);
  } finally {
    t.close();
  }
});

test("a book selects only its source cast, retains approved identities, and versions explicit age changes", () => {
  const t = setup();
  try {
    t.cast("family");
    const old = fixtureWorld.characters[0];
    const pin = pinStudioContinuity(t.store, "owner", "auto");
    const candidate = {
      ...fixtureWorld,
      characters: [{ ...old, species: "rabbit", bodyColors: "pink" }],
      objects: [],
    };
    const resolved = resolveContinuity(
      t.store,
      "owner",
      pin,
      candidate,
      source(),
      { questions: [], responses: {} },
    );
    assert.equal(resolved.question, null);
    assert.equal(resolved.world.characters.length, 1);
    assert.deepEqual(resolved.world.characters[0], old);
    assert.equal(resolved.reuseFamilyVersionId, "family");
    const ageCandidate = {
      ...candidate,
      characters: [
        {
          ...old,
          depictedAge: 8,
          ageState: "child",
          proportions: "small child",
        },
      ],
    };
    const ageSource = source(`${old.name} was 8 when the gate opened.`);
    const ageQuestion = resolveContinuity(
      t.store,
      "owner",
      pin,
      ageCandidate,
      ageSource,
      { questions: [], responses: {} },
    ).question!;
    assert.equal(ageQuestion.kind, "identity");
    const aged = resolveContinuity(
      t.store,
      "owner",
      pin,
      ageCandidate,
      ageSource,
      {
        questions: [ageQuestion],
        responses: {
          [ageQuestion.id]: {
            answerId: ageQuestion.options[0].id,
            key: crypto.randomUUID(),
          },
        },
      },
    );
    assert.equal(aged.world.characters[0].depictedAge, 8);
    assert.equal(aged.world.characters[0].species, old.species);
    assert.equal(aged.reuseFamilyVersionId, null);
    assert.equal(aged.referenceFamilies[0].id, "family");
    assert.equal(
      JSON.parse(
        t.store.one<{ world: string }>(
          "SELECT world FROM family_versions WHERE id='family'",
        )!.world,
      ).characters[0].depictedAge,
      old.depictedAge,
    );
    const newPerson = {
      ...old,
      id: "leo",
      name: "Leo",
      relationship: "neighbor",
    };
    const expanded = resolveContinuity(
      t.store,
      "owner",
      pin,
      { ...fixtureWorld, characters: [old, newPerson] },
      source(`${old.name} and Leo waited by the gate.`),
      { questions: [], responses: {} },
    );
    assert.equal(expanded.world.characters.length, 2);
    assert.equal(expanded.reuseFamilyVersionId, null);
    assert.equal(
      expanded.bindings.find((b) => b.characterId === "leo")!.personId,
      null,
    );
  } finally {
    t.close();
  }
});

test("same names never silently merge distinct people; uncertain answers create no identity claim", () => {
  const t = setup();
  try {
    t.cast("one");
    const old = fixtureWorld.characters[0];
    t.cast("two", {
      ...fixtureWorld,
      characters: [{ ...old, relationship: "neighbor" }],
    });
    const pin = pinStudioContinuity(t.store, "owner", "auto");
    const candidate = { ...fixtureWorld, characters: [old] };
    const state = { questions: [], responses: {} };
    const unresolved = resolveContinuity(
      t.store,
      "owner",
      pin,
      candidate,
      source(),
      state,
    );
    assert.equal(unresolved.question?.kind, "identity");
    assert.equal(unresolved.question?.options.length, 3);
    const response = {
      [unresolved.question!.id]: {
        answerId: "unspecified",
        key: crypto.randomUUID(),
      },
    };
    const unspecified = resolveContinuity(
      t.store,
      "owner",
      pin,
      candidate,
      source(),
      { questions: [unresolved.question!], responses: response },
    );
    assert.equal(unspecified.question, null);
    assert.equal(unspecified.bindings[0].remember, false);
    const absent = resolveContinuity(
      t.store,
      "owner",
      pin,
      candidate,
      source("An unnamed person waited."),
      state,
    );
    assert.equal(absent.bindings.length, 0);
    assert.equal(absent.referenceFamilies.length, 0);
  } finally {
    t.close();
  }
});

test("automatic identity needs direct source relationship evidence and rejects distinct, uncertain and invented roles", () => {
  const t = setup();
  try {
    const cousin = {
      ...fixtureWorld.characters[0],
      relationship: "cousin",
      depictedAge: 5,
    };
    const world = { ...fixtureWorld, characters: [cousin] };
    t.cast("cousin", world, "owner", `My cousin ${cousin.name} picked apples.`);
    const pin = pinStudioContinuity(t.store, "owner", "auto");
    const resolve = (text: string, candidate = world) =>
      resolveContinuity(t.store, "owner", pin, candidate, source(text), {
        questions: [],
        responses: {},
      });
    const ordinary = resolve(`My cousin ${cousin.name} brought pears.`);
    assert.equal(ordinary.question, null);
    assert.equal(ordinary.reuseFamilyVersionId, "cousin");
    for (const text of [
      `A different ${cousin.name}, also my cousin, brought pears.`,
      `I am not sure whether ${cousin.name} was my cousin.`,
      `This was not my cousin ${cousin.name}.`,
      `${cousin.name} was my cousin's daughter.`,
      `${cousin.name} brought pears.`,
      `${cousin.name} waited while my cousin brought pears.`,
    ]) {
      const result = resolve(text);
      assert.equal(result.question?.kind, "identity", text);
      assert.equal(result.bindings[0].personId, null, text);
    }
    const wrongPersonAge = resolve(
      `My cousin ${cousin.name} waited while Ada was 8.`,
      { ...world, characters: [{ ...cousin, depictedAge: 8 }] },
    );
    assert.equal(wrongPersonAge.question, null);
    assert.equal(wrongPersonAge.world.characters[0].depictedAge, 5);
    const actualAge = resolve(
      `My cousin ${cousin.name} was 8 when we picked pears.`,
      { ...world, characters: [{ ...cousin, depictedAge: 8 }] },
    );
    assert.equal(actualAge.world.characters[0].depictedAge, 8);
    assert.equal(actualAge.reuseFamilyVersionId, null);
  } finally {
    t.close();
  }
});

test("an explicitly unlinked identity stays unlinked when legacy backfill sees its completed book", () => {
  const t = setup();
  try {
    const world = { ...fixtureWorld, characters: [fixtureWorld.characters[0]] };
    const digest = t.store.putAsset(
      "memory",
      "approved reference for unsure person",
      "art",
    );
    t.store.run(
      "INSERT INTO family_versions VALUES('unsure','owner',?,?,?,?)",
      world.name,
      JSON.stringify(world),
      JSON.stringify([{ hash: digest, role: "identity", approved: true }]),
      now(),
    );
    t.store.run("INSERT INTO family_assets VALUES('unsure',?)", digest);
    const transcript = source();
    rememberContinuityCast(t.store, "owner", "unsure", world, transcript, [
      {
        characterId: world.characters[0].id,
        personId: null,
        remember: false,
        evidence: {
          sourceHash: hash(canonical(transcript)),
          sourceId: "s1",
          quote: fixtureSource,
        },
      },
    ]);
    assert.equal(
      t.store.all(
        "SELECT * FROM continuity_cast WHERE familyVersionId='unsure'",
      ).length,
      0,
    );
    t.store.run(
      "INSERT INTO revisions VALUES('memory',1,?,'synthetic')",
      JSON.stringify({ transcript, production: { familyVersionId: "unsure" } }),
    );
    indexPriorContinuity(
      t.store,
      "owner",
      continuityFamilies(t.store, "owner", {
        mode: "auto",
        familyVersionIds: ["unsure"],
      }),
    );
    assert.equal(
      t.store.all(
        "SELECT * FROM continuity_cast WHERE familyVersionId='unsure'",
      ).length,
      0,
    );
  } finally {
    t.close();
  }
});

test("same-name identity choices carry distinct remembered context and exclude other owners", () => {
  const t = setup();
  try {
    const character = { ...fixtureWorld.characters[0], relationship: "cousin" };
    const world = { ...fixtureWorld, characters: [character] };
    t.cast(
      "apples",
      world,
      "owner",
      `My cousin ${character.name} picked apples beside the old barn.`,
    );
    t.cast(
      "pears",
      world,
      "owner",
      `My cousin ${character.name} brought pears to the red cottage.`,
    );
    t.cast(
      "secret",
      world,
      "other",
      `My cousin ${character.name} kept a PRIVATE OTHER OWNER SECRET.`,
    );
    const result = resolveContinuity(
      t.store,
      "owner",
      pinStudioContinuity(t.store, "owner", "auto"),
      world,
      source(`My cousin ${character.name} walked home.`),
      { questions: [], responses: {} },
    );
    const options = result.question!.options;
    assert.equal(options.length, 3);
    assert(options.some((option) => option.detail?.includes("old barn")));
    assert(options.some((option) => option.detail?.includes("red cottage")));
    assert(!JSON.stringify(options).includes("PRIVATE OTHER OWNER SECRET"));
  } finally {
    t.close();
  }
});

test("deleting the source removes private continuity excerpts and requires fresh identity confirmation", () => {
  const t = setup();
  try {
    t.cast("family");
    t.cast("foreign", fixtureWorld, "other");
    const foreign = t.store.all(
      "SELECT * FROM continuity_cast WHERE familyVersionId='foreign'",
    );
    t.store.deleteProject("memory");
    const retained = t.store.all<{ evidence: string }>(
      "SELECT evidence FROM continuity_cast WHERE familyVersionId='family'",
    );
    assert.equal(retained.length, fixtureWorld.characters.length);
    for (const record of retained)
      assert.deepEqual(JSON.parse(record.evidence), {
        sourceHash: "",
        sourceId: "",
        quote: "",
      });
    assert.deepEqual(
      t.store.all(
        "SELECT * FROM continuity_cast WHERE familyVersionId='foreign'",
      ),
      foreign,
    );
    const result = resolveContinuity(
      t.store,
      "owner",
      pinStudioContinuity(t.store, "owner", "auto"),
      fixtureWorld,
      source(),
      { questions: [], responses: {} },
    );
    assert.equal(result.question?.kind, "identity");
    assert(!JSON.stringify(result.question).includes(fixtureSource));
    assert.match(
      result.question!.options[0].detail!,
      /original memory was removed/,
    );
    assert.equal(
      t.store.all(
        "SELECT * FROM continuity_cast WHERE familyVersionId='family' AND evidence LIKE '%three blue%'",
      ).length,
      0,
    );
  } finally {
    t.close();
  }
});

test("deleting an earlier source rebases identity evidence only to its surviving owner-scoped book", () => {
  const t = setup();
  try {
    t.cast("family");
    const survivingText =
      "Ada and Nell returned to the garden. This is the surviving source.";
    t.project("surviving", "owner", survivingText);
    const transcript = source(survivingText);
    const book = JSON.stringify({
      transcript,
      sourceHash: hash(canonical(transcript)),
      title: "Surviving source",
      production: { familyVersionId: "family" },
    });
    t.store.run("INSERT INTO revisions VALUES('surviving',1,?,'saved')", book);
    rememberStoryContinuity(t.store, "surviving", 1, "family", fixtureWorld);
    const pdfHash = t.store.putAsset("surviving", "Preserved PDF bytes", "pdf");
    t.store.run(
      "INSERT INTO editions VALUES('saved','surviving',1,'saved',?,?,?)",
      pdfHash,
      book,
      now(),
    );
    const edition = t.store.one("SELECT * FROM editions WHERE id='saved'");
    t.store.deleteProject("memory");
    for (const record of t.store.all<{ evidence: string }>(
      "SELECT evidence FROM continuity_cast WHERE familyVersionId='family'",
    )) {
      const evidence = JSON.parse(record.evidence);
      assert.equal(evidence.quote, survivingText);
      assert.equal(evidence.sourceHash, hash(canonical(transcript)));
      assert(!record.evidence.includes("three blue coat buttons"));
    }
    assert.deepEqual(
      t.store.one("SELECT * FROM editions WHERE id='saved'"),
      edition,
    );
    assert.equal(
      t.store.readAsset("surviving", pdfHash).toString(),
      "Preserved PDF bytes",
    );
    const result = resolveContinuity(
      t.store,
      "owner",
      pinStudioContinuity(t.store, "owner", "auto"),
      fixtureWorld,
      transcript,
      { questions: [], responses: {} },
    );
    assert.equal(result.question, null);
  } finally {
    t.close();
  }
});

test("deleting an unfinished legacy audio job also scrubs the source held only in its durable state", () => {
  const t = setup();
  try {
    t.cast("family");
    t.store.run("UPDATE projects SET transcript=NULL WHERE id='memory'");
    t.store.run(
      "INSERT INTO studio_jobs(id,projectId,baseRevision,kind,status,stage,request,state,profile,allowance,createdAt) VALUES('unfinished','memory',0,'generation','needs_editor','references','{}',?,'test',0,?)",
      JSON.stringify({ source: source(), familyVersionId: "family" }),
      now(),
    );
    t.store.deleteProject("memory");
    for (const row of t.store.all<{ evidence: string }>(
      "SELECT evidence FROM continuity_cast WHERE familyVersionId='family'",
    ))
      assert.equal(JSON.parse(row.evidence).quote, "");
  } finally {
    t.close();
  }
});

test("deleting a source removes copied option excerpts from other owned jobs while preserving choices and answers", () => {
  const t = setup();
  try {
    t.cast("family");
    const person = t.store.one<{ personId: string }>(
      "SELECT personId FROM continuity_cast WHERE familyVersionId='family'",
    )!.personId;
    const question = {
      id: "identity-saved",
      kind: "identity",
      prompt: "Which Nell is in this memory?",
      options: [
        {
          id: person,
          label: "Nell — cousin",
          detail: `Earlier book. “${fixtureSource}”`,
        },
        { id: "new", label: "Someone else" },
      ],
      allowUnspecified: true,
    };
    const responses = {
      "identity-saved": { answerId: person, key: "preserved-answer" },
    };
    const originalState = {
      continuity: { questions: [question], responses },
      otherSavedProgress: "keep",
    };
    for (const [projectId, owner] of [
      ["pending", "owner"],
      ["foreign", "other"],
    ]) {
      t.project(projectId, owner, "A different source for this job.");
      t.store.run(
        "INSERT INTO studio_jobs(id,projectId,baseRevision,kind,status,stage,request,state,profile,allowance,createdAt) VALUES(?,?,0,'generation','awaiting_continuity','world','{}',?,'test',0,?)",
        `${projectId}-job`,
        projectId,
        JSON.stringify(originalState),
        now(),
      );
    }
    t.store.deleteProject("memory");
    const owned = JSON.parse(
      t.store.one<{ state: string }>(
        "SELECT state FROM studio_jobs WHERE id='pending-job'",
      )!.state,
    );
    const foreign = JSON.parse(
      t.store.one<{ state: string }>(
        "SELECT state FROM studio_jobs WHERE id='foreign-job'",
      )!.state,
    );
    assert.equal(owned.continuity.questions[0].options[0].detail, undefined);
    assert.equal(
      owned.continuity.questions[0].options[0].label,
      question.options[0].label,
    );
    assert.equal(owned.continuity.questions[0].prompt, question.prompt);
    assert.deepEqual(owned.continuity.responses, responses);
    assert.equal(owned.otherSavedProgress, "keep");
    assert.deepEqual(foreign, originalState);
    assert(!JSON.stringify(owned).includes(fixtureSource));
  } finally {
    t.close();
  }
});

test("two autonomous books reuse approved cast references and save separate immutable editions", async () => {
  const t = setup();
  try {
    const firstProvider = new StudioFake();
    queueStudio(
      t.store,
      t.store.one<ProjectRow>("SELECT * FROM projects WHERE id='memory'")!,
      consent,
      testConfig,
    );
    await runStudio(t.store, firstProvider, testConfig);
    assert.equal(
      studioView(t.store, "memory")!.status,
      "complete",
      studioView(t.store, "memory")!.error ?? "",
    );
    const before = t.store.one<{ book: string; pdfHash: string }>(
      "SELECT book,pdfHash FROM editions WHERE projectId='memory'",
    )!;
    const first = Book.parse(JSON.parse(before.book));
    const nextProvider = new StudioFake();
    queueStudio(t.store, t.project("next"), consent, testConfig);
    await runStudio(t.store, nextProvider, testConfig);
    assert.equal(
      studioView(t.store, "next")!.status,
      "complete",
      studioView(t.store, "next")!.error ?? "",
    );
    const second = Book.parse(
      JSON.parse(
        t.store.one<{ book: string }>(
          "SELECT book FROM editions WHERE projectId='next'",
        )!.book,
      ),
    );
    assert.equal(
      second.production!.familyVersionId,
      first.production!.familyVersionId,
    );
    assert.deepEqual(
      second.production!.references,
      first.production!.references,
    );
    assert.equal(nextProvider.imageReferenceCounts.length, 12);
    assert.deepEqual(
      t.store.one("SELECT book,pdfHash FROM editions WHERE projectId='memory'"),
      before,
    );
    assert.equal(
      t.store.all("SELECT * FROM continuity_story_uses").length,
      fixtureWorld.characters.length * 2,
    );
  } finally {
    t.close();
  }
});

test("a consequential relationship question is answerable and retries do not replay completed provider calls", async () => {
  const t = setup();
  class QuestionProvider extends StudioFake {
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
          questions: [
            {
              id: "relationship",
              question: "How is Ada related to Nell?",
              whyItMatters: "Keep the central relationship true.",
              essential: true,
              answer: "",
            },
          ],
        });
      }
      if (name === "heart_questions_v1") {
        this.calls.push(name);
        return schema.parse({
          decisions: [
            {
              id: "relationship",
              kind: "blocking_relationship",
              decision:
                "The source does not establish the central relationship.",
            },
          ],
        });
      }
      return super.structured(name, schema, instructions, data, images);
    }
  }
  try {
    const p = new QuestionProvider();
    queueStudio(
      t.store,
      t.store.one<ProjectRow>("SELECT * FROM projects WHERE id='memory'")!,
      consent,
      testConfig,
    );
    await runStudio(t.store, p, testConfig);
    const paused = studioView(t.store, "memory")!;
    assert.equal(paused.status, "awaiting_continuity");
    assert.equal(paused.continuity!.question!.kind, "relationship");
    assert.equal(p.imageReferenceCounts.length, 0);
    const answer = {
      questionId: paused.continuity!.question!.id,
      answerId: "answer",
      text: "Ada is Nell's grandmother.",
      key: crypto.randomUUID(),
    };
    answerStudioContinuity(t.store, "memory", answer);
    answerStudioContinuity(t.store, "memory", answer);
    assert.throws(
      () =>
        answerStudioContinuity(t.store, "memory", {
          ...answer,
          text: "Someone else",
        }),
      /already has/,
    );
    await runStudio(t.store, p, testConfig);
    assert.equal(
      studioView(t.store, "memory")!.status,
      "complete",
      studioView(t.store, "memory")!.error ?? "",
    );
    assert.equal(
      p.calls.filter((call) => call === "heart_questions_v1").length,
      1,
    );
    assert.equal(p.calls.filter((call) => call === "heart").length, 1);
    assert.equal(
      t.store.one<{ transcript: string }>(
        "SELECT transcript FROM projects WHERE id='memory'",
      )!.transcript,
      JSON.stringify(source()),
    );
    const book = JSON.parse(
      t.store.one<{ book: string }>(
        "SELECT book FROM editions WHERE projectId='memory'",
      )!.book,
    );
    assert.match(
      canonical(book.production.heart.questions),
      /Family clarification/,
    );
  } finally {
    t.close();
  }
});

test("portable archives retain private identities across repeated restores without rewriting editions or queuing work", async () => {
  const t = setup();
  try {
    const p = new StudioFake();
    queueStudio(
      t.store,
      t.store.one<ProjectRow>("SELECT * FROM projects WHERE id='memory'")!,
      consent,
      testConfig,
    );
    await runStudio(t.store, p, testConfig);
    const bytes = exportArchive(
      t.store,
      t.store.one<ProjectRow>("SELECT * FROM projects WHERE id='memory'")!,
    );
    const original = JSON.parse(gunzipSync(bytes).toString());
    assert.equal(original.continuity.length, fixtureWorld.characters.length);
    const jobs = t.store.all("SELECT id FROM studio_jobs").length;
    const restored = restoreArchive(t.store, "other", bytes);
    const restoredAgain = restoreArchive(t.store, "other", bytes);
    assert.notEqual(restored.id, restoredAgain.id);
    assert.equal(
      t.store.all("SELECT id FROM continuity_people WHERE ownerId='other'")
        .length,
      fixtureWorld.characters.length,
    );
    const reexported = JSON.parse(
      gunzipSync(
        exportArchive(
          t.store,
          t.store.one<ProjectRow>(
            "SELECT * FROM projects WHERE id=?",
            restored.id,
          )!,
        ),
      ).toString(),
    );
    assert.deepEqual(reexported.continuity, original.continuity);
    assert.deepEqual(
      reexported.editions.map((e: { contentHash: string; pdfHash: string }) => [
        e.contentHash,
        e.pdfHash,
      ]),
      original.editions.map((e: { contentHash: string; pdfHash: string }) => [
        e.contentHash,
        e.pdfHash,
      ]),
    );
    assert.equal(t.store.all("SELECT id FROM studio_jobs").length, jobs);
    const matches = resolveContinuity(
      t.store,
      "other",
      pinStudioContinuity(t.store, "other", "auto"),
      fixtureWorld,
      source(),
      { questions: [], responses: {} },
    );
    assert.equal(matches.question, null);
    const tampered = structuredClone(original);
    tampered.continuity[0].evidence.quote =
      "This invented identity evidence was never said.";
    const { checksum: _checksum, ...payload } = tampered;
    tampered.checksum = hash(canonical(payload));
    assert.throws(
      () =>
        restoreArchive(t.store, "other", gzipSync(JSON.stringify(tampered))),
      /not supported/,
    );
  } finally {
    t.close();
  }
});

test("an ambiguous returning identity pauses before images and a saved answer resumes its original world request", async () => {
  const t = setup();
  try {
    t.cast("first");
    t.cast("second"); // A separately established family with the same names.
    const p = new StudioFake();
    queueStudio(
      t.store,
      t.store.one<ProjectRow>("SELECT * FROM projects WHERE id='memory'")!,
      consent,
      testConfig,
    );
    await runStudio(t.store, p, testConfig);
    for (let i = 0; i < fixtureWorld.characters.length; i++) {
      const view = studioView(t.store, "memory")!;
      assert.equal(view.status, "awaiting_continuity");
      assert.equal(p.imageReferenceCounts.length, 0);
      const question = view.continuity!.question!;
      const answer = {
        questionId: question.id,
        answerId: question.options[0].id,
        key: crypto.randomUUID(),
      };
      answerStudioContinuity(t.store, "memory", answer);
      answerStudioContinuity(t.store, "memory", answer);
      await runStudio(t.store, p, testConfig);
    }
    assert.equal(
      studioView(t.store, "memory")!.status,
      "complete",
      studioView(t.store, "memory")!.error ?? "",
    );
    assert.equal(p.calls.filter((call) => call === "world").length, 1);
    assert.equal(p.imageReferenceCounts.length, 12);
  } finally {
    t.close();
  }
});
