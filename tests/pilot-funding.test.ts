import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, hash, id, now, canonical } from "../src/server/store.js";
import { configureAccess, setOperator } from "../src/server/access.js";
import { startJourney } from "../src/server/almanac/journey.js";
import { engineConfig } from "../src/server/engine/provider.js";
import { FAMILY_CONSENT_VERSION } from "../src/shared/journey.js";
import {
  REQUEST_RATE_CARD,
  type EstimatedRequestReservation,
} from "../src/server/engine/request-cost.js";
import {
  makePilotPolicy,
  createPilotCampaign,
  authorizePilotCampaign,
  setPilotCampaignState,
  issuePilotInvitation,
  redeemPilotInvitation,
  revokePilotInvitation,
  pilotAccess,
  bindPilotCreation,
  linkPilotJob,
  pilotCreationFunding,
  pilotJobFunding,
  reservePilotRequest,
  markPilotDispatched,
  settlePilotRequest,
  reconcilePilotRequest,
  pilotCampaignSummary,
  eligiblePilotJobs,
  eligiblePilotCreations,
  PilotPreDispatchError,
} from "../src/server/pilot/service.js";
import { runPilotCommand } from "../scripts/pilot.js";

const policy = () =>
  makePilotPolicy({
    version: 1,
    mode: "estimated_pilot",
    textInputTokensPerByte: 1,
    imagePromptTokensPerByte: 1,
    imageInputTokensPerReference: 6000,
    imageInputOverheadTokens: 1000,
    safetyMultiplier: 2,
  });
function fixture(totalCents = 10000, maxHouseholds = 5) {
  const dir = mkdtempSync(join(tmpdir(), "everlore-pilot-funding-")),
    s = new Store(dir);
  configureAccess(s, false);
  for (const owner of [
    "operator",
    "family",
    "other",
    "third",
    "fourth",
    "fifth",
    "sixth",
  ])
    s.run(
      "INSERT INTO users VALUES(?,?,?,'private',?)",
      owner,
      owner,
      "unused",
      now(),
    );
  setOperator(s, "operator");
  const campaign = createPilotCampaign(s, "operator", {
    key: "pilot",
    totalCents,
    maxHouseholds,
    policy: policy(),
  });
  return {
    s,
    dir,
    campaign,
    close() {
      s.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
function activate(t: Fixture) {
  return authorizePilotCampaign(t.s, "operator", t.campaign.id, {
    authorizationReference: "Synthetic test authorization, never live funding",
    acknowledgeEstimatedCosts: true,
  });
}
function enroll(t: Fixture, owner = "family") {
  const invite = issuePilotInvitation(t.s, "operator", t.campaign.id, {
    key: owner,
    label: owner,
  });
  assert(invite.code);
  assert.equal(redeemPilotInvitation(t.s, invite.code, owner), true);
  return invite;
}
function creation(t: Fixture, owner = "family") {
  const started = startJourney(
    t.s,
    owner,
    {
      key: id(),
      consent: true,
      consentVersion: FAMILY_CONSENT_VERSION,
      processWithOpenAI: true,
    },
    engineConfig({}),
  );
  const session = started.session.session;
  const creationId = id(),
    projectId = id(),
    requestHash = hash(creationId),
    at = now();
  t.s.run(
    "INSERT INTO projects VALUES(?,?,?,'private','recording_saved',0,NULL,?,?)",
    projectId,
    owner,
    "Synthetic book",
    at,
    at,
  );
  t.s.run(
    "INSERT INTO almanac_creation_requests(id,ownerId,sessionId,requestKey,requestHash,consentVersion,selection,profile,continuity,status,projectId,createdAt,updatedAt) VALUES(?,?,?,?,?,?,'[]','{}','{}','pending',?,?,?)",
    creationId,
    owner,
    session.id,
    id(),
    requestHash,
    FAMILY_CONSENT_VERSION,
    projectId,
    at,
    at,
  );
  return {
    creationId,
    projectId,
    sourceProjectId: session.projectId,
    sessionId: session.id,
    requestHash,
  };
}
function job(
  t: Fixture,
  c: ReturnType<typeof creation>,
  owner = "family",
  kind = "generation",
  projectId = c.projectId,
) {
  const jobId = id();
  t.s.run(
    "INSERT INTO studio_jobs(id,projectId,baseRevision,kind,status,stage,request,state,profile,allowance,createdAt) VALUES(?,?,0,?,'queued','source','{}','{}',?,0,?)",
    jobId,
    projectId,
    kind,
    hash("profile"),
    now(),
  );
  linkPilotJob(t.s, owner, c.creationId, jobId);
  return jobId;
}
function ready(t: Fixture) {
  activate(t);
  enroll(t);
  const c = creation(t);
  bindPilotCreation(t.s, "family", c.creationId);
  return { ...c, jobId: job(t, c) };
}
function reservation(
  t: Fixture,
  cents = 50,
  kind: "audio" | "text" | "image" = "text",
): EstimatedRequestReservation {
  return {
    version: 1,
    costConfidence: "estimate",
    policyHash: t.campaign.policyHash,
    rateCardVersion: REQUEST_RATE_CARD.version,
    model: t.campaign.policy.models[kind],
    kind,
    reservationCents: cents,
    evidence: { measuredInputBytes: 100, declaredEstimateOnly: 1 },
  };
}
function reserve(t: Fixture, jobId: string, cents = 50, stage: string = id()) {
  return reservePilotRequest(t.s, {
    jobId,
    attemptId: id(),
    stage,
    inputHash: hash(stage),
    reservation: reservation(t, cents),
  });
}

test("pilot starts disabled, requires an explicit operator authorization, and freezes amount and policy", () => {
  const t = fixture();
  try {
    assert.equal(t.campaign.state, "draft");
    assert.equal(pilotAccess(t.s, "family"), null);
    assert.equal(
      t.s.one<{ count: number }>(
        "SELECT COUNT(*) AS count FROM pilot_authorizations",
      )!.count,
      0,
    );
    assert.throws(
      () =>
        issuePilotInvitation(t.s, "operator", t.campaign.id, {
          key: "invite",
          label: "family",
        }),
      /paused/,
    );
    assert.throws(
      () =>
        authorizePilotCampaign(t.s, "family", t.campaign.id, {
          authorizationReference: "Not an operator",
          acknowledgeEstimatedCosts: true,
        }),
      /configured Everlore operator/,
    );
    assert.throws(() =>
      authorizePilotCampaign(t.s, "operator", t.campaign.id, {
        authorizationReference: "Missing acknowledgment",
        acknowledgeEstimatedCosts: false,
      }),
    );
    assert.equal(activate(t).state, "active");
    assert.equal(activate(t).state, "active");
    assert.throws(
      () =>
        t.s.run(
          "UPDATE pilot_campaigns SET totalCents=20000 WHERE id=?",
          t.campaign.id,
        ),
      /immutable/,
    );
    assert.throws(
      () =>
        t.s.run(
          "UPDATE pilot_campaigns SET policy='{}' WHERE id=?",
          t.campaign.id,
        ),
      /immutable/,
    );
    assert.throws(
      () =>
        createPilotCampaign(t.s, "operator", {
          key: "pilot",
          totalCents: 20000,
          maxHouseholds: 5,
          policy: policy(),
        }),
      /different settings/,
    );
    assert.equal(
      createPilotCampaign(t.s, "operator", {
        key: "pilot",
        totalCents: 10000,
        maxHouseholds: 5,
        policy: policy(),
      }).id,
      t.campaign.id,
    );
    assert.equal(
      t.s.one<{ count: number }>("SELECT COUNT(*) AS count FROM engine_budget")!
        .count,
      0,
    );
  } finally {
    t.close();
  }
});

test("invitations reserve household capacity, never a whole-book budget, and safely replay/revoke", () => {
  const t = fixture(100, 1);
  try {
    activate(t);
    const invite = issuePilotInvitation(t.s, "operator", t.campaign.id, {
      key: "inv",
      label: "Family",
    });
    assert(invite.code);
    const again = issuePilotInvitation(t.s, "operator", t.campaign.id, {
      key: "inv",
      label: "Family",
    });
    assert.equal(again.id, invite.id);
    assert.equal(again.code, null);
    assert.equal(again.replayed, true);
    assert.throws(
      () =>
        issuePilotInvitation(t.s, "operator", t.campaign.id, {
          key: "second",
          label: "Other",
        }),
      /assigned/,
    );
    revokePilotInvitation(t.s, "operator", invite.id);
    assert.throws(
      () => redeemPilotInvitation(t.s, invite.code, "family"),
      /no longer available/,
    );
    const usable = issuePilotInvitation(t.s, "operator", t.campaign.id, {
      key: "replacement",
      label: "Family",
    });
    assert.equal(redeemPilotInvitation(t.s, usable.code, "family"), true);
    assert.equal(redeemPilotInvitation(t.s, usable.code, "family"), true);
    assert.throws(
      () => redeemPilotInvitation(t.s, usable.code, "other"),
      /no longer available/,
    );
    assert.equal(pilotAccess(t.s, "family")!.remainingCents, 100);
    assert.equal(pilotAccess(t.s, "family")!.canStart, true);
    assert.equal(
      pilotCampaignSummary(t.s, "operator", t.campaign.id).accountedCents,
      0,
    );
    assert.equal(
      redeemPilotInvitation(t.s, "not-a-pilot-code", "family"),
      false,
    );
  } finally {
    t.close();
  }
});

test("one entitlement pins the exact owned creation and excludes unrelated, Rosa, and Lab jobs", () => {
  const t = fixture();
  try {
    const r = ready(t);
    assert.equal(
      bindPilotCreation(t.s, "family", r.creationId)!.id,
      t.campaign.id,
    );
    assert.equal(pilotAccess(t.s, "family")!.canStart, false);
    const second = creation(t);
    assert.throws(
      () => bindPilotCreation(t.s, "family", second.creationId),
      /one new digital book/,
    );
    assert.throws(
      () => linkPilotJob(t.s, "other", r.creationId, r.jobId),
      /no matching/,
    );
    const unrelatedId = id();
    t.s.run(
      "INSERT INTO studio_jobs(id,projectId,baseRevision,kind,status,stage,request,state,profile,allowance,createdAt) VALUES(?,?,0,'lab','queued','source','{}','{}',?,7500,?)",
      unrelatedId,
      second.projectId,
      hash("Rosa-or-Lab-profile"),
      now(),
    );
    assert.throws(
      () => linkPilotJob(t.s, "family", r.creationId, unrelatedId),
      /Only this memory/,
    );
    assert.equal(pilotJobFunding(t.s, unrelatedId), null);
    assert.deepEqual(eligiblePilotCreations(t.s), [r.creationId]);
    assert.deepEqual(eligiblePilotJobs(t.s), [r.jobId]);
    t.s.run(
      "UPDATE studio_jobs SET status='running',leaseUntil=? WHERE id=?",
      Date.now() + 60000,
      r.jobId,
    );
    assert.deepEqual(eligiblePilotJobs(t.s), []);
    t.s.run("UPDATE studio_jobs SET leaseUntil=0 WHERE id=?", r.jobId);
    assert.deepEqual(eligiblePilotJobs(t.s), [r.jobId]);
    t.s.run(
      "UPDATE almanac_creation_requests SET requestHash=? WHERE id=?",
      hash("changed source"),
      r.creationId,
    );
    assert.throws(
      () => pilotCreationFunding(t.s, r.creationId),
      /no longer eligible/,
    );
    assert.deepEqual(eligiblePilotJobs(t.s), []);
  } finally {
    t.close();
  }
});

test("pool reservations are atomic across connections and retries cannot cross dispatch twice", () => {
  const t = fixture(100);
  let second: Store | undefined;
  try {
    const r = ready(t),
      attemptId = id();
    const input = {
      jobId: r.jobId,
      attemptId,
      stage: "story",
      inputHash: hash("story"),
      reservation: reservation(t, 75),
    };
    assert.equal(reservePilotRequest(t.s, input).isNew, true);
    second = new Store(t.dir);
    assert.equal(reservePilotRequest(second, input).isNew, false);
    assert.throws(
      () =>
        reservePilotRequest(second!, {
          ...input,
          attemptId: id(),
          stage: "art",
          inputHash: hash("art"),
        }),
      (e) =>
        e instanceof PilotPreDispatchError &&
        e.preDispatch &&
        /cannot cover/.test(e.message),
    );
    assert.throws(
      () => reservePilotRequest(second!, { ...input, attemptId: id() }),
      /saved request/,
    );
    markPilotDispatched(t.s, attemptId);
    assert.throws(
      () => markPilotDispatched(second!, attemptId),
      /already reached/,
    );
    assert.equal(
      pilotCampaignSummary(t.s, "operator", t.campaign.id).accountedCents,
      75,
    );
    assert.throws(
      () =>
        reservePilotRequest(t.s, {
          ...input,
          reservation: { ...input.reservation, policyHash: hash("different") },
        }),
      /frozen/,
    );
  } finally {
    second?.close();
    t.close();
  }
});

test("known usage releases excess, unknown or ambiguous outcomes keep their reserve until explicit reconciliation", () => {
  const t = fixture(200);
  try {
    const r = ready(t),
      a = reserve(t, r.jobId, 100, "first").attempt;
    markPilotDispatched(t.s, a.id);
    const usage = {
      outcome: "completed",
      usageEstimatedCents: 24.5,
      evidenceHash: hash("usage receipt"),
      evidenceKind: "provider_usage",
    };
    settlePilotRequest(t.s, a.id, usage);
    settlePilotRequest(t.s, a.id, usage);
    assert.equal(
      pilotCampaignSummary(t.s, "operator", t.campaign.id).accountedCents,
      25,
    );
    const b = reserve(t, r.jobId, 100, "second").attempt;
    markPilotDispatched(t.s, b.id);
    settlePilotRequest(t.s, b.id, {
      outcome: "ambiguous",
      evidenceHash: hash("timeout"),
      evidenceKind: "unknown_outcome",
    });
    assert.equal(
      pilotCampaignSummary(t.s, "operator", t.campaign.id).accountedCents,
      125,
    );
    assert.throws(
      () => settlePilotRequest(t.s, b.id, { ...usage, usageEstimatedCents: 0 }),
      /different outcome/,
    );
    assert.throws(
      () => reconcilePilotRequest(t.s, "family", b.id, usage),
      /configured Everlore operator/,
    );
    reconcilePilotRequest(t.s, "operator", b.id, {
      ...usage,
      usageEstimatedCents: 10,
    });
    const c = reserve(t, r.jobId, 50, "third").attempt;
    markPilotDispatched(t.s, c.id);
    settlePilotRequest(t.s, c.id, {
      outcome: "completed",
      evidenceHash: hash("receipt without usage"),
      evidenceKind: "unknown_outcome",
    });
    const report = pilotCampaignSummary(t.s, "operator", t.campaign.id);
    assert.equal(report.accountedCents, 85);
    assert.equal(report.attemptsWithoutUsage, 1);
    assert.equal(report.verifiedBilledCents, null);
  } finally {
    t.close();
  }
});

test("definitive non-dispatch releases funds, over-estimate usage is retained honestly and pauses the pool", () => {
  const t = fixture(100);
  try {
    const r = ready(t),
      a = reserve(t, r.jobId, 75, "prepare").attempt;
    settlePilotRequest(t.s, a.id, {
      outcome: "not_processed",
      evidenceKind: "local_pre_dispatch",
      evidenceHash: hash("local serialization failed"),
    });
    assert.equal(
      pilotCampaignSummary(t.s, "operator", t.campaign.id).remainingCents,
      100,
    );
    const b = reserve(t, r.jobId, 75, "prepare").attempt;
    markPilotDispatched(t.s, b.id);
    assert.throws(
      () =>
        settlePilotRequest(t.s, b.id, {
          outcome: "not_processed",
          evidenceKind: "local_pre_dispatch",
          evidenceHash: hash("false local claim"),
        }),
      /dispatched request/,
    );
    settlePilotRequest(t.s, b.id, {
      outcome: "completed",
      usageEstimatedCents: 120,
      evidenceKind: "provider_usage",
      evidenceHash: hash("usage exceeded forecast"),
    });
    const report = pilotCampaignSummary(t.s, "operator", t.campaign.id);
    assert.equal(report.accountedCents, 120);
    assert.equal(report.overrunCents, 20);
    assert.equal(report.campaign.state, "paused");
    assert.throws(
      () => setPilotCampaignState(t.s, "operator", t.campaign.id, "active"),
      /cannot resume/,
    );
  } finally {
    t.close();
  }
});

test("pause, recovery lock, request count limits, and outer-transaction rollback prevent dispatch", () => {
  const t = fixture(500);
  try {
    const r = ready(t);
    assert.throws(
      () =>
        t.s.transaction(() => {
          reserve(t, r.jobId, 25, "rolled-back");
          throw new Error("outer failure");
        }),
      /outer failure/,
    );
    assert.equal(
      pilotCampaignSummary(t.s, "operator", t.campaign.id).accountedCents,
      0,
    );
    setPilotCampaignState(t.s, "operator", t.campaign.id, "paused");
    assert.deepEqual(eligiblePilotJobs(t.s), []);
    assert.throws(() => reserve(t, r.jobId), /paused/);
    setPilotCampaignState(t.s, "operator", t.campaign.id, "active");
    t.s.run(
      "INSERT INTO recovery_locks VALUES(?,?,?,NULL,NULL)",
      id(),
      now(),
      now(),
    );
    assert.deepEqual(eligiblePilotCreations(t.s), []);
    assert.throws(() => reserve(t, r.jobId), /reconciled/);
    t.s.run("UPDATE recovery_locks SET releasedAt=?", now());
    assert.equal(eligiblePilotCreations(t.s).length, 1);
    const audio = { ...reservation(t, 1, "audio") };
    for (let n = 0; n < 30; n++)
      reservePilotRequest(t.s, {
        jobId: r.jobId,
        attemptId: id(),
        stage: `audio-${n}`,
        inputHash: hash(String(n)),
        reservation: audio,
      });
    assert.throws(
      () =>
        reservePilotRequest(t.s, {
          jobId: r.jobId,
          attemptId: id(),
          stage: "audio-over-limit",
          inputHash: hash("extra"),
          reservation: audio,
        }),
      /request limit/,
    );
  } finally {
    t.close();
  }
});

test("book deletion does not erase estimated spending, and cancelled creations cannot resume", () => {
  const t = fixture(500);
  try {
    const r = ready(t),
      a = reserve(t, r.jobId, 90).attempt;
    markPilotDispatched(t.s, a.id);
    settlePilotRequest(t.s, a.id, {
      outcome: "ambiguous",
      evidenceKind: "unknown_outcome",
      evidenceHash: hash("unknown"),
    });
    t.s.deleteProject(r.projectId);
    assert.equal(
      pilotCampaignSummary(t.s, "operator", t.campaign.id).accountedCents,
      90,
    );
    assert.equal(pilotAccess(t.s, "family")!.canStart, false);
    assert.throws(
      () => pilotCampaignSummary(t.s, "other", t.campaign.id),
      /configured Everlore operator/,
    );
    t.s.run(
      "UPDATE almanac_creation_requests SET status='cancelled' WHERE id=?",
      r.creationId,
    );
    assert.throws(() => pilotJobFunding(t.s, r.jobId), /no longer eligible/);
    assert.deepEqual(eligiblePilotCreations(t.s), []);
    assert.equal(
      t.s.one<{ count: number }>(
        "SELECT COUNT(*) AS count FROM pilot_settlements WHERE attemptId=?",
        a.id,
      )!.count,
      2,
    );
    assert.equal(canonical(t.campaign.policy), canonical(policy()));
  } finally {
    t.close();
  }
});

test("operator CLI keeps draft, authorization, enrollment and activation explicit with sanitized status", () => {
  const t = fixture();
  try {
    const body = {
      key: "cli-draft",
      totalCents: 100,
      maxHouseholds: 1,
      policy: policy(),
    };
    const file = join(t.dir, "synthetic-pilot-plan.json");
    writeFileSync(file, JSON.stringify(body));
    const draft = runPilotCommand(t.s, ["draft", file]) as {
      id: string;
      state: string;
    };
    assert.equal(draft.state, "draft");
    assert.throws(() =>
      runPilotCommand(t.s, [
        "authorize",
        draft.id,
        "--reference",
        "Synthetic explicit approval",
      ]),
    );
    assert.throws(() =>
      runPilotCommand(t.s, [
        "authorize",
        draft.id,
        "--reference",
        "Synthetic explicit approval",
        "--acknowledge-estimated-costs",
        "--increase",
        "1000",
      ]),
    );
    const activated = runPilotCommand(t.s, [
      "authorize",
      draft.id,
      "--reference",
      "Synthetic explicit approval",
      "--acknowledge-estimated-costs",
    ]) as { state: string };
    assert.equal(activated.state, "active");
    assert.throws(() =>
      runPilotCommand(t.s, [
        "enroll-existing",
        draft.id,
        "--key",
        "join",
        "--label",
        "Synthetic tester",
      ]),
    );
    assert.deepEqual(
      runPilotCommand(t.s, [
        "enroll-existing",
        draft.id,
        "--account",
        "family",
        "--key",
        "join",
        "--label",
        "Synthetic tester",
      ]),
      { campaignId: draft.id, enrolled: true, replayed: false },
    );
    const serialized = JSON.stringify(
      runPilotCommand(t.s, ["status", draft.id]),
    );
    for (const privateText of [
      "family",
      "Synthetic tester",
      "tokenHash",
      'policy"',
      "requestPolicy",
      "apiKey",
      "authorizationReference",
    ])
      assert.equal(serialized.includes(privateText), false, privateText);
    assert.equal(pilotAccess(t.s, "family")!.canStart, true);
    runPilotCommand(t.s, ["pause", draft.id]);
    assert.equal(pilotAccess(t.s, "family")!.canStart, false);
    runPilotCommand(t.s, ["resume", draft.id]);
    assert.equal(pilotAccess(t.s, "family")!.canStart, true);
    assert.equal(
      t.s.one<{ count: number }>("SELECT COUNT(*) AS count FROM studio_jobs")!
        .count,
      0,
    );
    assert.equal(
      t.s.one<{ count: number }>(
        "SELECT COUNT(*) AS count FROM pilot_attempts",
      )!.count,
      0,
    );
  } finally {
    t.close();
  }
});
