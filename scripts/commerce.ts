import { Store } from "../src/server/store.js";
import { migrateCommerce } from "../src/server/commerce/schema.js";
import {
  commerceConfig,
  readiness,
  fulfillmentReadiness,
} from "../src/server/commerce/config.js";
import {
  reconcilePrint,
  recoverCheckout,
  reconcileRefund,
} from "../src/server/commerce/service.js";
const s = new Store(process.env.DATA_DIR ?? ".data");
migrateCommerce(s);
try {
  const [command, orderId, providerId] = process.argv.slice(2),
    c = commerceConfig(s.dir);
  if (command === "status")
    console.log(
      JSON.stringify({
        ready: readiness(c).length === 0,
        fulfillmentReady: fulfillmentReadiness(c).length === 0,
        fulfillmentReasons: fulfillmentReadiness(c),
        reasons: readiness(c),
        mode: c.mode,
        publicOrigin: c.origin,
      }),
    );
  else if (command === "reconcile-print" && orderId && providerId)
    console.log(
      JSON.stringify(await reconcilePrint(s, orderId, providerId, c)),
    );
  else if (command === "reconcile-payment" && orderId)
    console.log(
      JSON.stringify(await recoverCheckout(s, orderId, c, fetch, providerId)),
    );
  else if (command === "reconcile-refund" && orderId)
    console.log(
      JSON.stringify(await reconcileRefund(s, orderId, c, fetch, providerId)),
    );
  else
    throw new Error(
      "Use commerce status, reconcile-payment ORDER_ID [SESSION_ID], reconcile-print ORDER_ID PROVIDER_ORDER_ID or reconcile-refund ORDER_ID [REFUND_ID].",
    );
} catch {
  console.error(
    "Commerce action could not complete. No new payment or print order was created.",
  );
  process.exitCode = 1;
} finally {
  s.close();
}
