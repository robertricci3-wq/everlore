import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, parse, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { Store, id, now } from "../src/server/store.js";
import { engineConfig, type Provider } from "../src/server/engine/provider.js";
import { codeHash, labOwner, setLabOwner } from "../src/server/lab/service.js";
import {
  newSession,
  pauseSession,
  runSession,
  SessionPlan,
  type SessionRow,
} from "../src/server/lab/session.js";
import { experimentReport, sessionReport } from "../src/server/lab/report.js";

const MARKER = ".everlore-synthetic-quality.json";
const OWNER = "quality-synthetic-operator";
const marker = {
  version: 1,
  purpose: "everlore-synthetic-quality",
  ownerId: OWNER,
};
const offline: Provider = {
  transcribe: async () => {
    throw new Error("Offline provider call prohibited");
  },
  structured: async () => {
    throw new Error("Offline provider call prohibited");
  },
  image: async () => {
    throw new Error("Offline provider call prohibited");
  },
};

function print(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}
function help() {
  console.log(`Everlore quality sessions (offline; no provider credentials loaded)
  preflight --data-dir=PATH
  run --data-dir=PATH [--lane=memory|story|art] [--iterations=1] [--request-key=KEY]
  status --data-dir=PATH
  report [ID] --data-dir=PATH [--session=ID|--experiment=ID]
  resume [ID] --data-dir=PATH [--session=ID]
  pause --data-dir=PATH --session=ID
Explicit operator maintenance: owner "Private shelf name" | verify
No background sessions, automatic commits, deployments, or paid calls.`);
}

// An unmarked application database is never opened by a quality command. Check
// paths and marker before Store can create directories, migrate or read data.
function inspectDirectory(raw: string | undefined) {
  if (!raw)
    throw new Error(
      "Choose an isolated synthetic store with --data-dir=PATH. The family database is never the default.",
    );
  const dir = resolve(raw);
  const prohibited = [
    resolve(".data"),
    resolve("."),
    resolve(homedir()),
    parse(dir).root,
    ...(process.env.DATA_DIR ? [resolve(process.env.DATA_DIR)] : []),
  ];
  const familyRoots = [
    resolve(".data"),
    ...(process.env.DATA_DIR ? [resolve(process.env.DATA_DIR)] : []),
  ];
  if (
    prohibited.includes(dir) ||
    familyRoots.some((root) => dir.startsWith(root + sep))
  )
    throw new Error(
      "Use a dedicated synthetic quality directory, not application or family storage.",
    );
  for (let part = dir; part !== parse(part).root; part = dirname(part))
    if (existsSync(part) && lstatSync(part).isSymbolicLink())
      throw new Error("Quality data paths cannot contain symbolic links.");
  const present = existsSync(dir);
  if (present && !lstatSync(dir).isDirectory())
    throw new Error("Quality data path must be a directory.");
  const markerPath = join(dir, MARKER);
  if (!existsSync(markerPath)) {
    if (present && readdirSync(dir).length)
      throw new Error(
        "This directory is not a marked synthetic quality store. Choose an empty directory; no existing data was opened.",
      );
    return { dir, initialized: false };
  }
  if (lstatSync(markerPath).isSymbolicLink())
    throw new Error("Quality store marker cannot be a symbolic link.");
  let found: unknown;
  try {
    found = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    throw new Error("The synthetic quality store marker is invalid.");
  }
  if (JSON.stringify(found) !== JSON.stringify(marker))
    throw new Error("This is not an approved synthetic quality store.");
  for (const entry of readdirSync(dir)) {
    if (lstatSync(join(dir, entry)).isSymbolicLink())
      throw new Error("Quality store contents cannot be symbolic links.");
    if (
      ![
        MARKER,
        "media",
        "evermore.sqlite",
        "evermore.sqlite-wal",
        "evermore.sqlite-shm",
      ].includes(entry)
    )
      throw new Error(
        "The quality store contains unexpected files. Keep provider settings and family files outside it.",
      );
  }
  const databasePath = join(dir, "evermore.sqlite");
  if (existsSync(databasePath)) {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      if (
        db.prepare("SELECT id FROM users WHERE id!=?").get(OWNER) ||
        db
          .prepare("SELECT id FROM projects WHERE ownerId!=? OR status!='lab'")
          .get(OWNER) ||
        db.prepare("SELECT id FROM recordings").get() ||
        db.prepare("SELECT id FROM family_versions").get() ||
        db
          .prepare(
            "SELECT id FROM lab_sessions WHERE json_extract(plan,'$.mode')!='offline'",
          )
          .get()
      )
        throw new Error(
          "The selected store contains family or live-session data. No migrations or evaluation will run.",
        );
    } finally {
      db.close();
    }
  }
  return { dir, initialized: true };
}

function openSynthetic(location: { dir: string; initialized: boolean }) {
  if (!location.initialized) {
    mkdirSync(location.dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(location.dir, MARKER), JSON.stringify(marker), {
      flag: "wx",
      mode: 0o600,
    });
  }
  const store = new Store(location.dir);
  try {
    if (
      store.one("SELECT id FROM users WHERE id!=?", OWNER) ||
      store.one("SELECT id FROM projects WHERE ownerId!=?", OWNER) ||
      store.one("SELECT id FROM recordings") ||
      store.one("SELECT id FROM family_versions")
    )
      throw new Error(
        "This store contains material outside the synthetic quality session. No evaluation will run.",
      );
    store.run(
      "INSERT OR IGNORE INTO users VALUES(?,?,?,?,?)",
      OWNER,
      "Synthetic quality operator",
      id(),
      "private",
      now(),
    );
    setLabOwner(store, OWNER);
    return store;
  } catch (error) {
    store.close();
    throw error;
  }
}

async function main() {
  const raw = process.argv.slice(2).filter((arg) => arg !== "--");
  const command = raw[0] ?? "help";
  if (command === "help" || command === "--help") {
    help();
    return;
  }
  // These established operator commands never read saved API settings either.
  if (command === "owner" || command === "verify") {
    const store = new Store(process.env.DATA_DIR ?? ".data");
    try {
      if (command === "owner") {
        if (!raw[1])
          throw new Error('Usage: pnpm lab owner "Exact private shelf name"');
        const user = store.one<{ id: string }>(
          "SELECT id FROM users WHERE name=? AND kind='private'",
          raw[1],
        );
        if (!user) throw new Error("No matching private shelf.");
        setLabOwner(store, user.id);
        console.log(
          "Creative Lab owner configured. Sign in to that private shelf.",
        );
      } else {
        const before = codeHash(),
          results: Record<string, boolean> = {};
        for (const check of ["typecheck", "lint", "test", "build", "test:e2e"])
          results[check] =
            spawnSync("sh", ["scripts/run.sh", check], { stdio: "inherit" })
              .status === 0;
        if (codeHash() !== before)
          throw new Error("Source changed during verification.");
        store.run(
          "INSERT INTO lab_settings VALUES('engineering_receipt',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          JSON.stringify({ codeHash: before, results, at: now() }),
        );
        print({ results });
        if (Object.values(results).some((ok) => !ok)) process.exitCode = 1;
      }
    } finally {
      store.close();
    }
    return;
  }
  if (
    ![
      "preflight",
      "run",
      "offline",
      "loop",
      "status",
      "report",
      "resume",
      "pause",
    ].includes(command)
  )
    throw new Error("Unknown quality command. Use pnpm lab help.");
  const { values, positionals } = parseArgs({
    args: raw.slice(1),
    allowPositionals: true,
    strict: true,
    options: {
      "data-dir": { type: "string" },
      lane: { type: "string" },
      iterations: { type: "string" },
      "request-key": { type: "string" },
      session: { type: "string" },
      experiment: { type: "string" },
      art: { type: "boolean" },
      live: { type: "boolean" },
      allowance: { type: "string" },
      "authorize-costs": { type: "boolean" },
    },
  });
  if (positionals.length) {
    if (
      positionals.length !== 1 ||
      !["resume", "report"].includes(command) ||
      values.session ||
      values.experiment
    )
      throw new Error(
        "Use one session ID with resume/report, or --session=ID; do not combine selectors.",
      );
    values.session = positionals[0];
  }
  if (
    values.live ||
    values.allowance !== undefined ||
    values["authorize-costs"]
  )
    throw new Error(
      "Paid CLI experiments are disabled. A separately authorized Lab request budget and verified cost bounds are required; family-book credits are not used.",
    );
  const location = inspectDirectory(values["data-dir"]);
  const plan = SessionPlan.parse({
    lane: values.art ? "art" : (values.lane ?? "memory"),
    mode: "offline",
    maxIterations:
      values.iterations === undefined ? 1 : Number(values.iterations),
    maxCents: 0,
    authorizeCosts: false,
    requestKey: values["request-key"],
  });
  if (command === "preflight") {
    print({
      ready: true,
      initialized: location.initialized,
      mode: "offline",
      lane: plan.lane,
      maxIterations: plan.maxIterations,
      maxCents: 0,
      providerCredentialsLoaded: false,
      next: location.initialized
        ? "Run or resume a retained synthetic session."
        : "Run creates a new empty synthetic store at the chosen path.",
    });
    return;
  }
  if (!location.initialized && ["status", "report"].includes(command)) {
    print({ initialized: false, sessions: [] });
    return;
  }
  if (!location.initialized && ["resume", "pause"].includes(command))
    throw new Error("No retained session exists in this directory.");
  const store = openSynthetic(location);
  let activeSession: string | undefined;
  const stop = () => {
    if (activeSession) pauseSession(store, activeSession);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    // Empty environment prevents API/model configuration leaking into an offline session.
    const config = engineConfig({});
    if (["run", "offline", "loop"].includes(command)) {
      activeSession = newSession(store, OWNER, plan);
      await runSession(store, activeSession, offline, config);
      print(sessionReport(store, activeSession));
    } else if (command === "status") {
      print({
        initialized: true,
        ownerConfigured: labOwner(store) === OWNER,
        sessions: store.all(
          "SELECT id,status,iteration,noProgress,checkpoint FROM lab_sessions ORDER BY rowid DESC",
        ),
      });
    } else if (command === "report") {
      if (values.session && values.experiment)
        throw new Error("Choose a session or an experiment report.");
      if (values.experiment) print(experimentReport(store, values.experiment));
      else {
        const sid =
          values.session ??
          store.one<{ id: string }>(
            "SELECT id FROM lab_sessions ORDER BY rowid DESC LIMIT 1",
          )?.id;
        print(sid ? sessionReport(store, sid) : { sessions: [] });
      }
    } else {
      if (!values.session)
        throw new Error("Choose the retained session with --session=ID.");
      const session = store.one<SessionRow>(
        "SELECT * FROM lab_sessions WHERE id=? AND ownerId=?",
        values.session,
        OWNER,
      );
      if (!session)
        throw new Error("Session unavailable in this synthetic store.");
      if (SessionPlan.parse(JSON.parse(session.plan)).mode !== "offline")
        throw new Error(
          "Paid sessions cannot resume through the offline quality CLI.",
        );
      activeSession = values.session;
      if (command === "pause") pauseSession(store, activeSession);
      else await runSession(store, activeSession, offline, config);
      print(sessionReport(store, activeSession));
    }
    if (
      activeSession &&
      store.one<{ status: string }>(
        "SELECT status FROM lab_sessions WHERE id=?",
        activeSession,
      )?.status === "needs_attention"
    )
      process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    store.close();
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error
      ? error.message
      : "Quality command failed before completion.",
  );
  process.exitCode = 1;
});
