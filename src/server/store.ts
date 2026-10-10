import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  writeFileSync,
  renameSync,
  readFileSync,
  existsSync,
  unlinkSync,
  chmodSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { migrateLab } from "./lab/schema.js";
import { migrateContinuity } from "./engine/continuity-schema.js";
import { forgetProjectContinuity } from "./engine/continuity.js";
import { migrateAlmanac } from "./almanac/schema.js";
import { migrateFeedback } from "./feedback.js";
import { migratePilot } from "./pilot/schema.js";

export function hash(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export class Store {
  db: DatabaseSync;
  dir: string;
  constructor(dir: string) {
    this.dir = resolve(dir);
    mkdirSync(join(this.dir, "media"), { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    this.db = new DatabaseSync(join(this.dir, "evermore.sqlite"), {
      timeout: 5000,
    });
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,password TEXT NOT NULL,kind TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(tokenHash TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,ownerId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,title TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,transcript TEXT,consentAt TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recordings(id TEXT PRIMARY KEY,projectId TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,assetHash TEXT NOT NULL,mime TEXT NOT NULL,bytes INTEGER NOT NULL,captureMode TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assets(hash TEXT NOT NULL,projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,kind TEXT NOT NULL,PRIMARY KEY(hash,projectId));
      CREATE TABLE IF NOT EXISTS revisions(projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,revision INTEGER NOT NULL,book TEXT NOT NULL,contentHash TEXT NOT NULL,PRIMARY KEY(projectId,revision));
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,inputHash TEXT NOT NULL,baseRevision INTEGER NOT NULL,status TEXT NOT NULL,stage TEXT NOT NULL,attempt INTEGER NOT NULL DEFAULT 0,leaseUntil INTEGER NOT NULL DEFAULT 0,leaseToken TEXT,error TEXT,UNIQUE(projectId,inputHash));
      CREATE TABLE IF NOT EXISTS stage_results(jobId TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,stage TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(jobId,stage));
      CREATE TABLE IF NOT EXISTS editions(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,revision INTEGER NOT NULL,contentHash TEXT NOT NULL,pdfHash TEXT NOT NULL,book TEXT NOT NULL,createdAt TEXT NOT NULL,UNIQUE(projectId,revision));
      CREATE TABLE IF NOT EXISTS edits(projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,key TEXT NOT NULL,requestHash TEXT NOT NULL,resultRevision INTEGER NOT NULL,PRIMARY KEY(projectId,key));
      CREATE TABLE IF NOT EXISTS corrections(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,baseRevision INTEGER NOT NULL,kind TEXT NOT NULL,detail TEXT NOT NULL,spreadId TEXT,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS engine_runs(id TEXT PRIMARY KEY,projectId TEXT UNIQUE NOT NULL REFERENCES projects(id) ON DELETE CASCADE,baseRevision INTEGER NOT NULL,status TEXT NOT NULL,stage TEXT NOT NULL,consent TEXT NOT NULL,profile TEXT NOT NULL,allowance INTEGER NOT NULL,leaseUntil INTEGER NOT NULL DEFAULT 0,leaseToken TEXT,error TEXT,transcript TEXT,sourceApproved INTEGER NOT NULL DEFAULT 0,artApproved INTEGER NOT NULL DEFAULT 0,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS engine_steps(runId TEXT NOT NULL REFERENCES engine_runs(id) ON DELETE CASCADE,stage TEXT NOT NULL,state TEXT NOT NULL,result TEXT,PRIMARY KEY(runId,stage));
      CREATE TABLE IF NOT EXISTS studio_jobs(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,baseRevision INTEGER NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,stage TEXT NOT NULL,request TEXT NOT NULL,state TEXT NOT NULL,profile TEXT NOT NULL,allowance INTEGER NOT NULL,leaseUntil INTEGER NOT NULL DEFAULT 0,leaseToken TEXT,error TEXT,createdAt TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS studio_one_active ON studio_jobs(projectId) WHERE status NOT IN ('complete','superseded');
      CREATE TABLE IF NOT EXISTS studio_steps(jobId TEXT NOT NULL REFERENCES studio_jobs(id) ON DELETE CASCADE,stage TEXT NOT NULL,inputHash TEXT NOT NULL,state TEXT NOT NULL,result TEXT,PRIMARY KEY(jobId,stage));
      CREATE TABLE IF NOT EXISTS studio_calls(id TEXT PRIMARY KEY,jobId TEXT NOT NULL REFERENCES studio_jobs(id) ON DELETE CASCADE,stage TEXT NOT NULL,kind TEXT NOT NULL,model TEXT NOT NULL,requestHash TEXT NOT NULL,status TEXT NOT NULL,latencyMs INTEGER,requestId TEXT,usage TEXT,estimatedCents INTEGER NOT NULL,actualCents INTEGER,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS studio_approvals(jobId TEXT NOT NULL REFERENCES studio_jobs(id) ON DELETE CASCADE,gate TEXT NOT NULL,inputHash TEXT NOT NULL,payload TEXT NOT NULL,createdAt TEXT NOT NULL,PRIMARY KEY(jobId,gate));
      CREATE TABLE IF NOT EXISTS family_versions(id TEXT PRIMARY KEY,ownerId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,world TEXT NOT NULL,referenceData TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS family_assets(familyId TEXT NOT NULL REFERENCES family_versions(id) ON DELETE CASCADE,hash TEXT NOT NULL,PRIMARY KEY(familyId,hash));
      CREATE TABLE IF NOT EXISTS engine_budget(runId TEXT PRIMARY KEY,allowance INTEGER NOT NULL,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery_locks(id TEXT PRIMARY KEY,restoredAt TEXT NOT NULL,snapshotAt TEXT NOT NULL,releasedAt TEXT,evidence TEXT);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS studio_call_failures(callId TEXT PRIMARY KEY REFERENCES studio_calls(id) ON DELETE CASCADE,details TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS studio_connection_checks(keyHash TEXT PRIMARY KEY,failure TEXT,checkedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS studio_recoveries(id TEXT PRIMARY KEY,jobId TEXT NOT NULL REFERENCES studio_jobs(id) ON DELETE CASCADE,callId TEXT NOT NULL UNIQUE,stage TEXT NOT NULL,uncertain INTEGER NOT NULL,extraReserve INTEGER NOT NULL,createdAt TEXT NOT NULL);
    `);
    migrateLab(this.db);
    migrateAlmanac(this.db);
    migrateContinuity(this.db);
    migrateFeedback(this.db);
    migratePilot(this.db);
  }
  one<T>(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
  all<T>(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).all(...params) as T[];
  }
  run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  putAsset(projectId: string, data: Uint8Array | string, kind: string) {
    const digest = hash(data),
      path = join(this.dir, "media", digest);
    if (!existsSync(path)) {
      const temp = `${path}.${id()}.tmp`,
        fd = openSync(temp, "wx", 0o600);
      try {
        writeFileSync(fd, data);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, path);
      const parent = openSync(join(this.dir, "media"), "r");
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
    }
    if (hash(readFileSync(path)) !== digest)
      throw new Error("Stored asset hash mismatch");
    this.run(
      "INSERT OR IGNORE INTO assets VALUES(?,?,?)",
      digest,
      projectId,
      kind,
    );
    return digest;
  }
  readAsset(projectId: string, digest: string) {
    if (
      !/^[a-f0-9]{64}$/.test(digest) ||
      !this.one(
        "SELECT hash FROM assets WHERE projectId=? AND hash=?",
        projectId,
        digest,
      )
    )
      throw new Error("Asset unavailable");
    const bytes = readFileSync(join(this.dir, "media", digest));
    if (hash(bytes) !== digest) throw new Error("Asset integrity failure");
    return bytes;
  }
  deleteProject(projectId: string) {
    const assets = this.all<{ hash: string }>(
      "SELECT hash FROM assets WHERE projectId=?",
      projectId,
    );
    this.transaction(() => {
      // Preserve potentially billed attempts, not unused whole-book ceilings,
      // before the project's private job/call records cascade away.
      this.run(
        `UPDATE engine_budget SET allowance=(
        SELECT COALESCE(SUM(estimatedCents),0) FROM studio_calls
        WHERE jobId=engine_budget.runId AND status!='rejected'
      ) WHERE runId IN (SELECT id FROM studio_jobs WHERE projectId=?)`,
        projectId,
      );
      forgetProjectContinuity(this, projectId);
      this.run("DELETE FROM projects WHERE id=?", projectId);
    });
    for (const asset of assets)
      if (
        !this.one("SELECT hash FROM assets WHERE hash=?", asset.hash) &&
        !this.one("SELECT hash FROM family_assets WHERE hash=?", asset.hash)
      ) {
        const path = join(this.dir, "media", asset.hash);
        if (existsSync(path)) unlinkSync(path);
      }
  }
  close() {
    this.db.close();
  }
}
export interface ProjectRow {
  id: string;
  ownerId: string;
  title: string;
  mode: string;
  status: string;
  revision: number;
  transcript: string | null;
  consentAt: string;
  createdAt: string;
}
export interface JobRow {
  id: string;
  projectId: string;
  inputHash: string;
  baseRevision: number;
  status: string;
  stage: string;
  attempt: number;
  leaseUntil: number;
  leaseToken: string | null;
  error: string | null;
}
