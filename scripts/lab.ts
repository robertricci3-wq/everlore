import { spawnSync } from "node:child_process";
import { Store } from "../src/server/store.js";
import {
  engineConfig,
  OpenAIProvider,
  type Provider,
} from "../src/server/engine/provider.js";
import { loadStudioConnection } from "../src/server/engine/setup.js";
import {
  codeHash,
  labOwner,
  labView,
  setLabOwner,
} from "../src/server/lab/service.js";
import { newSession, runSession } from "../src/server/lab/session.js";
const args = process.argv.slice(2).filter((x) => x !== "--"),
  command = args[0],
  store = new Store(process.env.DATA_DIR ?? ".data"),
  c = engineConfig();
loadStudioConnection(store, c);
try {
  if (command === "owner") {
    const name = args[1];
    if (!name)
      throw new Error('Usage: pnpm lab owner "Exact private shelf name"');
    const u = store.one<{ id: string }>(
      "SELECT id FROM users WHERE name=? AND kind='private'",
      name,
    );
    if (!u) throw new Error("No matching private shelf.");
    setLabOwner(store, u.id);
    console.log(
      "Creative Lab owner configured. Sign in to that private shelf.",
    );
  } else if (command === "verify") {
    const before = codeHash(),
      results: Record<string, boolean> = {};
    for (const check of ["typecheck", "lint", "test", "build", "test:e2e"]) {
      const result = spawnSync("sh", ["scripts/run.sh", check], {
        stdio: "inherit",
      });
      results[check] = result.status === 0;
    }
    if (codeHash() !== before)
      throw new Error("Source changed during verification.");
    store.run(
      "INSERT INTO lab_settings VALUES('engineering_receipt',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      JSON.stringify({
        codeHash: before,
        results,
        at: new Date().toISOString(),
      }),
    );
    console.log(JSON.stringify({ results }));
    if (Object.values(results).some((x) => !x)) process.exitCode = 1;
  } else if (command === "offline" || command === "loop") {
    const owner = labOwner(store);
    if (!owner) throw new Error("Configure one private Lab owner first.");
    const live = command === "loop" && args.includes("--live"),
      allowance = Number(
        args.find((a) => a.startsWith("--allowance="))?.split("=")[1] ?? 0,
      ),
      iterations = Number(
        args.find((a) => a.startsWith("--iterations="))?.split("=")[1] ?? 2,
      );
    const sid = newSession(store, owner, {
      mode: live ? "live" : "offline",
      lane: args.includes("--art") ? "art" : "story",
      maxIterations: iterations,
      maxCents: Math.round(allowance * 100),
      authorizeCosts: args.includes("--authorize-costs"),
    });
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
    await runSession(
      store,
      sid,
      live
        ? new OpenAIProvider({ ...c, budgetCents: Math.round(allowance * 100) })
        : offline,
      c,
    );
    console.log(
      JSON.stringify(
        store.one(
          "SELECT id,status,iteration,noProgress,checkpoint FROM lab_sessions WHERE id=?",
          sid,
        ),
        null,
        2,
      ),
    );
  } else if (command === "status") {
    const owner = labOwner(store);
    console.log(
      JSON.stringify(
        owner
          ? {
              active: labView(store, c, owner).activeHash,
              sessions: store.all(
                "SELECT id,status,iteration,noProgress,checkpoint FROM lab_sessions",
              ),
              experiments: labView(store, c, owner).experiments.map((e) => ({
                id: e.id,
                title: e.title,
                status: e.status,
                summary: e.summary,
              })),
            }
          : { ownerConfigured: false },
        null,
        2,
      ),
    );
  } else
    console.log(
      'Commands: owner "Shelf name" | offline [--art] | loop --live --allowance=USD --authorize-costs [--iterations=2] [--art] | verify | status',
    );
} finally {
  store.close();
}
