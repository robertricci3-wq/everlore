import { useEffect, useState } from "react";
import type { MemoryExperimentView } from "../shared/memoryLab.js";
import { api } from "./api.js";

export function MemoryLab() {
  const [experiments, setExperiments] = useState<MemoryExperimentView[]>([]);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [caseId, setCaseId] = useState("");
  const load = async () =>
    setExperiments(
      (await api<{ experiments: MemoryExperimentView[] }>("/lab/memory"))
        .experiments,
    );
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const current = experiments.find((e) => e.id === selected) ?? experiments[0];
  const scenario =
    current?.plan.cases.find((c) => c.id === caseId) ?? current?.plan.cases[0];
  return (
    <section aria-label="Guided memory experiments">
      <article className="lab-panel">
        <div className="eyebrow">Memory first · zero provider calls</div>
        <h2>Let a meaningful tradition stand on its own.</h2>
        <p>
          Compare the existing guide with one focused change: skip the request
          for a single occasion when a recurring ritual already contains a
          distinctive detail and stated meaning.
        </p>
        <p className="muted">
          Scripted behavior checks, not evidence of comfort, better books or
          child engagement. Existing interviews retain their original guide.
        </p>
        <button
          className="button"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              const e = await api<{ id: string }>("/lab/memory", {});
              setSelected(e.id);
            })
          }
        >
          Freeze memory comparison
        </button>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
      </article>
      {experiments.length > 0 && (
        <label>
          Retained memory experiment
          <select
            value={current?.id ?? ""}
            onChange={(e) => setSelected(e.target.value)}
          >
            {experiments.map((e) => (
              <option value={e.id} key={e.id}>
                {e.createdAt} · {e.status}
              </option>
            ))}
          </select>
        </label>
      )}
      {current && (
        <>
          <article className="lab-panel">
            <h3>
              {current.status === "paused"
                ? "Saved checkpoint"
                : "Frozen comparison"}
            </h3>
            <p>{current.plan.hypothesis}</p>
            <p>
              <strong>Tradeoff:</strong> {current.plan.risk}
            </p>
            <p>
              {current.summary.complete}/{current.summary.total} decisions
              retained · {current.summary.failures} failed runs ·{" "}
              {current.summary.providerCalls} provider calls
            </p>
            <p>
              {current.summary.candidateWins} pairs with fewer prompts ·{" "}
              {current.summary.baselineWins} reverse changes ·{" "}
              {current.summary.ties} ties
            </p>
            <p className="lab-note">{current.summary.limitation}</p>
            {["planned", "paused"].includes(current.status) && (
              <div className="lab-actions">
                <button
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    void action(() => api(`/lab/memory/${current.id}/run`, {}))
                  }
                >
                  {current.status === "paused"
                    ? "Resume memory comparison"
                    : "Run memory comparison"}
                </button>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void action(() =>
                      api(`/lab/memory/${current.id}/run`, { maxPairs: 1 }),
                    )
                  }
                >
                  Run one pair and checkpoint
                </button>
              </div>
            )}
            <a
              href={`/api/lab/memory/${current.id}`}
              target="_blank"
              rel="noreferrer"
            >
              Frozen inputs and evidence ↗
            </a>
            {current.error && <p className="alert">{current.error}</p>}
          </article>
          {scenario && (
            <>
              <label>
                Interview case
                <select
                  value={scenario.id}
                  onChange={(e) => setCaseId(e.target.value)}
                >
                  {current.plan.cases.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
              </label>
              <article className="lab-panel">
                <h3>Original synthetic telling</h3>
                {scenario.session.turns.map((t) => (
                  <p key={t.id}>
                    {t.transcript?.rawText ?? "Unfinished or skipped turn"}
                  </p>
                ))}
              </article>
              <div className="lab-comparison">
                {(["baseline", "candidate"] as const).map((arm) => {
                  const run = current.runs.find(
                    (r) =>
                      r.caseId === scenario.id &&
                      r.replicate === 1 &&
                      r.arm === arm,
                  );
                  return (
                    <article className="lab-artifact" key={arm}>
                      <h3>
                        {arm === "baseline"
                          ? "Existing guide"
                          : "Candidate guide"}
                      </h3>
                      {run ? (
                        <>
                          <p>
                            <strong>{run.output.action}</strong> ·{" "}
                            {run.output.reason}
                          </p>
                          {run.output.promptText && (
                            <blockquote>{run.output.promptText}</blockquote>
                          )}
                          <details open>
                            <summary>Source citations</summary>
                            {run.output.evidence.length ? (
                              run.output.evidence.map((e, i) => (
                                <blockquote key={i}>
                                  {e.quote}
                                  <small>
                                    {" "}
                                    · characters {e.start}–{e.end}
                                  </small>
                                </blockquote>
                              ))
                            ) : (
                              <p>No source passage cited by this decision.</p>
                            )}
                          </details>
                          <details>
                            <summary>Preservation checks</summary>
                            <ul>
                              {run.assertions.map((a) => (
                                <li key={a}>{a}</li>
                              ))}
                            </ul>
                            {run.failures.map((f) => (
                              <p className="alert" key={f}>
                                {f}
                              </p>
                            ))}
                          </details>
                        </>
                      ) : (
                        <p>
                          Run this frozen comparison to inspect the decision.
                        </p>
                      )}
                    </article>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
