import type { DatabaseSync } from "node:sqlite";

/** Additive only. Source sessions and generated books remain ordinary projects. */
export function migrateAlmanac(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS almanac_pages(
      ownerId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL,chapterId TEXT,
      position INTEGER NOT NULL,hidden INTEGER NOT NULL DEFAULT 0,
      custom INTEGER NOT NULL DEFAULT 0,invitationIds TEXT NOT NULL,
      createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,PRIMARY KEY(ownerId,id)
    );
    CREATE TABLE IF NOT EXISTS almanac_sessions(
      id TEXT PRIMARY KEY,ownerId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      projectId TEXT UNIQUE NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      pageId TEXT NOT NULL,invitationId TEXT NOT NULL,invitationVersion TEXT NOT NULL,
      invitation TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',
      requestKey TEXT NOT NULL,consentAt TEXT NOT NULL,aiConsentAt TEXT,
      createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,
      UNIQUE(ownerId,requestKey),FOREIGN KEY(ownerId,pageId) REFERENCES almanac_pages(ownerId,id)
    );
    CREATE TABLE IF NOT EXISTS almanac_turns(
      id TEXT PRIMARY KEY,sessionId TEXT NOT NULL REFERENCES almanac_sessions(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,requestKey TEXT NOT NULL,requestHash TEXT NOT NULL,
      body TEXT NOT NULL,UNIQUE(sessionId,sequence),UNIQUE(sessionId,requestKey)
    );
    CREATE TABLE IF NOT EXISTS almanac_transcriptions(
      jobId TEXT PRIMARY KEY REFERENCES studio_jobs(id) ON DELETE CASCADE,
      turnId TEXT NOT NULL UNIQUE REFERENCES almanac_turns(id) ON DELETE CASCADE,
      sessionId TEXT NOT NULL REFERENCES almanac_sessions(id) ON DELETE CASCADE,
      audioHash TEXT NOT NULL,model TEXT NOT NULL,consentAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS almanac_transcript_versions(
      id TEXT PRIMARY KEY,turnId TEXT NOT NULL REFERENCES almanac_turns(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,contentHash TEXT NOT NULL,body TEXT NOT NULL,
      createdAt TEXT NOT NULL,UNIQUE(turnId,revision),UNIQUE(turnId,contentHash)
    );
    CREATE TABLE IF NOT EXISTS almanac_sources(
      id TEXT PRIMARY KEY,sessionId TEXT NOT NULL REFERENCES almanac_sessions(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,sourceHash TEXT NOT NULL,
      generationProjectId TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
      body TEXT NOT NULL,createdAt TEXT NOT NULL,UNIQUE(sessionId,revision),UNIQUE(sessionId,sourceHash)
    );
    CREATE TABLE IF NOT EXISTS almanac_memories(
      ownerId TEXT NOT NULL,pageId TEXT NOT NULL,
      projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      createdAt TEXT NOT NULL,PRIMARY KEY(ownerId,pageId,projectId),
      FOREIGN KEY(ownerId,pageId) REFERENCES almanac_pages(ownerId,id)
    );
    CREATE TABLE IF NOT EXISTS almanac_archive_provenance(
      sessionId TEXT PRIMARY KEY REFERENCES almanac_sessions(id) ON DELETE CASCADE,
      body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS almanac_recovery_actions(
      id TEXT PRIMARY KEY,jobId TEXT NOT NULL REFERENCES studio_jobs(id) ON DELETE CASCADE,
      actorId TEXT NOT NULL REFERENCES users(id),action TEXT NOT NULL,createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS almanac_title_applications(
      sessionId TEXT PRIMARY KEY REFERENCES almanac_sessions(id) ON DELETE CASCADE,
      title TEXT NOT NULL,previousTitle TEXT NOT NULL,appliedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS almanac_session_keys(
      ownerId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      requestKey TEXT NOT NULL,sessionId TEXT NOT NULL REFERENCES almanac_sessions(id) ON DELETE CASCADE,
      PRIMARY KEY(ownerId,requestKey)
    );
    CREATE TABLE IF NOT EXISTS almanac_consents(
      id TEXT PRIMARY KEY,ownerId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      version TEXT NOT NULL,scope TEXT NOT NULL,text TEXT NOT NULL,acceptedAt TEXT NOT NULL,
      UNIQUE(ownerId,version,scope)
    );
    CREATE TABLE IF NOT EXISTS almanac_creation_requests(
      id TEXT PRIMARY KEY,ownerId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sessionId TEXT NOT NULL REFERENCES almanac_sessions(id) ON DELETE CASCADE,
      requestKey TEXT NOT NULL,requestHash TEXT NOT NULL,consentVersion TEXT NOT NULL,
      selection TEXT NOT NULL,profile TEXT NOT NULL,continuity TEXT NOT NULL,
      status TEXT NOT NULL,sourceId TEXT REFERENCES almanac_sources(id) ON DELETE SET NULL,
      projectId TEXT REFERENCES projects(id) ON DELETE SET NULL,
      historicalProjectId TEXT,
      studioJobId TEXT REFERENCES studio_jobs(id) ON DELETE SET NULL,
      pauseReason TEXT,error TEXT,leaseToken TEXT,leaseUntil INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,lastAttemptAt INTEGER NOT NULL DEFAULT 0,
      UNIQUE(ownerId,requestKey)
    );
    CREATE INDEX IF NOT EXISTS almanac_creation_session ON almanac_creation_requests(sessionId,createdAt);
    CREATE TABLE IF NOT EXISTS almanac_creation_keys(
      ownerId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      requestKey TEXT NOT NULL,requestHash TEXT NOT NULL,
      creationId TEXT NOT NULL REFERENCES almanac_creation_requests(id) ON DELETE CASCADE,
      PRIMARY KEY(ownerId,requestKey)
    );
    CREATE TABLE IF NOT EXISTS almanac_journey_events(
      sessionId TEXT NOT NULL REFERENCES almanac_sessions(id) ON DELETE CASCADE,
      event TEXT NOT NULL,createdAt TEXT NOT NULL,PRIMARY KEY(sessionId,event)
    );
  `);
  const columns = db.prepare("PRAGMA table_info(almanac_sessions)").all();
  if (!columns.some((column) => column.name === "purpose"))
    db.exec(
      "ALTER TABLE almanac_sessions ADD COLUMN purpose TEXT NOT NULL DEFAULT 'memory' CHECK(purpose IN ('memory','page_title'))",
    );
  if (!columns.some((column) => column.name === "guideProfile"))
    db.exec("ALTER TABLE almanac_sessions ADD COLUMN guideProfile TEXT");
  const creationColumns = db.prepare("PRAGMA table_info(almanac_creation_requests)").all();
  if (!creationColumns.some(column => column.name === "historicalProjectId"))
    db.exec("ALTER TABLE almanac_creation_requests ADD COLUMN historicalProjectId TEXT");
  db.exec("UPDATE almanac_creation_requests SET historicalProjectId=projectId WHERE historicalProjectId IS NULL AND projectId IS NOT NULL");
}
