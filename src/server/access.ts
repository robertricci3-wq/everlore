import { randomBytes, scryptSync } from "node:crypto";
import { z } from "zod";
import { hash, id, now, type Store } from "./store.js";
import { reservedBudget } from "./engine/budget.js";
import type { EngineConfig } from "./engine/provider.js";
import { Credentials } from "../shared/contracts.js";
import { studioReservation } from "../shared/studioSetup.js";
import { redeemPilotInvitation } from "./pilot/service.js";

export class AccessError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function migrateAccess(store: Store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS access_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS access_invitations(id TEXT PRIMARY KEY,tokenHash TEXT UNIQUE NOT NULL,createdBy TEXT NOT NULL,label TEXT NOT NULL,bookCount INTEGER NOT NULL,creditCents INTEGER NOT NULL,expiresAt INTEGER NOT NULL,redeemedBy TEXT,revokedAt TEXT,createdAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS access_grants(ownerId TEXT PRIMARY KEY,invitationId TEXT UNIQUE NOT NULL,bookCount INTEGER NOT NULL,creditCents INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS access_jobs(jobId TEXT PRIMARY KEY,ownerId TEXT NOT NULL,isBook INTEGER NOT NULL);
  `);
}
export function configureAccess(
  store: Store,
  hosted: boolean,
  explicitId = process.env.EVERLORE_OPERATOR_ID,
) {
  migrateAccess(store);
  store.run(
    "INSERT INTO access_settings VALUES('hosted',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    hosted ? "true" : "false",
  );
  if (explicitId) setOperator(store, explicitId);
}
function setting(store: Store, key: string) {
  migrateAccess(store);
  return store.one<{ value: string }>(
    "SELECT value FROM access_settings WHERE key=?",
    key,
  )?.value;
}
export const isHosted = (store: Store) => setting(store, "hosted") === "true";
export const operatorId = (store: Store) =>
  setting(store, "operator_id") ?? null;
export function setOperator(store: Store, ownerId: string) {
  migrateAccess(store);
  if (!store.one("SELECT id FROM users WHERE id=? AND kind='private'", ownerId))
    throw new AccessError(
      409,
      "Choose an existing private shelf as the operator.",
    );
  store.run(
    "INSERT INTO access_settings VALUES('operator_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ownerId,
  );
}
export function createOperator(store: Store, name: string, password: string) {
  migrateAccess(store);
  if (operatorId(store))
    throw new AccessError(
      409,
      "An operator is already configured. Use set with an existing shelf to change it.",
    );
  const input = Credentials.parse({ name, password, adult: true });
  const salt = randomBytes(16).toString("hex"),
    ownerId = id();
  store.transaction(() => {
    store.run(
      "INSERT INTO users VALUES(?,?,?,?,?)",
      ownerId,
      input.name.toLowerCase(),
      `${salt}:${scryptSync(input.password, salt, 64).toString("hex")}`,
      "private",
      now(),
    );
    setOperator(store, ownerId);
  });
  return ownerId;
}
export function requireOperator(store: Store, ownerId: string) {
  if (operatorId(store) !== ownerId)
    throw new AccessError(
      403,
      "Only the configured Everlore operator can manage this service.",
    );
}
function grantUsed(store: Store, ownerId: string) {
  return store.one<{ total: number }>(
    "SELECT COALESCE(SUM(b.allowance),0) AS total FROM access_jobs j JOIN engine_budget b ON b.runId=j.jobId WHERE j.ownerId=?",
    ownerId,
  )!.total;
}
function earmarked(store: Store, exceptOwner?: string) {
  const grants = store.all<{ ownerId: string; creditCents: number }>(
    "SELECT ownerId,creditCents FROM access_grants",
  );
  const issued = store.one<{ total: number }>(
    "SELECT COALESCE(SUM(creditCents),0) AS total FROM access_invitations WHERE redeemedBy IS NULL AND revokedAt IS NULL AND expiresAt>?",
    Date.now(),
  )!.total;
  return (
    issued +
    grants.reduce(
      (n, g) =>
        n +
        (g.ownerId === exceptOwner
          ? 0
          : Math.max(0, g.creditCents - grantUsed(store, g.ownerId))),
      0,
    )
  );
}
export function committedFunding(store: Store) {
  return reservedBudget(store) + earmarked(store);
}
export function accessView(store: Store, config: EngineConfig) {
  const used = reservedBudget(store),
    assigned = earmarked(store);
  return {
    operatorConfigured: !!operatorId(store),
    cycleReserveCents: studioReservation(config),
    availableCents: Math.max(0, config.budgetCents - used - assigned),
    authorizedCents: config.budgetCents,
    reservedCents: used,
    assignedCents: assigned,
    invitations: store.all(
      "SELECT id,label,bookCount,creditCents,expiresAt,redeemedBy,revokedAt,createdAt FROM access_invitations ORDER BY createdAt DESC",
    ),
  };
}
export function issueInvitation(
  store: Store,
  ownerId: string,
  input: unknown,
  config: EngineConfig,
) {
  requireOperator(store, ownerId);
  const body = z
    .object({
      label: z.string().trim().min(1).max(100),
      bookCount: z.number().int().min(1).max(10).default(1),
      expiresDays: z.number().int().min(1).max(30).default(7),
      creditCents: z.number().int().positive().max(1000000),
    })
    .parse(input);
  const token = randomBytes(24).toString("base64url"),
    invitationId = id(),
    expiresAt = Date.now() + body.expiresDays * 86400000;
  store.transaction(() => {
    if (body.creditCents < body.bookCount * studioReservation(config))
      throw new AccessError(
        409,
        "The invitation needs enough of the existing allowance for its books.",
      );
    if (body.creditCents > accessView(store, config).availableCents)
      throw new AccessError(
        409,
        "The existing authorized allowance cannot cover this invitation. No allowance was increased.",
      );
    store.run(
      "INSERT INTO access_invitations VALUES(?,?,?,?,?,?,?,NULL,NULL,?)",
      invitationId,
      hash(token),
      ownerId,
      body.label,
      body.bookCount,
      body.creditCents,
      expiresAt,
      now(),
    );
  });
  return {
    id: invitationId,
    code: token,
    expiresAt,
    bookCount: body.bookCount,
    creditCents: body.creditCents,
  };
}
export function redeemInvitation(store: Store, code: unknown, ownerId: string) {
  if (!operatorId(store))
    throw new AccessError(
      503,
      "The private pilot is not accepting invitations yet.",
    );
  if (redeemPilotInvitation(store, code, ownerId)) return;
  const invite =
    typeof code === "string"
      ? store.one<{ id: string; bookCount: number; creditCents: number }>(
          "SELECT id,bookCount,creditCents FROM access_invitations WHERE tokenHash=? AND redeemedBy IS NULL AND revokedAt IS NULL AND expiresAt>?",
          hash(code.trim()),
          Date.now(),
        )
      : undefined;
  if (!invite)
    throw new AccessError(
      403,
      "This invitation is invalid, expired or already used. Ask the person who invited you for a new one.",
    );
  store.run(
    "UPDATE access_invitations SET redeemedBy=? WHERE id=?",
    ownerId,
    invite.id,
  );
  store.run(
    "INSERT INTO access_grants VALUES(?,?,?,?)",
    ownerId,
    invite.id,
    invite.bookCount,
    invite.creditCents,
  );
}
export function revokeInvitation(
  store: Store,
  actor: string,
  invitationId: string,
) {
  requireOperator(store, actor);
  store.run(
    "UPDATE access_invitations SET revokedAt=? WHERE id=? AND redeemedBy IS NULL",
    now(),
    invitationId,
  );
}
export function generationAccess(
  store: Store,
  ownerId: string,
  config: EngineConfig,
) {
  const totalUsed = reservedBudget(store);
  if (!isHosted(store))
    return {
      canStart: true,
      message: "",
      remainingCents: Math.max(0, config.budgetCents - totalUsed),
    };
  const grant = store.one<{ bookCount: number; creditCents: number }>(
    "SELECT bookCount,creditCents FROM access_grants WHERE ownerId=?",
    ownerId,
  );
  const usedBooks = store.one<{ total: number }>(
    "SELECT COUNT(*) AS total FROM access_jobs WHERE ownerId=? AND isBook=1",
    ownerId,
  )!.total;
  const remainingCents = Math.max(
    0,
    Math.min(
      config.budgetCents - totalUsed - earmarked(store, ownerId),
      operatorId(store) === ownerId
        ? config.budgetCents
        : (grant?.creditCents ?? 0) - grantUsed(store, ownerId),
    ),
  );
  const canStart =
    remainingCents >= studioReservation(config) &&
    (operatorId(store) === ownerId || (!!grant && usedBooks < grant.bookCount));
  return {
    canStart,
    remainingCents,
    message: canStart
      ? "Your invitation includes story creation. Tell us one memory to begin."
      : "Your shelf and stories are safe. Story creation is not available on this invitation right now; contact Everlore for help.",
  };
}
// Called inside the same transaction as job creation. Grants cannot be spent twice
// by two concurrent books, and deleting a project does not erase its allocation.
export function allocateGeneration(
  store: Store,
  ownerId: string,
  jobId: string,
  amount: number,
  config: EngineConfig,
  isBook: boolean,
) {
  if (!isHosted(store)) return;
  const view = generationAccess(store, ownerId, config);
  if ((isBook && !view.canStart) || amount > view.remainingCents)
    throw new AccessError(
      409,
      view.message ||
        "This invitation cannot cover another generation request.",
    );
  store.run(
    "INSERT INTO access_jobs VALUES(?,?,?)",
    jobId,
    ownerId,
    isBook ? 1 : 0,
  );
}
export function requireAllocationIncrease(
  store: Store,
  jobId: string,
  extra: number,
  config: EngineConfig,
) {
  if (!isHosted(store)) return;
  const allocation = store.one<{ ownerId: string }>(
    "SELECT ownerId FROM access_jobs WHERE jobId=?",
    jobId,
  );
  if (!allocation)
    throw new AccessError(
      409,
      "This earlier job needs an operator allocation before more generation.",
    );
  if (
    extra > generationAccess(store, allocation.ownerId, config).remainingCents
  )
    throw new AccessError(
      409,
      "This invitation has used its available generation allocation. Completed work is preserved.",
    );
}
