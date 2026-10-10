import { z } from "zod";
import { canonical, hash, id, now, type Store } from "../store.js";
import { requireOperator } from "../access.js";

export class CostError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function ensureCostRecords(s: Store) {
  // Deliberately not cascaded with projects: a source deletion must not erase a billing receipt.
  s.db.exec(`CREATE TABLE IF NOT EXISTS billing_reconciliations(
    id TEXT PRIMARY KEY,idempotencyKey TEXT NOT NULL UNIQUE,payloadHash TEXT NOT NULL,
    targetType TEXT NOT NULL,targetId TEXT NOT NULL,component TEXT NOT NULL,
    amountCents INTEGER NOT NULL,currency TEXT NOT NULL,sourceType TEXT NOT NULL,
    sourceReference TEXT NOT NULL,observedAt TEXT NOT NULL,recordedBy TEXT NOT NULL,
    supersedesId TEXT UNIQUE,createdAt TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS billing_target ON billing_reconciliations(targetType,targetId,component);`);
}
const ReconciliationInput = z
  .object({
    idempotencyKey: z.string().min(8).max(100),
    targetType: z.enum(["studio_call", "order"]),
    targetId: z.string().min(1).max(100),
    component: z.enum(["generation", "printing", "shipping", "payment_fee"]),
    amountCents: z.number().int().min(0).max(100000000),
    currency: z.literal("USD"),
    sourceType: z.enum(["invoice", "provider_statement", "provider_dashboard"]),
    sourceReference: z.string().trim().min(3).max(500),
    observedAt: z.iso.datetime(),
    verified: z.literal(true),
    supersedesId: z.string().min(1).max(100).nullable().default(null),
  })
  .strict();
export interface Reconciliation {
  id: string;
  targetType: "studio_call" | "order";
  targetId: string;
  component: "generation" | "printing" | "shipping" | "payment_fee";
  amountCents: number;
  currency: "USD";
  sourceType: string;
  sourceReference: string;
  observedAt: string;
  recordedBy: string;
  supersedesId: string | null;
  createdAt: string;
}
export function reconcileBilling(
  s: Store,
  actor: string,
  input: unknown,
): Reconciliation {
  requireOperator(s, actor);
  const body = ReconciliationInput.parse(input),
    digest = hash(canonical(body));
  ensureCostRecords(s);
  return s.transaction(() => {
    const repeated = s.one<Reconciliation & { payloadHash: string }>(
      "SELECT * FROM billing_reconciliations WHERE idempotencyKey=?",
      body.idempotencyKey,
    );
    if (repeated) {
      if (repeated.payloadHash !== digest)
        throw new CostError(
          409,
          "This reconciliation key was already used for different evidence.",
        );
      return repeated;
    }
    const latest = s.one<Reconciliation>(
      `SELECT r.* FROM billing_reconciliations r WHERE targetType=? AND targetId=? AND component=? AND NOT EXISTS(SELECT 1 FROM billing_reconciliations n WHERE n.supersedesId=r.id)`,
      body.targetType,
      body.targetId,
      body.component,
    );
    if (body.targetType === "studio_call") {
      if (
        body.component !== "generation" ||
        (!latest &&
          !s.one("SELECT id FROM studio_calls WHERE id=?", body.targetId))
      )
        throw new CostError(400, "Choose an existing generation attempt.");
    } else if (
      body.component === "generation" ||
      !hasTable(s, "book_orders") ||
      (!latest &&
        !s.one("SELECT id FROM book_orders WHERE id=?", body.targetId))
    )
      throw new CostError(400, "Choose an existing order cost component.");
    if ((latest?.id ?? null) !== body.supersedesId)
      throw new CostError(
        409,
        "The current evidence changed. Reload before recording a correction.",
      );
    const record: Reconciliation = {
      id: id(),
      targetType: body.targetType,
      targetId: body.targetId,
      component: body.component,
      amountCents: body.amountCents,
      currency: body.currency,
      sourceType: body.sourceType,
      sourceReference: body.sourceReference,
      observedAt: body.observedAt,
      recordedBy: actor,
      supersedesId: body.supersedesId,
      createdAt: now(),
    };
    s.run(
      "INSERT INTO billing_reconciliations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      record.id,
      body.idempotencyKey,
      digest,
      record.targetType,
      record.targetId,
      record.component,
      record.amountCents,
      record.currency,
      record.sourceType,
      record.sourceReference,
      record.observedAt,
      record.recordedBy,
      record.supersedesId,
      record.createdAt,
    );
    return record;
  });
}
const hasTable = (s: Store, name: string) =>
  !!s.one("SELECT name FROM sqlite_master WHERE type='table' AND name=?", name);
function json(value: string | null): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(value || "null");
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
const money = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
export interface CallCost {
  id: string;
  stage: string;
  kind: string;
  model: string;
  status: string;
  createdAt: string;
  reservedCents: number;
  boundCents: number | null;
  boundRateCard: string | null;
  usageEstimateCents: number | null;
  usageRateCard: string | null;
  verifiedActualCents: number | null;
  actualSource: string | null;
  reconciliationId: string | null;
  legacyActualCents: number | null;
  unknownCharge: boolean;
  latencyMs: number | null;
  usage: Record<string, number>;
}
export interface CostTotals {
  reservedCents: number;
  requestReservationCents: number;
  usageEstimateCents: number;
  usageEstimatedAttempts: number;
  verifiedActualCents: number;
  verifiedAttempts: number;
  unknownChargeAttempts: number;
  attempts: number;
}
export interface JobCost {
  id: string;
  projectId: string;
  kind: string;
  status: string;
  stage: string;
  baseRevision: number;
  intendedRevision: number | null;
  createdAt: string;
  calls: CallCost[];
  totals: CostTotals;
}
export interface OrderCost {
  id: string;
  editionId: string;
  status: string;
  mode: string;
  merchandiseCents: number;
  collectedTaxCents: number | null;
  paidTotalCents: number | null;
  refundedCents: number;
  quoteEstimateCents: number | null;
  hasUnclassifiedProviderCharges: boolean;
  components: {
    component: "printing" | "shipping" | "payment_fee";
    verifiedActualCents: number | null;
    source: string | null;
    reconciliationId: string | null;
  }[];
}
export interface BookCostSummary {
  projectId: string;
  title: string;
  status: string;
  mode: string;
  revision: number;
  sourceSessionId: string | null;
  sourceProjectId: string | null;
  relatedBookIds: string[];
  jobs: JobCost[];
  editions: { id: string; revision: number; createdAt: string }[];
  orders: OrderCost[];
  totals: CostTotals;
  legacyRuns: { id: string; status: string; reservedCents: number }[];
}
export interface CostReport {
  version: 1;
  generatedAt: string;
  currency: "USD";
  books: BookCostSummary[];
  reconciliations: Reconciliation[];
  totals: CostTotals;
  unattributed: {
    reservations: { jobId: string; reservedCents: number }[];
    reconciliations: Reconciliation[];
  };
  metrics: {
    cohort: string;
    bookProjects: number;
    completedBooks: number;
    completionRate: number | null;
    activeOrIncompleteBooks: number;
    usageCost: {
      samples: number;
      medianCents: number | null;
      p90Cents: number | null;
    };
    actualCost: {
      samples: number;
      medianCents: number | null;
      p90Cents: number | null;
    };
    sampleDefinition: string;
  };
}
function totals(calls: CallCost[], reservedCents = 0): CostTotals {
  return {
    reservedCents,
    requestReservationCents: calls.reduce((n, c) => n + c.reservedCents, 0),
    usageEstimateCents: calls.reduce(
      (n, c) => n + (c.usageEstimateCents ?? 0),
      0,
    ),
    usageEstimatedAttempts: calls.filter((c) => c.usageEstimateCents !== null)
      .length,
    verifiedActualCents: calls.reduce(
      (n, c) => n + (c.verifiedActualCents ?? 0),
      0,
    ),
    verifiedAttempts: calls.filter((c) => c.verifiedActualCents !== null)
      .length,
    unknownChargeAttempts: calls.filter((c) => c.unknownCharge).length,
    attempts: calls.length,
  };
}
function distribution(values: number[]) {
  const a = [...values].sort((x, y) => x - y),
    n = a.length;
  return {
    samples: n,
    medianCents: n
      ? (a[Math.floor((n - 1) / 2)] + a[Math.floor(n / 2)]) / 2
      : null,
    p90Cents: n ? a[Math.ceil(n * 0.9) - 1] : null,
  };
}
/** Read-only financial projection: never settles budgets, retries work, or promotes estimates to bills. */
export function bookCostReport(s: Store, actor: string): CostReport {
  requireOperator(s, actor);
  ensureCostRecords(s);
  const reconciliations = s.all<Reconciliation>(
    "SELECT id,targetType,targetId,component,amountCents,currency,sourceType,sourceReference,observedAt,recordedBy,supersedesId,createdAt FROM billing_reconciliations ORDER BY createdAt,id",
  );
  const superseded = new Set(reconciliations.map((r) => r.supersedesId));
  const current = new Map(
    reconciliations
      .filter((r) => !superseded.has(r.id))
      .map((r) => [`${r.targetType}:${r.targetId}:${r.component}`, r]),
  );
  const bounds = new Map(
    hasTable(s, "studio_request_bounds")
      ? s
          .all<{ callId: string; body: string }>(
            "SELECT callId,body FROM studio_request_bounds",
          )
          .map((r) => [r.callId, json(r.body)])
      : [],
  );
  const meters = new Map(
    hasTable(s, "studio_metered_costs")
      ? s
          .all<{ callId: string; body: string }>(
            "SELECT callId,body FROM studio_metered_costs",
          )
          .map((r) => [r.callId, json(r.body)])
      : [],
  );
  const calls = s.all<{
    id: string;
    jobId: string;
    stage: string;
    kind: string;
    model: string;
    status: string;
    createdAt: string;
    estimatedCents: number;
    actualCents: number | null;
    latencyMs: number | null;
    usage: string | null;
  }>(
    "SELECT id,jobId,stage,kind,model,status,createdAt,estimatedCents,actualCents,latencyMs,usage FROM studio_calls ORDER BY rowid",
  );
  const callMap = new Map<string, CallCost[]>();
  for (const c of calls) {
    const r = current.get(`studio_call:${c.id}:generation`),
      bound = bounds.get(c.id),
      meter = meters.get(c.id);
    const usage = Object.fromEntries(
      Object.entries(json(c.usage)).filter(
        ([key, value]) =>
          ["input_tokens", "output_tokens", "total_tokens", "seconds"].includes(
            key,
          ) &&
          typeof value === "number" &&
          Number.isFinite(value) &&
          value >= 0,
      ),
    ) as Record<string, number>;
    const row: CallCost = {
      id: c.id,
      stage: c.stage,
      kind: c.kind,
      model: c.model,
      status: c.status,
      createdAt: c.createdAt,
      reservedCents: c.status === "rejected" ? 0 : c.estimatedCents,
      boundCents: money(bound?.maxCostCents),
      boundRateCard:
        typeof bound?.rateCardVersion === "string"
          ? bound.rateCardVersion
          : null,
      usageEstimateCents: money(meter?.estimatedCostCents),
      usageRateCard:
        typeof meter?.rateCardVersion === "string"
          ? meter.rateCardVersion
          : null,
      verifiedActualCents: r?.amountCents ?? null,
      actualSource: r ? `${r.sourceType}: ${r.sourceReference}` : null,
      reconciliationId: r?.id ?? null,
      legacyActualCents: c.actualCents,
      unknownCharge: c.status !== "rejected" && !r,
      latencyMs: c.latencyMs,
      usage,
    };
    const group = callMap.get(c.jobId) ?? [];
    group.push(row);
    callMap.set(c.jobId, group);
  }
  const rawJobs = s.all<{
    id: string;
    projectId: string;
    kind: string;
    status: string;
    stage: string;
    baseRevision: number;
    createdAt: string;
    reservedCents: number;
  }>(
    "SELECT j.id,j.projectId,j.kind,j.status,j.stage,j.baseRevision,j.createdAt,COALESCE(b.allowance,0) AS reservedCents FROM studio_jobs j LEFT JOIN engine_budget b ON b.runId=j.id WHERE j.kind!='lab' ORDER BY j.rowid",
  );
  const jobs: JobCost[] = rawJobs.map((j) => ({
    ...j,
    intendedRevision:
      j.kind === "interview_transcription" ? null : j.baseRevision + 1,
    calls: callMap.get(j.id) ?? [],
    totals: totals(callMap.get(j.id) ?? [], j.reservedCents),
  }));
  const sourceLinks =
    hasTable(s, "almanac_sources") && hasTable(s, "almanac_sessions")
      ? s.all<{
          sessionId: string;
          projectId: string;
          generationProjectId: string;
        }>(
          "SELECT a.sessionId,s.projectId,a.generationProjectId FROM almanac_sources a JOIN almanac_sessions s ON s.id=a.sessionId",
        )
      : [];
  const editions = s.all<{
    id: string;
    projectId: string;
    revision: number;
    createdAt: string;
  }>("SELECT id,projectId,revision,createdAt FROM editions");
  const legacy = s.all<{
    id: string;
    projectId: string;
    status: string;
    reservedCents: number;
  }>(
    "SELECT j.id,j.projectId,j.status,COALESCE(b.allowance,j.allowance) AS reservedCents FROM engine_runs j LEFT JOIN engine_budget b ON b.runId=j.id",
  );
  type RawOrder = {
    id: string;
    projectId: string;
    editionId: string;
    status: string;
    mode: string;
    amountCents: number;
    taxCents: number | null;
    totalCents: number | null;
    refundedCents: number;
    paymentFeeCents: number | null;
    providerCosts: string | null;
    quoteEstimateCents: number | null;
  };
  const orderRows = hasTable(s, "book_orders")
    ? s.all<RawOrder>(
        "SELECT o.id,o.projectId,o.editionId,o.status,o.mode,o.amountCents,o.taxCents,o.totalCents,o.refundedCents,o.paymentFeeCents,o.providerCosts,q.estimatedCents AS quoteEstimateCents FROM book_orders o LEFT JOIN print_quotes q ON q.orderId=o.id",
      )
    : [];
  const books = s
    .all<{
      id: string;
      title: string;
      status: string;
      mode: string;
      revision: number;
    }>(
      "SELECT id,title,status,mode,revision FROM projects ORDER BY createdAt DESC,id",
    )
    .map((p) => {
      const group = jobs.filter((j) => j.projectId === p.id),
        related = sourceLinks.filter((l) => l.projectId === p.id),
        source = sourceLinks.find((l) => l.generationProjectId === p.id),
        old = legacy.filter((j) => j.projectId === p.id);
      const orders: OrderCost[] = orderRows
        .filter((o) => o.projectId === p.id)
        .map((o) => ({
          id: o.id,
          editionId: o.editionId,
          status: o.status,
          mode: o.mode,
          merchandiseCents: o.amountCents,
          collectedTaxCents: o.taxCents,
          paidTotalCents: o.totalCents,
          refundedCents: o.refundedCents,
          quoteEstimateCents: o.quoteEstimateCents,
          hasUnclassifiedProviderCharges:
            !!o.providerCosts && o.providerCosts !== "[]",
          components: (["printing", "shipping", "payment_fee"] as const).map(
            (component) => {
              const r = current.get(`order:${o.id}:${component}`);
              return {
                component,
                verifiedActualCents:
                  r?.amountCents ??
                  (component === "payment_fee" ? o.paymentFeeCents : null),
                source: r
                  ? `${r.sourceType}: ${r.sourceReference}`
                  : component === "payment_fee" && o.paymentFeeCents !== null
                    ? "Stripe balance transaction"
                    : null,
                reconciliationId: r?.id ?? null,
              };
            },
          ),
        }));
      return {
        projectId: p.id,
        title: p.title,
        status: p.status,
        mode: p.mode,
        revision: p.revision,
        sourceSessionId: source?.sessionId ?? related[0]?.sessionId ?? null,
        sourceProjectId: source?.projectId ?? null,
        relatedBookIds: [...new Set(related.map((l) => l.generationProjectId))],
        jobs: group,
        editions: editions
          .filter((e) => e.projectId === p.id)
          .map(({ id, revision, createdAt }) => ({ id, revision, createdAt })),
        orders,
        totals: totals(
          group.flatMap((j) => j.calls),
          group.reduce((n, j) => n + j.totals.reservedCents, 0) +
            old.reduce((n, j) => n + j.reservedCents, 0),
        ),
        legacyRuns: old.map(({ id, status, reservedCents }) => ({
          id,
          status,
          reservedCents,
        })),
      };
    });
  const productionBooks = books.filter(
    (b) =>
      b.mode !== "synthetic_fixture" &&
      b.jobs.some((j) => j.kind === "generation"),
  );
  // All failed attempts are included in costs. Source-session costs stay a separate row, so no book distribution silently excludes or repeats them.
  const completed = productionBooks.filter(
    (b) =>
      b.jobs.some((j) => j.kind === "generation" && j.status === "complete") &&
      b.editions.length > 0,
  );
  const eligible = completed.filter(
    (b) =>
      !b.sourceProjectId &&
      !b.legacyRuns.length &&
      b.jobs.every((j) => j.status === "complete" || j.status === "superseded"),
  );
  const usageSamples = eligible
    .filter((b) => {
      const billable = b.jobs
        .flatMap((j) => j.calls)
        .filter((c) => c.status !== "rejected");
      return (
        billable.length > 0 &&
        billable.every((c) => c.usageEstimateCents !== null)
      );
    })
    .map((b) => b.totals.usageEstimateCents);
  const actualSamples = eligible
    .filter((b) => {
      const billable = b.jobs
        .flatMap((j) => j.calls)
        .filter((c) => c.status !== "rejected");
      return (
        billable.length > 0 &&
        billable.every((c) => c.verifiedActualCents !== null)
      );
    })
    .map((b) => b.totals.verifiedActualCents);
  const included = books.filter((b) => b.mode !== "synthetic_fixture"),
    allCalls = included.flatMap((b) =>
      b.jobs.filter((j) => j.kind !== "lab").flatMap((j) => j.calls),
    );
  const retainedReservations = s.all<{ jobId: string; reservedCents: number }>(
    "SELECT b.runId AS jobId,b.allowance AS reservedCents FROM engine_budget b WHERE b.allowance>0 AND NOT EXISTS(SELECT 1 FROM studio_jobs j WHERE j.id=b.runId) AND NOT EXISTS(SELECT 1 FROM engine_runs r WHERE r.id=b.runId) ORDER BY b.createdAt",
  );
  const retainedEvidence = [...current.values()].filter((r) =>
    r.targetType === "studio_call"
      ? !calls.some((c) => c.id === r.targetId)
      : !orderRows.some((o) => o.id === r.targetId),
  );
  return {
    version: 1,
    generatedAt: now(),
    currency: "USD",
    books,
    reconciliations,
    unattributed: {
      reservations: retainedReservations,
      reconciliations: retainedEvidence,
    },
    totals: totals(
      allCalls,
      included.reduce((n, b) => n + b.totals.reservedCents, 0),
    ),
    metrics: {
      cohort:
        "Non-synthetic projects with a generation job. Completion requires a completed generation job and a saved edition; all other started books remain in the denominator.",
      bookProjects: productionBooks.length,
      completedBooks: completed.length,
      completionRate: productionBooks.length
        ? completed.length / productionBooks.length
        : null,
      activeOrIncompleteBooks: productionBooks.length - completed.length,
      usageCost: distribution(usageSamples),
      actualCost: distribution(actualSamples),
      sampleDefinition:
        "Generation cost per completed, edition-backed book, including all retained attempts and revisions. Only settled jobs with complete usage or reconciled actual coverage qualify. Legacy runs, synthetic fixtures and books linked to a separately costed interview session are excluded. Printing, shipping, fees and tax are separate. Median averages the middle pair; p90 uses nearest rank. No sample means unknown, not zero.",
    },
  };
}
