import { Store } from "../src/server/store.js";
import { isRecoveryLocked, releaseRecoveryLock } from "../src/server/recovery-lock.js";
import {
  createOperator,
  setOperator,
  operatorId,
} from "../src/server/access.js";
const store = new Store(process.env.DATA_DIR ?? ".data");
try {
  const [command, name] = process.argv.slice(2);
  if (command === "create" && name) {
    createOperator(store, name, process.env.EVERLORE_OPERATOR_PASSWORD ?? "");
    console.log(
      "Operator created. Remove EVERLORE_OPERATOR_PASSWORD from the environment after provisioning.",
    );
  } else if (command === "set" && name) {
    const user = store.one<{ id: string }>(
      "SELECT id FROM users WHERE name=? AND kind='private'",
      name.toLowerCase(),
    );
    if (!user) throw new Error("Choose an existing private shelf name.");
    setOperator(store, user.id);
    console.log("Operator configured.");
  } else if (command === "release-recovery") {
    if (!operatorId(store)) throw new Error("Configure the operator first.");
    releaseRecoveryLock(store, process.argv.slice(3).join(" "));
    console.log("Recovery lock released; reconciliation evidence recorded.");
  } else if (command === "status")
    console.log(
      (operatorId(store) ? "Operator configured." : "Operator not configured.") +
      (isRecoveryLocked(store) ? " Restore recovery lock active; reconcile provider outcomes before release-recovery EVIDENCE." : ""),
    );
  else
    throw new Error(
      "Use: operator.ts create NAME (with EVERLORE_OPERATOR_PASSWORD), set NAME, or status.",
    );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Operator setup failed.",
  );
  process.exitCode = 1;
} finally {
  store.close();
}
