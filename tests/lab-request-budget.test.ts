import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, now } from "../src/server/store.js";
import { OpenAIProvider, type EngineConfig } from "../src/server/engine/provider.js";
import { REQUEST_RATE_CARD } from "../src/server/engine/request-cost.js";
import { candidateProfile, createExperiment, experiment, setLabOwner } from "../src/server/lab/service.js";
import { runExperiment } from "../src/server/lab/runner.js";
import { seedLibrary } from "../src/server/lab/library.js";
import { fixtureWorld, StudioFake } from "./support/studio-fixtures.js";

const config: EngineConfig = {
  enabled: true, apiKey: "synthetic-local-key", budgetCents: 1,
  textReserve: 1, imageReserve: 1, audioReserve: 1,
  textModel: "gpt-5.4", imageModel: "gpt-image-2", audioModel: "gpt-4o-transcribe",
};
function setup(maxCents: number) {
  const dir = mkdtempSync(join(tmpdir(), "everlore-lab-guard-")), store = new Store(dir);
  store.run("INSERT INTO users VALUES('operator','Guard test','unused','private',?)", now());
  setLabOwner(store, "operator");
  seedLibrary(store);
  const profile = candidateProfile(store, config, "posture");
  const eid = createExperiment(store, "operator", {
    plan: {
      title: "Request-bound isolated test", hypothesis: "Exercise every dispatch guard without a network call.",
      risk: "Synthetic results are not creative evidence.", lane: "art", mode: "live",
      candidateHash: profile.hash, caseIds: ["front"], replicates: 1,
      criterion: "visual_expression", principleIds: ["specificity"], prerequisiteIds: [],
    },
    maxCents, authorizeCosts: true,
  }, config);
  return { store, eid, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function response() {
  return new Response(JSON.stringify({
    status: "completed", usage: { input_tokens: 200, output_tokens: 100 },
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(fixtureWorld) }] }],
  }), { status: 200, headers: { "Content-Type": "application/json", "x-request-id": "synthetic-receipt" } });
}

test("Lab rejects unguarded providers before dispatch and preserves a resumable checkpoint", async () => {
  const t = setup(10000), provider = new StudioFake();
  try {
    await runExperiment(t.store, t.eid, provider, config);
    assert.equal(experiment(t.store, t.eid).status, "paused");
    assert.deepEqual(provider.calls, []);
    assert.equal(t.store.one<{n:number}>("SELECT COUNT(*) n FROM lab_calls")!.n, 0);
    assert.match(t.store.one<{message:string}>("SELECT message FROM lab_request_checkpoints")!.message, /conservative/);
    await runExperiment(t.store, t.eid, provider, config);
    assert.deepEqual(provider.calls, []);
    assert.equal(experiment(t.store, t.eid).status, "paused");
  } finally { t.close(); }
});

test("Lab reserves the actual adapter bound before a text request; unbounded art stops without dispatch", async () => {
  const t = setup(10000);
  let fetches = 0;
  const provider = new OpenAIProvider(config, async (url) => {
    fetches++;
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    const reserved = t.store.one<{ estimatedCents:number; body:string }>(
      "SELECT c.estimatedCents,b.body FROM lab_calls c JOIN lab_request_bounds b ON b.callId=c.id WHERE status='started'",
    )!;
    assert(reserved.estimatedCents > config.textReserve);
    assert.equal(JSON.parse(reserved.body).maxCostCents, reserved.estimatedCents);
    assert.equal(JSON.parse(reserved.body).rateCardVersion, REQUEST_RATE_CARD.version);
    return response();
  });
  try {
    await runExperiment(t.store, t.eid, provider, config);
    assert.equal(fetches, 1);
    assert.equal(experiment(t.store, t.eid).status, "paused");
    assert.match(experiment(t.store, t.eid).error!, /input.*bound|bound.*input/);
    assert.equal(t.store.one<{n:number}>("SELECT COUNT(*) n FROM lab_calls")!.n, 1);
    assert.equal(t.store.one<{actualCents:null}>("SELECT actualCents FROM lab_calls")!.actualCents, null);
    const metered = JSON.parse(t.store.one<{body:string}>("SELECT body FROM lab_metered_costs")!.body);
    assert.equal(metered.source, "provider_usage");
    assert.equal(metered.billedCostCents, null);
    assert(metered.estimatedCostCents > 0);
    await runExperiment(t.store, t.eid, provider, config);
    assert.equal(fetches, 1, "resuming reuses completed world and never repeats its paid request");
  } finally { t.close(); }
});

test("Lab allowance exhaustion occurs before request and creates no false paid attempt", async () => {
  const t = setup(100);
  let fetches = 0;
  const provider = new OpenAIProvider(config, async () => { fetches++; return response(); });
  try {
    await runExperiment(t.store, t.eid, provider, config);
    assert.equal(fetches, 0);
    assert.equal(experiment(t.store, t.eid).status, "paused");
    assert.equal(t.store.one<{n:number}>("SELECT COUNT(*) n FROM lab_calls")!.n, 0);
    assert.equal(t.store.one<{n:number}>("SELECT COUNT(*) n FROM lab_steps")!.n, 0);
    assert.equal(t.store.one<{reason:string}>("SELECT reason FROM lab_request_checkpoints")!.reason, "budget");
    await runExperiment(t.store, t.eid, provider, config);
    assert.equal(fetches, 0);
  } finally { t.close(); }
});

test("Lab retains a network-ambiguous reservation and never retries it automatically", async () => {
  const t = setup(10000);
  let fetches = 0;
  const provider = new OpenAIProvider(config, async () => { fetches++; throw new Error("Synthetic interrupted response"); });
  try {
    await runExperiment(t.store, t.eid, provider, config);
    assert.equal(fetches, 1);
    assert.equal(experiment(t.store, t.eid).status, "needs_attention");
    const call = t.store.one<{status:string;estimatedCents:number}>("SELECT status,estimatedCents FROM lab_calls")!;
    assert.equal(call.status, "ambiguous_failure");
    assert(call.estimatedCents > config.textReserve);
    await assert.rejects(() => runExperiment(t.store, t.eid, provider, config), /reconciliation/);
    assert.equal(fetches, 1);
  } finally { t.close(); }
});
