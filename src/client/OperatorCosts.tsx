import { useEffect, useState } from "react";
import { api } from "./api.js";
import type {
  BookCostSummary,
  CostReport,
  Reconciliation,
} from "../server/costs/service.js";
const usd = (cents: number | null) =>
  cents === null
    ? "Unknown"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(cents / 100);

type StoryRecovery = {
  kind?: "story";
  jobId: string;
  error: string | null;
  recovery: {
    callId: string;
    stage: string;
    message: string;
    uncertain: boolean;
    extraReserveUsd: number;
    resumeReserveUsd?: number;
    requestId: string | null;
  } | null;
};
export type Recovery =
  | StoryRecovery
  | {
      kind: "interview";
      interview: {
        sessionId: string;
        turnId: string;
        jobId: string;
        status: string;
        resumable: boolean;
        uncertain: boolean;
        message: string;
        calls: {
          id: string;
          status: string;
          requestId: string | null;
          estimatedCents: number;
          actualCents: number | null;
          createdAt: string;
        }[];
      };
    };
export function operatorRecoveryAction(
  projectId: string,
  state: Recovery,
  ack: boolean,
): { path: string; body: object } | null {
  if (state.kind === "interview") {
    const record = state.interview;
    if (!record.resumable || record.uncertain) return null;
    return {
      path: `/operator/interviews/${record.sessionId}/turns/${record.turnId}/recovery`,
      body: { retry: true },
    };
  }
  if (!state.recovery || (state.recovery.uncertain && !ack)) return null;
  return {
    path: `/operator/projects/${projectId}/resume`,
    body: {
      jobId: state.jobId,
      callId: state.recovery.callId,
      acknowledgePossibleCharge: ack,
    },
  };
}
function OperatorRecovery({
  projectId,
  onChange,
}: {
  projectId: string;
  onChange: () => void;
}) {
  const [state, setState] = useState<Recovery>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [ack, setAck] = useState(false);
  async function load() {
    setBusy(true);
    setError("");
    try {
      setState(await api<Recovery>(`/operator/projects/${projectId}/recovery`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const interview = state?.kind === "interview" ? state.interview : null;
  const story = state && state.kind !== "interview" ? state : null;
  async function resume() {
    const action = state ? operatorRecoveryAction(projectId, state, ack) : null;
    if (!action) return;
    setBusy(true);
    setError("");
    try {
      await api(action.path, action.body);
      setState(undefined);
      setAck(false);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="source-details">
      <summary>Operator recovery</summary>
      <button
        className="button secondary"
        disabled={busy}
        onClick={() => void load()}
      >
        Inspect saved checkpoint
      </button>
      {interview && (
        <>
          <p>{interview.message}</p>
          <p>
            Interview transcription · {interview.status}. Existing recordings
            and request evidence are preserved.
          </p>
          {interview.calls.length > 0 && (
            <ul>
              {interview.calls.map((call) => (
                <li key={call.id}>
                  Attempt {call.id}: {call.status} · reserved{" "}
                  {usd(call.estimatedCents)}
                  {call.requestId
                    ? ` · provider request ${call.requestId}`
                    : " · no provider request identifier recorded"}
                </li>
              ))}
            </ul>
          )}
          {interview.uncertain ? (
            <p className="notice">
              Paid retry is blocked while the outcome is uncertain. Verify the
              listed requests with the provider. The family can add a written
              transcript without repeating the paid request.
            </p>
          ) : (
            interview.resumable && (
              <button
                className="button"
                disabled={busy}
                onClick={() => void resume()}
              >
                Retry saved transcription
              </button>
            )
          )}
        </>
      )}
      {story && (
        <>
          <p>
            {story.recovery?.message ??
              story.error ??
              "No resumable checkpoint is available."}
          </p>
          {story.recovery && (
            <>
              <p>
                Stage: {story.recovery.stage}. Remaining reservation:{" "}
                {usd(
                  (story.recovery.resumeReserveUsd ??
                    story.recovery.extraReserveUsd) * 100,
                )}
                .
              </p>
              {story.recovery.requestId && (
                <p>Provider request: {story.recovery.requestId}</p>
              )}
              {story.recovery.uncertain && (
                <label className="consent">
                  <input
                    type="checkbox"
                    checked={ack}
                    onChange={(e) => setAck(e.target.checked)}
                  />
                  <span>
                    I checked this attempt and understand it may already have
                    been charged. I authorize retrying the unfinished step
                    within the existing allowance.
                  </span>
                </label>
              )}
              <button
                className="button"
                disabled={busy || (story.recovery.uncertain && !ack)}
                onClick={() => void resume()}
              >
                Resume saved work
              </button>
            </>
          )}
        </>
      )}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}
function ReconcileForm({
  book,
  records,
  onSaved,
}: {
  book: BookCostSummary;
  records: Reconciliation[];
  onSaved: () => void;
}) {
  const targets = [
    ...book.jobs.flatMap((j) =>
      j.calls.map((c) => ({
        key: `studio_call:${c.id}:generation`,
        type: "studio_call",
        id: c.id,
        component: "generation",
        label: `${j.kind} / ${c.stage} / ${c.id}`,
        current: c.reconciliationId,
      })),
    ),
    ...book.orders.flatMap((o) =>
      o.components.map((c) => ({
        key: `order:${o.id}:${c.component}`,
        type: "order",
        id: o.id,
        component: c.component,
        label: `Order ${o.id} / ${c.component}`,
        current: c.reconciliationId,
      })),
    ),
  ];
  const [key, setKey] = useState(""),
    [amount, setAmount] = useState(""),
    [source, setSource] = useState("invoice"),
    [reference, setReference] = useState(""),
    [date, setDate] = useState(""),
    [verified, setVerified] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [attempt, setAttempt] = useState<{
    signature: string;
    id: string;
  } | null>(null);
  const selected = targets.find((t) => t.key === key),
    previous = records.find((r) => r.id === selected?.current);
  async function submit() {
    if (!selected) return;
    const cents = Number(amount) * 100;
    if (
      !amount.trim() ||
      !Number.isFinite(cents) ||
      cents < 0 ||
      Math.abs(cents - Math.round(cents)) > 0.00001 ||
      !date ||
      !reference.trim() ||
      !verified
    ) {
      setError(
        "Enter a USD amount with at most two decimals, an evidence date and reference, then confirm verification.",
      );
      return;
    }
    const body = {
      targetType: selected.type,
      targetId: selected.id,
      component: selected.component,
      amountCents: Math.round(cents),
      currency: "USD",
      sourceType: source,
      sourceReference: reference,
      observedAt: new Date(`${date}T00:00:00.000Z`).toISOString(),
      verified: true,
      supersedesId: selected.current,
    };
    const signature = JSON.stringify(body),
      idempotencyKey =
        attempt?.signature === signature ? attempt.id : crypto.randomUUID();
    setAttempt({ signature, id: idempotencyKey });
    setBusy(true);
    setError("");
    try {
      await api("/operator/costs/reconciliations", { ...body, idempotencyKey });
      setVerified(false);
      setReference("");
      setAmount("");
      setAttempt(null);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!targets.length) return null;
  return (
    <details className="source-details">
      <summary>Record verified billing evidence</summary>
      <p>
        Match one actual charge to one attempt or order component. Do not
        allocate the same invoice total to multiple attempts. A correction adds
        a new receipt; it does not erase earlier evidence or replace estimates.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label>
          Cost to reconcile
          <select
            required
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setVerified(false);
            }}
          >
            <option value="">Choose an attempt or order cost</option>
            {targets.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        {previous && (
          <p>
            Correcting {usd(previous.amountCents)} from{" "}
            {previous.sourceReference}. Earlier evidence will remain in history.
          </p>
        )}
        <label>
          Verified charge (USD)
          <input
            required
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label>
          Evidence source
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="invoice">Invoice</option>
            <option value="provider_statement">Provider statement</option>
            <option value="provider_dashboard">Provider dashboard</option>
          </select>
        </label>
        <label>
          Invoice or charge reference
          <input
            required
            maxLength={500}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Invoice identifier and line or request reference"
          />
        </label>
        <label>
          Date of billing evidence
          <input
            required
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label className="consent">
          <input
            type="checkbox"
            checked={verified}
            onChange={(e) => setVerified(e.target.checked)}
          />
          <span>
            I verified this actual charge against the cited source and matched
            it only to this cost.
          </span>
        </label>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        <button
          className="button secondary"
          disabled={busy || !selected || !verified}
        >
          {busy ? "Saving evidence…" : "Save billing evidence"}
        </button>
      </form>
    </details>
  );
}
export function OperatorCosts() {
  const [report, setReport] = useState<CostReport>(),
    [error, setError] = useState("");
  async function refresh() {
    try {
      setReport(await api<CostReport>("/operator/costs"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <section className="project-state operator-costs">
      <span className="eyebrow">EVERLORE OPERATOR</span>
      <h1>The cost of each story</h1>
      <p>
        <a href="#/operator/studio">Service connection</a> ·{" "}
        <a href="#/operator/orders">Orders and fulfillment</a>
      </p>
      <p>
        Reservations are authorization records, usage estimates are calculated
        from provider usage, and verified charges need billing evidence. None of
        these figures establishes profitability.
      </p>
      <button className="button secondary" onClick={() => void refresh()}>
        Refresh cost records
      </button>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {report && (
        <>
          <dl className="cost-summary">
            <dt>Reservations linked to current books, including legacy jobs</dt>
            <dd>{usd(report.totals.reservedCents)}</dd>
            <dt>Usage-derived estimates (partial coverage)</dt>
            <dd>
              {usd(report.totals.usageEstimateCents)} across{" "}
              {report.totals.usageEstimatedAttempts} attempts
            </dd>
            <dt>Verified generation charges</dt>
            <dd>
              {usd(report.totals.verifiedActualCents)} across{" "}
              {report.totals.verifiedAttempts} attempts
            </dd>
            <dt>Attempts with unknown charges</dt>
            <dd>{report.totals.unknownChargeAttempts}</dd>
          </dl>
          {!!(
            report.unattributed.reservations.length ||
            report.unattributed.reconciliations.length
          ) && (
            <details className="source-details">
              <summary>Retained costs without a current book</summary>
              <p>
                These records can outlive a deleted private story. They are
                separate from the current-book totals and distributions above;
                their original cohort is unknown.
              </p>
              <ul>
                {report.unattributed.reservations.map((r) => (
                  <li key={r.jobId}>
                    Job {r.jobId}: retained reservation {usd(r.reservedCents)};
                    actual charge unknown unless separately reconciled.
                  </li>
                ))}
                {report.unattributed.reconciliations.map((r) => (
                  <li key={r.id}>
                    {r.component}: verified {usd(r.amountCents)} from{" "}
                    {r.sourceReference}; target {r.targetId}.
                  </li>
                ))}
              </ul>
            </details>
          )}
          <h2>Completion and cost distribution</h2>
          <p>
            {report.metrics.completedBooks} of {report.metrics.bookProjects}{" "}
            started books have a saved edition (
            {report.metrics.completionRate === null
              ? "no sample"
              : `${Math.round(report.metrics.completionRate * 100)}%`}
            ). {report.metrics.activeOrIncompleteBooks} remain active or
            incomplete.
          </p>
          <p>{report.metrics.cohort}</p>
          <p>{report.metrics.sampleDefinition}</p>
          <div className="cost-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Generation cost</th>
                  <th>Qualified books</th>
                  <th>Median</th>
                  <th>p90</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Usage estimate</td>
                  <td>{report.metrics.usageCost.samples}</td>
                  <td>{usd(report.metrics.usageCost.medianCents)}</td>
                  <td>{usd(report.metrics.usageCost.p90Cents)}</td>
                </tr>
                <tr>
                  <td>Verified charge</td>
                  <td>{report.metrics.actualCost.samples}</td>
                  <td>{usd(report.metrics.actualCost.medianCents)}</td>
                  <td>{usd(report.metrics.actualCost.p90Cents)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="small muted">
            Synthetic fixture projects remain inspectable below and are excluded
            from aggregate totals. Interview transcription stays on its source
            memory and is not duplicated across resulting books. Tax and sales
            are reported separately from costs.
          </p>
          {report.books.map((book) => (
            <details
              className="source-details"
              key={book.projectId}
              id={`cost-${book.projectId}`}
            >
              <summary>
                {book.title} · {book.status} · revision {book.revision}
              </summary>
              <p>
                Project {book.projectId}
                {book.mode === "synthetic_fixture"
                  ? " · Synthetic fixture"
                  : ""}
              </p>
              {book.sourceProjectId && (
                <p>
                  Interview costs are recorded once on{" "}
                  <a
                    href={`#cost-${book.sourceProjectId}`}
                    onClick={(e) => {
                      e.preventDefault();
                      const el = document.getElementById(
                        `cost-${book.sourceProjectId}`,
                      );
                      if (el instanceof HTMLDetailsElement) el.open = true;
                      el?.scrollIntoView({ block: "start" });
                    }}
                  >
                    source memory {book.sourceProjectId}
                  </a>
                  ; they are not repeated here.
                </p>
              )}
              {!!book.relatedBookIds.length && (
                <p>
                  Source interview for {book.relatedBookIds.length} saved book
                  source revision(s): {book.relatedBookIds.join(", ")}.
                </p>
              )}
              <p>
                Reserved {usd(book.totals.reservedCents)} · Usage estimate{" "}
                {usd(book.totals.usageEstimateCents)} (
                {book.totals.usageEstimatedAttempts} attempts) · Verified{" "}
                {usd(book.totals.verifiedActualCents)} · Unknown charges:{" "}
                {book.totals.unknownChargeAttempts}
              </p>
              <p>
                Saved editions:{" "}
                {book.editions.length
                  ? book.editions
                      .map((e) => `${e.id} (revision ${e.revision})`)
                      .join(", ")
                  : "None yet"}
              </p>
              {book.jobs.map((job) => (
                <details className="source-details" key={job.id}>
                  <summary>
                    {job.kind} · {job.status} ·{" "}
                    {job.intendedRevision === null
                      ? "Interview source"
                      : `intended revision ${job.intendedRevision}`}
                  </summary>
                  <p>
                    Job {job.id} · stage {job.stage}. Reservation{" "}
                    {usd(job.totals.reservedCents)}. An intended revision is not
                    proof that an edition was saved.
                  </p>
                  <div className="cost-table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Stage / attempt</th>
                          <th>Status / model</th>
                          <th>Reserved</th>
                          <th>Usage estimate</th>
                          <th>Verified charge</th>
                        </tr>
                      </thead>
                      <tbody>
                        {job.calls.map((call) => (
                          <tr key={call.id}>
                            <td>
                              {call.stage}
                              <br />
                              <small>{call.id}</small>
                            </td>
                            <td>
                              {call.status}
                              <br />
                              {call.model}
                            </td>
                            <td>
                              {usd(call.reservedCents)}
                              {call.boundCents !== null && (
                                <small>
                                  <br />
                                  Bound {usd(call.boundCents)} (
                                  {call.boundRateCard})
                                </small>
                              )}
                            </td>
                            <td>
                              {usd(call.usageEstimateCents)}
                              {call.usageRateCard && (
                                <small>
                                  <br />
                                  {call.usageRateCard}
                                </small>
                              )}
                            </td>
                            <td>
                              {usd(call.verifiedActualCents)}
                              {call.actualSource && (
                                <small>
                                  <br />
                                  {call.actualSource}
                                </small>
                              )}
                              {call.legacyActualCents !== null && (
                                <small>
                                  <br />
                                  Legacy actual field{" "}
                                  {usd(call.legacyActualCents)}; provenance
                                  unverified
                                </small>
                              )}
                              {call.status === "rejected" &&
                                call.verifiedActualCents === null && (
                                  <small>
                                    <br />
                                    Rejected request; no successful dispatch
                                    recorded
                                  </small>
                                )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!job.calls.length && <p>No request attempts recorded.</p>}
                </details>
              ))}
              {!!book.legacyRuns.length && (
                <p>
                  Legacy engine runs:{" "}
                  {book.legacyRuns
                    .map(
                      (r) =>
                        `${r.id} (${r.status}, reserved ${usd(r.reservedCents)})`,
                    )
                    .join("; ")}
                  . Per-request usage and actual charges are unknown.
                </p>
              )}
              {book.orders.map((o) => (
                <div key={o.id}>
                  <h3>Order {o.id}</h3>
                  <p>
                    {o.status} · {o.mode} · edition {o.editionId}
                  </p>
                  <p>
                    Merchandise {usd(o.merchandiseCents)} · Tax{" "}
                    {usd(o.collectedTaxCents)} · Paid total{" "}
                    {usd(o.paidTotalCents)} · Refunded {usd(o.refundedCents)} ·
                    Print/shipping quote estimate {usd(o.quoteEstimateCents)}
                  </p>
                  <ul>
                    {o.components.map((c) => (
                      <li key={c.component}>
                        {c.component.replace("_", " ")}:{" "}
                        {usd(c.verifiedActualCents)}
                        {c.source
                          ? ` — ${c.source}`
                          : "; billing evidence needed"}
                      </li>
                    ))}
                  </ul>
                  {o.hasUnclassifiedProviderCharges && (
                    <p>
                      Printer charge records exist. Match their individual line
                      items to printing and shipping before treating them as
                      verified component costs.
                    </p>
                  )}
                </div>
              ))}
              {book.jobs.some((j) =>
                ["needs_attention", "needs_editor"].includes(j.status),
              ) && (
                <OperatorRecovery
                  projectId={book.projectId}
                  onChange={() => void refresh()}
                />
              )}
              <ReconcileForm
                book={book}
                records={report.reconciliations}
                onSaved={() => void refresh()}
              />
            </details>
          ))}
          <details className="source-details">
            <summary>
              Billing evidence history ({report.reconciliations.length})
            </summary>
            <ul>
              {report.reconciliations.map((r) => (
                <li key={r.id}>
                  {r.createdAt} · {r.component} {usd(r.amountCents)} ·{" "}
                  {r.sourceType}: {r.sourceReference} · target {r.targetId} ·
                  recorded by {r.recordedBy}
                  {r.supersedesId ? ` · corrects ${r.supersedesId}` : ""}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}
