import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { AccessError, operatorId } from "../access.js";
import type { Store } from "../store.js";
import {
  bookCostReport,
  reconcileBilling,
  CostError,
  ensureCostRecords,
} from "./service.js";
export function installOperatorCostRoutes(
  app: Express,
  s: Store,
  operatorGuard: RequestHandler,
) {
  ensureCostRecords(s);
  app.get("/api/operator/costs", operatorGuard, (_req, res) => {
    try {
      res.json(bookCostReport(s, operatorId(s) ?? ""));
    } catch (error) {
      res
        .status(error instanceof AccessError ? error.status : 500)
        .json({
          error:
            error instanceof AccessError
              ? error.message
              : "Cost records could not be loaded.",
        });
    }
  });
  app.post("/api/operator/costs/reconciliations", operatorGuard, (req, res) => {
    try {
      res.json(reconcileBilling(s, operatorId(s) ?? "", req.body));
    } catch (error) {
      res
        .status(
          error instanceof CostError || error instanceof AccessError
            ? error.status
            : error instanceof z.ZodError
              ? 400
              : 500,
        )
        .json({
          error:
            error instanceof CostError || error instanceof AccessError
              ? error.message
              : error instanceof z.ZodError
                ? "Provide a valid USD amount, evidence reference and verification date."
                : "Reconciliation could not be saved.",
        });
    }
  });
}
