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
import { activeProfile } from "../src/server/lab/profiles.js";
import {
  queueStudio,
  runStudio,
  studioView,
} from "../src/server/engine/studio.js";
import { requestStudioPause } from "../src/server/engine/budget.js";
import { resumeStudio, studioRecovery } from "../src/server/engine/recovery.js";
import {
  appendCharacterAppearanceDirection,
  resolveCharacterAppearance,
  CHARACTER_APPEARANCE_STAGE,
} from "../src/server/engine/character-appearance.js";
import { Transcript, Book } from "../src/shared/contracts.js";
import { type Snapshot } from "../src/shared/studio.js";
import {
  StudioFake,
  testConfig,
  fixtureSource,
  fixtureWorld,
  fixtureManuscript,
} from "./support/studio-fixtures.js";

// Synthetic source, provider and artwork only; no family files or live requests.
async function fixture(weak = true) {
  const dir = mkdtempSync(join(tmpdir(), "everlore-appearance-")),
    store = new Store(dir);
  configureAccess(store, false);
  for (const name of ["operator", "family", "other"])
    store.run(
      "INSERT INTO users VALUES(?,?,?,'private',?)",
      name,
      name,
      "unused",
      now(),
    );
  const source = Transcript.parse({
    version: 1,
    mode: "manual",
    recordingId: null,
    rawText: fixtureSource,
    segments: [{ id: "s1", text: fixtureSource, startMs: null, endMs: null }],
  });
  store.run(
    "INSERT INTO projects VALUES('memory','family','Synthetic appearance','manual','awaiting_editorial',0,?,?,?)",
    canonical(source),
    now(),
    now(),
  );
  const project = () =>
    store.one<ProjectRow>("SELECT * FROM projects WHERE id='memory'")!;
  const profile = activeProfile(store, testConfig);
  const jobId = queueStudio(
    store,
    project(),
    {
      autonomous: true,
      processWithOpenAI: true,
      imaginativeAdaptation: true,
      legacyWish: "",
    },
    testConfig,
    profile,
  );
  const world = structuredClone(fixtureWorld);
  world.characters.find((c) => c.id === "ada")!.species = "bear";
  class AppearanceFake extends StudioFake {
    sceneWorlds: Snapshot["world"][] = [];
    refinementWorlds: Snapshot["world"][] = [];
    override async structured<T>(
      name: string,
      schema: z.ZodType<T>,
      instruction: string,
      data: unknown,
      images: Buffer[] = [],
    ) {
      if (name === "world") {
        this.calls.push(name);
        return schema.parse(world);
      }
      if (name === "scenes")
        this.sceneWorlds.push(
          structuredClone((data as { world: Snapshot["world"] }).world),
        );
      if (/^refine_[12]$/.test(name))
        this.refinementWorlds.push(
          structuredClone((data as { world: Snapshot["world"] }).world),
        );
      return super.structured(name, schema, instruction, data, images);
    }
  }
  const provider = new AppearanceFake();
  provider.weak = weak;
  provider.onStructured = (name) => {
    if (name === "draft_3_poetics") requestStudioPause(store, jobId);
  };
  await runStudio(store, provider, testConfig, { jobId });
  setOperator(store, "operator");
  assert.equal(
    store.one<{ status: string }>(
      "SELECT status FROM studio_jobs WHERE id=?",
      jobId,
    )!.status,
    "needs_attention",
  );
  assert.equal(
    store.one<{ stage: string }>(
      "SELECT stage FROM studio_jobs WHERE id=?",
      jobId,
    )!.stage,
    weak ? "refine_1" : "scenes",
  );
  const recovery = studioRecovery(store, jobId)!;
  assert.equal(recovery.preDispatch, true);
  const input = {
    ownerId: "family",
    projectId: "memory",
    jobId,
    checkpointId: recovery.callId,
    sourceHash: hash(canonical(source)),
    baseWorldHash: hash(canonical(world)),
    characterId: "ada",
    appearance: {
      silhouette:
        "Soft rounded teddy-bear silhouette, small rounded ears and broad paws.",
      face: "Gentle dark eyes and a short rounded muzzle.",
      bodyColors: "Warm honey-brown fur with a cream muzzle.",
      proportions: "Adult bear scale with softly rounded limbs; never a child.",
    },
    direction:
      "Make this bear's appearance teddy-like; retain identity, species, adult age and outfit.",
  };
  return {
    dir,
    store,
    source,
    world,
    profile,
    project,
    jobId,
    provider,
    input,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function snapshot(t: Fixture) {
  return canonical({
    project: t.project(),
    job: t.store.one("SELECT * FROM studio_jobs WHERE id=?", t.jobId),
    steps: t.store.all(
      "SELECT * FROM studio_steps WHERE jobId=? AND stage!=? ORDER BY stage",
      t.jobId,
      CHARACTER_APPEARANCE_STAGE,
    ),
    calls: t.store.all(
      "SELECT * FROM studio_calls WHERE jobId=? ORDER BY id",
      t.jobId,
    ),
    budget: t.store.all("SELECT * FROM engine_budget"),
    pause: t.store.all("SELECT * FROM studio_pause_requests"),
    checkpoints: t.store.all("SELECT * FROM studio_checkpoints"),
  });
}
function resume(t: Fixture) {
  const recovery = studioRecovery(t.store, t.jobId)!;
  resumeStudio(
    t.store,
    t.project(),
    {
      jobId: t.jobId,
      callId: recovery.callId,
      acknowledgePossibleCharge: false,
    },
    testConfig,
  );
}

test("teddy appearance resumes pending refinement with original text inputs, then reaches scenes and final book", async (ctx) => {
  const network = ctx.mock.method(globalThis, "fetch", async () => {
    throw new Error("No live provider calls allowed");
  });
  const t = await fixture();
  try {
    const before = snapshot(t),
      priorCalls = [...t.provider.calls];
    const completed = t.store.all<{
      stage: string;
      result: string;
      inputHash: string;
    }>(
      "SELECT stage,result,inputHash FROM studio_steps WHERE jobId=? AND state='completed'",
      t.jobId,
    );
    const record = appendCharacterAppearanceDirection(
      t.store,
      "operator",
      t.input,
    );
    assert.deepEqual(studioView(t.store, "memory")!.world, record.world);
    assert.equal(
      snapshot(t),
      before,
      "appending direction does not resume, rewrite source, spend or edit existing steps",
    );
    assert.deepEqual(
      appendCharacterAppearanceDirection(t.store, "operator", t.input),
      record,
    );
    assert.deepEqual(
      record.world.characters.find((c) => c.id === "ada"),
      {
        ...t.world.characters.find((c) => c.id === "ada"),
        ...t.input.appearance,
      },
    );
    assert.deepEqual(
      record.world.characters.find((c) => c.id !== "ada"),
      t.world.characters.find((c) => c.id !== "ada"),
    );
    resume(t);
    t.provider.weak = false;
    t.provider.onStructured = undefined;
    await runStudio(t.store, t.provider, testConfig, { jobId: t.jobId });
    assert.equal(
      t.store.one<{ status: string }>(
        "SELECT status FROM studio_jobs WHERE id=?",
        t.jobId,
      )!.status,
      "complete",
    );
    assert.deepEqual(t.provider.calls.slice(0, priorCalls.length), priorCalls);
    for (const name of priorCalls)
      assert.equal(
        t.provider.calls.filter((c) => c === name).length,
        1,
        `no replay: ${name}`,
      );
    assert.deepEqual(t.provider.refinementWorlds, [t.world]);
    assert.deepEqual(t.provider.sceneWorlds, [record.world]);
    for (const original of completed)
      assert.deepEqual(
        t.store.one(
          "SELECT stage,result,inputHash FROM studio_steps WHERE jobId=? AND stage=?",
          t.jobId,
          original.stage,
        ),
        original,
      );
    const book = Book.parse(
      JSON.parse(
        t.store.one<{ book: string }>(
          "SELECT book FROM revisions WHERE projectId='memory'",
        )!.book,
      ),
    );
    assert.deepEqual(book.production!.world, record.world);
    assert.deepEqual(book.transcript, t.source);
    assert.equal(book.production!.engineProfile!.hash, t.profile.hash);
    assert.equal(t.store.all("SELECT id FROM studio_jobs").length, 1);
    const finalState = snapshot(t);
    assert.deepEqual(
      appendCharacterAppearanceDirection(t.store, "operator", t.input),
      record,
    );
    assert.equal(
      snapshot(t),
      finalState,
      "a repeated direction never requeues the completed job",
    );
    assert.equal(network.mock.callCount(), 0);
  } finally {
    t.close();
  }
});

test("a stopped scenes checkpoint resumes without repeating an already accepted manuscript", async () => {
  const t = await fixture(false);
  try {
    const accepted = t.store.one(
      "SELECT * FROM studio_steps WHERE stage='accepted_story'",
    );
    const checkpoint = t.store.one<{ inputHash: string }>(
      "SELECT inputHash FROM studio_checkpoints WHERE id=?",
      t.input.checkpointId,
    )!;
    // Supported interrupted local placeholder: explicitly no dispatched scene call.
    t.store.run(
      "INSERT INTO studio_steps VALUES(?,'scenes',?,'started',NULL)",
      t.jobId,
      checkpoint.inputHash,
    );
    const record = appendCharacterAppearanceDirection(
      t.store,
      "operator",
      t.input,
    );
    resume(t);
    t.provider.onStructured = (name) => {
      if (name === "scenes") requestStudioPause(t.store, t.jobId);
    };
    await runStudio(t.store, t.provider, testConfig, { jobId: t.jobId });
    assert.deepEqual(t.provider.sceneWorlds, [record.world]);
    assert.equal(t.provider.calls.filter((c) => c === "draft_1").length, 1);
    assert.deepEqual(
      t.store.one("SELECT * FROM studio_steps WHERE stage='accepted_story'"),
      accepted,
    );
  } finally {
    t.close();
  }
});

test("a later user meeting-age clarification guides only illustrations and retains exact separate provenance", async (ctx) => {
  const network = ctx.mock.method(globalThis, "fetch", async () => {
    throw new Error("No live provider calls allowed");
  });
  const t = await fixture();
  try {
    const clarification = {
      kind: "user_clarification" as const,
      usage: "illustration_guidance_only" as const,
      quote:
        "  They were both sixty-six at their meeting.\nUse that only to guide the pictures.  ",
      receivedAt: "2026-10-15T17:00:00Z",
      ages: t.world.characters.map((c) => ({ characterId: c.id, age: 66 })),
    };
    const input = { ...t.input, meetingAgeClarification: clarification };
    const before = snapshot(t);
    const record = appendCharacterAppearanceDirection(
      t.store,
      "operator",
      input,
    );
    assert.equal(snapshot(t), before);
    assert.deepEqual(record.meetingAgeClarification, clarification);
    assert.equal(
      record.meetingAgeClarification!.quote,
      clarification.quote,
      "do not trim or rewrite the received quotation",
    );
    assert(record.world.characters.every((c) => c.depictedAge === 66));
    for (const original of t.world.characters) {
      const changed = record.world.characters.find(
        (c) => c.id === original.id,
      )!;
      for (const key of [
        "id",
        "name",
        "species",
        "relationship",
        "outfit",
        "signatureDetail",
      ] as const)
        assert.equal(changed[key], original[key]);
    }
    assert.match(record.world.worldRules, /PRIVATE ILLUSTRATION GUIDANCE ONLY/);
    assert.match(
      record.world.worldRules,
      /separate from the original frozen transcript/,
    );
    assert.match(record.world.worldRules, /Do not copy these numbers/);
    assert.deepEqual(
      appendCharacterAppearanceDirection(t.store, "operator", input),
      record,
    );
    resume(t);
    t.provider.weak = false;
    t.provider.onStructured = undefined;
    await runStudio(t.store, t.provider, testConfig, { jobId: t.jobId });
    assert.deepEqual(
      t.provider.refinementWorlds,
      [t.world],
      "late age guidance cannot leak into text generation",
    );
    assert.deepEqual(t.provider.sceneWorlds, [record.world]);
    const book = Book.parse(
      JSON.parse(
        t.store.one<{ book: string }>(
          "SELECT book FROM revisions WHERE projectId='memory'",
        )!.book,
      ),
    );
    assert.deepEqual(book.transcript, t.source);
    assert.deepEqual(book.production!.manuscript, fixtureManuscript);
    const narrative = [
      book.title,
      book.byline,
      ...book.spreads.map((s) => s.text),
      book.production!.manuscript.trueParts,
    ].join("\n");
    assert.doesNotMatch(narrative, /\b66\b|sixty[- ]six/i);
    assert(book.people.every((p) => p.depictedAge === 66));
    assert.equal(network.mock.callCount(), 0);
  } finally {
    t.close();
  }
});

test("meeting ages require exact attributed visual-only guidance and unique existing adult character IDs", async () => {
  const t = await fixture();
  try {
    const valid = {
      kind: "user_clarification",
      usage: "illustration_guidance_only",
      quote: "They met as adults aged sixty-six; use only for the pictures.",
      receivedAt: "2026-10-15T17:00:00Z",
      ages: [{ characterId: "ada", age: 66 }],
    };
    for (const clarification of [
      { ...valid, quote: " " },
      { ...valid, kind: "frozen_transcript" },
      { ...valid, usage: "story_text" },
      { ...valid, receivedAt: "unknown" },
      { ...valid, ages: [{ characterId: "absent", age: 66 }] },
      { ...valid, ages: [valid.ages[0], valid.ages[0]] },
      ...[5, 121, 66.5].map((age) => ({
        ...valid,
        ages: [{ characterId: "ada", age }],
      })),
    ])
      assert.throws(() =>
        appendCharacterAppearanceDirection(t.store, "operator", {
          ...t.input,
          meetingAgeClarification: clarification,
        }),
      );
    assert.equal(
      t.store.all(
        "SELECT * FROM studio_steps WHERE stage=?",
        CHARACTER_APPEARANCE_STAGE,
      ).length,
      0,
    );
  } finally {
    t.close();
  }
});

test("appearance direction rejects identity edits, unauthorized callers, stale inputs and conflicting retry", async () => {
  const t = await fixture();
  try {
    assert.throws(
      () => appendCharacterAppearanceDirection(t.store, "family", t.input),
      /Only the configured/,
    );
    assert.throws(
      () =>
        appendCharacterAppearanceDirection(t.store, "operator", {
          ...t.input,
          ownerId: "other",
        }),
      /owner's original/,
    );
    for (const field of [
      "name",
      "species",
      "relationship",
      "outfit",
      "id",
      "ageState",
      "depictedAge",
    ])
      assert.throws(() =>
        appendCharacterAppearanceDirection(t.store, "operator", {
          ...t.input,
          appearance: { ...t.input.appearance, [field]: "changed" },
        }),
      );
    assert.throws(
      () =>
        appendCharacterAppearanceDirection(t.store, "operator", {
          ...t.input,
          sourceHash: "0".repeat(64),
        }),
      /source changed/,
    );
    assert.throws(
      () =>
        appendCharacterAppearanceDirection(t.store, "operator", {
          ...t.input,
          baseWorldHash: "0".repeat(64),
        }),
      /world changed/,
    );
    assert.throws(
      () =>
        appendCharacterAppearanceDirection(t.store, "operator", {
          ...t.input,
          checkpointId: "stale",
        }),
      /pre-dispatch/,
    );
    assert.throws(
      () =>
        appendCharacterAppearanceDirection(t.store, "operator", {
          ...t.input,
          characterId: "absent",
        }),
      /one character/,
    );
    appendCharacterAppearanceDirection(t.store, "operator", t.input);
    assert.throws(
      () =>
        appendCharacterAppearanceDirection(t.store, "operator", {
          ...t.input,
          direction: "A different visual instruction.",
        }),
      /immutable/,
    );
    const stored = t.store.one<{ result: string }>(
      "SELECT result FROM studio_steps WHERE stage=?",
      CHARACTER_APPEARANCE_STAGE,
    )!;
    const changed = JSON.parse(stored.result);
    changed.world.characters[0].name = "Wrong identity";
    t.store.run(
      "UPDATE studio_steps SET result=? WHERE stage=?",
      canonical(changed),
      CHARACTER_APPEARANCE_STAGE,
    );
    assert.throws(
      () => resolveCharacterAppearance(t.store, t.jobId, t.world, t.source),
      /no longer matches/,
    );
  } finally {
    t.close();
  }
});

test("active leases, other gates, established canon and any dispatched visual work prevent direction", async () => {
  const cases = [
    "guided",
    "lease",
    "status",
    "kind",
    "revision",
    "canon",
    "image",
    "scene",
    "completed-scene",
    "ambiguous",
    "pause",
    "newer",
  ];
  for (const which of cases) {
    const t = await fixture();
    try {
      const changes: Record<string, [string, (string | number)[]]> = {
        guided: [
          "UPDATE studio_jobs SET request=json_set(request,'$.autonomous',json('false'))",
          [],
        ],
        lease: [
          "UPDATE studio_jobs SET leaseToken='active',leaseUntil=9999999999999",
          [],
        ],
        status: ["UPDATE studio_jobs SET status='needs_editor'", []],
        kind: ["UPDATE studio_jobs SET kind='repair'", []],
        revision: ["UPDATE projects SET revision=1 WHERE id='memory'", []],
        canon: [
          "UPDATE studio_jobs SET state=json_set(state,'$.continuityBindings',json(?))",
          ['[{"personId":"old-person"}]'],
        ],
        image: [
          "INSERT INTO studio_calls VALUES('image',?,'canon_identity','image','fake','hash','rejected',NULL,NULL,NULL,1,NULL,?)",
          [t.jobId, now()],
        ],
        scene: [
          "INSERT INTO studio_calls VALUES('scene',?,'scenes','text','fake','hash','completed',NULL,NULL,NULL,1,NULL,?)",
          [t.jobId, now()],
        ],
        "completed-scene": [
          "INSERT INTO studio_steps VALUES(?,'scenes','hash','completed','{}')",
          [t.jobId],
        ],
        ambiguous: [
          "UPDATE studio_calls SET status='ambiguous_failure' WHERE stage='draft_3_poetics'",
          [],
        ],
        pause: ["DELETE FROM studio_pause_requests", []],
        newer: [
          "INSERT INTO studio_jobs(id,projectId,baseRevision,kind,status,stage,request,state,profile,allowance,createdAt) SELECT 'newer',projectId,0,'generation','complete','family_review',request,state,profile,0,createdAt FROM studio_jobs WHERE id=?",
          [t.jobId],
        ],
      };
      const [sql, args] = changes[which];
      t.store.run(sql, ...args);
      assert.throws(
        () => appendCharacterAppearanceDirection(t.store, "operator", t.input),
        /./,
        which,
      );
      assert.equal(
        t.store.all(
          "SELECT * FROM studio_steps WHERE stage=?",
          CHARACTER_APPEARANCE_STAGE,
        ).length,
        0,
      );
    } finally {
      t.close();
    }
  }
});
