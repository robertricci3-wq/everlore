import { Store } from "../src/server/store.js";
import { createBackup, verifyBackup, restoreBackup } from "../src/server/backup.js";
const [action, source, destination] = process.argv.slice(2);
try {
  if (action === "verify" && source) {
    const result = verifyBackup(source);
    console.log(JSON.stringify({ verified: true, files: result.files.length, createdAt: result.createdAt }));
  } else if (action === "restore" && source && destination) {
    console.log(JSON.stringify(restoreBackup(source, destination)));
    console.log("Restore verified and locked. Reconcile provider outcomes, then record evidence using operator.ts release-recovery before enabling work.");
  } else if (action === "create" && source && destination) {
    const s = new Store(source);
    try { console.log(JSON.stringify(await createBackup(s, destination))); } finally { s.close(); }
  } else throw new Error("Usage: backup create DATA_DIR BACKUP_DIR | verify BACKUP_DIR | restore BACKUP_DIR NEW_DATA_DIR");
} catch {
  console.error("Backup operation failed. Check paths, permissions and integrity; no existing data was replaced.");
  process.exitCode = 1;
}
