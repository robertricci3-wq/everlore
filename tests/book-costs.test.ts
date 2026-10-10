import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express, Request, Response, RequestHandler } from "express";
import { Store, now } from "../src/server/store.js";
import { configureAccess } from "../src/server/access.js";
import { engineConfig } from "../src/server/engine/provider.js";
import {
  familySetupView,
  setupView,
  saveStudioConnection,
  checkSavedStudioConnection,
} from "../src/server/engine/setup.js";
import { ensureStudioBudgetRecords } from "../src/server/engine/budget.js";
import { migrateCommerce } from "../src/server/commerce/schema.js";
import {
  bookCostReport,
  reconcileBilling,
} from "../src/server/costs/service.js";
import { installOperatorCostRoutes } from "../src/server/costs/routes.js";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { StoryStudio } from "../src/client/StoryStudio.js";
import type { ProjectView } from "../src/shared/contracts.js";
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "everlore-cost-test-")),
    s = new Store(dir);
  for (const owner of ["operator", "family"])
    s.run(
      "INSERT INTO users VALUES(?,?,?,'private',?)",
      owner,
      owner,
      "unused",
      now(),
    );
  configureAccess(s, false, "operator");
  ensureStudioBudgetRecords(s);
  migrateCommerce(s);
  const project = (pid: string, mode = "engine") =>
    s.run(
      "INSERT INTO projects VALUES(?,'family',? ,?,'complete',1,?,?,?)",
      pid,
      `Book ${pid}`,
      mode,
      "PRIVATE TRANSCRIPT",
      now(),
      now(),
    );
  const job = (
    pid: string,
    jid: string,
    status = "complete",
    kind = "generation",
    reserve = 200,
  ) => {
    s.run(
      "INSERT INTO studio_jobs(id,projectId,baseRevision,kind,status,stage,request,state,profile,allowance,createdAt) VALUES(?,?,0,?,?,'manuscript',?,?,?,200,?)",
      jid,
      pid,
      kind,
      status,
      '{"apiKey":"PRIVATE KEY"}',
      '{"transcript":"PRIVATE STATE"}',
      "{}",
      now(),
    );
    s.run("INSERT INTO engine_budget VALUES(?,?,?)", jid, reserve, now());
  };
  const call = (
    jid: string,
    cid: string,
    status = "completed",
    estimate = 100,
    usage: number | null = 5,
  ) => {
    s.run(
      "INSERT INTO studio_calls(id,jobId,stage,kind,model,requestHash,status,latencyMs,requestId,usage,estimatedCents,createdAt) VALUES(?,?,'manuscript','text','test-model','request',?,20,'req',?,?,?)",
      cid,
      jid,
      status,
      JSON.stringify({ input_tokens: 300, secret: "PRIVATE USAGE" }),
      estimate,
      now(),
    );
    if (usage !== null)
      s.run(
        "INSERT INTO studio_metered_costs VALUES(?,?)",
        cid,
        JSON.stringify({
          version: 1,
          source: "provider_usage",
          estimatedCostCents: usage,
          rateCardVersion: "fixture-v1",
          billedCostCents: null,
        }),
      );
  };
  const edition = (pid: string) =>
    s.run(
      "INSERT INTO editions VALUES(?,?,1,'hash','pdf','PRIVATE BOOK',?)",
      `edition-${pid}`,
      pid,
      now(),
    );
  return {
    s,
    project,
    job,
    call,
    edition,
    close() {
      s.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const receipt = (targetId: string, amountCents = 7) => ({
  idempotencyKey: `fixture-reconcile-${targetId}`,
  targetType: "studio_call",
  targetId,
  component: "generation",
  amountCents,
  currency: "USD",
  sourceType: "invoice",
  sourceReference: `invoice-line-${targetId}`,
  observedAt: "2026-10-01T00:00:00.000Z",
  verified: true,
  supersedesId: null,
});
test("cost report separates held funds, usage, unknown and actual; preserves failed attempts and private content", () => {
  const t = setup();
  try {
    t.project("one");
    t.job("one", "j1");
    t.call("j1", "c1");
    t.call("j1", "c2", "ambiguous", 50, null);
    t.call("j1", "c3", "rejected", 50, null);
    t.edition("one");
    t.s.run(
      "INSERT INTO studio_request_bounds VALUES('c1',?)",
      JSON.stringify({ maxCostCents: 100, rateCardVersion: "bound-v1" }),
    );
    const r = bookCostReport(t.s, "operator");
    assert.equal(r.totals.reservedCents, 200);
    assert.equal(r.totals.requestReservationCents, 150);
    assert.equal(r.totals.usageEstimateCents, 5);
    assert.equal(r.totals.unknownChargeAttempts, 2);
    assert.equal(r.totals.verifiedActualCents, 0);
    assert.equal(r.books[0].jobs[0].calls[0].verifiedActualCents, null);
    assert.equal(r.books[0].jobs[0].calls[0].boundCents, 100);
    assert.equal(r.metrics.completedBooks, 1);
    assert.equal(r.metrics.usageCost.samples, 0);
    assert.doesNotMatch(JSON.stringify(r), /PRIVATE/);
    assert.equal(
      t.s.one<{ allowance: number }>("SELECT allowance FROM engine_budget")!
        .allowance,
      200,
    );
  } finally {
    t.close();
  }
});
test("reconciliation is append-only, idempotent and operator-only without overwriting estimates", () => {
  const t = setup();
  try {
    t.project("one");
    t.job("one", "j1");
    t.call("j1", "c1");
    assert.throws(
      () => bookCostReport(t.s, "family"),
      /configured Everlore operator/,
    );
    assert.throws(
      () => reconcileBilling(t.s, "family", receipt("c1")),
      /configured Everlore operator/,
    );
    const r = reconcileBilling(t.s, "operator", receipt("c1"));
    assert.equal(reconcileBilling(t.s, "operator", receipt("c1")).id, r.id);
    assert.throws(
      () => reconcileBilling(t.s, "operator", receipt("c1", 9)),
      /already used/,
    );
    assert.throws(
      () =>
        reconcileBilling(t.s, "operator", {
          ...receipt("c1", 9),
          idempotencyKey: "different-receipt",
        }),
      /current evidence changed/,
    );
    const correction = reconcileBilling(t.s, "operator", {
      ...receipt("c1", 0),
      idempotencyKey: "corrected-receipt",
      supersedesId: r.id,
    });
    const report = bookCostReport(t.s, "operator");
    assert.equal(report.reconciliations.length, 2);
    assert.equal(report.books[0].jobs[0].calls[0].verifiedActualCents, 0);
    assert.equal(
      report.books[0].jobs[0].calls[0].reconciliationId,
      correction.id,
    );
    assert.equal(report.totals.unknownChargeAttempts, 0);
    assert.deepEqual(
      t.s.one("SELECT estimatedCents,actualCents FROM studio_calls"),
      Object.assign(Object.create(null), {
        estimatedCents: 100,
        actualCents: null,
      }),
    );
    assert.throws(
      () =>
        reconcileBilling(t.s, "operator", {
          ...receipt("c1"),
          idempotencyKey: "stale-correction",
          supersedesId: r.id,
        }),
      /current evidence changed/,
    );
  } finally {
    t.close();
  }
});
test("sample definitions include failed book attempts, exclude synthetic and avoid unknown-as-zero medians", () => {
  const t = setup();
  try {
    for (const [pid, price] of [
      ["one", 10],
      ["two", 30],
    ] as const) {
      t.project(pid);
      t.job(pid, `j-${pid}`);
      t.call(`j-${pid}`, `c-${pid}`, "completed", 100, price);
      t.edition(pid);
      reconcileBilling(t.s, "operator", receipt(`c-${pid}`, price + 5));
    }
    t.project("failed");
    t.job("failed", "jf", "needs_attention");
    t.call("jf", "cf", "ambiguous", 100, null);
    t.project("fixture", "synthetic_fixture");
    t.job("fixture", "js");
    t.call("js", "cs", "completed", 100, 1000);
    t.edition("fixture");
    const r = bookCostReport(t.s, "operator");
    assert.equal(r.metrics.bookProjects, 3);
    assert.equal(r.metrics.completedBooks, 2);
    assert.equal(r.metrics.completionRate, 2 / 3);
    assert.deepEqual(r.metrics.usageCost, {
      samples: 2,
      medianCents: 20,
      p90Cents: 30,
    });
    assert.deepEqual(r.metrics.actualCost, {
      samples: 2,
      medianCents: 25,
      p90Cents: 35,
    });
    assert.equal(r.totals.usageEstimateCents, 40);
    assert.equal(r.books.length, 4);
  } finally {
    t.close();
  }
});
test("source-session transcription is linked to two books but charged only once in totals", () => {
  const t = setup();
  try {
    t.project("source");
    t.job("source", "interview", "complete", "interview_transcription");
    t.call("interview", "audio", "completed", 100, 3);
    t.s.run(
      "INSERT INTO almanac_pages VALUES('family','p','Test','Description',NULL,0,0,0,'[]',?,?)",
      now(),
      now(),
    );
    t.s.run(
      "INSERT INTO almanac_sessions(id,ownerId,projectId,pageId,invitationId,invitationVersion,invitation,requestKey,consentAt,createdAt,updatedAt) VALUES('session','family','source','p','i','v1','{}','request',?,?,?)",
      now(),
      now(),
      now(),
    );
    for (const pid of ["one", "two"]) {
      t.project(pid);
      t.job(pid, `j${pid}`);
      t.call(`j${pid}`, `c${pid}`);
      t.edition(pid);
      t.s.run(
        "INSERT INTO almanac_sources VALUES(?,'session',?,?,?,'{}',?)",
        `source-${pid}`,
        pid === "one" ? 1 : 2,
        `hash-${pid}`,
        pid,
        now(),
      );
    }
    const r = bookCostReport(t.s, "operator");
    assert.equal(r.totals.usageEstimateCents, 13);
    assert.equal(
      r.books.find((b) => b.projectId === "source")!.relatedBookIds.length,
      2,
    );
    assert.equal(
      r.books.find((b) => b.projectId === "one")!.sourceProjectId,
      "source",
    );
    assert.equal(r.metrics.bookProjects, 2);
    assert.equal(r.metrics.usageCost.samples, 0);
    assert.equal(
      r.books.find((b) => b.projectId === "source")!.jobs[0].intendedRevision,
      null,
    );
  } finally {
    t.close();
  }
});
test("order prices and taxes are separate from costs and verified component corrections retain provenance", () => {
  const t = setup();
  try {
    t.project("one");
    t.s.run(
      "INSERT INTO book_orders(id,ownerId,projectId,editionId,bundleId,amountCents,mode,sku,shippingMethod,status,createdAt,updatedAt,taxCents,totalCents,paymentFeeCents) VALUES('o','family','one','edition','bundle',14900,'test','sku','standard','shipped',?,?,100,15000,450)",
      now(),
      now(),
    );
    let o = bookCostReport(t.s, "operator").books[0].orders[0];
    assert.equal(o.merchandiseCents, 14900);
    assert.equal(o.collectedTaxCents, 100);
    assert.equal(o.components[0].verifiedActualCents, null);
    assert.equal(o.components[2].verifiedActualCents, 450);
    reconcileBilling(t.s, "operator", {
      ...receipt("o", 3000),
      targetType: "order",
      component: "printing",
    });
    o = bookCostReport(t.s, "operator").books[0].orders[0];
    assert.equal(o.components[0].verifiedActualCents, 3000);
    assert.equal(o.components[1].verifiedActualCents, null);
    assert.equal(
      t.s.one<{ amountCents: number }>("SELECT amountCents FROM book_orders")!
        .amountCents,
      14900,
    );
  } finally {
    t.close();
  }
});
test("families and operator family views cannot see key state, allowance or provider failure details", async () => {
  const t = setup();
  try {
    const c = {
      ...engineConfig({}),
      enabled: true,
      apiKey: "sk-fixture-private-secret",
      budgetCents: 50000,
    };
    assert.equal(setupView(t.s, "family", c).canManage, false);
    assert.equal(setupView(t.s, "family", c).hasKey, false);
    assert.equal(familySetupView(t.s, "operator", c).canManage, false);
    assert.equal(familySetupView(t.s, "operator", c).budgetUsd, 0);
    assert.doesNotMatch(
      JSON.stringify(familySetupView(t.s, "family", c)),
      /sk-fixture|API|allowance|billing/,
    );
    assert.throws(
      () => saveStudioConnection(t.s, "family", {}, c),
      /configured Everlore operator/,
    );
    let calls = 0;
    await assert.rejects(
      checkSavedStudioConnection(t.s, "family", c, async () => {
        calls++;
        throw new Error("unexpected");
      }),
      /configured Everlore operator/,
    );
    assert.equal(calls, 0);
  } finally {
    t.close();
  }
});
test("family rendering contains no setup, allowance or uncertain paid recovery controls", () => {
  const project = {
    id: "p",
    engine: {
      kind: "generation",
      id: "j",
      status: "needs_attention",
      stage: "heart",
      error: "PRIVATE API key failed",
      recovery: {
        message: "PRIVATE allowance",
        stage: "heart",
        uncertain: true,
        extraReserveUsd: 50,
        requestId: "SECRET_REQUEST",
      },
    },
  } as unknown as ProjectView;
  const html = renderToStaticMarkup(
    createElement(StoryStudio, { project, refresh: async () => {} }),
  );
  assert.match(html, /original memory and completed work are saved/);
  assert.doesNotMatch(
    html,
    /PRIVATE|SECRET_REQUEST|API key|allowance|Resume saved story|possible-charge|Save connection/,
  );
  const fresh = renderToStaticMarkup(
    createElement(StoryStudio, {
      project: { id: "p" } as ProjectView,
      refresh: async () => {},
    }),
  );
  assert.doesNotMatch(fresh, /API key|allowance|Connect the story studio/);
});
test("operator cost endpoints execute authorization before reads and reconciliation", () => {
  const t = setup();
  const routes = new Map<string, RequestHandler[]>();
  const app = {
    get(path: string, ...handlers: RequestHandler[]) {
      routes.set(`GET ${path}`, handlers);
    },
    post(path: string, ...handlers: RequestHandler[]) {
      routes.set(`POST ${path}`, handlers);
    },
  } as unknown as Express;
  installOperatorCostRoutes(app, t.s, (req, res, next) => {
    if (req.headers["x-fixture-role"] !== "operator")
      return void res.status(403).json({ error: "Denied" });
    next();
  });
  function request(route: string, role: string) {
    let status = 200,
      body: unknown;
    const req = {
      headers: { "x-fixture-role": role },
      body: receipt("missing"),
    } as unknown as Request;
    const res = {
      status(code: number) {
        status = code;
        return res;
      },
      json(value: unknown) {
        body = value;
        return res;
      },
    } as unknown as Response;
    const handlers = routes.get(route)!;
    let index = 0;
    const next = () => {
      const handler = handlers[index++];
      if (handler) handler(req, res, next);
    };
    next();
    return { status, body };
  }
  try {
    for (const route of routes.keys()) {
      const response = request(route, "family");
      assert.equal(response.status, 403);
      assert.deepEqual(response.body, { error: "Denied" });
    }
    assert.equal(request("GET /api/operator/costs", "operator").status, 200);
    assert.equal(t.s.all("SELECT * FROM billing_reconciliations").length, 0);
  } finally {
    t.close();
  }
});

test("deleted private books retain separately labeled reservations and billing evidence", () => {
  const t = setup();
  try {
    t.project("one");
    t.job("one", "j1");
    t.call("j1", "c1");
    const first = reconcileBilling(t.s, "operator", receipt("c1", 7));
    t.s.deleteProject("one");
    const r = bookCostReport(t.s, "operator");
    assert.equal(r.books.length, 0);
    assert.equal(r.unattributed.reservations[0].reservedCents, 100);
    assert.equal(r.unattributed.reconciliations[0].amountCents, 7);
    assert.equal(r.metrics.actualCost.samples, 0);
    reconcileBilling(t.s, "operator", {
      ...receipt("c1", 8),
      supersedesId: first.id,
      idempotencyKey: "correct-deleted-receipt",
    });
    assert.equal(
      bookCostReport(t.s, "operator").unattributed.reconciliations[0]
        .amountCents,
      8,
    );
  } finally {
    t.close();
  }
});
test("family availability is paused for a disabled worker, restore lock and unsupported strict cost plan", () => {
  const t = setup(),
    previous = process.env.DISABLE_WORKER;
  try {
    const c = {
      ...engineConfig({}),
      enabled: true,
      apiKey: "sk-test-never-used",
      budgetCents: 100000,
      audioReserve: 1,
      textReserve: 1,
      imageReserve: 1,
    };
    delete process.env.DISABLE_WORKER;
    assert.equal(familySetupView(t.s, "family", c).ready, true);
    assert.equal(
      familySetupView(t.s, "family", { ...c, strictCostGuard: true }).canStart,
      false,
    );
    process.env.DISABLE_WORKER = "1";
    assert.equal(familySetupView(t.s, "family", c).ready, false);
    delete process.env.DISABLE_WORKER;
    t.s.run(
      "INSERT INTO recovery_locks VALUES('restore',?,?,NULL,NULL)",
      now(),
      now(),
    );
    assert.equal(familySetupView(t.s, "family", c).canStart, false);
  } finally {
    if (previous === undefined) delete process.env.DISABLE_WORKER;
    else process.env.DISABLE_WORKER = previous;
    t.close();
  }
});

test("operator interview recovery never uses story retry acknowledgments or enables uncertain requests", async () => {
  const { operatorRecoveryAction } =
    await import("../src/client/OperatorCosts.js");
  const safe = {
    kind: "interview" as const,
    interview: {
      sessionId: "session",
      turnId: "turn",
      jobId: "job",
      status: "needs_attention",
      resumable: true,
      uncertain: false,
      message: "Safe retry",
      calls: [],
    },
  };
  assert.deepEqual(operatorRecoveryAction("source-project", safe, true), {
    path: "/operator/interviews/session/turns/turn/recovery",
    body: { retry: true },
  });
  assert.equal(
    operatorRecoveryAction(
      "source-project",
      { ...safe, interview: { ...safe.interview, uncertain: true } },
      true,
    ),
    null,
  );
  assert.equal(
    operatorRecoveryAction(
      "source-project",
      { ...safe, interview: { ...safe.interview, resumable: false } },
      false,
    ),
    null,
  );
  const story = {
    kind: "story" as const,
    jobId: "story-job",
    error: null,
    recovery: {
      callId: "story-call",
      stage: "heart",
      message: "Check attempt",
      uncertain: true,
      extraReserveUsd: 1,
      requestId: null,
    },
  };
  assert.equal(operatorRecoveryAction("book", story, false), null);
  assert.deepEqual(operatorRecoveryAction("book", story, true), {
    path: "/operator/projects/book/resume",
    body: {
      jobId: "story-job",
      callId: "story-call",
      acknowledgePossibleCharge: true,
    },
  });
});
