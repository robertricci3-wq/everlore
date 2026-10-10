import type { DatabaseSync } from "node:sqlite";
import { migrateMemoryLab } from "./memory-schema.js";
export function migrateLab(db: DatabaseSync) {
  db.exec(`
CREATE TABLE IF NOT EXISTS lab_sessions(id TEXT PRIMARY KEY,ownerId TEXT NOT NULL REFERENCES users(id),plan TEXT NOT NULL,status TEXT NOT NULL,iteration INTEGER NOT NULL,noProgress INTEGER NOT NULL,currentExperiment TEXT,checkpoint TEXT NOT NULL,createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lab_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lab_profiles(hash TEXT PRIMARY KEY,body TEXT NOT NULL,createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lab_principles(id TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(id,version));
CREATE TABLE IF NOT EXISTS lab_cases(id TEXT PRIMARY KEY,ownerId TEXT,body TEXT NOT NULL,createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lab_experiments(id TEXT PRIMARY KEY,ownerId TEXT NOT NULL REFERENCES users(id),plan TEXT NOT NULL,planHash TEXT NOT NULL,status TEXT NOT NULL,maxCents INTEGER NOT NULL DEFAULT 0,authorization TEXT,engineering TEXT NOT NULL DEFAULT 'pending',error TEXT,canon TEXT,createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lab_runs(id TEXT PRIMARY KEY,experimentId TEXT NOT NULL REFERENCES lab_experiments(id),caseId TEXT NOT NULL,replicate INTEGER NOT NULL,arm TEXT NOT NULL,side TEXT NOT NULL,status TEXT NOT NULL,stage TEXT NOT NULL DEFAULT 'queued',projectId TEXT REFERENCES projects(id),jobId TEXT,leaseToken TEXT,leaseUntil INTEGER NOT NULL DEFAULT 0,output TEXT,error TEXT,UNIQUE(experimentId,caseId,replicate,arm));
CREATE TABLE IF NOT EXISTS lab_steps(runId TEXT NOT NULL REFERENCES lab_runs(id),stage TEXT NOT NULL,inputHash TEXT NOT NULL,state TEXT NOT NULL,result TEXT,PRIMARY KEY(runId,stage));
CREATE TABLE IF NOT EXISTS lab_calls(id TEXT PRIMARY KEY,runId TEXT NOT NULL REFERENCES lab_runs(id),stage TEXT NOT NULL,kind TEXT NOT NULL,model TEXT NOT NULL,status TEXT NOT NULL,requestHash TEXT NOT NULL,requestId TEXT,usage TEXT,latencyMs INTEGER,estimatedCents INTEGER NOT NULL,actualCents INTEGER,createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lab_observations(id TEXT PRIMARY KEY,experimentId TEXT NOT NULL REFERENCES lab_experiments(id),body TEXT NOT NULL,createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lab_comparisons(experimentId TEXT NOT NULL REFERENCES lab_experiments(id),pairKey TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(experimentId,pairKey));
CREATE TABLE IF NOT EXISTS lab_releases(id TEXT PRIMARY KEY,experimentId TEXT REFERENCES lab_experiments(id),action TEXT NOT NULL,profileHash TEXT NOT NULL,previousHash TEXT NOT NULL,notes TEXT NOT NULL,createdAt TEXT NOT NULL);
`);
  migrateMemoryLab(db);
}
