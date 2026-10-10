import type { DatabaseSync } from "node:sqlite";

/** Financial evidence deliberately survives removal of a private book/job. */
export function migratePilot(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pilot_campaigns(
      id TEXT PRIMARY KEY,requestKey TEXT NOT NULL UNIQUE,requestHash TEXT NOT NULL,
      createdBy TEXT NOT NULL,totalCents INTEGER NOT NULL,maxHouseholds INTEGER NOT NULL,
      policy TEXT NOT NULL,policyHash TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'draft',
      createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS pilot_one_active_campaign ON pilot_campaigns(state) WHERE state='active';
    CREATE TRIGGER IF NOT EXISTS pilot_frozen_campaign BEFORE UPDATE OF totalCents,maxHouseholds,policy,policyHash,createdBy,requestKey,requestHash ON pilot_campaigns
      BEGIN SELECT RAISE(ABORT,'Pilot authorization and policy are immutable'); END;
    CREATE TABLE IF NOT EXISTS pilot_authorizations(
      campaignId TEXT PRIMARY KEY,actorId TEXT NOT NULL,reference TEXT NOT NULL,
      policyHash TEXT NOT NULL,acknowledgedEstimatedCosts INTEGER NOT NULL,createdAt TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS pilot_frozen_authorization BEFORE UPDATE ON pilot_authorizations
      BEGIN SELECT RAISE(ABORT,'Pilot authorization is immutable'); END;
    CREATE TABLE IF NOT EXISTS pilot_events(
      id TEXT PRIMARY KEY,campaignId TEXT NOT NULL,actorId TEXT NOT NULL,kind TEXT NOT NULL,createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pilot_invitations(
      id TEXT PRIMARY KEY,campaignId TEXT NOT NULL,requestKey TEXT NOT NULL,requestHash TEXT NOT NULL,
      tokenHash TEXT NOT NULL UNIQUE,label TEXT NOT NULL,expiresAt INTEGER NOT NULL,
      ownerId TEXT,revokedAt TEXT,createdAt TEXT NOT NULL,UNIQUE(campaignId,requestKey)
    );
    CREATE TABLE IF NOT EXISTS pilot_memberships(
      ownerId TEXT PRIMARY KEY,campaignId TEXT NOT NULL,invitationId TEXT NOT NULL UNIQUE,createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pilot_creations(
      creationId TEXT PRIMARY KEY,ownerId TEXT NOT NULL,campaignId TEXT NOT NULL,policyHash TEXT NOT NULL,requestHash TEXT NOT NULL,
      createdAt TEXT NOT NULL,UNIQUE(campaignId,ownerId)
    );
    CREATE TABLE IF NOT EXISTS pilot_jobs(
      jobId TEXT PRIMARY KEY,creationId TEXT NOT NULL,ownerId TEXT NOT NULL,campaignId TEXT NOT NULL,
      kind TEXT NOT NULL,policyHash TEXT NOT NULL,createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pilot_attempts(
      id TEXT PRIMARY KEY,campaignId TEXT NOT NULL,creationId TEXT NOT NULL,jobId TEXT NOT NULL,
      stage TEXT NOT NULL,kind TEXT NOT NULL,model TEXT NOT NULL,inputHash TEXT NOT NULL,policyHash TEXT NOT NULL,
      reservedCents INTEGER NOT NULL,accountedCents INTEGER NOT NULL,status TEXT NOT NULL,
      usageEstimatedCents REAL,settlement TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pilot_attempts_campaign ON pilot_attempts(campaignId);
    CREATE TABLE IF NOT EXISTS pilot_settlements(
      id TEXT PRIMARY KEY,attemptId TEXT NOT NULL,actorId TEXT,body TEXT NOT NULL,createdAt TEXT NOT NULL
    );
  `);
}
