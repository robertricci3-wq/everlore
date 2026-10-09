import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store.js";
import { createOperator } from "../src/server/access.js";
import { engineConfig, type Provider } from "../src/server/engine/provider.js";
import { activeProfile } from "../src/server/lab/profiles.js";
import {
  candidateProfile,
  codeHash,
  createExperiment,
  experiment,
  parsePlan,
  setLabOwner,
  summary,
} from "../src/server/lab/service.js";
import { runExperiment } from "../src/server/lab/runner.js";

test("hosted Lab freezes and resumes with CI-identical source inputs and no provider calls", async () => {
  // This same test runs in the built Docker image as the unprivileged user.
  // It deliberately ignores DATA_DIR and all provider environment settings.
  const directory = mkdtempSync(join(tmpdir(), "everlore-hosted-lab-"));
  let store = new Store(directory);
  const config = engineConfig({});
  let providerCalls = 0;
  const forbidden = async (): Promise<never> => {
    providerCalls++;
    throw new Error("The hosted Lab smoke test must never call a provider.");
  };
  const provider: Provider = {
    transcribe: forbidden,
    structured: forbidden,
    image: forbidden,
  };
  try {
    const implementationHash = codeHash();
    assert.match(implementationHash, /^[a-f0-9]{64}$/);
    if (process.env.EVERLORE_EXPECTED_CODE_HASH)
      assert.equal(
        implementationHash,
        process.env.EVERLORE_EXPECTED_CODE_HASH,
        "The container must fingerprint the exact sources verified by CI.",
      );
    const owner = createOperator(
      store,
      "synthetic-lab-operator",
      "Synthetic disposable test password",
    );
    setLabOwner(store, owner);
    const baseline = activeProfile(store, config);
    const candidate = candidateProfile(store, config, "particulars");
    const experimentId = createExperiment(
      store,
      owner,
      {
        plan: {
          evaluationPhase: "development",
          title: "Container compatibility check",
          hypothesis: "The packaged runtime retains every frozen source input.",
          risk: "Omitted test sources prevent freezing or resuming experiments.",
          lane: "story",
          candidateHash: candidate.hash,
          caseIds: ["ordinary"],
          replicates: 1,
          mode: "offline",
          criterion: "family_specificity",
          principleIds: ["specificity"],
          prerequisiteIds: [],
        },
        maxCents: 0,
        authorizeCosts: false,
      },
      config,
    );
    const frozen = parsePlan(experiment(store, experimentId));
    assert.equal(frozen.codeHash, implementationHash);
    assert.equal(frozen.baselineHash, baseline.hash);
    assert.equal(frozen.candidateHash, candidate.hash);

    store.close();
    store = new Store(directory);
    assert.deepEqual(parsePlan(experiment(store, experimentId)), frozen);
    await runExperiment(store, experimentId, provider, config);
    const result = summary(store, experiment(store, experimentId));
    assert.equal(result.complete, 2);
    assert.equal(result.failures, 0);
    assert.equal(providerCalls, 0);
    assert.equal(activeProfile(store, config).hash, baseline.hash);
    assert.equal(
      store.one<{ count: number }>("SELECT count(*) AS count FROM lab_releases")!.count,
      0,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
