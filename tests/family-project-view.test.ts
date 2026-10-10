import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app.js";
import { configureAccess } from "../src/server/access.js";
import { engineConfig } from "../src/server/engine/provider.js";
import { canonical, hash, now, Store } from "../src/server/store.js";

test("project API redacts raw failure and paid recovery details for families while retaining operator diagnostics", async () => {
  const directory = mkdtempSync(join(tmpdir(), "everlore-family-projection-"));
  const store = new Store(directory);
  const rawFailure = "PRIVATE_DIAGNOSTIC provider request failed; quota=12345";
  const requestId = "PRIVATE_PROVIDER_REQUEST";
  const source = {
    version: 1,
    mode: "manual",
    recordingId: null,
    rawText: "I remember the green door.",
    segments: [
      {
        id: "s1",
        text: "I remember the green door.",
        startMs: null,
        endMs: null,
      },
    ],
  };
  for (const owner of ["operator", "family", "other-family"]) {
    store.run(
      "INSERT INTO users VALUES(?,?,?,?,?)",
      owner,
      owner,
      "unused",
      "private",
      now(),
    );
    store.run(
      "INSERT INTO sessions VALUES(?,?,?)",
      hash(`session-${owner}`),
      owner,
      Date.now() + 60000,
    );
  }
  configureAccess(store, false, "operator");
  function project(id: string, owner: string) {
    store.run(
      "INSERT INTO projects VALUES(?,?,?,?,?,0,?,?,?)",
      id,
      owner,
      "Synthetic memory",
      "manual",
      "needs_attention",
      canonical(source),
      now(),
      now(),
    );
  }
  function studio(id: string, owner: string) {
    project(id, owner);
    store.run(
      "INSERT INTO studio_jobs(id,projectId,baseRevision,kind,status,stage,request,state,profile,allowance,error,createdAt) VALUES(?,?,0,'generation','needs_attention','heart','{}',?,'fixture-profile',100,?,?)",
      `${id}-studio`,
      id,
      canonical({ source }),
      rawFailure,
      now(),
    );
    store.run(
      "INSERT INTO studio_calls VALUES(?,?, 'heart','text','fixture-model','input','ambiguous_failure',1,?,NULL,50,NULL,?)",
      `${id}-call`,
      `${id}-studio`,
      requestId,
      now(),
    );
    store.run(
      "INSERT INTO jobs(id,projectId,inputHash,baseRevision,status,stage,attempt,error) VALUES(?,?,?,0,'retryable_failure','manuscript',1,?)",
      `${id}-job`,
      id,
      `${id}-input`,
      rawFailure,
    );
  }
  studio("family-studio", "family");
  studio("operator-studio", "operator");
  project("family-legacy", "family");
  store.run(
    "INSERT INTO engine_runs(id,projectId,baseRevision,status,stage,consent,profile,allowance,error,transcript,createdAt) VALUES('legacy-run','family-legacy',0,'needs_attention','manuscript','{}','{}',100,?,?,?)",
    rawFailure,
    canonical(source),
    now(),
  );
  project("family-clean", "family");
  store.run(
    "INSERT INTO jobs(id,projectId,inputHash,baseRevision,status,stage,attempt,error) VALUES('clean-job','family-clean','clean-input',0,'queued','manuscript',0,NULL)",
  );
  const server = createApp(
    store,
    engineConfig({}),
    async () => {
      throw new Error("No provider calls expected");
    },
    null,
  ).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  async function get(path: string, user: string) {
    const response = await fetch(`${base}/api${path}`, {
      headers: { Cookie: `evermore=session-${user}` },
    });
    return { status: response.status, body: await response.json() };
  }
  try {
    for (const id of ["family-studio", "family-legacy"]) {
      const { status, body } = await get(`/projects/${id}`, "family");
      assert.equal(status, 200);
      assert.equal(body.engine.status, "needs_attention");
      assert.equal(body.transcript.rawText, source.rawText);
      assert.equal(body.engine.transcript, source.rawText);
      assert.match(body.engine.error, /memory and completed work are saved/);
      assert.match(body.engine.error, /Everlore host/);
      assert.doesNotMatch(
        JSON.stringify(body),
        /PRIVATE_|quota=|extraReserveUsd|fixture-model/,
      );
      if (id === "family-studio") {
        assert.equal(body.engine.recovery, null);
        assert.match(body.jobs[0].error, /memory and completed work are saved/);
        assert.equal(body.jobs[0].attempt, 1);
      }
    }
    const ownOperator = await get("/projects/operator-studio", "operator");
    assert.equal(ownOperator.status, 200);
    assert.equal(ownOperator.body.engine.error, rawFailure);
    assert.equal(ownOperator.body.engine.recovery.requestId, requestId);
    assert.equal(ownOperator.body.jobs[0].error, rawFailure);
    const operatorRecovery = await get(
      "/operator/projects/family-studio/recovery",
      "operator",
    );
    assert.equal(operatorRecovery.status, 200);
    assert.equal(operatorRecovery.body.error, rawFailure);
    assert.equal(operatorRecovery.body.recovery.requestId, requestId);
    assert.equal(
      (await get("/operator/projects/family-studio/recovery", "family")).status,
      403,
    );
    assert.equal(
      (await get("/projects/family-studio", "other-family")).status,
      404,
    );
    assert.equal(
      (await get("/projects/family-studio/engine/evidence", "family")).status,
      403,
    );
    assert.equal(
      (await get("/projects/family-studio/engine/evidence", "other-family"))
        .status,
      403,
    );
    const evidence = await get(
      "/projects/family-studio/engine/evidence",
      "operator",
    );
    assert.equal(evidence.status, 200);
    assert.equal(evidence.body.jobs[0].calls[0].requestId, requestId);
    const clean = await get("/projects/family-clean", "family");
    assert.equal(clean.body.engine, null);
    assert.equal(clean.body.jobs[0].error, null);
    assert.equal(
      store.one<{ error: string }>(
        "SELECT error FROM studio_jobs WHERE projectId='family-studio'",
      )!.error,
      rawFailure,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
