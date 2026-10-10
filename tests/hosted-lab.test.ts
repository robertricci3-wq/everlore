import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash, Store } from "../src/server/store.js";
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
      store.one<{ count: number }>(
        "SELECT count(*) AS count FROM lab_releases",
      )!.count,
      0,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("hosted quality helper keeps resumable evidence outside family storage", () => {
  const scratch = realpathSync(
    mkdtempSync(join(tmpdir(), "everlore-hosted-quality-")),
  );
  const mountedRoot = process.env.EVERLORE_HOSTED_QUALITY_DIR;
  const qualityRoot = mountedRoot ?? scratch;
  const directory = mkdtempSync(join(qualityRoot, "session-"));
  const family = mountedRoot ? process.env.DATA_DIR! : join(scratch, "family");
  if (!mountedRoot) {
    const store = new Store(family);
    createOperator(store, "private-smoke-family", "Synthetic smoke password");
    store.close();
  }
  function snapshot(root: string): Array<[string, string]> {
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory()
        ? snapshot(path)
        : [[path, hash(readFileSync(path))]];
    });
  }
  function run(...args: string[]) {
    const result = spawnSync("sh", ["scripts/quality-loop.sh", ...args], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        DATA_DIR: family,
        OPENAI_API_KEY: "synthetic-must-not-be-used",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes("synthetic-must-not-be-used"), false);
    return JSON.parse(result.stdout);
  }
  try {
    if (mountedRoot) {
      assert.equal(mountedRoot, "/var/data/everlore-quality");
      assert.equal(family, "/var/data/everlore");
      assert.equal(statSync(mountedRoot).mode & 0o777, 0o700);
      assert.equal(statSync(mountedRoot).uid, process.getuid!());
    }
    const before = snapshot(family);
    const preflight = run("preflight", `--data-dir=${directory}`);
    assert.equal(preflight.initialized, false);
    assert.equal(preflight.providerCredentialsLoaded, false);
    assert.equal(existsSync(join(directory, "evermore.sqlite")), false);
    const first = run(
      "offline",
      `--data-dir=${directory}`,
      "--lane=memory",
      "--iterations=1",
      "--request-key=hosted-smoke",
    );
    assert.equal(first.status, "complete");
    assert.equal(first.iteration, 1);
    assert.equal(first.experiments.length, 1);
    assert.equal(first.experiments[0].summary.providerCalls, 0);
    assert.equal(first.experiments[0].summary.promotionEligible, false);
    assert.equal(
      first.experiments[0].summary.complete,
      first.experiments[0].summary.total,
    );
    const evidence = snapshot(directory);
    assert.deepEqual(run("resume", first.id, `--data-dir=${directory}`), first);
    assert.deepEqual(run("report", first.id, `--data-dir=${directory}`), first);
    // Opening an existing SQLite connection may alter WAL bookkeeping; verify
    // retained evidence by report identity and leave family bytes untouched.
    assert.ok(evidence.some(([path]) => path.endsWith("evermore.sqlite")));
    assert.deepEqual(snapshot(family), before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});
