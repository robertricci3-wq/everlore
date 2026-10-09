import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import { Store, now, type ProjectRow } from "../src/server/store.js";
import {
  queueStudio,
  runStudio,
  studioView,
} from "../src/server/engine/studio.js";
import { resumeStudio } from "../src/server/engine/recovery.js";
import {
  reservedBudget,
  requestStudioPause,
  StudioPreDispatchPause,
} from "../src/server/engine/budget.js";
import type { RequestCostBound } from "../src/server/engine/request-cost.js";
import type { ProviderReceipt } from "../src/server/engine/provider.js";
import { StudioFake, testConfig } from "./support/studio-fixtures.js";

const config = { ...testConfig, strictCostGuard: true };
const consent = {
  autonomous: true,
  processWithOpenAI: true,
  imaginativeAdaptation: true,
  legacyWish: "",
};
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "everlore-request-budget-")),
    store = new Store(dir);
  store.run(
    "INSERT INTO users VALUES('owner','owner','unused','private',?)",
    now(),
  );
  store.run(
    "INSERT INTO projects VALUES('memory','owner','Synthetic budget test','unavailable','awaiting_transcription',0,NULL,?,?)",
    now(),
    now(),
  );
  const digest = store.putAsset("memory", "synthetic audio only", "audio");
  store.run(
    "INSERT INTO recordings VALUES('rec','memory',?,'audio/wav',20,'upload',?)",
    digest,
    now(),
  );
  const project = () =>
    store.one<ProjectRow>("SELECT * FROM projects WHERE id='memory'")!;
  const jobId = queueStudio(store, project(), consent, config);
  return {
    store,
    project,
    jobId,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
class GuardedFake extends StudioFake {
  guard?: (bound: RequestCostBound) => void;
  costs = { audio: 40, text: 120, image: 80 };
  blockPlan = false;
  beforeDispatch?: () => void;
  waitForAudio?: Promise<void>;
  withRequestGuard(guard: (bound: RequestCostBound) => void) {
    this.guard = guard;
    return this;
  }
  validateRequestCosts() {
    if (this.blockPlan)
      throw new StudioPreDispatchPause("Synthetic unbounded reference cost.");
  }
  takeReceipt(): ProviderReceipt {
    return {
      requestId: "synthetic-request",
      usage: { input_tokens: 1 },
      meteredCost: {
        version: 1,
        rateCardVersion: "synthetic-cost-rule-1",
        estimatedCostCents: 1,
        source: "provider_usage",
        billedCostCents: null,
      },
    };
  }
  quote(kind: RequestCostBound["kind"]) {
    this.beforeDispatch?.();
    this.guard!({
      version: 1,
      rateCardVersion: "synthetic-cost-rule-1",
      model: `test-${kind}`,
      kind,
      maxCostCents: this.costs[kind],
      evidence: { synthetic: 1 },
    });
  }
  override async transcribe() {
    this.quote("audio");
    const result = await super.transcribe();
    await this.waitForAudio;
    return result;
  }
  override async structured<T>(
    name: string,
    schema: z.ZodType<T>,
    instructions: string,
    data: unknown,
    images: Buffer[] = [],
  ) {
    this.quote("text");
    return super.structured(name, schema, instructions, data, images);
  }
  override async image(prompt: string, refs?: Buffer | Buffer[]) {
    this.quote("image");
    return super.image(prompt, refs);
  }
}
function resume(t: ReturnType<typeof setup>, c = config) {
  const recovery = studioView(t.store, "memory")!.recovery!;
  assert(recovery);
  return resumeStudio(
    t.store,
    t.project(),
    {
      jobId: t.jobId,
      callId: recovery.callId,
      acknowledgePossibleCharge: false,
    },
    c,
  );
}

test("strict preflight refuses unsupported costs and unguarded providers before any paid call", async () => {
  for (const provider of [
    Object.assign(new GuardedFake(), { blockPlan: true }),
    new StudioFake(),
  ]) {
    const t = setup();
    try {
      await runStudio(t.store, provider, config);
      assert.deepEqual(provider.calls, []);
      assert.equal(t.store.all("SELECT * FROM studio_calls").length, 0);
      assert.equal(reservedBudget(t.store), 0);
      const recovery = studioView(t.store, "memory")!.recovery!;
      assert.equal(recovery.uncertain, false);
      assert.equal(recovery.stage, "transcription");
      assert.equal(
        t.store.all("SELECT * FROM studio_checkpoints WHERE resumedAt IS NULL")
          .length,
        1,
      );
      assert.equal(await runStudio(t.store, provider, config), false);
    } finally {
      t.close();
    }
  }
});

test("a bound above the flat estimate stops before dispatch and safe resume reuses completed work", async () => {
  const t = setup(),
    p = new GuardedFake();
  try {
    t.store.run("UPDATE studio_jobs SET allowance=100");
    t.store.run("UPDATE engine_budget SET allowance=100");
    await runStudio(t.store, p, { ...config, budgetCents: 150 });
    assert.deepEqual(p.calls, ["transcription"]);
    assert.equal(reservedBudget(t.store), 40);
    assert.equal(
      t.store.one("SELECT * FROM studio_steps WHERE stage='heart'"),
      undefined,
    );
    const calls = t.store.all<{ estimatedCents: number; actualCents: null }>(
      "SELECT * FROM studio_calls",
    );
    assert.deepEqual(
      calls.map((c) => c.estimatedCents),
      [40],
    );
    assert.equal(calls[0].actualCents, null);
    assert.equal(t.store.all("SELECT * FROM studio_request_bounds").length, 1);
    const recovery = studioView(t.store, "memory")!.recovery!;
    assert.equal(recovery.stage, "heart");
    assert.equal(recovery.uncertain, false);
    assert.throws(
      () => resume(t, { ...config, budgetCents: 150 }),
      /allowance/,
    );
    const nextConfig = { ...config, budgetCents: 160, strictCostGuard: false };
    resume(t, nextConfig);
    resumeStudio(
      t.store,
      t.project(),
      {
        jobId: t.jobId,
        callId: recovery.callId,
        acknowledgePossibleCharge: false,
      },
      nextConfig,
    );
    p.onStructured = () => requestStudioPause(t.store, t.jobId);
    await runStudio(t.store, p, nextConfig);
    assert.deepEqual(p.calls, ["transcription", "heart"]);
    assert.equal(reservedBudget(t.store), 160);
    assert.equal(t.store.all("SELECT * FROM studio_request_bounds").length, 2);
    assert.equal(t.store.all("SELECT * FROM studio_recoveries").length, 1);
    assert.equal(
      JSON.parse(
        t.store.one<{ request: string }>("SELECT request FROM studio_jobs")!
          .request,
      ).strictCostGuard,
      true,
    );
    assert.equal(studioView(t.store, "memory")!.recovery!.uncertain, false);
  } finally {
    t.close();
  }
});

test("a pause during an in-flight call saves its result then stops the next request; resume is idempotent", async () => {
  const t = setup(),
    p = new GuardedFake();
  let finish!: () => void;
  p.waitForAudio = new Promise<void>((resolve) => {
    finish = resolve;
  });
  try {
    const running = runStudio(t.store, p, config);
    assert.deepEqual(p.calls, ["transcription"]);
    requestStudioPause(t.store, t.jobId);
    finish();
    await running;
    assert.deepEqual(p.calls, ["transcription"]);
    assert.equal(
      t.store.one<{ state: string }>(
        "SELECT state FROM studio_steps WHERE stage='transcription'",
      )!.state,
      "completed",
    );
    assert.equal(studioView(t.store, "memory")!.recovery!.stage, "heart");
    resume(t);
    p.onStructured = () => requestStudioPause(t.store, t.jobId);
    await runStudio(t.store, p, config);
    assert.deepEqual(p.calls, ["transcription", "heart"]);
    assert.equal(reservedBudget(t.store), 160);
  } finally {
    t.close();
  }
});

test("a pause arriving while the provider prepares its request is checked again before dispatch", async () => {
  const t = setup(),
    p = new GuardedFake();
  try {
    p.beforeDispatch = () => requestStudioPause(t.store, t.jobId);
    await runStudio(t.store, p, config);
    assert.deepEqual(p.calls, []);
    assert.equal(t.store.all("SELECT * FROM studio_calls").length, 0);
    assert.equal(reservedBudget(t.store), 0);
    assert.equal(
      studioView(t.store, "memory")!.recovery!.stage,
      "transcription",
    );
  } finally {
    t.close();
  }
});

test("ambiguous dispatched requests retain their full bound and require explicit uncertain recovery", async () => {
  const t = setup(),
    p = new GuardedFake();
  try {
    p.failAt = "heart";
    await runStudio(t.store, p, config);
    assert.deepEqual(p.calls, ["transcription", "heart"]);
    assert.equal(reservedBudget(t.store), 160);
    assert.equal(studioView(t.store, "memory")!.recovery!.uncertain, true);
    assert.equal(t.store.all("SELECT * FROM studio_checkpoints").length, 0);
    assert.throws(() => resume(t), /possible earlier charge/);
    assert.equal(await runStudio(t.store, p, config), false);
    assert.deepEqual(p.calls, ["transcription", "heart"]);
  } finally {
    t.close();
  }
});

test("a complete guarded fixture book retains bounds and usage estimates separately without double-reserving", async () => {
  const t = setup(),
    p = new GuardedFake();
  try {
    await runStudio(t.store, p, config);
    assert.equal(studioView(t.store, "memory")!.status, "complete");
    assert.equal(t.store.all("SELECT * FROM editions").length, 1);
    const calls = t.store.all<{
      estimatedCents: number;
      actualCents: number | null;
    }>("SELECT estimatedCents,actualCents FROM studio_calls");
    assert(calls.length > 12);
    assert(calls.every((c) => c.actualCents === null));
    assert.equal(
      reservedBudget(t.store),
      calls.reduce((sum, c) => sum + c.estimatedCents, 0),
    );
    assert.equal(
      t.store.all("SELECT * FROM studio_request_bounds").length,
      calls.length,
    );
    const costs = t.store.all<{ body: string }>(
      "SELECT body FROM studio_metered_costs",
    );
    assert.equal(costs.length, calls.length);
    assert(costs.every((c) => JSON.parse(c.body).billedCostCents === null));
    assert.equal(await runStudio(t.store, p, config), false);
  } finally {
    t.close();
  }
});
