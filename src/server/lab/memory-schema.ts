import type { DatabaseSync } from "node:sqlite";

export function migrateMemoryLab(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lab_memory_experiments(
      id TEXT PRIMARY KEY,ownerId TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL,plan TEXT NOT NULL,planHash TEXT NOT NULL,
      createdAt TEXT NOT NULL,error TEXT
    );
    CREATE TABLE IF NOT EXISTS lab_memory_runs(
      experimentId TEXT NOT NULL REFERENCES lab_memory_experiments(id),
      caseId TEXT NOT NULL,replicate INTEGER NOT NULL,arm TEXT NOT NULL,
      body TEXT NOT NULL,createdAt TEXT NOT NULL,
      PRIMARY KEY(experimentId,caseId,replicate,arm)
    );
  `);
}
