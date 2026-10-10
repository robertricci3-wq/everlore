import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest, type Server } from "node:http";
import { createApp } from "../src/server/app.js";
import { createOperator } from "../src/server/access.js";
import { Store, hash, now } from "../src/server/store.js";
import { engineConfig } from "../src/server/engine/provider.js";
import {
  makePilotPolicy,
  createPilotCampaign,
  authorizePilotCampaign,
  setPilotCampaignState,
  pilotAccess,
} from "../src/server/pilot/service.js";

test("hosted pilot invitation signs up a private family ready to create without legacy funding or provider setup", async () => {
  const previous = process.env.EVERLORE_PILOT_WORKER;
  process.env.EVERLORE_PILOT_WORKER = "1";
  const dir = mkdtempSync(join(tmpdir(), "everlore-pilot-hosted-access-"));
  const store = new Store(dir);
  const config = {
    ...engineConfig({}),
    enabled: false,
    strictCostGuard: true,
    apiKey: "synthetic-never-sent",
    budgetCents: 7500,
  };
  let server: Server | undefined;
  let providerCalls = 0;
  try {
    const operator = createOperator(
      store,
      "operator",
      "synthetic-operator-password",
    );
    const operatorCookie = "evermore=synthetic-operator-session";
    store.run(
      "INSERT INTO sessions VALUES(?,?,?)",
      hash("synthetic-operator-session"),
      operator,
      Date.now() + 600000,
    );
    store.run("INSERT INTO engine_budget VALUES(?,?,?)", "rosa", 7500, now());
    const legacy = {
      budget: store.all("SELECT * FROM engine_budget"),
      grants: store.all("SELECT * FROM access_grants"),
      invitations: store.all("SELECT * FROM access_invitations"),
    };
    const campaign = createPilotCampaign(store, operator, {
      key: "hosted-invitation-test",
      totalCents: 25000,
      maxHouseholds: 5,
      policy: makePilotPolicy({
        version: 1,
        mode: "estimated_pilot",
        textInputTokensPerByte: 1,
        imagePromptTokensPerByte: 1,
        imageInputTokensPerReference: 6000,
        imageInputOverheadTokens: 1000,
        safetyMultiplier: 2,
      }),
    });
    authorizePilotCampaign(store, operator, campaign.id, {
      authorizationReference: "Synthetic test only; no live funding",
      acknowledgeEstimatedCosts: true,
    });
    const app = createApp(
      store,
      config,
      async () => {
        providerCalls++;
        throw new Error("Onboarding must not dispatch a provider request");
      },
      "https://pilot.example.test",
    );
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const call = async (path: string, body?: unknown, cookie = "") => {
      // Model Render ingress directly: preserve the public Host while the
      // server listens locally. No browser Secure-cookie bypass is required.
      return new Promise<Response>((resolve, reject) => {
        const request = httpRequest(
          base + path,
          {
            method: body === undefined ? "GET" : "POST",
            headers: {
              Host: "pilot.example.test",
              Origin: "https://pilot.example.test",
              "X-Forwarded-For": "198.51.100.23",
              "X-Forwarded-Proto": "https",
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
    };
    assert.equal((await call("/api/operator/pilot")).status, 401);
    assert.equal(
      (await call("/api/operator/invitations", { label: "Unauthorized" }))
        .status,
      401,
    );
    const invitationResponse = await call(
      "/api/operator/invitations",
      { key: "new-household", label: "Synthetic family", expiresDays: 7 },
      operatorCookie,
    );
    assert.equal(invitationResponse.status, 201);
    const invitation = (await invitationResponse.json()) as {
      id: string;
      code: string;
    };
    assert(invitation.code);
    assert(
      store.one("SELECT id FROM pilot_invitations WHERE id=?", invitation.id),
    );
    const register = (name: string, inviteCode?: string) =>
      call("/api/register", {
        name,
        password: "synthetic-family-password",
        adult: true,
        ...(inviteCode ? { inviteCode } : {}),
      });
    for (const invalid of [undefined, "not-a-valid-invitation"]) {
      assert.equal((await register("invalid-family", invalid)).status, 403);
      assert.equal(store.all("SELECT id FROM users").length, 1);
      assert.equal(store.all("SELECT tokenHash FROM sessions").length, 1);
    }
    const joined = await register("Family One", invitation.code);
    assert.equal(joined.status, 201);
    const family = (await joined.json()) as { id: string; kind: string };
    assert.equal(family.kind, "private");
    const setCookie = joined.headers.get("set-cookie")!;
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /HttpOnly/);
    const familyCookie = setCookie.split(";")[0];
    assert.equal(pilotAccess(store, family.id)?.campaign.id, campaign.id);
    assert.equal(pilotAccess(store, family.id)?.canStart, true);
    assert.equal(store.all("SELECT * FROM pilot_memberships").length, 1);
    const setup = await call("/api/journey/setup", undefined, familyCookie);
    assert.equal(setup.status, 200);
    assert.deepEqual(await setup.json(), {
      consentVersion: "family-memory-v1",
      consented: false,
      aiProcessingConsented: false,
      adaptationConsented: false,
      canCreate: true,
    });
    const session = await (
      await call("/api/session", undefined, familyCookie)
    ).json();
    assert.equal(session.hosted, true);
    assert.equal(session.user.id, family.id);
    assert.equal(session.user.operator, false);
    assert.equal(session.user.labOwner, false);
    for (const path of ["/api/operator/pilot", "/api/operator/access"])
      assert.equal((await call(path, undefined, familyCookie)).status, 403);
    for (const path of ["/api/operator/invitations", "/api/studio-setup"])
      assert.equal(
        (await call(path, { label: "Forbidden" }, familyCookie)).status,
        403,
      );
    assert.equal((await register("Family Two", invitation.code)).status, 403);
    assert.equal(store.all("SELECT id FROM users").length, 2);
    assert.equal(store.all("SELECT tokenHash FROM sessions").length, 2);
    assert.equal(store.all("SELECT * FROM pilot_memberships").length, 1);
    assert.deepEqual(store.all("SELECT * FROM engine_budget"), legacy.budget);
    assert.deepEqual(store.all("SELECT * FROM access_grants"), legacy.grants);
    assert.deepEqual(
      store.all("SELECT * FROM access_invitations"),
      legacy.invitations,
    );
    assert.equal(config.enabled, false);
    assert.equal(config.budgetCents, 7500);
    assert.equal(store.all("SELECT * FROM pilot_attempts").length, 0);
    assert.equal(store.all("SELECT * FROM studio_jobs").length, 0);
    assert.equal(store.all("SELECT * FROM book_orders").length, 0);
    assert.equal(providerCalls, 0);
  } finally {
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.EVERLORE_PILOT_WORKER;
    else process.env.EVERLORE_PILOT_WORKER = previous;
  }
});

test("a newer draft cannot hide the active pilot invitation pool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "everlore-pilot-active-access-")), store = new Store(dir);
  let server: Server | undefined;
  try {
    const operator = createOperator(store, "operator", "synthetic-operator-password");
    store.run("INSERT INTO sessions VALUES(?,?,?)", hash("pilot-active-session"), operator, Date.now() + 600000);
    const policy = makePilotPolicy({ version: 1, mode: "estimated_pilot", textInputTokensPerByte: 1,
      imagePromptTokensPerByte: 1, imageInputTokensPerReference: 6000, imageInputOverheadTokens: 1000, safetyMultiplier: 2 });
    const active = createPilotCampaign(store, operator, { key: "active-pool", totalCents: 10000, maxHouseholds: 5, policy });
    authorizePilotCampaign(store, operator, active.id, { authorizationReference: "Synthetic routing test; no live funds", acknowledgeEstimatedCosts: true });
    const draft = createPilotCampaign(store, operator, { key: "newer-draft", totalCents: 5000, maxHouseholds: 1, policy });
    const app = createApp(store, engineConfig({}), async () => { throw new Error("No provider dispatch permitted"); }, null);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address === "object");
    const call = (path: string, body?: unknown) => fetch(`http://127.0.0.1:${address.port}/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Cookie: "evermore=pilot-active-session", "X-Evermore-Client": "1", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const report = await (await call("/operator/pilot")).json();
    assert.equal(report.pilot.campaign.id, active.id);
    const access = await (await call("/operator/access")).json();
    assert.equal(access.pilot.state, "active");
    assert.equal(access.availableCents, 10000);
    assert.equal(access.canInvite, true);
    const issued = await call("/operator/invitations", { key: "active-invitation", label: "Synthetic family" });
    assert.equal(issued.status, 201);
    const invitation = await issued.json();
    assert(invitation.code);
    assert.equal(store.one<{ campaignId: string }>("SELECT campaignId FROM pilot_invitations WHERE id=?", invitation.id)!.campaignId, active.id);
    assert.equal(store.all("SELECT * FROM pilot_invitations WHERE campaignId=?", draft.id).length, 0);
    setPilotCampaignState(store, operator, active.id, "paused");
    const fallback = await (await call("/operator/pilot")).json();
    assert.equal(fallback.pilot.campaign.id, draft.id);
    assert.equal((await (await call("/operator/access")).json()).canInvite, false);
    assert.equal(store.all("SELECT * FROM pilot_attempts").length, 0);
    assert.equal(store.all("SELECT * FROM studio_jobs").length, 0);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    store.close(); rmSync(dir, { recursive: true, force: true });
  }
});
