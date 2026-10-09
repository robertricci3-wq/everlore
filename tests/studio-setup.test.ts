import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store.js";
import { engineConfig } from "../src/server/engine/provider.js";
import {
  saveStudioConnection,
  setupView,
  loadStudioConnection,
} from "../src/server/engine/setup.js";
import { studioAllowance } from "../src/server/engine/studio.js";
import {
  studioReservation,
  studioSettingsIssue,
  usdCents,
} from "../src/shared/studioSetup.js";

const input = {
  apiKey: "sk-synthetic-never-a-real-provider-key",
  budgetUsd: 69.5,
  audioReserveUsd: 3,
  textReserveUsd: 0.5,
  imageReserveUsd: 0.75,
  authorizeCosts: true,
};
test("setup and generation use the same bounded reservation and exact cents", () => {
  const config = {
    ...engineConfig({}),
    audioReserve: 300,
    textReserve: 50,
    imageReserve: 75,
  };
  assert.equal(studioReservation(config), 6950);
  assert.equal(studioAllowance(config), 6950);
  assert.equal(usdCents(0.29), 29);
  for (const [changes, pattern] of [
    [{ apiKey: "short" }, /complete API key/],
    [{ apiKey: "" }, /Paste an API key/],
    [{ budgetUsd: 0 }, /total allowance/],
    [{ budgetUsd: NaN }, /valid total allowance/],
    [{ budgetUsd: 10001 }, /cannot exceed/],
    [{ textReserveUsd: 0 }, /editorial request reserve/],
    [{ imageReserveUsd: 0.001 }, /illustration request reserve/],
    [{ audioReserveUsd: 101 }, /audio request reserve/],
    [{ audioReserveUsd: 0.999 }, /two decimal places/],
    [{ authorizeCosts: false }, /authorization box/],
  ] as const)
    assert.match(
      studioSettingsIssue({ ...input, ...changes }, false, 0)!,
      pattern,
    );
  assert.equal(studioSettingsIssue({ ...input, apiKey: "" }, true, 0), null);
  assert.match(
    studioSettingsIssue(input, true, 6951)!,
    /69.51 already reserved/,
  );
});

test("saving a smaller allowance keeps the key but blocks new books until sufficiently funded", () => {
  const dir = mkdtempSync(join(tmpdir(), "everlore-setup-")),
    store = new Store(dir),
    config = engineConfig({});
  try {
    const saved = saveStudioConnection(
      store,
      "owner",
      { ...input, budgetUsd: 10 },
      config,
    );
    assert.equal(saved.ready, true);
    assert.equal(saved.hasKey, true);
    assert.equal(saved.canStart, false);
    assert.match(saved.message, /at least \$69.50/);
    assert.doesNotMatch(JSON.stringify(saved), /sk-synthetic/);
    assert.equal(saved.textReserveUsd, 0.5);
    assert.equal(saved.imageReserveUsd, 0.75);
    assert.equal(saved.audioReserveUsd, 3);
    assert.throws(
      () => saveStudioConnection(store, "other", input, config),
      /Only the shelf/,
    );
    assert.throws(
      () =>
        saveStudioConnection(
          store,
          "owner",
          { ...input, authorizeCosts: false },
          config,
        ),
      /authorization box/,
    );
    assert.equal(config.budgetCents, 1000);
    const updated = saveStudioConnection(
      store,
      "owner",
      { ...input, apiKey: "" },
      config,
    );
    assert.equal(updated.canStart, true);
    const restarted = engineConfig({});
    loadStudioConnection(store, restarted);
    assert.deepEqual(setupView(store, "owner", restarted), updated);
    assert.equal(restarted.apiKey, input.apiKey);
    store.run(
      "INSERT INTO engine_budget VALUES(?,?,?)",
      "synthetic-reservation",
      1,
      new Date().toISOString(),
    );
    assert.equal(setupView(store, "owner", config).canStart, false);
    assert.match(setupView(store, "owner", config).message, /at least \$69.51/);
    assert.equal(store.all("SELECT * FROM studio_calls").length, 0);
    assert.equal(store.all("SELECT * FROM studio_jobs").length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
