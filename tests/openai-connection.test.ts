import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, hash, now } from "../src/server/store.js";
import {
  replaceOpenAIConnection,
  verifyOpenAIConnection,
} from "../src/server/engine/connection.js";

const oldKey = "sk-synthetic-old-key-not-for-provider",
  newKey = "sk-synthetic-new-key-not-for-provider",
  model = "synthetic-text-model";
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "everlore-openai-")),
    store = new Store(dir),
    file = join(dir, "studio-connection.json");
  const settings = {
    ownerId: "existing-owner",
    apiKey: oldKey,
    budgetCents: 13800,
    audioReserve: 300,
    textReserve: 50,
    imageReserve: 75,
    textModel: model,
    imageModel: "existing-image-model",
    futureSettings: { keep: "exactly" },
  };
  writeFileSync(file, JSON.stringify(settings), { mode: 0o600 });
  return {
    store,
    file,
    settings,
    clean() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("OpenAI replacement is read-only verified and changes only the private key, preserving owner, models and funds", async () => {
  const t = setup();
  try {
    t.store.run(
      "INSERT INTO studio_connection_checks VALUES(?,?,?)",
      hash(newKey),
      JSON.stringify({
        kind: "authentication",
        httpStatus: 401,
        retrySafe: true,
      }),
      now(),
    );
    let count = 0;
    const result = await replaceOpenAIConnection(
      t.store,
      newKey,
      model,
      async (url, init) => {
        count++;
        assert.equal(String(url), `https://api.openai.com/v1/models/${model}`);
        assert.equal(init?.method, "GET");
        assert.equal(init?.redirect, "error");
        assert.equal(init?.body, undefined);
        assert.equal(
          new Headers(init?.headers).get("Authorization"),
          `Bearer ${newKey}`,
        );
        return Response.json({ id: model, object: "model" });
      },
    );
    assert.equal(count, 1);
    assert.deepEqual(JSON.parse(readFileSync(t.file, "utf8")), {
      ...t.settings,
      apiKey: newKey,
    });
    assert.equal(statSync(t.file).mode & 0o777, 0o600);
    assert.equal(
      t.store.one<{ failure: null }>(
        "SELECT failure FROM studio_connection_checks WHERE keyHash=?",
        hash(newKey),
      )?.failure,
      null,
    );
    assert.equal(result.generationStarted, false);
    assert.equal(result.billingVerified, false);
    assert.equal(result.restartRequired, true);
    assert.doesNotMatch(
      JSON.stringify(result),
      /sk-synthetic|existing-owner|13800/,
    );
    assert.equal(t.store.all("SELECT * FROM studio_jobs").length, 0);
  } finally {
    t.clean();
  }
});
test("invalid, rejected and malformed OpenAI replacements preserve the previous private connection without echoing payloads", async () => {
  const t = setup();
  try {
    const original = readFileSync(t.file, "utf8");
    let sent = 0;
    await assert.rejects(
      () =>
        replaceOpenAIConnection(t.store, "short", model, async () => {
          sent++;
          return Response.json({});
        }),
      /complete OpenAI/,
    );
    assert.equal(sent, 0);
    for (const response of [
      new Response("PRIVATE_PROVIDER_PAYLOAD", { status: 401 }),
      new Response("PRIVATE_PROVIDER_PAYLOAD", { status: 403 }),
      Response.json({ id: "other-model", object: "model" }),
      Response.json({ private: "PRIVATE_PROVIDER_PAYLOAD" }),
    ]) {
      await assert.rejects(
        () =>
          replaceOpenAIConnection(t.store, newKey, model, async () => response),
        (error) =>
          error instanceof Error &&
          !/PRIVATE_PROVIDER_PAYLOAD|sk-synthetic/.test(error.message),
      );
      assert.equal(readFileSync(t.file, "utf8"), original);
    }
    await assert.rejects(
      () =>
        replaceOpenAIConnection(t.store, newKey, model, async () => {
          throw new Error("PRIVATE_PROVIDER_PAYLOAD");
        }),
      /Could not reach OpenAI/,
    );
    assert.equal(readFileSync(t.file, "utf8"), original);
  } finally {
    t.clean();
  }
});
test("OpenAI replacement rejects stale settings and active work rather than overwriting either", async () => {
  const t = setup();
  try {
    const updated = { ...t.settings, budgetCents: 13900 };
    await assert.rejects(
      () =>
        replaceOpenAIConnection(t.store, newKey, model, async () => {
          writeFileSync(t.file, JSON.stringify(updated));
          return Response.json({ id: model, object: "model" });
        }),
      /connection changed/,
    );
    assert.deepEqual(JSON.parse(readFileSync(t.file, "utf8")), updated);
    t.store.run(
      "INSERT INTO users VALUES('owner','Owner','password','private',?)",
      now(),
    );
    t.store.run(
      "INSERT INTO projects VALUES('project','owner','Synthetic','manual','draft',0,NULL,?,?)",
      now(),
      now(),
    );
    t.store.run(
      "INSERT INTO studio_jobs(id,projectId,baseRevision,kind,status,stage,request,state,profile,allowance,createdAt) VALUES('job','project',0,'generation','queued','source','{}','{}','synthetic',100,?)",
      now(),
    );
    let sent = 0;
    await assert.rejects(
      () =>
        replaceOpenAIConnection(t.store, newKey, model, async () => {
          sent++;
          return Response.json({ id: model, object: "model" });
        }),
      /active story work/,
    );
    assert.equal(sent, 0);
  } finally {
    t.clean();
  }
});
test("OpenAI connection checks reject invalid model paths and report authentication without implying billing", async () => {
  let sent = 0;
  await assert.rejects(
    () =>
      verifyOpenAIConnection(newKey, "../secret", async () => {
        sent++;
        return Response.json({});
      }),
    /configured text model/,
  );
  assert.equal(sent, 0);
  const result = await verifyOpenAIConnection(newKey, model, async () =>
    Response.json({ id: model, object: "model" }),
  );
  assert.equal(result.authenticated, true);
  assert.equal(result.billingVerified, false);
  assert.equal(result.generationStarted, false);
});
