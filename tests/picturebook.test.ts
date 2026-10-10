import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ReaderExperience,
  VisualDirection,
  PremiseDiversity,
} from "../src/shared/picturebook.js";
import {
  readerExperienceProblems,
  visualDirectionProblems,
  premiseDiversityProblems,
  roughCompositionSvg,
} from "../src/server/engine/picturebook.js";
import {
  fixturePlan,
  fixtureHeart,
  fixtureScenes,
  fixtureWorld,
  fixtureConcepts,
  testConfig,
} from "./support/studio-fixtures.js";
import { Store, now } from "../src/server/store.js";
import {
  candidateProfile,
  createExperiment,
  setLabOwner,
  labView,
} from "../src/server/lab/service.js";
import { activeProfile, verifyProfile } from "../src/server/lab/profiles.js";
import { heldOutCases } from "../src/server/lab/release-cases.js";
import { cases } from "../src/server/lab/library.js";
const reader = ReaderExperience.parse({
  version: 1,
  dramaticPossibilities: [
    {
      nuggetIds: [fixtureHeart.nuggets[0].id],
      remembered: fixtureHeart.nuggets[0].quote,
      possibleMotivation: "A possible wish to feel capable",
      imaginativeTransformation: "The buttons become small hills",
      status: "interpretation_and_invention",
    },
  ],
  spreads: fixturePlan.beats.map((b) => ({
    spread: b.spread,
    understands: b.action,
    anticipates: b.pageTurn,
    discovers: b.visualDiscovery,
    feels: b.emotionalChange,
    turnInvitation: b.pageTurn,
    wordsReveal: b.action,
    picturesReveal: b.visualDiscovery,
  })),
  language: {
    voice: "Intimate and concrete",
    rhythm: "Vary breath groups",
    repetitionWithChange: "I have time gains meaning",
    silence: "Let a gesture carry the ending",
  },
  specificityTests: [
    {
      nuggetId: fixtureHeart.nuggets[0].id,
      removedDetail: "The three buttons",
      affectedSpreads: [1, 12],
      whatStopsWorking:
        "The final fastening no longer answers the first difficulty",
    },
  ],
});
const visual = VisualDirection.parse({
  version: 1,
  emotionalColorProgression: "Cool morning to warm intimacy",
  recurringMotifs: ["Three small circles"],
  spreads: fixtureScenes.scenes.map((s) => ({
    spread: s.spread,
    emotionalPurpose: s.emotion,
    colorIntent: "Preserve the blue coat in morning light",
    density: "quiet",
    focalPoint: { x: 0.5, y: 0.5 },
    staging: s.characterIds.map((id) => ({
      characterId: id,
      center: { x: 0.4, y: 0.6 },
      scale: 0.3,
      posture: "Leaning toward the shared task",
    })),
    wordPictureRelationship: "Picture shows patient attention",
    visualSurprise: s.visualDiscovery,
  })),
});
test("reader planning preserves exact sourced evidence and rejects duplicate spreads or invented remembered words", () => {
  const p = { ...fixturePlan, readerExperience: structuredClone(reader) };
  assert.deepEqual(readerExperienceProblems(p, fixtureHeart), []);
  p.readerExperience.dramaticPossibilities[0].remembered = "An invented death";
  p.readerExperience.spreads[11].spread = 1;
  assert.equal(readerExperienceProblems(p, fixtureHeart).length, 2);
});
test("rough visual plans require the exact cast and render twelve geometric panels", () => {
  const s = { ...fixtureScenes, visualDirection: structuredClone(visual) };
  assert.deepEqual(visualDirectionProblems(s, fixtureWorld), []);
  assert.equal((roughCompositionSvg(s).match(/<g /g) ?? []).length, 12);
  s.visualDirection.spreads[0].staging[0].characterId = "unrelated-family";
  assert.match(
    visualDirectionProblems(s, fixtureWorld).join(),
    /exactly its contracted cast/,
  );
});
test("premise comparison checks all unique pairs and retains a finding of superficial variation", () => {
  const ids = fixtureConcepts.concepts.map((c) => c.id);
  const review = PremiseDiversity.parse({
    version: 1,
    comparisons: [
      [0, 1],
      [0, 2],
      [1, 2],
    ].map(([a, b]) => ({
      firstId: ids[a],
      secondId: ids[b],
      distinct: true,
      differenceInAction: "Different consequential choice",
      differenceInPayoff: "Different ending rooted in the same truth",
    })),
  });
  assert.deepEqual(premiseDiversityProblems(fixtureConcepts, review), []);
  review.comparisons[0].distinct = false;
  assert.match(
    premiseDiversityProblems(fixtureConcepts, review).join(),
    /superficially/,
  );
  review.comparisons[2] = review.comparisons[1];
  assert.match(
    premiseDiversityProblems(fixtureConcepts, review).join(),
    /exactly once/,
  );
});
test("candidate capabilities are hashed and isolated; held-out cases cannot enter development", () => {
  const dir = mkdtempSync(join(tmpdir(), "everlore-picturebook-")),
    store = new Store(dir);
  try {
    store.run(
      "INSERT INTO users VALUES('owner','Owner','unused','private',?)",
      now(),
    );
    setLabOwner(store, "owner");
    const base = activeProfile(store, testConfig),
      candidate = candidateProfile(store, testConfig, "reader-experience");
    assert.equal(candidate.craftRules.readerExperienceVersion, 1);
    assert.equal(activeProfile(store, testConfig).hash, base.hash);
    assert.equal(base.craftRules.readerExperienceVersion, undefined);
    assert.throws(
      () =>
        verifyProfile({
          ...candidate,
          craftRules: { ...candidate.craftRules, readerExperienceVersion: 2 },
        }),
      /integrity/,
    );
    const view = labView(store, testConfig, "owner");
    assert.equal(view.cases.length, 6);
    assert.ok(view.cases.every((c) => !c.id.startsWith("heldout-")));
    assert.equal(heldOutCases.length, 6);
    assert.ok(
      heldOutCases.every((c) => !cases.some((d) => d.source === c.source)),
    );
    const input = {
      plan: {
        title: "Isolation experiment",
        hypothesis: "Reader planning may improve specificity.",
        risk: "May become formulaic.",
        lane: "story",
        candidateHash: candidate.hash,
        caseIds: [heldOutCases[0].id],
        replicates: 1,
        mode: "offline",
        criterion: "read_aloud",
        principleIds: ["voice"],
      },
    };
    assert.throws(
      () => createExperiment(store, "owner", input, testConfig),
      /separate/,
    );
    assert.throws(
      () =>
        createExperiment(
          store,
          "owner",
          { ...input, plan: { ...input.plan, evaluationPhase: "release" } },
          testConfig,
        ),
      /development comparison/,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("candidate production uses and persists structured reader and visual direction before final artwork", async () => {
  const { StudioFake } = await import("./support/studio-fixtures.js");
  const { saveProfile } = await import("../src/server/lab/profiles.js");
  const { queueStudio, runStudio, latestStudio, studioCached } =
    await import("../src/server/engine/studio.js");
  const { Book } = await import("../src/shared/contracts.js");
  const { z } = await import("zod");
  class PlanningFake extends StudioFake {
    async structured<T>(
      name: string,
      schema: import("zod").z.ZodType<T>,
      instructions: string,
      data: unknown,
      images: Buffer[] = [],
    ): Promise<T> {
      if (name === "story_plan")
        return schema.parse({ ...fixturePlan, readerExperience: reader });
      if (name === "scenes")
        return schema.parse({ ...fixtureScenes, visualDirection: visual });
      return super.structured(name, schema, instructions, data, images);
    }
  }
  const dir = mkdtempSync(join(tmpdir(), "everlore-planning-")),
    store = new Store(dir);
  try {
    store.run(
      "INSERT INTO users VALUES('owner','Owner','unused','private',?)",
      now(),
    );
    const base = activeProfile(store, testConfig),
      profile = saveProfile(store, {
        ...base,
        name: "Synthetic combined planning verification",
        parentHash: base.hash,
        craftRules: {
          ...base.craftRules,
          readerExperienceVersion: 1,
          visualDirectionVersion: 1,
        },
      });
    store.run(
      "UPDATE lab_settings SET value=? WHERE key='active_profile'",
      profile.hash,
    );
    store.run(
      "INSERT INTO projects VALUES('memory','owner','Synthetic','unavailable','awaiting_transcription',0,NULL,?,?)",
      now(),
      now(),
    );
    const asset = store.putAsset("memory", "synthetic audio", "audio");
    store.run(
      "INSERT INTO recordings VALUES('rec','memory',?,'audio/wav',20,'upload',?)",
      asset,
      now(),
    );
    const project = store.one<import("../src/server/store.js").ProjectRow>(
      "SELECT * FROM projects WHERE id='memory'",
    )!;
    queueStudio(
      store,
      project,
      {
        processWithOpenAI: true,
        imaginativeAdaptation: true,
        legacyWish: "Patient love",
      },
      testConfig,
    );
    await runStudio(store, new PlanningFake(), testConfig);
    const job = latestStudio(store, "memory")!;
    assert.equal(job.status, "complete", job.error ?? job.stage);
    assert.ok(studioCached(store, job.id, "rough_compositions"));
    const book = Book.parse(
      JSON.parse(
        store.one<{ book: string }>(
          "SELECT book FROM revisions WHERE projectId='memory'",
        )!.book,
      ),
    );
    assert.equal(book.production?.plan.readerExperience?.version, 1);
    assert.equal(book.production?.scenes.visualDirection?.spreads.length, 12);
    assert.equal(book.spreads.length, 12);
    assert.ok(z.string().parse(book.title));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
