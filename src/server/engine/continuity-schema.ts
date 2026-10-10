import type { DatabaseSync } from "node:sqlite";

/** Private, additive continuity indexes. Books remain authoritative snapshots. */
export function migrateContinuity(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS continuity_people(
      id TEXT PRIMARY KEY, ownerId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, normalizedName TEXT NOT NULL, createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS continuity_people_owner_name ON continuity_people(ownerId,normalizedName);
    CREATE TABLE IF NOT EXISTS continuity_origins(
      ownerId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      originalId TEXT NOT NULL, personId TEXT NOT NULL REFERENCES continuity_people(id) ON DELETE CASCADE,
      PRIMARY KEY(ownerId,originalId)
    );
    CREATE TABLE IF NOT EXISTS continuity_indexed_versions(
      familyVersionId TEXT PRIMARY KEY REFERENCES family_versions(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS continuity_cast(
      familyVersionId TEXT NOT NULL REFERENCES family_versions(id) ON DELETE CASCADE,
      characterId TEXT NOT NULL, personId TEXT NOT NULL REFERENCES continuity_people(id) ON DELETE CASCADE,
      evidence TEXT NOT NULL, PRIMARY KEY(familyVersionId,characterId)
    );
    CREATE TABLE IF NOT EXISTS continuity_story_uses(
      projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, personId TEXT NOT NULL REFERENCES continuity_people(id) ON DELETE CASCADE,
      familyVersionId TEXT NOT NULL REFERENCES family_versions(id) ON DELETE CASCADE,
      characterId TEXT NOT NULL, PRIMARY KEY(projectId,revision,personId)
    );
  `);
}
