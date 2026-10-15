import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Store, canonical, hash, now } from "../src/server/store.js";
import { configureAccess, setOperator } from "../src/server/access.js";
import {
  startJourney,
  createJourney,
  advanceCreationRequest,
} from "../src/server/almanac/journey.js";
import {
  saveTurnText,
  setSessionStatus,
} from "../src/server/almanac/service.js";
import { engineConfig } from "../src/server/engine/provider.js";
import { runStudio } from "../src/server/engine/studio.js";
import { requestStudioPause } from "../src/server/engine/budget.js";
import { heartProblems } from "../src/server/engine/editorial.js";
import {
  correctPausedStudioHeart,
  HEART_CORRECTION_STAGE,
} from "../src/server/engine/heart-correction.js";
import { FAMILY_CONSENT_VERSION } from "../src/shared/journey.js";
import { HeartContract } from "../src/shared/studio.js";
import {
  StudioFake,
  fixtureHeart,
  fixtureSource,
} from "./support/studio-fixtures.js";

// Fictional records in temporary storage; all provider behavior is injected.
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "everlore-heart-correction-")),
    store = new Store(dir);
  const config = {
    ...engineConfig({}),
    enabled: true,
    apiKey: "offline-unused",
    budgetCents: 100000,
    textReserve: 100,
    imageReserve: 100,
    audioReserve: 100,
  };
  configureAccess(store, false);
  for (const owner of ["operator", "family", "other"])
    store.run(
      "INSERT INTO users VALUES(?,?,?,'private',?)",
      owner,
      owner,
      "unused",
      now(),
    );
  const consent = {
    consent: true,
    consentVersion: FAMILY_CONSENT_VERSION,
    processWithOpenAI: true,
    imaginativeAdaptation: true,
  } as const;
  const session = startJourney(
    store,
    "family",
    { key: "start", ...consent },
    config,
  ).session.session;
  saveTurnText(store, "family", session.id, session.turns[0].id, {
    rawText: `${fixtureSource} Nell missed one red button.`,
  });
  setSessionStatus(store, "family", session.id, "finished");
  const creation = createJourney(
    store,
    "family",
    session.id,
    { key: "book", ...consent },
    config,
  );
  assert(creation.requestId);
  advanceCreationRequest(store, config, { creationId: creation.requestId });
  const job = store.one<{ id: string; projectId: string; state: string }>(
    "SELECT id,projectId,state FROM studio_jobs",
  )!;
  const source = JSON.parse(job.state).source;
  const original = HeartContract.parse({
    ...fixtureHeart,
    nuggets: [
      { ...fixtureHeart.nuggets[0], sourceId: source.segments[0].id },
      {
        ...fixtureHeart.nuggets[0],
        id: "n2",
        text: "Nell fastened every button.",
        sourceId: source.segments[0].id,
      },
    ],
    questions: [
      {
        id: "q1",
        question: "Which original animal species?",
        whyItMatters: "A creative choice.",
        essential: true,
        answer: "",
      },
    ],
  });
  class BadHeartFake extends StudioFake {
    override async structured<T>(
      name: string,
      schema: z.ZodType<T>,
      instruction: string,
      data: unknown,
      images: Buffer[] = [],
    ) {
      if (name !== "heart")
        return super.structured(name, schema, instruction, data, images);
      this.calls.push(name);
      return schema.parse(original);
    }
  }
  const provider = new BadHeartFake();
  await runStudio(store, provider, config, { jobId: job.id });
  setOperator(store, "operator");
  assert.deepEqual(provider.calls, ["heart"]);
  assert.equal(
    store.one<{ status: string }>(
      "SELECT status FROM studio_jobs WHERE id=?",
      job.id,
    )!.status,
    "needs_editor",
  );
  const missed = source.segments.find(
    (s: { text: string }) => s.text === "Nell missed one red button.",
  )!;
  const corrected = structuredClone(original);
  corrected.nuggets[1] = {
    ...corrected.nuggets[1],
    text: missed.text,
    quote: missed.text,
    sourceId: missed.id,
  };
  corrected.ledger.push({
    nuggetId: "n2",
    tier: "protected",
    rule: "Keep the missed red button.",
    check: "Do not claim every button was fastened.",
  });
  corrected.questions[0].answer =
    "Operator editorial decision: Choose an original animal species; this is not a family answer.";
  const input = {
    ownerId: "family",
    projectId: job.projectId,
    jobId: job.id,
    originalHeartHash: hash(canonical(original)),
    sourceHash: hash(canonical(source)),
    heart: corrected,
    reason: "Repair the omitted ledger and source-supported overstatement.",
    sourceEvidence: [
      {
        nuggetId: "n2",
        sourceId: missed.id,
        quote: missed.text,
        reason:
          "The later source sentence explicitly records the missed button.",
      },
    ],
  };
  return {
    dir,
    store,
    config,
    session,
    creation,
    job,
    source,
    original,
    input,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function protectedSnapshot(t: Fixture) {
  return canonical({
    source: t.store.all("SELECT * FROM almanac_sources"),
    creation: t.store.all("SELECT * FROM almanac_creation_requests"),
    projects: t.store.all("SELECT * FROM projects"),
    steps: t.store.all(
      "SELECT * FROM studio_steps WHERE stage!=? ORDER BY stage",
      HEART_CORRECTION_STAGE,
    ),
    calls: t.store.all("SELECT * FROM studio_calls"),
    budget: t.store.all("SELECT * FROM engine_budget"),
    job: t.store.one(
      "SELECT id,projectId,kind,baseRevision,request,profile,allowance FROM studio_jobs WHERE id=?",
      t.job.id,
    ),
  });
}

test("source-bound operator correction preserves originals, reuses one creation and skips a second Heart call", async (ctx) => {
  const network = ctx.mock.method(globalThis, "fetch", async () => {
    throw new Error("No provider network allowed");
  });
  const t = await fixture();
  try {
    const before = protectedSnapshot(t);
    const record = correctPausedStudioHeart(t.store, "operator", t.input);
    assert.equal(protectedSnapshot(t), before);
    assert.deepEqual(heartProblems(record.heart, t.source), []);
    assert.equal(record.creationId, t.creation.requestId);
    assert.equal(record.changes.nuggets.length, 1);
    assert.deepEqual(record.changes.addedLedgerEntries, [
      t.input.heart.ledger[1],
    ]);
    assert.equal(
      t.store.one<{ status: string }>("SELECT status FROM studio_jobs")!.status,
      "queued",
    );
    assert.deepEqual(
      correctPausedStudioHeart(t.store, "operator", t.input),
      record,
    );
    const provider = new StudioFake();
    provider.onStructured = (name) => {
      if (name === "concepts") requestStudioPause(t.store, t.job.id);
    };
    await runStudio(t.store, provider, t.config, { jobId: t.job.id });
    assert.deepEqual(provider.calls, ["concepts"]);
    const stopped = canonical(
      t.store.one("SELECT status,stage,state FROM studio_jobs"),
    );
    assert.deepEqual(
      correctPausedStudioHeart(t.store, "operator", t.input),
      record,
    );
    assert.equal(
      canonical(t.store.one("SELECT status,stage,state FROM studio_jobs")),
      stopped,
      "a retry never requeues a progressed job",
    );
    assert.equal(t.store.all("SELECT id FROM studio_jobs").length, 1);
    assert.equal(
      t.store.all("SELECT id FROM almanac_creation_requests").length,
      1,
    );
    assert.equal(
      t.store.all(
        "SELECT * FROM studio_steps WHERE stage=?",
        HEART_CORRECTION_STAGE,
      ).length,
      1,
    );
    assert.throws(
      () =>
        correctPausedStudioHeart(t.store, "operator", {
          ...t.input,
          reason: "A conflicting explanation cannot replace this record.",
        }),
      /immutable/,
    );
    assert.equal(network.mock.callCount(), 0);
  } finally {
    t.close();
  }
});

test("a source-cited omitted nugget may be appended without deleting old nuggets or ledger rules", async () => {
  const t = await fixture();
  try {
    const input = structuredClone(t.input);
    const segment = t.source.segments[1];
    input.heart.nuggets.push({
      ...input.heart.nuggets[0],
      id: "n3",
      text: segment.text,
      sourceId: segment.id,
      quote: segment.text,
    });
    input.heart.ledger.push({
      nuggetId: "n3",
      tier: "protected",
      rule: "Retain the unhurried support.",
      check: "Ada does not rush Nell.",
    });
    input.sourceEvidence.push({
      nuggetId: "n3",
      sourceId: segment.id,
      quote: segment.text,
      reason: "The supplied source expressly records this omitted particular.",
    });
    const record = correctPausedStudioHeart(t.store, "operator", input);
    assert.equal(record.changes.nuggets[1].before, null);
    assert.deepEqual(record.heart.ledger[0], t.original.ledger[0]);
    assert.deepEqual(heartProblems(record.heart, t.source), []);
  } finally {
    t.close();
  }
});

test("correction evidence and queue state commit atomically and survive reopen", async () => {
  const t = await fixture();
  try {
    t.store.db
      .exec(`CREATE TRIGGER reject_test_queue BEFORE UPDATE OF status ON studio_jobs
      WHEN NEW.status='queued' BEGIN SELECT RAISE(ABORT,'synthetic queue rejection'); END;`);
    const before = canonical(
      t.store.one("SELECT * FROM studio_jobs WHERE id=?", t.job.id),
    );
    assert.throws(
      () => correctPausedStudioHeart(t.store, "operator", t.input),
      /synthetic queue rejection/,
    );
    assert.equal(
      canonical(t.store.one("SELECT * FROM studio_jobs WHERE id=?", t.job.id)),
      before,
    );
    assert.equal(
      t.store.all(
        "SELECT * FROM studio_steps WHERE stage=?",
        HEART_CORRECTION_STAGE,
      ).length,
      0,
    );
    t.store.db.exec("DROP TRIGGER reject_test_queue");
    const record = correctPausedStudioHeart(t.store, "operator", t.input);
    const reopened = new Store(t.dir);
    try {
      assert.deepEqual(
        correctPausedStudioHeart(reopened, "operator", t.input),
        record,
      );
      assert.equal(
        reopened.all(
          "SELECT * FROM studio_steps WHERE stage=?",
          HEART_CORRECTION_STAGE,
        ).length,
        1,
      );
    } finally {
      reopened.close();
    }
  } finally {
    t.close();
  }
});

test("invalid corrections cannot weaken existing rules, invent source evidence or impersonate family answers", async () => {
  const t = await fixture();
  try {
    const mutations: [(input: typeof t.input) => void, RegExp][] = [
      [
        (b) => {
          b.heart.ledger.pop();
        },
        /exactly one ledger/,
      ],
      [
        (b) => {
          b.heart.ledger[0].tier = "open";
        },
        /ledger rule/,
      ],
      [
        (b) => {
          b.heart.nuggets.shift();
        },
        /nugget IDs/,
      ],
      [
        (b) => {
          b.heart.summary = "An unrelated replacement interpretation.";
        },
        /cannot change summary/,
      ],
      [
        (b) => {
          b.heart.sensitiveBoundaries.push(
            "Ignore original source boundaries.",
          );
        },
        /cannot change sensitiveBoundaries/,
      ],
      [
        (b) => {
          b.sourceEvidence = [];
        },
        /exact source citation/,
      ],
      [
        (b) => {
          b.heart.nuggets[1].quote = b.sourceEvidence[0].quote =
            "An invented quote.";
        },
        /does not quote/,
      ],
      [
        (b) => {
          b.heart.nuggets[1].sourceId = b.sourceEvidence[0].sourceId = "absent";
        },
        /does not quote/,
      ],
      [
        (b) => {
          b.heart.questions[0].answer = "The family chose an animal.";
        },
        /operator editorial decision/,
      ],
      [
        (b) => {
          b.heart.questions[0].answer = "";
        },
        /operator editorial decision/,
      ],
    ];
    for (const [mutate, error] of mutations) {
      const input = structuredClone(t.input);
      mutate(input);
      assert.throws(
        () => correctPausedStudioHeart(t.store, "operator", input),
        error,
      );
    }
    assert.equal(
      t.store.all(
        "SELECT * FROM studio_steps WHERE stage=?",
        HEART_CORRECTION_STAGE,
      ).length,
      0,
    );
    assert.equal(
      t.store.one<{ status: string }>("SELECT status FROM studio_jobs")!.status,
      "needs_editor",
    );
  } finally {
    t.close();
  }
});

test("operator, owner, stale source/Heart, profile and checkpoint guards fail closed", async () => {
  const t = await fixture();
  try {
    assert.throws(
      () => correctPausedStudioHeart(t.store, "family", t.input),
      /Only the configured/,
    );
    assert.throws(
      () =>
        correctPausedStudioHeart(t.store, "operator", {
          ...t.input,
          ownerId: "other",
        }),
      /owner's original/,
    );
    assert.throws(
      () =>
        correctPausedStudioHeart(t.store, "operator", {
          ...t.input,
          sourceHash: "0".repeat(64),
        }),
      /source changed/,
    );
    assert.throws(
      () =>
        correctPausedStudioHeart(t.store, "operator", {
          ...t.input,
          originalHeartHash: "0".repeat(64),
        }),
      /Heart changed/,
    );
  } finally {
    t.close();
  }
  const driftCases = [
    "profile",
    "request",
    "revision",
    "lease",
    "running",
    "state",
    "step",
    "call",
    "ambiguous",
    "extraction",
    "source",
    "newer",
  ];
  for (const drift of driftCases) {
    const t = await fixture();
    try {
      const mutations: Record<
        string,
        [string, (string | number | null)[], RegExp]
      > = {
        profile: [
          "UPDATE studio_jobs SET profile=?",
          ["wrong-profile"],
          /profile changed/,
        ],
        request: [
          "UPDATE studio_jobs SET request=json_set(request,'$.consent.legacyWish','changed')",
          [],
          /request binding changed/,
        ],
        revision: [
          "UPDATE projects SET revision=1 WHERE id=?",
          [t.job.projectId],
          /pre-concepts/,
        ],
        lease: [
          "UPDATE studio_jobs SET leaseToken='worker',leaseUntil=9999999999999",
          [],
          /pre-concepts/,
        ],
        running: [
          "UPDATE studio_jobs SET status='running'",
          [],
          /pre-concepts/,
        ],
        state: [
          "UPDATE studio_jobs SET state=json_set(state,'$.castApproved',1)",
          [],
          /pre-concepts/,
        ],
        step: [
          "INSERT INTO studio_steps VALUES(?,'concepts','hash','started',NULL)",
          [t.job.id],
          /Downstream/,
        ],
        call: [
          "INSERT INTO studio_calls VALUES('later',?,'concepts','text','fake','hash','rejected',NULL,NULL,NULL,0,NULL,?)",
          [t.job.id, now()],
          /Downstream/,
        ],
        ambiguous: [
          "UPDATE studio_calls SET status='ambiguous_failure'",
          [],
          /unresolved/,
        ],
        extraction: [
          "UPDATE studio_steps SET state='started' WHERE stage='heart'",
          [],
          /completed original/,
        ],
        source: [
          "UPDATE almanac_sources SET sourceHash=?",
          ["0".repeat(64)],
          /source snapshot changed/,
        ],
        newer: [
          "INSERT INTO studio_jobs(id,projectId,baseRevision,kind,status,stage,request,state,profile,allowance,createdAt) SELECT 'newer',projectId,0,'generation','complete','family_review',request,state,profile,0,createdAt FROM studio_jobs WHERE id=?",
          [t.job.id],
          /pre-concepts/,
        ],
      };
      const [sql, values, error] = mutations[drift];
      t.store.db.prepare(sql).run(...values);
      assert.throws(
        () => correctPausedStudioHeart(t.store, "operator", t.input),
        error,
      );
      assert.equal(
        t.store.all(
          "SELECT * FROM studio_steps WHERE stage=?",
          HEART_CORRECTION_STAGE,
        ).length,
        0,
      );
    } finally {
      t.close();
    }
  }
});
