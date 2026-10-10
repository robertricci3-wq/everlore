import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  statSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Store, id, now } from "../src/server/store.js";
import { setLabOwner } from "../src/server/lab/service.js";
import {
  newSession,
  runSession,
  SessionPlan,
  type SessionRow,
} from "../src/server/lab/session.js";
import {
  acquireSessionLease,
  releaseSessionLease,
  ownsSessionLease,
  SESSION_LEASE_MS,
} from "../src/server/lab/session-schema.js";
import { engineConfig, type Provider } from "../src/server/engine/provider.js";
import {
  createMemoryExperiment,
  runMemoryExperiment,
} from "../src/server/lab/memory.js";

const offline: Provider = {
  transcribe: async () => {
    throw new Error("Unexpected paid call");
  },
  structured: async () => {
    throw new Error("Unexpected paid call");
  },
  image: async () => {
    throw new Error("Unexpected paid call");
  },
};
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "everlore-session-")),
    store = new Store(dir);
  store.run(
    "INSERT INTO users VALUES('operator','Synthetic operator','unused','private',?)",
    now(),
  );
  setLabOwner(store, "operator");
  return {
    dir,
    store,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/lab.ts", ...args],
    {
      cwd: resolve("."),
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, ...env },
    },
  );
}

test("quality plans default to one offline memory iteration and reject unbounded limits", () => {
  assert.deepEqual(SessionPlan.parse({}), {
    mode: "offline",
    lane: "memory",
    maxIterations: 1,
    maxCents: 0,
    authorizeCosts: false,
  });
  for (const maxIterations of [0, 6, -1, Infinity, 1.2])
    assert.equal(SessionPlan.safeParse({ maxIterations }).success, false);
});

test("session request identity is idempotent and mismatched reuse is rejected", () => {
  const t = setup();
  try {
    const first = newSession(t.store, "operator", { requestKey: "a" });
    assert.equal(newSession(t.store, "operator", { requestKey: "a" }), first);
    assert.throws(
      () =>
        newSession(t.store, "operator", { requestKey: "a", maxIterations: 2 }),
      /different frozen plan/,
    );
    assert.equal(
      t.store.one<{ n: number }>("SELECT count(*) n FROM lab_sessions")!.n,
      1,
    );
  } finally {
    t.close();
  }
});

test("persisted quality lease excludes another connection and stale owners cannot release it", () => {
  const t = setup(),
    second = new Store(t.dir);
  try {
    const a = newSession(t.store, "operator", {}),
      b = newSession(t.store, "operator", {});
    const at = Date.now(),
      token = acquireSessionLease(t.store, a, at);
    assert.throws(() => acquireSessionLease(second, b, at), /already running/);
    const replacement = acquireSessionLease(
      second,
      b,
      at + SESSION_LEASE_MS + 1,
    );
    releaseSessionLease(t.store, a, token);
    assert.equal(
      ownsSessionLease(second, b, replacement, at + SESSION_LEASE_MS + 2),
      true,
    );
    assert.equal(
      ownsSessionLease(t.store, a, token, at + SESSION_LEASE_MS + 2),
      false,
    );
  } finally {
    second.close();
    t.close();
  }
});

test("memory session recovers the experiment identity saved before creation and does not replay a complete session", async () => {
  const t = setup();
  try {
    const sid = newSession(t.store, "operator", {}),
      eid = id();
    t.store.run(
      "INSERT INTO lab_session_experiments VALUES(?,0,'memory',?,NULL,?)",
      sid,
      eid,
      now(),
    );
    t.store.run(
      "UPDATE lab_sessions SET status='running',currentExperiment=? WHERE id=?",
      eid,
      sid,
    );
    await runSession(t.store, sid, offline, engineConfig({}));
    const first = t.store.one<SessionRow>(
      "SELECT * FROM lab_sessions WHERE id=?",
      sid,
    )!;
    assert.equal(first.status, "complete");
    assert.equal(first.iteration, 1);
    assert.equal(first.noProgress, 0);
    assert.equal(
      t.store.one<{ id: string }>("SELECT id FROM lab_memory_experiments")!.id,
      eid,
    );
    await runSession(t.store, sid, offline, engineConfig({}));
    assert.equal(
      t.store.one<{ n: number }>(
        "SELECT count(*) n FROM lab_memory_experiments",
      )!.n,
      1,
    );
    assert.equal(
      t.store.one<{ n: number }>("SELECT count(*) n FROM lab_calls")!.n,
      0,
    );
    assert.equal(t.store.one("SELECT slot FROM lab_session_leases"), undefined);
  } finally {
    t.close();
  }
});

test("memory session counts its first supported finding, then stops after two repeated comparisons", async () => {
  const t = setup();
  try {
    const sid = newSession(t.store, "operator", { maxIterations: 5 }),
      eid = createMemoryExperiment(t.store, "operator");
    const partial = runMemoryExperiment(t.store, "operator", eid, {
      maxPairs: 2,
    });
    assert.equal(partial.status, "paused");
    t.store.run(
      "INSERT INTO lab_session_experiments VALUES(?,0,'memory',?,NULL,?)",
      sid,
      eid,
      now(),
    );
    t.store.run(
      "UPDATE lab_sessions SET status='paused',currentExperiment=? WHERE id=?",
      eid,
      sid,
    );
    await runSession(t.store, sid, offline, engineConfig({}));
    const session = t.store.one<SessionRow>(
      "SELECT * FROM lab_sessions WHERE id=?",
      sid,
    )!;
    assert.equal(session.iteration, 3);
    assert.equal(session.noProgress, 2);
    assert.equal(session.status, "complete");
    assert.equal(
      t.store.one<{ n: number }>(
        "SELECT count(*) n FROM lab_memory_experiments",
      )!.n,
      3,
    );
    assert.match(session.checkpoint, /No live creative gain/);
  } finally {
    t.close();
  }
});

test("CLI preflight is read-only, rejects unsafe stores and paid options before initialization", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "everlore-cli-")));
  try {
    const target = join(dir, "quality"),
      production = join(dir, "family");
    const preflight = cli(["preflight", `--data-dir=${target}`], {
      DATA_DIR: production,
      OPENAI_API_KEY: "never-load-this-synthetic-value",
    });
    assert.equal(preflight.status, 0, preflight.stderr);
    assert.equal(JSON.parse(preflight.stdout).providerCredentialsLoaded, false);
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(production), false);
    for (const args of [
      ["run"],
      ["run", `--data-dir=${target}`, "--iterations=500"],
      ["run", `--data-dir=${target}`, "--live"],
      ["run", "--data-dir=.data"],
    ])
      assert.notEqual(cli(args).status, 0);
    assert.equal(existsSync(target), false);
    writeFileSync(join(dir, "private.txt"), "private existing data");
    const before = statSync(join(dir, "private.txt")).mtimeMs;
    assert.notEqual(cli(["run", `--data-dir=${dir}`]).status, 0);
    assert.equal(statSync(join(dir, "private.txt")).mtimeMs, before);
    assert.equal(
      readFileSync(join(dir, "private.txt"), "utf8"),
      "private existing data",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI runs and resumes the same isolated offline session without reading production settings", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "everlore-cli-run-")));
  try {
    const target = join(dir, "quality"),
      production = join(dir, "family");
    const env = {
      DATA_DIR: production,
      OPENAI_API_KEY: "never-load-this-synthetic-value",
    };
    const first = cli(
      ["run", `--data-dir=${target}`, "--request-key=one"],
      env,
    );
    assert.equal(first.status, 0, first.stderr);
    const report = JSON.parse(first.stdout);
    assert.equal(report.status, "complete");
    assert.equal(report.plan.maxCents, 0);
    assert.equal(report.plan.maxIterations, 1);
    assert.equal(report.plan.lane, "memory");
    assert.equal(existsSync(production), false);
    assert.equal(first.stdout.includes(env.OPENAI_API_KEY), false);
    const again = cli(
      ["run", `--data-dir=${target}`, "--request-key=one"],
      env,
    );
    assert.equal(again.status, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).id, report.id);
    const resumed = cli(["resume", report.id, `--data-dir=${target}`], env);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).iteration, 1);
    const printed = cli(["report", report.id, `--data-dir=${target}`], env);
    assert.equal(printed.status, 0, printed.stderr);
    assert.equal(JSON.parse(printed.stdout).id, report.id);
    assert.notEqual(
      cli(
        ["report", report.id, `--session=${report.id}`, `--data-dir=${target}`],
        env,
      ).status,
      0,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("busy session rejection preserves both sessions and a marker cannot authorize private data", async () => {
  const t = setup();
  try {
    const first = newSession(t.store, "operator", {}),
      second = newSession(t.store, "operator", {});
    const token = acquireSessionLease(t.store, first);
    await assert.rejects(
      runSession(t.store, second, offline, engineConfig({})),
      /already running/,
    );
    assert.equal(
      t.store.one<SessionRow>("SELECT * FROM lab_sessions WHERE id=?", second)!
        .status,
      "planned",
    );
    releaseSessionLease(t.store, first, token);
    writeFileSync(
      join(t.dir, ".everlore-synthetic-quality.json"),
      JSON.stringify({
        version: 1,
        purpose: "everlore-synthetic-quality",
        ownerId: "quality-synthetic-operator",
      }),
    );
    const before = t.store.one<{ n: number }>(
      "SELECT count(*) n FROM users",
    )!.n;
    const rejected = cli(["preflight", `--data-dir=${realpathSync(t.dir)}`]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /family or live-session data/);
    assert.equal(
      t.store.one<{ n: number }>("SELECT count(*) n FROM users")!.n,
      before,
    );
  } finally {
    t.close();
  }
});
