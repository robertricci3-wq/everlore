import express, {
  type Express,
  type Request,
  type RequestHandler,
} from "express";
import { z } from "zod";
import type { Store } from "../store.js";
import { now, id, hash } from "../store.js";
import { isRecoveryLocked } from "../recovery-lock.js";
import { verifyStripeEvent } from "../payments/checkout.js";
import { commerceConfig, readiness, type CommerceSettings } from "./config.js";
import {
  migrateCommerce,
  recoverInterruptedCommerce,
  type OrderRow,
} from "./schema.js";
import {
  latestPrintBundle,
  loadPrintBundle,
  renderPrintPreview,
} from "./print.js";
import {
  startOrder,
  order,
  view,
  reconcilePayment,
  printBytes,
  refreshShipping,
  recoverCheckout,
  renewCheckout,
  reconcilePrint,
  refundOrder,
  reconcileRefund,
  prepareProductPrint,
} from "./service.js";
export function installCommercePublic(
  app: Express,
  s: Store,
  config: () => CommerceSettings = () => commerceConfig(s.dir),
  request: typeof fetch = fetch,
) {
  migrateCommerce(s);
  // Restart never repeats a request whose paid outcome is unknown.
  recoverInterruptedCommerce(s);
  app.post(
    "/api/payments/stripe/webhook",
    express.raw({ type: "application/json", limit: "256kb" }),
    async (req, res) => {
      const c = config();
      let event;
      try {
        event = verifyStripeEvent(
          req.body,
          req.get("stripe-signature") ?? "",
          c.webhookSecret,
        );
      } catch {
        return void res
          .status(400)
          .json({ error: "Invalid payment notification." });
      }
      if (event.livemode !== (c.mode === "live"))
        return void res
          .status(400)
          .json({ error: "Payment environment mismatch." });
      if (
        ![
          "checkout.session.completed",
          "checkout.session.async_payment_succeeded",
          "checkout.session.expired",
          "charge.refunded",
        ].includes(event.type)
      )
        return void res.json({ received: true });
      if (s.one("SELECT id FROM payment_events WHERE id=?", event.id))
        return void res.json({ received: true });
      try {
        if (event.type === "charge.refunded") {
          const charge = z
            .object({ payment_intent: z.string().nullable() })
            .parse(event.data.object);
          const o = charge.payment_intent
            ? s.one<OrderRow>(
                "SELECT * FROM book_orders WHERE paymentIntent=?",
                charge.payment_intent,
              )
            : null;
          if (!o) return void res.json({ received: true });
          await reconcilePayment(s, o.id, c, request);
          s.run(
            "INSERT OR IGNORE INTO payment_events VALUES(?,?,?)",
            event.id,
            o.id,
            now(),
          );
          return void res.json({ received: true });
        }
        const data = z
          .object({
            id: z.string(),
            metadata: z.object({ orderId: z.string().uuid() }),
          })
          .parse(event.data.object);
        await reconcilePayment(s, data.metadata.orderId, c, request, data.id);
        s.run(
          "INSERT OR IGNORE INTO payment_events VALUES(?,?,?)",
          event.id,
          data.metadata.orderId,
          now(),
        );
        res.json({ received: true });
      } catch {
        res.status(503).json({
          error:
            "Payment reconciliation pending. Please retry this notification.",
        });
      }
    },
  );
  app.get("/api/print-assets/:orderId/:digest", (req, res) => {
    try {
      const bytes = printBytes(
        s,
        String(req.params.orderId),
        String(req.params.digest),
        Number(req.query.expires),
        String(req.query.token ?? ""),
        config(),
      );
      res.set("Cache-Control", "no-store").type("pdf").send(bytes);
    } catch {
      res.status(404).json({ error: "Print asset unavailable." });
    }
  });
}
export function installCommerceRoutes(
  app: Express,
  s: Store,
  auth: RequestHandler,
  owner: (req: Request) => { id: string },
  config: () => CommerceSettings = () => commerceConfig(s.dir),
) {
  app.get("/api/orders", auth, (req, res) => {
    res.json(
      s
        .all<OrderRow>(
          "SELECT * FROM book_orders WHERE ownerId=? ORDER BY createdAt DESC",
          owner(req).id,
        )
        .map(view),
    );
  });
  const owned = (req: Request) => {
    const p = s.one<{ id: string }>(
      "SELECT id FROM projects WHERE id=? AND ownerId=?",
      String(req.params.id),
      owner(req).id,
    );
    if (!p) throw new Error("Book unavailable.");
    return p.id;
  };
  app.get(
    "/api/projects/:id/editions/:editionId/purchase",
    auth,
    (req, res) => {
      const pid = owned(req),
        eid = String(req.params.editionId);
      if (
        !s.one("SELECT id FROM editions WHERE id=? AND projectId=?", eid, pid)
      )
        return void res
          .status(404)
          .json({ error: "Saved edition unavailable." });
      const c = config(),
        bundle = latestPrintBundle(s, eid),
        o = s.one<OrderRow>(
          "SELECT * FROM book_orders WHERE editionId=? AND ownerId=?",
          eid,
          owner(req).id,
        );
      res.json({
        reasons: [
          ...(isRecoveryLocked(s)
            ? ["Ordering is paused while this restored service is reconciled."]
            : []),
          ...readiness(c),
        ],
        priceCents: c.priceCents || null,
        currency: "USD",
        shippingIncluded: true,
        format: "210 mm square hardcover · 32 interior pages",
        bundle,
        order: o ? view(o) : null,
      });
    },
  );
  app.post(
    "/api/projects/:id/editions/:editionId/prepare-print",
    auth,
    async (req, res) => {
      const p = owned(req);
      try {
        res.json(
          await prepareProductPrint(
            s,
            p,
            String(req.params.editionId),
            config(),
          ),
        );
      } catch {
        res.status(409).json({
          error:
            "The configured product could not be verified for this edition. Its digital book remains available.",
        });
      }
    },
  );
  app.get(
    "/api/projects/:id/print/:bundleId/preview/:page",
    auth,
    async (req, res) => {
      try {
        const pid = owned(req),
          bundle = loadPrintBundle(s, String(req.params.bundleId)),
          page = Number(req.params.page);
        if (
          bundle.projectId !== pid ||
          bundle.version !== 2 ||
          !Number.isInteger(page)
        )
          throw new Error("Preview unavailable");
        res
          .set("Cache-Control", "no-store")
          .type("png")
          .send(await renderPrintPreview(s, bundle, page));
      } catch {
        res.status(404).json({ error: "Print preview unavailable." });
      }
    },
  );
  app.get("/api/projects/:id/print/:bundleId/pdf", auth, (req, res) => {
    try {
      const pid = owned(req),
        bundle = loadPrintBundle(s, String(req.params.bundleId));
      if (bundle.projectId !== pid) throw new Error("Print unavailable");
      const bytes = s.readAsset(pid, bundle.pdfHash);
      if (hash(bytes) !== bundle.pdfHash)
        throw new Error("Print integrity failure");
      res.set("Cache-Control", "no-store").type("pdf").send(bytes);
    } catch {
      res.status(404).json({ error: "Print file unavailable." });
    }
  });
  app.post(
    "/api/projects/:id/editions/:editionId/checkout",
    auth,
    async (req, res) => {
      try {
        res.json(
          await startOrder(
            s,
            owner(req).id,
            owned(req),
            String(req.params.editionId),
            config(),
          ),
        );
      } catch {
        res.status(409).json({
          error:
            "This edition is not ready for checkout. Check its print preparation and store setup.",
        });
      }
    },
  );
  app.get("/api/orders/:orderId", auth, (req, res) => {
    try {
      res.json(view(order(s, String(req.params.orderId), owner(req).id)));
    } catch {
      res.status(404).json({ error: "Order unavailable." });
    }
  });
  app.post("/api/orders/:orderId/refresh", auth, async (req, res) => {
    try {
      const o = order(s, String(req.params.orderId), owner(req).id),
        c = config();
      if (
        ["awaiting_payment", "needs_attention", "checkout_expired"].includes(
          o.status,
        ) &&
        !o.recipient
      )
        await recoverCheckout(s, o.id, c);
      if (["submitted", "provider_failed"].includes(o.status))
        await refreshShipping(s, o.id, c);
      res.json(view(order(s, o.id)));
    } catch {
      res.status(503).json({
        error:
          "We could not refresh this order yet. Its saved state is unchanged.",
      });
    }
  });
  app.post("/api/orders/:orderId/renew-checkout", auth, async (req, res) => {
    try {
      res.json(
        await renewCheckout(
          s,
          String(req.params.orderId),
          owner(req).id,
          config(),
        ),
      );
    } catch {
      res.status(409).json({
        error:
          "We must verify that every earlier checkout expired unpaid before opening another.",
      });
    }
  });
  app.post("/api/orders/:orderId/support", auth, (req, res) => {
    try {
      const o = order(s, String(req.params.orderId), owner(req).id);
      const body = z
        .object({ message: z.string().trim().min(10).max(2000) })
        .parse(req.body);
      const prior = s.one<{ id: string }>(
        "SELECT id FROM order_support WHERE orderId=? AND ownerId=? AND message=? AND status='open'",
        o.id,
        owner(req).id,
        body.message,
      );
      if (prior) return void res.json({ id: prior.id, status: "open" });
      const tid = id();
      s.run(
        "INSERT INTO order_support VALUES(?,?,?,?,'open',?,?)",
        tid,
        o.id,
        owner(req).id,
        body.message,
        now(),
        now(),
      );
      res.json({ id: tid, status: "open" });
    } catch {
      res.status(400).json({
        error:
          "Please include 10–2,000 characters about the order you need help with.",
      });
    }
  });
}

export function installCommerceOperatorRoutes(
  app: Express,
  s: Store,
  operator: RequestHandler,
  config: () => CommerceSettings = () => commerceConfig(s.dir),
  request: typeof fetch = fetch,
) {
  app.get("/api/operator/orders", operator, (_req, res) => {
    res.json({
      orders: s
        .all<OrderRow>(
          "SELECT * FROM book_orders ORDER BY createdAt DESC LIMIT 200",
        )
        .map((o) => ({
          ...view(o),
          providerId: o.providerId,
          attempts: s.all(
            "SELECT id,sequence,status,sessionId,error,createdAt FROM checkout_attempts WHERE orderId=? ORDER BY sequence",
            o.id,
          ),
          refund:
            s.one(
              "SELECT id,status,amountCents,reason,providerId,error FROM order_refunds WHERE orderId=?",
              o.id,
            ) ?? null,
        })),
      support: s.all(
        "SELECT id,orderId,message,status,createdAt FROM order_support WHERE status='open' ORDER BY createdAt LIMIT 200",
      ),
    });
  });
  app.post(
    "/api/operator/orders/:orderId/reconcile",
    operator,
    async (req, res) => {
      try {
        const body = z
          .object({
            kind: z.enum(["payment", "print", "shipping", "refund"]),
            providerId: z.string().max(200).optional(),
          })
          .parse(req.body);
        const oid = String(req.params.orderId),
          c = config();
        if (body.kind === "payment")
          await recoverCheckout(
            s,
            oid,
            c,
            request,
            body.providerId || undefined,
          );
        else if (body.kind === "print")
          await reconcilePrint(
            s,
            oid,
            z.string().min(1).parse(body.providerId),
            c,
            request,
          );
        else if (body.kind === "shipping")
          await refreshShipping(s, oid, c, request);
        else
          await reconcileRefund(
            s,
            oid,
            c,
            request,
            body.providerId || undefined,
          );
        res.json(view(order(s, oid)));
      } catch {
        res.status(409).json({
          error:
            "The provider record could not be reconciled. No replacement payment or print request was made.",
        });
      }
    },
  );
  app.post(
    "/api/operator/orders/:orderId/refund",
    operator,
    async (req, res) => {
      try {
        const body = z
          .object({
            reason: z.string().trim().min(1).max(1000),
            confirm: z.literal(true),
          })
          .parse(req.body);
        res.json(
          await refundOrder(
            s,
            String(req.params.orderId),
            body.reason,
            config(),
            request,
          ),
        );
      } catch {
        res.status(409).json({
          error:
            "Refund is not available. Reconcile the existing payment and printing outcome first.",
        });
      }
    },
  );
  app.post("/api/operator/support/:ticketId/resolve", operator, (req, res) => {
    s.run(
      "UPDATE order_support SET status='resolved',updatedAt=? WHERE id=?",
      now(),
      String(req.params.ticketId),
    );
    res.json({ ok: true });
  });
}
