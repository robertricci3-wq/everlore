import { backup, DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync, lstatSync, chmodSync, renameSync, rmSync } from "node:fs";
import { resolve, join, relative, isAbsolute, dirname } from "node:path";
import { z } from "zod";
import { hash, id, now, type Store } from "./store.js";

const privateFiles = ["studio-connection.json", "stripe-connection.json", "prodigi-connection.json"];
const Manifest = z.object({
  version: z.literal(1), createdAt: z.string(),
  files: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative() })).min(1),
});
function allowed(path: string) {
  return path === "evermore.sqlite" || privateFiles.includes(path) || /^media\/[a-f0-9]{64}$/.test(path);
}
function fileBytes(root: string, path: string) {
  if (!allowed(path)) throw new Error("Backup contains an invalid file path.");
  const full = join(root, path);
  if (!lstatSync(full).isFile() || lstatSync(full).isSymbolicLink()) throw new Error("Backup contains an unsupported file.");
  if (path.startsWith("media/") && lstatSync(join(root, "media")).isSymbolicLink()) throw new Error("Backup media cannot be a symbolic link.");
  return readFileSync(full);
}
function referencedMedia(db: DatabaseSync) {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(x => x.name));
  const hashes = new Set<string>();
  for (const table of ["assets", "family_assets"])
    if (tables.has(table)) for (const r of db.prepare(`SELECT DISTINCT hash FROM ${table}`).all() as {hash:string}[]) hashes.add(r.hash);
  return [...hashes].sort();
}
function checkDatabase(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const result = db.prepare("PRAGMA integrity_check").all();
    if (result.length !== 1 || Object.values(result[0])[0] !== "ok" || db.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("Backup database integrity check failed.");
    return referencedMedia(db);
  } finally { db.close(); }
}
export function verifyBackup(directory: string) {
  const root = resolve(directory);
  if (lstatSync(root).isSymbolicLink()) throw new Error("Backup directory cannot be a symbolic link.");
  const manifest = Manifest.parse(JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")));
  const seen = new Set<string>();
  for (const f of manifest.files) {
    if (seen.has(f.path)) throw new Error("Duplicate backup file.");
    seen.add(f.path);
    const bytes = fileBytes(root, f.path);
    if (bytes.length !== f.bytes || hash(bytes) !== f.sha256) throw new Error("Backup file integrity check failed.");
  }
  if (!seen.has("evermore.sqlite")) throw new Error("Backup database is missing.");
  for (const digest of checkDatabase(join(root, "evermore.sqlite"))) {
    if (!seen.has(`media/${digest}`) || hash(fileBytes(root, `media/${digest}`)) !== digest)
      throw new Error("Backup referenced media is missing or invalid.");
  }
  return manifest;
}
export async function createBackup(store: Store, destination: string) {
  const target = resolve(destination), fromSource = relative(store.dir, target);
  if (!fromSource || (!fromSource.startsWith("..") && !isAbsolute(fromSource))) throw new Error("Choose a backup destination outside the active data directory.");
  if (existsSync(target)) throw new Error("Backup destination already exists.");
  const stage = `${target}.${id()}.partial`;
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  try {
    await backup(store.db, join(stage, "evermore.sqlite"));
    chmodSync(join(stage, "evermore.sqlite"), 0o600);
    const media = checkDatabase(join(stage, "evermore.sqlite"));
    mkdirSync(join(stage, "media"), { mode: 0o700 });
    const paths = ["evermore.sqlite", ...media.map(x => `media/${x}`)];
    for (const path of [...paths.slice(1), ...privateFiles.filter(f => existsSync(join(store.dir, f)))]) {
      const bytes = fileBytes(store.dir, path);
      if (path.startsWith("media/") && hash(bytes) !== path.slice(6)) throw new Error("Source media integrity check failed.");
      writeFileSync(join(stage, path), bytes, { flag: "wx", mode: 0o600 });
      if (!paths.includes(path)) paths.push(path);
    }
    const manifest = { version: 1, createdAt: now(), files: paths.map(path => { const bytes = readFileSync(join(stage, path)); return {path, sha256: hash(bytes), bytes: bytes.length}; }) };
    writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    verifyBackup(stage);
    renameSync(stage, target);
    return { path: target, files: paths.length, createdAt: manifest.createdAt };
  } catch (e) { rmSync(stage, { recursive: true, force: true }); throw e; }
}
export function restoreBackup(source: string, destination: string) {
  const manifest = verifyBackup(source), target = resolve(destination);
  if (existsSync(target)) throw new Error("Restore requires a new data directory; existing family work is never overwritten.");
  const stage = `${target}.${id()}.partial`;
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  try {
    for (const f of manifest.files) {
      mkdirSync(dirname(join(stage, f.path)), { recursive: true, mode: 0o700 });
      // Recheck during the copy so a changed backup cannot pass validation then be substituted.
      const bytes = fileBytes(resolve(source), f.path);
      if (hash(bytes) !== f.sha256) throw new Error("Backup changed during restore.");
      writeFileSync(join(stage, f.path), bytes, { mode: 0o600 });
    }
    copyFileSync(join(source, "manifest.json"), join(stage, "manifest.json"));
    verifyBackup(stage);
    rmSync(join(stage, "manifest.json"));
    const restored = new DatabaseSync(join(stage, "evermore.sqlite"));
    try {
      restored.exec("CREATE TABLE IF NOT EXISTS recovery_locks(id TEXT PRIMARY KEY,restoredAt TEXT NOT NULL,snapshotAt TEXT NOT NULL,releasedAt TEXT,evidence TEXT)");
      restored.prepare("INSERT INTO recovery_locks VALUES(?,?,?,NULL,NULL)").run(id(), now(), manifest.createdAt);
    } finally { restored.close(); }
    renameSync(stage, target);
    return { path: target, files: manifest.files.length, requiresReconciliation: true };
  } catch (e) { rmSync(stage, { recursive: true, force: true }); throw e; }
}
