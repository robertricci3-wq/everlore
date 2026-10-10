import { randomBytes } from "node:crypto";
import { z } from "zod";
import { AccessError, requireOperator } from "../access.js";
import { canonical, hash, id, now, type Store } from "../store.js";
import { isRecoveryLocked } from "../recovery-lock.js";
import {
  REQUEST_RATE_CARD,
  parseEstimatedRequestPolicy,
  type EstimatedRequestPolicy,
  type EstimatedRequestReservation,
} from "../engine/request-cost.js";
import { migratePilot } from "./schema.js";

type Kind = "audio" | "text" | "image";
export class PilotPreDispatchError extends Error {
  readonly preDispatch = true;
  constructor(message: string, readonly status = 409) {
    super(message);
    this.name = "PilotPreDispatchError";
  }
}
const money = z.number().int().positive().max(1000000);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const PolicyEnvelope = z
  .object({
    version: z.literal(1),
    mode: z.literal("estimated_pilot"),
    requestPolicy: z.unknown(),
    rateCard: z.record(z.string(), z.unknown()),
    models: z
      .object({
        audio: z.string().min(1),
        text: z.string().min(1),
        image: z.string().min(1),
      })
      .strict(),
    maxRequests: z
      .object({
        audio: z.number().int().min(1).max(30),
        text: z.number().int().min(1).max(70),
        image: z.number().int().min(1).max(42),
      })
      .strict(),
  })
  .strict();
export interface PilotPolicyRecord {
  version: 1;
  mode: "estimated_pilot";
  requestPolicy: EstimatedRequestPolicy;
  rateCard: Record<string, unknown>;
  models: Record<Kind, string>;
  maxRequests: Record<Kind, number>;
}
export function makePilotPolicy(
  requestPolicy: EstimatedRequestPolicy,
): PilotPolicyRecord {
  return {
    version: 1,
    mode: "estimated_pilot",
    requestPolicy: parseEstimatedRequestPolicy(requestPolicy),
    rateCard: { ...REQUEST_RATE_CARD },
    models: {
      audio: "gpt-4o-transcribe",
      text: "gpt-5.4",
      image: "gpt-image-2",
    },
    maxRequests: { audio: 30, text: 70, image: 42 },
  };
}
function parsePolicy(input: unknown): PilotPolicyRecord {
  const parsed = PolicyEnvelope.parse(input);
  return {
    ...parsed,
    requestPolicy: parseEstimatedRequestPolicy(parsed.requestPolicy),
  };
}
/** Safe both as a standalone operation and within an existing creation transaction. */
function atomic<T>(s: Store, fn: () => T): T {
  if (!s.db.isTransaction) return s.transaction(fn);
  const name = `pilot_${id().replaceAll("-", "")}`;
  s.db.exec(`SAVEPOINT ${name}`);
  try {
    const value = fn();
    s.db.exec(`RELEASE ${name}`);
    return value;
  } catch (error) {
    s.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
    throw error;
  }
}
function ensure(s: Store) {
  migratePilot(s.db);
}
export interface PilotCampaign {
  id: string;
  createdBy: string;
  totalCents: number;
  maxHouseholds: number;
  policy: PilotPolicyRecord;
  policyHash: string;
  state: "draft" | "active" | "paused";
  createdAt: string;
  updatedAt: string;
}
interface CampaignRow extends Omit<PilotCampaign, "policy"> {
  policy: string;
}
export function readPilotCampaign(s: Store, campaignId: string): PilotCampaign {
  ensure(s);
  const row = s.one<CampaignRow>(
    "SELECT * FROM pilot_campaigns WHERE id=?",
    campaignId,
  );
  if (!row) throw new AccessError(404, "This feedback pilot was not found.");
  const policy = parsePolicy(JSON.parse(row.policy));
  if (hash(canonical(policy)) !== row.policyHash)
    throw new AccessError(
      409,
      "The saved pilot policy failed its integrity check.",
    );
  return { ...row, policy };
}
function spent(s: Store, campaignId: string) {
  return s.one<{ amount: number }>(
    "SELECT COALESCE(SUM(accountedCents),0) AS amount FROM pilot_attempts WHERE campaignId=?",
    campaignId,
  )!.amount;
}
function active(s: Store, campaign: PilotCampaign) {
  if (
    campaign.state !== "active" ||
    !s.one(
      "SELECT campaignId FROM pilot_authorizations WHERE campaignId=?",
      campaign.id,
    )
  )
    throw new AccessError(
      409,
      "Feedback book creation is paused. Your memory is saved.",
    );
  if (isRecoveryLocked(s))
    throw new AccessError(
      409,
      "Feedback creation is paused while saved requests are reconciled.",
    );
}
function privateOwner(s: Store, ownerId: string) {
  if (!s.one("SELECT id FROM users WHERE id=? AND kind='private'", ownerId))
    throw new AccessError(403, "A private family account is required.");
}
export function createPilotCampaign(s: Store, actor: string, input: unknown) {
  requireOperator(s, actor);
  ensure(s);
  const body = z
    .object({
      key: z.string().min(1).max(200),
      totalCents: money,
      maxHouseholds: z.number().int().min(1).max(5),
      policy: z.unknown(),
    })
    .strict()
    .parse(input);
  const policy = parsePolicy(body.policy);
  if (canonical(policy.rateCard) !== canonical(REQUEST_RATE_CARD))
    throw new AccessError(
      409,
      "Use the current reviewed rates when freezing a new pilot policy.",
    );
  const requestHash = hash(canonical({ ...body, policy }));
  return atomic(s, () => {
    const old = s.one<{ id: string; requestHash: string }>(
      "SELECT id,requestHash FROM pilot_campaigns WHERE requestKey=?",
      body.key,
    );
    if (old) {
      if (old.requestHash !== requestHash)
        throw new AccessError(
          409,
          "This pilot request key has different settings.",
        );
      return readPilotCampaign(s, old.id);
    }
    const campaignId = id(),
      at = now();
    s.run(
      "INSERT INTO pilot_campaigns VALUES(?,?,?,?,?,?,?,?,'draft',?,?)",
      campaignId,
      body.key,
      requestHash,
      actor,
      body.totalCents,
      body.maxHouseholds,
      canonical(policy),
      hash(canonical(policy)),
      at,
      at,
    );
    return readPilotCampaign(s, campaignId);
  });
}
export function authorizePilotCampaign(
  s: Store,
  actor: string,
  campaignId: string,
  input: unknown,
) {
  requireOperator(s, actor);
  ensure(s);
  const body = z
    .object({
      authorizationReference: z.string().trim().min(10).max(1000),
      acknowledgeEstimatedCosts: z.literal(true),
    })
    .strict()
    .parse(input);
  return atomic(s, () => {
    const campaign = readPilotCampaign(s, campaignId);
    const old = s.one<{ reference: string }>(
      "SELECT reference FROM pilot_authorizations WHERE campaignId=?",
      campaignId,
    );
    if (old && old.reference !== body.authorizationReference)
      throw new AccessError(
        409,
        "This pilot already has a different authorization record.",
      );
    if (campaign.state === "paused" && old)
      throw new AccessError(
        409,
        "Use the explicit resume operation for this authorized pilot.",
      );
    if (
      s.one(
        "SELECT id FROM pilot_campaigns WHERE state='active' AND id!=?",
        campaignId,
      )
    )
      throw new AccessError(
        409,
        "Pause the other pilot before activating this one.",
      );
    s.run(
      "INSERT OR IGNORE INTO pilot_authorizations VALUES(?,?,?,?,1,?)",
      campaignId,
      actor,
      body.authorizationReference,
      campaign.policyHash,
      now(),
    );
    if (campaign.state !== "active") {
      s.run(
        "UPDATE pilot_campaigns SET state='active',updatedAt=? WHERE id=?",
        now(),
        campaignId,
      );
      s.run(
        "INSERT INTO pilot_events VALUES(?,?,?,'authorized',?)",
        id(),
        campaignId,
        actor,
        now(),
      );
    }
    return readPilotCampaign(s, campaignId);
  });
}
export function setPilotCampaignState(
  s: Store,
  actor: string,
  campaignId: string,
  state: "active" | "paused",
) {
  requireOperator(s, actor);
  ensure(s);
  z.enum(["active", "paused"]).parse(state);
  return atomic(s, () => {
    const campaign = readPilotCampaign(s, campaignId);
    if (
      !s.one(
        "SELECT campaignId FROM pilot_authorizations WHERE campaignId=?",
        campaignId,
      )
    )
      throw new AccessError(
        409,
        "Authorize the pilot explicitly before changing its operation.",
      );
    if (
      state === "active" &&
      (spent(s, campaignId) >= campaign.totalCents ||
        s.one(
          "SELECT id FROM pilot_campaigns WHERE state='active' AND id!=?",
          campaignId,
        ))
    )
      throw new AccessError(
        409,
        "This pilot cannot resume within its existing allowance.",
      );
    s.run(
      "UPDATE pilot_campaigns SET state=?,updatedAt=? WHERE id=?",
      state,
      now(),
      campaignId,
    );
    if (campaign.state !== state)
      s.run(
        "INSERT INTO pilot_events VALUES(?,?,?,?,?)",
        id(),
        campaignId,
        actor,
        state === "active" ? "resumed" : "paused",
        now(),
      );
    return readPilotCampaign(s, campaignId);
  });
}
export function issuePilotInvitation(
  s: Store,
  actor: string,
  campaignId: string,
  input: unknown,
) {
  requireOperator(s, actor);
  ensure(s);
  const body = z
    .object({
      key: z.string().min(1).max(200),
      label: z.string().trim().min(1).max(100),
      expiresDays: z.number().int().min(1).max(30).default(7),
    })
    .strict()
    .parse(input);
  const requestHash = hash(canonical(body));
  return atomic(s, () => {
    const campaign = readPilotCampaign(s, campaignId);
    active(s, campaign);
    const old = s.one<{ id: string; requestHash: string; expiresAt: number }>(
      "SELECT id,requestHash,expiresAt FROM pilot_invitations WHERE campaignId=? AND requestKey=?",
      campaignId,
      body.key,
    );
    if (old) {
      if (old.requestHash !== requestHash)
        throw new AccessError(
          409,
          "This invitation request key has different details.",
        );
      return {
        id: old.id,
        code: null,
        expiresAt: old.expiresAt,
        replayed: true,
      };
    }
    const places = s.one<{ amount: number }>(
      "SELECT COUNT(*) AS amount FROM pilot_invitations WHERE campaignId=? AND (ownerId IS NOT NULL OR (revokedAt IS NULL AND expiresAt>?))",
      campaignId,
      Date.now(),
    )!.amount;
    if (places >= campaign.maxHouseholds)
      throw new AccessError(
        409,
        "All feedback invitations in this pilot are assigned.",
      );
    const invitationId = id(),
      code = randomBytes(24).toString("base64url"),
      expiresAt = Date.now() + body.expiresDays * 86400000;
    s.run(
      "INSERT INTO pilot_invitations VALUES(?,?,?,?,?,?,?,NULL,NULL,?)",
      invitationId,
      campaignId,
      body.key,
      requestHash,
      hash(code),
      body.label,
      expiresAt,
      now(),
    );
    return { id: invitationId, code, expiresAt, replayed: false };
  });
}
export function revokePilotInvitation(
  s: Store,
  actor: string,
  invitationId: string,
) {
  requireOperator(s, actor);
  ensure(s);
  s.run(
    "UPDATE pilot_invitations SET revokedAt=? WHERE id=? AND ownerId IS NULL",
    now(),
    invitationId,
  );
}
/** False means it is not a pilot token; legacy invitation handling may follow. */
export function redeemPilotInvitation(
  s: Store,
  code: unknown,
  ownerId: string,
): boolean {
  ensure(s);
  if (typeof code !== "string") return false;
  return atomic(s, () => {
    const row = s.one<{
      id: string;
      campaignId: string;
      ownerId: string | null;
      revokedAt: string | null;
      expiresAt: number;
    }>("SELECT * FROM pilot_invitations WHERE tokenHash=?", hash(code.trim()));
    if (!row) return false;
    privateOwner(s, ownerId);
    if (row.ownerId === ownerId) return true;
    if (row.ownerId || row.revokedAt || row.expiresAt <= Date.now())
      throw new AccessError(
        403,
        "This invitation is no longer available. Ask for a new invitation.",
      );
    const campaign = readPilotCampaign(s, row.campaignId);
    active(s, campaign);
    if (s.one("SELECT ownerId FROM pilot_memberships WHERE ownerId=?", ownerId))
      throw new AccessError(
        409,
        "This family already has a feedback invitation.",
      );
    const count = s.one<{ amount: number }>(
      "SELECT COUNT(*) AS amount FROM pilot_memberships WHERE campaignId=?",
      campaign.id,
    )!.amount;
    if (count >= campaign.maxHouseholds)
      throw new AccessError(409, "This feedback pilot is full.");
    s.run("UPDATE pilot_invitations SET ownerId=? WHERE id=?", ownerId, row.id);
    s.run(
      "INSERT INTO pilot_memberships VALUES(?,?,?,?)",
      ownerId,
      campaign.id,
      row.id,
      now(),
    );
    return true;
  });
}
export function pilotAccess(s: Store, ownerId: string, nextEstimatedCents = 1) {
  ensure(s);
  money.parse(nextEstimatedCents);
  const member = s.one<{ campaignId: string }>(
    "SELECT campaignId FROM pilot_memberships WHERE ownerId=?",
    ownerId,
  );
  if (!member) return null;
  const campaign = readPilotCampaign(s, member.campaignId);
  const creation = s.one<{ creationId: string }>(
    "SELECT creationId FROM pilot_creations WHERE ownerId=? AND campaignId=?",
    ownerId,
    campaign.id,
  );
  const remainingCents = Math.max(
    0,
    campaign.totalCents - spent(s, campaign.id),
  );
  return {
    campaign,
    remainingCents,
    creationId: creation?.creationId ?? null,
    canStart:
      campaign.state === "active" &&
      !isRecoveryLocked(s) &&
      !creation &&
      remainingCents >= nextEstimatedCents,
  };
}
export function bindPilotCreation(
  s: Store,
  ownerId: string,
  creationId: string,
) {
  ensure(s);
  return atomic(s, () => {
    const access = pilotAccess(s, ownerId);
    if (!access) return null;
    const request = s.one<{
      ownerId: string;
      requestHash: string;
      status: string;
      studioJobId: string | null;
      createdAt: string;
    }>(
      "SELECT ownerId,requestHash,status,studioJobId,createdAt FROM almanac_creation_requests WHERE id=?",
      creationId,
    );
    if (!request || request.ownerId !== ownerId)
      throw new AccessError(404, "This creation request was not found.");
    const old = s.one<{ requestHash: string }>(
      "SELECT requestHash FROM pilot_creations WHERE creationId=? AND ownerId=?",
      creationId,
      ownerId,
    );
    if (old) {
      if (old.requestHash !== request.requestHash)
        throw new AccessError(409, "This saved creation request has changed.");
      return access.campaign;
    }
    if (
      !access.canStart ||
      request.studioJobId ||
      ["ready", "cancelled"].includes(request.status) ||
      request.createdAt < access.campaign.createdAt
    )
      throw new AccessError(
        409,
        "This invitation includes one new digital book. Your saved work is preserved.",
      );
    s.run(
      "INSERT INTO pilot_creations VALUES(?,?,?,?,?,?)",
      creationId,
      ownerId,
      access.campaign.id,
      access.campaign.policyHash,
      request.requestHash,
      now(),
    );
    return access.campaign;
  });
}
export function pilotCreationFunding(s: Store, creationId: string) {
  ensure(s);
  const row = s.one<{
    campaignId: string;
    ownerId: string;
    policyHash: string;
    requestHash: string;
  }>("SELECT * FROM pilot_creations WHERE creationId=?", creationId);
  if (!row) return null;
  const request = s.one<{
    ownerId: string;
    requestHash: string;
    status: string;
  }>(
    "SELECT ownerId,requestHash,status FROM almanac_creation_requests WHERE id=?",
    creationId,
  );
  if (
    !request ||
    request.ownerId !== row.ownerId ||
    request.requestHash !== row.requestHash ||
    request.status === "cancelled"
  )
    throw new AccessError(
      409,
      "This saved creation is no longer eligible for pilot generation.",
    );
  const campaign = readPilotCampaign(s, row.campaignId);
  if (campaign.policyHash !== row.policyHash)
    throw new AccessError(409, "The pinned pilot policy changed.");
  return { campaign, creationId, ownerId: row.ownerId };
}
export function linkPilotJob(
  s: Store,
  ownerId: string,
  creationId: string,
  jobId: string,
) {
  ensure(s);
  return atomic(s, () => {
    const funding = pilotCreationFunding(s, creationId);
    if (!funding || funding.ownerId !== ownerId)
      throw new AccessError(
        403,
        "This creation has no matching pilot funding.",
      );
    const job = s.one<{ kind: string; projectId: string; ownerId: string }>(
      "SELECT j.kind,j.projectId,p.ownerId FROM studio_jobs j JOIN projects p ON p.id=j.projectId WHERE j.id=?",
      jobId,
    );
    const request = s.one<{ sessionId: string; projectId: string | null }>(
      "SELECT sessionId,projectId FROM almanac_creation_requests WHERE id=?",
      creationId,
    )!;
    const sessionProject = s.one<{ projectId: string }>(
      "SELECT projectId FROM almanac_sessions WHERE id=?",
      request.sessionId,
    )?.projectId;
    if (
      !job ||
      job.ownerId !== ownerId ||
      !["generation", "interview_transcription"].includes(job.kind) ||
      job.projectId !==
        (job.kind === "generation" ? request.projectId : sessionProject)
    )
      throw new AccessError(
        403,
        "Only this memory's transcription and book jobs can use its pilot funding.",
      );
    const old = s.one<{ creationId: string }>(
      "SELECT creationId FROM pilot_jobs WHERE jobId=?",
      jobId,
    );
    if (old && old.creationId !== creationId)
      throw new AccessError(409, "This job already has different funding.");
    s.run(
      "INSERT OR IGNORE INTO pilot_jobs VALUES(?,?,?,?,?,?,?)",
      jobId,
      creationId,
      ownerId,
      funding.campaign.id,
      job.kind,
      funding.campaign.policyHash,
      now(),
    );
    return funding;
  });
}
export function pilotJobFunding(s: Store, jobId: string) {
  ensure(s);
  const row = s.one<{
    creationId: string;
    ownerId: string;
    campaignId: string;
    policyHash: string;
  }>("SELECT * FROM pilot_jobs WHERE jobId=?", jobId);
  if (!row) return null;
  const funding = pilotCreationFunding(s, row.creationId);
  if (
    !funding ||
    funding.ownerId !== row.ownerId ||
    funding.campaign.id !== row.campaignId ||
    funding.campaign.policyHash !== row.policyHash
  )
    throw new AccessError(
      409,
      "This job's funding does not match its creation request.",
    );
  const live = s.one<{
    kind: string;
    ownerId: string;
    projectId: string;
    sessionProjectId: string;
    generationProjectId: string | null;
  }>(
    "SELECT j.kind,p.ownerId,j.projectId,a.projectId AS sessionProjectId,r.projectId AS generationProjectId FROM studio_jobs j JOIN projects p ON p.id=j.projectId JOIN almanac_creation_requests r ON r.id=? JOIN almanac_sessions a ON a.id=r.sessionId WHERE j.id=?",
    row.creationId,
    jobId,
  );
  if (
    !live ||
    live.ownerId !== row.ownerId ||
    !["generation", "interview_transcription"].includes(live.kind) ||
    live.projectId !==
      (live.kind === "generation"
        ? live.generationProjectId
        : live.sessionProjectId)
  )
    throw new AccessError(
      409,
      "This pilot job no longer belongs to its saved memory.",
    );
  return { ...funding, jobId };
}
export function eligiblePilotCreations(s: Store): string[] {
  ensure(s);
  if (isRecoveryLocked(s)) return [];
  return s
    .all<{ id: string }>(
      "SELECT r.id FROM pilot_creations p JOIN pilot_campaigns c ON c.id=p.campaignId JOIN almanac_creation_requests r ON r.id=p.creationId WHERE c.state='active' AND r.status NOT IN ('ready','cancelled') AND r.requestHash=p.requestHash ORDER BY r.createdAt",
    )
    .map((row) => row.id);
}
export function eligiblePilotJobs(s: Store): string[] {
  ensure(s);
  if (isRecoveryLocked(s)) return [];
  return s
    .all<{ id: string }>(
      "SELECT j.id FROM pilot_jobs p JOIN pilot_campaigns c ON c.id=p.campaignId JOIN studio_jobs j ON j.id=p.jobId JOIN pilot_creations f ON f.creationId=p.creationId JOIN almanac_creation_requests r ON r.id=f.creationId WHERE c.state='active' AND (j.status='queued' OR (j.status='running' AND j.leaseUntil<?)) AND r.status NOT IN ('ready','cancelled') AND r.requestHash=f.requestHash ORDER BY j.createdAt",
      Date.now(),
    )
    .map((row) => row.id);
}
interface AttemptRow {
  id: string;
  campaignId: string;
  creationId: string;
  jobId: string;
  stage: string;
  kind: Kind;
  model: string;
  inputHash: string;
  policyHash: string;
  reservedCents: number;
  accountedCents: number;
  status:
    "reserved" | "dispatched" | "completed" | "ambiguous" | "not_processed";
  usageEstimatedCents: number | null;
  settlement: string | null;
}
export function reservePilotRequest(
  s: Store,
  input: {
    jobId: string;
    attemptId: string;
    stage: string;
    inputHash: string;
    reservation: EstimatedRequestReservation;
  },
) {
  try {
    return reserveRequest(s, input);
  } catch (error) {
    throw new PilotPreDispatchError(
      error instanceof AccessError
        ? error.message
        : "The pilot request estimate could not be validated. Nothing was sent.",
      error instanceof AccessError ? error.status : 409,
    );
  }
}
function reserveRequest(
  s: Store,
  input: {
    jobId: string;
    attemptId: string;
    stage: string;
    inputHash: string;
    reservation: EstimatedRequestReservation;
  },
) {
  ensure(s);
  sha.parse(input.inputHash);
  z.string().min(1).max(200).parse(input.stage);
  z.string().min(1).max(200).parse(input.attemptId);
  const estimate = input.reservation;
  money.parse(estimate.reservationCents);
  sha.parse(estimate.policyHash);
  if (
    estimate.version !== 1 ||
    estimate.costConfidence !== "estimate" ||
    !["audio", "text", "image"].includes(estimate.kind) ||
    Object.values(estimate.evidence).some((n) => !Number.isFinite(n) || n < 0)
  )
    throw new AccessError(409, "The next request has no valid pilot estimate.");
  return atomic(s, () => {
    const funding = pilotJobFunding(s, input.jobId);
    if (!funding)
      throw new AccessError(
        403,
        "This job is not funded by the feedback pilot.",
      );
    const campaign = funding.campaign;
    if (
      estimate.policyHash !== campaign.policyHash ||
      estimate.rateCardVersion !== campaign.policy.rateCard.version ||
      estimate.model !== campaign.policy.models[estimate.kind]
    )
      throw new AccessError(
        409,
        "The next request differs from its frozen pilot cost policy.",
      );
    const old = s.one<AttemptRow>(
      "SELECT * FROM pilot_attempts WHERE id=?",
      input.attemptId,
    );
    if (old) {
      if (
        old.jobId !== input.jobId ||
        old.stage !== input.stage ||
        old.inputHash !== input.inputHash ||
        old.policyHash !== estimate.policyHash ||
        old.reservedCents !== estimate.reservationCents ||
        old.model !== estimate.model ||
        old.kind !== estimate.kind
      )
        throw new AccessError(
          409,
          "This saved attempt has different inputs. It must not be repeated.",
        );
      return { isNew: false, attempt: old };
    }
    active(s, campaign);
    if (
      !s.one(
        "SELECT j.id FROM studio_jobs j JOIN almanac_creation_requests r ON r.id=? WHERE j.id=? AND j.status IN ('queued','running') AND r.status NOT IN ('ready','cancelled')",
        funding.creationId,
        input.jobId,
      )
    )
      throw new AccessError(
        409,
        "This creation is no longer waiting for provider work.",
      );
    if (
      s.one(
        "SELECT id FROM pilot_attempts WHERE jobId=? AND stage=? AND status!='not_processed'",
        input.jobId,
        input.stage,
      )
    )
      throw new AccessError(
        409,
        "This stage has a saved request. Reuse its result or reconcile it before another attempt.",
      );
    const attempts = s.one<{ amount: number }>(
      "SELECT COUNT(*) AS amount FROM pilot_attempts WHERE creationId=? AND kind=? AND status!='not_processed'",
      funding.creationId,
      estimate.kind,
    )!.amount;
    if (attempts >= campaign.policy.maxRequests[estimate.kind])
      throw new AccessError(
        409,
        "This book reached its pilot request limit. Completed work is saved.",
      );
    if (spent(s, campaign.id) + estimate.reservationCents > campaign.totalCents)
      throw new AccessError(
        409,
        "The feedback allowance cannot cover the next estimated request. Completed work is saved.",
      );
    const at = now();
    s.run(
      "INSERT INTO pilot_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?,'reserved',NULL,NULL,?,?)",
      input.attemptId,
      campaign.id,
      funding.creationId,
      input.jobId,
      input.stage,
      estimate.kind,
      estimate.model,
      input.inputHash,
      campaign.policyHash,
      estimate.reservationCents,
      estimate.reservationCents,
      at,
      at,
    );
    s.run(
      "INSERT INTO pilot_settlements VALUES(?,?,NULL,?,?)",
      id(),
      input.attemptId,
      canonical({ event: "reserved", estimate }),
      at,
    );
    return {
      isNew: true,
      attempt: s.one<AttemptRow>(
        "SELECT * FROM pilot_attempts WHERE id=?",
        input.attemptId,
      )!,
    };
  });
}
export function markPilotDispatched(s: Store, attemptId: string) {
  ensure(s);
  return atomic(s, () => {
    const row = s.one<AttemptRow>(
      "SELECT * FROM pilot_attempts WHERE id=?",
      attemptId,
    );
    if (!row || row.status !== "reserved")
      throw new AccessError(
        409,
        "This pilot request has already reached its dispatch boundary.",
      );
    pilotJobFunding(s, row.jobId);
    if (
      !s.one(
        "SELECT j.id FROM studio_jobs j JOIN almanac_creation_requests r ON r.id=? WHERE j.id=? AND j.status IN ('queued','running') AND r.status NOT IN ('ready','cancelled')",
        row.creationId,
        row.jobId,
      )
    )
      throw new PilotPreDispatchError(
        "This saved request is no longer ready to dispatch.",
      );
    active(s, readPilotCampaign(s, row.campaignId));
    s.run(
      "UPDATE pilot_attempts SET status='dispatched',updatedAt=? WHERE id=?",
      now(),
      attemptId,
    );
    return { dispatched: true as const };
  });
}
const Settlement = z
  .object({
    outcome: z.enum(["completed", "ambiguous", "not_processed"]),
    usageEstimatedCents: z
      .number()
      .finite()
      .nonnegative()
      .max(10000000)
      .optional(),
    evidenceHash: sha,
    evidenceKind: z.enum([
      "provider_usage",
      "provider_rejection",
      "local_pre_dispatch",
      "unknown_outcome",
    ]),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      (v.usageEstimatedCents !== undefined &&
        (v.outcome !== "completed" || v.evidenceKind !== "provider_usage")) ||
      (v.outcome === "not_processed" &&
        !["local_pre_dispatch", "provider_rejection"].includes(v.evidenceKind))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Releasing estimated funds requires matching usage or non-processing evidence.",
      });
  });
export type PilotSettlement = z.infer<typeof Settlement>;
function settle(
  s: Store,
  attemptId: string,
  body: PilotSettlement,
  actor: string | null,
) {
  const row = s.one<AttemptRow>(
    "SELECT * FROM pilot_attempts WHERE id=?",
    attemptId,
  );
  if (!row) throw new AccessError(404, "This pilot request was not found.");
  const encoded = canonical(body);
  if (row.settlement === encoded) return row;
  if (
    row.settlement &&
    !(
      actor &&
      (row.status === "ambiguous" ||
        (row.status === "completed" && row.usageEstimatedCents === null))
    )
  )
    throw new AccessError(
      409,
      "This attempt already has a different outcome. Its evidence remains preserved.",
    );
  if (body.evidenceKind === "local_pre_dispatch" && row.status !== "reserved")
    throw new AccessError(
      409,
      "A dispatched request cannot be released as a local failure.",
    );
  if (body.outcome === "completed" && row.status === "reserved")
    throw new AccessError(
      409,
      "This request has not crossed its dispatch boundary.",
    );
  const accounted =
    body.outcome === "not_processed"
      ? 0
      : body.usageEstimatedCents === undefined
        ? row.reservedCents
        : Math.ceil(body.usageEstimatedCents);
  s.run(
    "UPDATE pilot_attempts SET status=?,accountedCents=?,usageEstimatedCents=?,settlement=?,updatedAt=? WHERE id=?",
    body.outcome,
    accounted,
    body.usageEstimatedCents ?? null,
    encoded,
    now(),
    attemptId,
  );
  s.run(
    "INSERT INTO pilot_settlements VALUES(?,?,?,?,?)",
    id(),
    attemptId,
    actor,
    encoded,
    now(),
  );
  const campaign = readPilotCampaign(s, row.campaignId);
  if (spent(s, campaign.id) >= campaign.totalCents)
    s.run(
      "UPDATE pilot_campaigns SET state='paused',updatedAt=? WHERE id=?",
      now(),
      campaign.id,
    );
  return s.one<AttemptRow>(
    "SELECT * FROM pilot_attempts WHERE id=?",
    attemptId,
  )!;
}
export function settlePilotRequest(
  s: Store,
  attemptId: string,
  input: unknown,
) {
  ensure(s);
  const body = Settlement.parse(input);
  return atomic(s, () => settle(s, attemptId, body, null));
}
export function reconcilePilotRequest(
  s: Store,
  actor: string,
  attemptId: string,
  input: unknown,
) {
  requireOperator(s, actor);
  ensure(s);
  const body = Settlement.parse(input);
  return atomic(s, () => settle(s, attemptId, body, actor));
}
export function pilotCampaignSummary(
  s: Store,
  actor: string,
  campaignId: string,
) {
  requireOperator(s, actor);
  const campaign = readPilotCampaign(s, campaignId);
  const attempts = s.all<AttemptRow>(
    "SELECT * FROM pilot_attempts WHERE campaignId=? ORDER BY createdAt",
    campaignId,
  );
  const held = spent(s, campaignId);
  return {
    campaign,
    currency: "USD",
    costConfidence: "estimate" as const,
    accountedCents: held,
    remainingCents: Math.max(0, campaign.totalCents - held),
    overrunCents: Math.max(0, held - campaign.totalCents),
    reservedCents: attempts.reduce((sum, row) => sum + row.reservedCents, 0),
    usageEstimatedCents: attempts
      .filter((row) => row.usageEstimatedCents !== null)
      .reduce((sum, row) => sum + row.usageEstimatedCents!, 0),
    attemptsWithoutUsage: attempts.filter(
      (row) =>
        row.usageEstimatedCents === null && row.status !== "not_processed",
    ).length,
    ambiguousAttempts: attempts.filter((row) =>
      ["dispatched", "ambiguous"].includes(row.status),
    ).length,
    verifiedBilledCents: null,
    households: s.one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM pilot_memberships WHERE campaignId=?",
      campaignId,
    )!.count,
    booksRequested: s.one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM pilot_creations WHERE campaignId=?",
      campaignId,
    )!.count,
    invitations: s.all(
      "SELECT id,label,expiresAt,ownerId,revokedAt,createdAt FROM pilot_invitations WHERE campaignId=? ORDER BY createdAt",
      campaignId,
    ),
    attempts,
    note: "Estimates and held reservations are not verified billing or a guaranteed provider cap. Completion depends on available funds and quality gates.",
  };
}
