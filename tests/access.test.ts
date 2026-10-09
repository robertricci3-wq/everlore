import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest, type Server } from "node:http";
import { Store, id, now } from "../src/server/store.js";
import { queueStudio } from "../src/server/engine/studio.js";
import { createApp } from "../src/server/app.js";
import { engineConfig } from "../src/server/engine/provider.js";
import { saveStudioConnection, setupView } from "../src/server/engine/setup.js";
import {
  accessView,
  allocateGeneration,
  configureAccess,
  createOperator,
  generationAccess,
  issueInvitation,
  redeemInvitation,
  requireAllocationIncrease,
} from "../src/server/access.js";

const config = () => ({
  ...engineConfig({}),
  enabled: true,
  apiKey: "sk-synthetic-provider-key-never-used",
  budgetCents: 10000,
  audioReserve: 100,
  textReserve: 1,
  imageReserve: 1,
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "everlore-access-")),
    store = new Store(dir),
    c = config();
  configureAccess(store, true);
  return {
    store,
    c,
    clean() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const registerUser = (store: Store, name: string) => {
  const userId = id();
  store.run(
    "INSERT INTO users VALUES(?,?,?,?,?)",
    userId,
    name,
    "unused",
    "private",
    now(),
  );
  return userId;
};
test("hosted operator is explicit even with an environment-funded provider, and family setup reveals no allocation or key state", () => {
  const t = setup();
  try {
    const first = registerUser(t.store, "first family");
    assert.equal(setupView(t.store, first, t.c).canManage, false);
    assert.equal(setupView(t.store, first, t.c).hasKey, false);
    assert.throws(
      () => saveStudioConnection(t.store, first, {}, t.c),
      /Only the configured/,
    );
    const operator = createOperator(
      t.store,
      "operator",
      "synthetic-long-password",
    );
    assert.equal(setupView(t.store, operator, t.c).canManage, true);
    assert.equal(setupView(t.store, first, t.c).budgetUsd, 0);
  } finally {
    t.clean();
  }
});
test("single-use invitations earmark existing funds, expire, and cannot increase a family's allocation", () => {
  const t = setup();
  try {
    const operator = createOperator(
      t.store,
      "operator",
      "synthetic-long-password",
    );
    const original = t.c.budgetCents;
    const invite = issueInvitation(
      t.store,
      operator,
      { label: "First family", bookCount: 1, creditCents: 300, expiresDays: 7 },
      t.c,
    );
    assert.equal(accessView(t.store, t.c).assignedCents, 300);
    assert.equal(t.c.budgetCents, original);
    assert.throws(
      () => allocateGeneration(t.store, operator, id(), 9900, t.c, true),
      /invitation/,
    );
    assert.throws(
      () =>
        saveStudioConnection(
          t.store,
          operator,
          {
            apiKey: "",
            budgetUsd: 1,
            audioReserveUsd: 1,
            textReserveUsd: 0.01,
            imageReserveUsd: 0.01,
            authorizeCosts: true,
          },
          t.c,
        ),
      /already reserved/,
    );
    const family = registerUser(t.store, "family");
    t.store.transaction(() => redeemInvitation(t.store, invite.code, family));
    assert.throws(
      () =>
        redeemInvitation(t.store, invite.code, registerUser(t.store, "other")),
      /already used/,
    );
    const job = id();
    t.store.transaction(() => {
      allocateGeneration(t.store, family, job, 212, t.c, true);
      t.store.run("INSERT INTO engine_budget VALUES(?,?,?)", job, 212, now());
    });
    assert.equal(generationAccess(t.store, family, t.c).canStart, false);
    assert.doesNotThrow(() => requireAllocationIncrease(t.store, job, 88, t.c));
    assert.throws(
      () => requireAllocationIncrease(t.store, job, 89, t.c),
      /available generation allocation/,
    );
    assert.throws(
      () => allocateGeneration(t.store, family, id(), 212, t.c, true),
      /invitation/,
    );
    assert.throws(
      () =>
        issueInvitation(
          t.store,
          operator,
          { label: "Too much", creditCents: 10000 },
          t.c,
        ),
      /existing authorized/,
    );
    const expired = issueInvitation(
      t.store,
      operator,
      { label: "Expired", creditCents: 212 },
      t.c,
    );
    t.store.run(
      "UPDATE access_invitations SET expiresAt=0 WHERE id=?",
      expired.id,
    );
    assert.throws(
      () =>
        redeemInvitation(
          t.store,
          expired.code,
          registerUser(t.store, "expired"),
        ),
      /expired/,
    );
    assert.equal(accessView(t.store, t.c).assignedCents, 88);
  } finally {
    t.clean();
  }
});
test("hosted HTTP requires invites, protects operator APIs, has read-only public examples and proxy-aware throttling", async () => {
  const t = setup(),
    operator = createOperator(t.store, "operator", "synthetic-long-password");
  let calls = 0;
  const app = createApp(
    t.store,
    t.c,
    async () => {
      calls++;
      return new Response("{}");
    },
    "https://books.example.test",
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (
    path: string,
    body?: unknown,
    cookie = "",
    ip = "198.51.100.4",
  ) => {
    // Node's fetch intentionally rewrites Host to its URL host. Use a real
    // HTTP request here to model Render's ingress forwarding the public host.
    const response = await new Promise<Response>((resolve, reject) => {
      const request = httpRequest(
        base + path,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Host: "books.example.test",
            Origin: "https://books.example.test",
            "X-Forwarded-For": ip,
            "X-Evermore-Client": "1",
            "Content-Type": "application/json",
            Cookie: cookie,
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.on("error", reject);
          incoming.on("end", () => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(incoming.headers)) {
              if (Array.isArray(value))
                for (const part of value) headers.append(name, part);
              else if (value !== undefined) headers.set(name, value);
            }
            resolve(
              new Response(Buffer.concat(chunks), {
                status: incoming.statusCode,
                headers,
              }),
            );
          });
        },
      );
      request.on("error", reject);
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
    return { response, data: await response.json() };
  };
  try {
    const pre = t.store.all("SELECT * FROM users").length;
    assert.equal((await call("/api/demo", {})).data.readOnly, true);
    assert.equal((await call("/api/example")).data.book.spreads.length, 12);
    assert.equal(t.store.all("SELECT * FROM users").length, pre);
    assert.equal(t.store.all("SELECT * FROM projects").length, 0);
    assert.equal(
      (
        await call("/api/register", {
          name: "No invite",
          password: "synthetic-family-password",
          adult: true,
        })
      ).response.status,
      403,
    );
    const invite = issueInvitation(
      t.store,
      operator,
      { label: "Family", creditCents: 500 },
      t.c,
    );
    const join = await call("/api/register", {
      name: "Family",
      password: "synthetic-family-password",
      adult: true,
      inviteCode: invite.code,
    });
    assert.equal(join.response.status, 201);
    assert.match(join.response.headers.get("set-cookie")!, /Secure/);
    const cookie = join.response.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (await call("/api/operator/access", undefined, cookie)).response.status,
      403,
    );
    assert.equal(
      (await call("/api/studio-setup", {}, cookie)).response.status,
      403,
    );
    assert.equal(
      (await call("/api/studio-setup/check", {}, cookie)).response.status,
      403,
    );
    assert.equal(calls, 0);
    const state = await call("/api/studio-setup", undefined, cookie);
    assert.equal(state.data.canStart, true);
    assert.equal(state.data.canManage, false);
    assert.equal(
      (
        await call("/api/register", {
          name: "Second",
          password: "synthetic-family-password",
          adult: true,
          inviteCode: invite.code,
        })
      ).response.status,
      403,
    );
    assert.equal(t.store.all("SELECT * FROM users").length, pre + 1);
    for (let i = 0; i < 20; i++)
      await call(
        "/api/login",
        { name: "unknown", password: "synthetic-long-password" },
        "",
        "198.51.100.40",
      );
    assert.equal(
      (
        await call(
          "/api/login",
          { name: "unknown", password: "synthetic-long-password" },
          "",
          "198.51.100.40",
        )
      ).response.status,
      429,
    );
    assert.equal(
      (
        await call(
          "/api/login",
          { name: "unknown", password: "synthetic-long-password" },
          "",
          "198.51.100.41",
        )
      ).response.status,
      401,
    );
    assert.equal((await call("/readyz")).response.status, 200);
    app.locals.draining = true;
    assert.equal((await call("/readyz")).response.status, 503);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    t.clean();
  }
});

test("hosted generation queue consumes one invitation book atomically and keeps spent usage after deletion", () => {
  const t = setup();
  try {
    const operator = createOperator(
      t.store,
      "operator",
      "synthetic-long-password",
    );
    const invitation = issueInvitation(
      t.store,
      operator,
      { label: "One book", creditCents: 500 },
      t.c,
    );
    const family = registerUser(t.store, "family");
    t.store.transaction(() =>
      redeemInvitation(t.store, invitation.code, family),
    );
    const projectId = id();
    t.store.run(
      "INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?)",
      projectId,
      family,
      "A synthetic memory",
      "manual",
      "draft",
      0,
      null,
      now(),
      now(),
    );
    t.store.run(
      "INSERT INTO recordings VALUES(?,?,?,?,?,?,?)",
      id(),
      projectId,
      "synthetic",
      "audio/wav",
      44,
      "upload",
      now(),
    );
    const project = t.store.one<import("../src/server/store.js").ProjectRow>(
      "SELECT * FROM projects WHERE id=?",
      projectId,
    )!;
    const request = { processWithOpenAI: true, imaginativeAdaptation: true };
    const jobId = queueStudio(t.store, project, request, t.c);
    assert.equal(queueStudio(t.store, project, request, t.c), jobId);
    assert.equal(
      t.store.all("SELECT * FROM access_jobs WHERE ownerId=?", family).length,
      1,
    );
    assert.equal(generationAccess(t.store, family, t.c).canStart, false);
    t.store.run(
      "INSERT INTO studio_calls VALUES(?,?,?,?,?,?,'completed',NULL,NULL,NULL,?,NULL,?)",
      id(),
      jobId,
      "synthetic",
      "text",
      "synthetic",
      "hash",
      20,
      now(),
    );
    t.store.deleteProject(projectId);
    assert.equal(
      t.store.one<{ allowance: number }>(
        "SELECT allowance FROM engine_budget WHERE runId=?",
        jobId,
      )?.allowance,
      20,
    );
    assert.equal(generationAccess(t.store, family, t.c).remainingCents, 480);
    assert.equal(generationAccess(t.store, family, t.c).canStart, false);
  } finally {
    t.clean();
  }
});
