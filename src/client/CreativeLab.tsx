import { MemoryLab } from "./MemoryLab.js";
import { ReaderExperience, VisualDirection } from "../shared/picturebook.js";
import { useEffect, useState } from "react";
import { ArrowRight, FlaskConical, Pause, Play, RotateCcw } from "lucide-react";
import { api } from "./api.js";
import type { LabView, LabExperimentView, LabRunView } from "../shared/lab.js";
type View = LabView & {
  sessions: Array<{
    id: string;
    status: string;
    iteration: number;
    noProgress: number;
    checkpoint: string;
  }>;
  agenda: Array<{
    id: string;
    title: string;
    target: string;
    criterion: string;
    amendment: string;
    risk: string;
  }>;
};
const money = (n: number | null) =>
  n === null ? "Unknown" : `$${(n / 100).toFixed(2)}`;
export function CreativeLab() {
  const [data, setData] = useState<View | null>(null),
    [error, setError] = useState(""),
    [selected, setSelected] = useState(""),
    [releasePrereq, setReleasePrereq] = useState(""),
    [evaluationPhase, setEvaluationPhase] = useState<"development" | "release">(
      "development",
    ),
    [scope, setScope] = useState<"stage" | "book">("stage"),
    [storyPrereq, setStoryPrereq] = useState(""),
    [artPrereq, setArtPrereq] = useState(""),
    [mechanism, setMechanism] = useState("particulars"),
    [mode, setMode] = useState<"offline" | "live">("offline"),
    [replicates, setReplicates] = useState(3),
    [allowance, setAllowance] = useState(""),
    [authorized, setAuthorized] = useState(false),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState<"memory" | "experiments" | "library" | "profiles">(
      "memory",
    );
  const load = async () => {
    const v = await api<View>("/lab");
    setData(v);
  };
  useEffect(() => {
    let mounted = true;
    const refresh = () =>
      void api<View>("/lab")
        .then((v) => {
          if (mounted) setData(v);
        })
        .catch((e) => {
          if (mounted) setError(e.message);
        });
    refresh();
    const timer = setInterval(refresh, 2500);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
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
  const current =
    data?.experiments.find((e) => e.id === selected) ?? data?.experiments[0];
  return (
    <main className="creative-lab enter">
      <div className="eyebrow">
        <FlaskConical size={18} /> Everlore Creative Lab
      </div>
      <h1>
        Find the extraordinary
        <br />
        <em>in the ordinary.</em>
      </h1>
      <p className="lead">
        A working studio for better family stories. Generate, examine, revise,
        and compare—then keep only changes supported by the evidence.
      </p>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {!data ? (
        <p>Opening the private lab…</p>
      ) : !data.allowed ? (
        <section className="lab-panel">
          <h2>A private working studio</h2>
          <p>
            This shelf is not the configured Lab operator. Use the local Lab
            owner command described in the development guide, then sign in to
            that shelf.
          </p>
          <a href="#/login">Sign in</a>
        </section>
      ) : (
        <>
          <div className="lab-promise">
            <span>
              <strong>Autonomous craft loop</strong>
              <br />
              No creative approval stop
            </span>
            <span>
              <strong>Three connected workflows</strong>
              <br />
              Story · Art · Complete book
            </span>
            <span>
              <strong>Evidence stays honest</strong>
              <br />
              Model judgment ≠ child response
            </span>
          </div>
          <nav className="lab-tabs" aria-label="Lab sections">
            {(["memory", "experiments", "library", "profiles"] as const).map(
              (t) => (
                <button
                  key={t}
                  className={tab === t ? "active" : ""}
                  onClick={() => setTab(t)}
                >
                  {t === "memory"
                    ? "Guided memory"
                    : t === "experiments"
                      ? "Experiments"
                      : t === "library"
                        ? "Craft library"
                        : "Engine versions"}
                </button>
              ),
            )}
          </nav>
          {tab === "memory" ? (
            <MemoryLab />
          ) : tab === "library" ? (
            <section>
              <p className="muted">
                Critical methods from literature, oral language and
                illustration. Sources, interpretations and hypotheses stay
                distinct. These are research-informed tools, not claims of
                expert authorship.
              </p>
              <div className="lab-library">
                {data.principles.map((p) => (
                  <article className="lab-panel" key={p.id}>
                    <span className="eyebrow">
                      {p.area} · {p.perspective}
                    </span>
                    <h2>{p.title}</h2>
                    <p>{p.interpretation}</p>
                    {p.study && (
                      <p>
                        <strong>Original Everlore example:</strong>{" "}
                        {p.study.originalExample}
                        <br />
                        <small>
                          Technique hypothesis; creative improvement not yet
                          demonstrated.
                        </small>
                      </p>
                    )}
                    <p>
                      <strong>Try:</strong> {p.application}
                    </p>
                    <p>
                      <strong>Watch for:</strong> {p.counterexample}
                    </p>
                    <p>
                      <strong>Evaluate:</strong> {p.evaluation}
                    </p>
                    <a href={p.source.url} target="_blank" rel="noreferrer">
                      {p.source.title} ↗
                    </a>
                    <p className="muted">
                      Source status: {p.source.status.replaceAll("_", " ")} ·{" "}
                      {p.evidence.length} retained experiment findings
                    </p>
                  </article>
                ))}
              </div>
            </section>
          ) : tab === "profiles" ? (
            <section>
              <p className="muted">
                Rules, prompts, model settings and rubrics are frozen together.
                Releases affect new jobs; existing books and jobs retain their
                version.
              </p>
              {data.profiles.map((p) => (
                <article className="lab-panel" key={p.hash}>
                  <span className="eyebrow">
                    {p.hash === data.activeHash
                      ? "Active engine"
                      : "Candidate / historical version"}
                  </span>
                  <h2>{p.name}</h2>
                  <p>
                    {p.change.amendment ||
                      "The starting implementation; creative performance still requires live evidence."}
                  </p>
                  <code className="lab-hash">{p.hash}</code>
                  <p className="muted">
                    {p.models.text} · {p.models.image} · {p.rubric.version}
                  </p>
                </article>
              ))}
              <h2>Release history</h2>
              {!data.releases.length ? (
                <p>
                  No candidate has been promoted. Offline examples cannot
                  activate an engine release.
                </p>
              ) : (
                data.releases.map((r) => (
                  <article className="lab-panel" key={r.id}>
                    <strong>{r.action.replaceAll("_", " ")}</strong>
                    <p className="muted">{r.createdAt}</p>
                    <code className="lab-hash">{r.profileHash}</code>
                    {r.profileHash === data.activeHash && (
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() =>
                          void action(() =>
                            api(`/lab/releases/${r.id}/rollback`, {}),
                          )
                        }
                      >
                        <RotateCcw size={16} /> Roll back this release
                      </button>
                    )}
                  </article>
                ))
              )}
            </section>
          ) : (
            <>
              <section className="lab-panel">
                <div className="eyebrow">One mechanism at a time</div>
                <h2>Start a controlled comparison</h2>
                <p>
                  Identical memories. Frozen criteria. Reversed comparison
                  order. Every attempt retained, including failures. The engine
                  compares and decides automatically.
                </p>
                <div className="lab-form">
                  <label>
                    Craft question
                    <select
                      value={mechanism}
                      onChange={(e) => setMechanism(e.target.value)}
                    >
                      {data.agenda.map((a) => (
                        <option value={a.id} key={a.id}>
                          {a.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Execution
                    <select
                      value={mode}
                      onChange={(e) => setMode(e.target.value as typeof mode)}
                    >
                      <option value="offline">Offline · verify the loop</option>
                      <option value="live">Live · generate and evaluate</option>
                    </select>
                  </label>
                  <label>
                    Runs per case
                    <select
                      value={replicates}
                      onChange={(e) => setReplicates(Number(e.target.value))}
                    >
                      <option value={1}>1 · exploration only</option>
                      <option value={3}>3 · repeatability campaign</option>
                    </select>
                  </label>
                </div>
                <label>
                  Evaluation purpose
                  <select
                    value={evaluationPhase}
                    onChange={(e) =>
                      setEvaluationPhase(
                        e.target.value as typeof evaluationPhase,
                      )
                    }
                  >
                    <option value="development">Development memories</option>
                    <option value="release">Held-out release evaluation</option>
                  </select>
                </label>
                <label>
                  Comparison scope
                  <select
                    value={scope}
                    onChange={(e) => setScope(e.target.value as typeof scope)}
                  >
                    <option value="stage">Focused story or art stage</option>
                    <option value="book">
                      Complete book · words, pictures and layout
                    </option>
                  </select>
                </label>
                {evaluationPhase === "release" && (
                  <label>
                    Matched development comparison of this candidate
                    <select
                      value={releasePrereq}
                      onChange={(e) => setReleasePrereq(e.target.value)}
                    >
                      <option value="">
                        Choose retained development evidence
                      </option>
                      {data.experiments
                        .filter(
                          (e) =>
                            e.mode === mode &&
                            ["complete", "inconclusive"].includes(e.status),
                        )
                        .map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.title}
                          </option>
                        ))}
                    </select>
                    <small>
                      The server verifies candidate, baseline and comparison
                      scope match.
                    </small>
                  </label>
                )}
                {scope === "book" && mode === "live" && (
                  <div className="lab-form">
                    <label>
                      Completed story experiment
                      <select
                        value={storyPrereq}
                        onChange={(e) => setStoryPrereq(e.target.value)}
                      >
                        <option value="">Choose prior evidence</option>
                        {data.experiments
                          .filter(
                            (e) =>
                              e.lane === "story" &&
                              e.mode === "live" &&
                              ["complete", "promoted"].includes(e.status),
                          )
                          .map((e) => (
                            <option value={e.id} key={e.id}>
                              {e.title}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label>
                      Completed art experiment
                      <select
                        value={artPrereq}
                        onChange={(e) => setArtPrereq(e.target.value)}
                      >
                        <option value="">Choose prior evidence</option>
                        {data.experiments
                          .filter(
                            (e) =>
                              e.lane === "art" &&
                              e.mode === "live" &&
                              ["complete", "promoted"].includes(e.status),
                          )
                          .map((e) => (
                            <option value={e.id} key={e.id}>
                              {e.title}
                            </option>
                          ))}
                      </select>
                    </label>
                  </div>
                )}
                <p className="muted">
                  {data.agenda.find((a) => a.id === mechanism)?.risk}
                </p>
                {mode === "live" ? (
                  <>
                    <label>
                      Separate experiment allowance (USD)
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={allowance}
                        onChange={(e) => setAllowance(e.target.value)}
                        placeholder="Choose an explicit amount"
                      />
                    </label>
                    <label className="check-label">
                      <input
                        type="checkbox"
                        checked={authorized}
                        onChange={(e) => setAuthorized(e.target.checked)}
                      />{" "}
                      I authorize this experiment to send the labeled synthetic
                      cases to the provider, within this separate allowance.
                    </label>
                    <p className="muted">
                      {data.providerConfigured
                        ? "Provider configured."
                        : "Provider connection is still needed."}{" "}
                      Request reserves are estimates, not actual billing. A low
                      allowance stops the experiment at its checkpoint.
                    </p>
                  </>
                ) : (
                  <p className="lab-note">
                    Offline runs use visibly labeled control-flow placeholders.
                    They make no provider calls and cannot prove creative
                    improvement or promote a release.
                  </p>
                )}
                <button
                  className="button"
                  disabled={
                    busy ||
                    (mode === "live" &&
                      (!authorized ||
                        !Number(allowance) ||
                        !data.providerConfigured))
                  }
                  onClick={() =>
                    void action(async () => {
                      const a = data.agenda.find((a) => a.id === mechanism)!;
                      const r = await api<{ id: string }>("/lab/experiments", {
                        evaluationPhase,
                        mechanism,
                        lane:
                          scope === "book"
                            ? "book"
                            : a.target === "art"
                              ? "art"
                              : "story",
                        prerequisiteIds: [
                          ...(scope === "book" && mode === "live"
                            ? [storyPrereq, artPrereq]
                            : []),
                          ...(evaluationPhase === "release"
                            ? [releasePrereq]
                            : []),
                        ].filter(Boolean),
                        mode,
                        replicates,
                        maxCents:
                          mode === "live"
                            ? Math.round(Number(allowance) * 100)
                            : 0,
                        authorizeCosts: authorized,
                      });
                      setSelected(r.id);
                    })
                  }
                >
                  Freeze this experiment <ArrowRight size={18} />
                </button>{" "}
                <button
                  className="button secondary"
                  disabled={
                    busy ||
                    (mode === "live" &&
                      (!authorized ||
                        !Number(allowance) ||
                        !data.providerConfigured))
                  }
                  onClick={() =>
                    void action(() =>
                      api("/lab/sessions", {
                        mode,
                        lane:
                          data.agenda.find((a) => a.id === mechanism)
                            ?.target === "art"
                            ? "art"
                            : "story",
                        maxIterations: 2,
                        maxCents:
                          mode === "live"
                            ? Math.round(Number(allowance) * 100)
                            : 0,
                        authorizeCosts: authorized,
                      }),
                    )
                  }
                >
                  Run a two-iteration learning session
                </button>
                <p className="muted">
                  A learning session selects the next craft questions
                  automatically. It shares the entered allowance across two
                  experiments, uses three runs per case, and stops after two
                  iterations without demonstrated improvement. No scheduled
                  restart.
                </p>
                {data.sessions.map((s) => (
                  <div className="lab-note" key={s.id}>
                    <strong>
                      {s.status.replaceAll("_", " ")} · {s.iteration} completed
                      iterations
                    </strong>
                    <p>{s.checkpoint}</p>
                    {["running", "paused"].includes(s.status) && (
                      <button
                        className="button secondary"
                        onClick={() =>
                          void action(() =>
                            api(
                              `/lab/sessions/${s.id}/${s.status === "paused" ? "resume" : "pause"}`,
                              {},
                            ),
                          )
                        }
                      >
                        {s.status === "paused"
                          ? "Resume session"
                          : "Pause session"}
                      </button>
                    )}
                  </div>
                ))}
              </section>
              <div className="lab-workspace">
                <aside className="lab-experiments">
                  <h2>Retained experiments</h2>
                  {!data.experiments.length && (
                    <p>Your first comparison begins above.</p>
                  )}
                  {data.experiments.map((e) => (
                    <button
                      className={`lab-experiment ${current?.id === e.id ? "selected" : ""}`}
                      key={e.id}
                      onClick={() => setSelected(e.id)}
                    >
                      <strong>{e.title}</strong>
                      <span>
                        {e.mode} · {e.lane} · {e.status.replaceAll("_", " ")}
                      </span>
                      <span>
                        {e.summary.complete}/{e.summary.total} artifacts
                        retained
                      </span>
                    </button>
                  ))}
                </aside>
                {current && (
                  <ExperimentPanel e={current} busy={busy} action={action} />
                )}
              </div>
            </>
          )}
        </>
      )}
    </main>
  );
}
function ExperimentPanel({
  e,
  busy,
  action,
}: {
  e: LabExperimentView;
  busy: boolean;
  action: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [pair, setPair] = useState(""),
    [preference, setPreference] = useState("tie"),
    [note, setNote] = useState("");
  const pairs = [...new Set(e.runs.map((r) => r.pairKey))],
    key = pairs.includes(pair) ? pair : pairs[0],
    runs = e.runs.filter((r) => r.pairKey === key);
  return (
    <section className="lab-results">
      <div className="lab-panel">
        <div className="eyebrow">
          {e.mode} · {e.lane} · {e.status.replaceAll("_", " ")}
        </div>
        <h2>{e.title}</h2>
        <p>{e.hypothesis}</p>
        <div className="lab-actions">
          {["planned", "paused"].includes(e.status) && (
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                void action(() => api(`/lab/experiments/${e.id}/start`, {}))
              }
            >
              <Play size={17} />{" "}
              {e.status === "paused" ? "Resume" : "Run comparison"}
            </button>
          )}
          {e.status === "running" && (
            <button
              className="button secondary"
              onClick={() =>
                void action(() => api(`/lab/experiments/${e.id}/pause`, {}))
              }
            >
              <Pause size={17} /> Pause after current call
            </button>
          )}
          <a
            href={`/api/lab/experiments/${e.id}/evidence`}
            target="_blank"
            rel="noreferrer"
          >
            {e.evaluationPhase === "release"
              ? "Aggregate release evidence ↗"
              : "Full evidence ↗"}
          </a>
        </div>
        {e.error && (
          <p role="alert" className="alert">
            {e.error}
          </p>
        )}
        {e.evaluationPhase === "release" && (
          <p className="lab-note">
            Held-out evaluation: individual inputs, outputs and critiques remain
            outside development views.
          </p>
        )}
        <div className="lab-metrics">
          <span>
            <b>{e.summary.wins}</b>candidate wins
          </span>
          <span>
            <b>{e.summary.losses}</b>baseline wins
          </span>
          <span>
            <b>{e.summary.ties}</b>ties
          </span>
          <span>
            <b>{e.summary.inconclusive}</b>inconclusive
          </span>
          <span>
            <b>{e.summary.failures}</b>failures
          </span>
          <span>
            <b>{e.summary.repairs}</b>repairs
          </span>
        </div>
        <a
          href={`/api/lab/experiments/${e.id}/report`}
          target="_blank"
          rel="noreferrer"
        >
          Score distribution and review packet ↗
        </a>
        <p className="muted">
          Reserved estimates: {money(e.reservedCents)} / {money(e.maxCents)} ·
          Actual billing: {money(e.summary.actualCents)} · Engineering:{" "}
          {e.engineering}
        </p>
        <details open>
          <summary>Automatic release gates</summary>
          <ul>
            {e.summary.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          {!e.summary.blockers.length && (
            <p>
              All frozen gates passed. This candidate can be activated
              automatically.
            </p>
          )}
        </details>
        <details>
          <summary>Failures and representative non-wins</summary>
          {e.summary.worstCases.map((c) => (
            <p key={c}>{c}</p>
          ))}
          {e.runs
            .filter((r) => r.error)
            .map((r) => (
              <p key={r.id}>
                {r.caseTitle}, {r.side}: {r.error}
              </p>
            ))}
        </details>
      </div>
      {pairs.length > 0 && (
        <>
          <label className="lab-pair-select">
            Blind comparison
            <select
              value={key}
              onChange={(event) => setPair(event.target.value)}
            >
              {pairs.map((k) => (
                <option key={k} value={k}>
                  {e.runs.find((r) => r.pairKey === k)?.caseTitle} · run{" "}
                  {k.split(":")[1]}
                </option>
              ))}
            </select>
          </label>
          <div className="lab-comparison">
            {runs.map((r) => (
              <Artifact key={r.id} run={r} />
            ))}
          </div>
          <details className="lab-panel">
            <summary>Optional observations · never a required step</summary>
            <p>
              Record your own specific findings. The automated loop continues
              without this form. A model preference is not a child’s response.
            </p>
            <label>
              Preference
              <select
                value={preference}
                onChange={(x) => setPreference(x.target.value)}
              >
                <option value="A">A</option>
                <option value="B">B</option>
                <option value="tie">Tie</option>
                <option value="inconclusive">Inconclusive</option>
              </select>
            </label>
            <label>
              Evidence
              <textarea
                value={note}
                onChange={(x) => setNote(x.target.value)}
                placeholder="What specifically worked or failed?"
              />
            </label>
            <button
              className="button secondary"
              disabled={busy || note.trim().length < 12}
              onClick={() =>
                void action(async () => {
                  await api(`/lab/experiments/${e.id}/observations`, {
                    pairKey: key,
                    role: "owner_editor",
                    preference,
                    evidence: note,
                    concerns: "",
                    readerAge: null,
                    rereadRequested: null,
                    observed: "",
                  });
                  setNote("");
                })
              }
            >
              Save optional observation
            </button>
            {e.observations
              .filter((o) => o.pairKey === key)
              .map((o) => (
                <p key={o.id}>
                  {o.preference}: {o.evidence}
                </p>
              ))}
          </details>
        </>
      )}
    </section>
  );
}
function Artifact({ run }: { run: LabRunView }) {
  const o = run.output as {
    storyPlan?: { readerExperience?: unknown };
    scenePlan?: { visualDirection?: unknown };
    mode?: string;
    label?: string;
    title?: string;
    source?: string;
    spreads?: Array<{ text: string; artDirection?: string }>;
    artHashes?: string[];
    renderedHashes?: string[];
    manuscript?: { trueParts?: string };
  } | null;
  const reader = ReaderExperience.safeParse(o?.storyPlan?.readerExperience);
  const visual = VisualDirection.safeParse(o?.scenePlan?.visualDirection);
  return (
    <article className="lab-artifact">
      <header>
        <span className="lab-side">{run.side}</span>
        <div>
          <strong>{o?.title || run.caseTitle}</strong>
          <p className="muted">
            {run.status.replaceAll("_", " ")} · {run.stage.replaceAll("_", " ")}
          </p>
        </div>
      </header>
      {o?.label && <p className="lab-note">{o.label}</p>}
      {o?.source && (
        <details>
          <summary>Ordinary context</summary>
          <p>{o.source}</p>
        </details>
      )}
      {reader.success && (
        <details>
          <summary>Planned reader experience · not observed responses</summary>
          {reader.data.spreads.map((s) => (
            <p key={s.spread}>
              <strong>Spread {s.spread}:</strong> {s.understands} ·
              Anticipation: {s.anticipates} · Discovery: {s.discovers} ·
              Feeling: {s.feels}
            </p>
          ))}
        </details>
      )}
      {visual.success && (
        <details>
          <summary>
            Rough compositions · layout studies, not finished art
          </summary>
          <p>{visual.data.emotionalColorProgression}</p>
          <div className="lab-contact-sheet">
            {visual.data.spreads.map((s) => (
              <figure key={s.spread}>
                <svg
                  viewBox="0 0 200 160"
                  role="img"
                  aria-label={`Spread ${s.spread} rough composition`}
                >
                  <rect width="200" height="160" fill="#f1ead5" />
                  {s.staging.map((c, i) => (
                    <ellipse
                      key={c.characterId}
                      cx={c.center.x * 180 + 10}
                      cy={c.center.y * 130 + 15}
                      rx={c.scale * 60}
                      ry={c.scale * 75}
                      fill={i % 2 ? "#cc633c" : "#56687d"}
                    />
                  ))}
                  <circle
                    cx={s.focalPoint.x * 180 + 10}
                    cy={s.focalPoint.y * 130 + 15}
                    r="3"
                    fill="#343f44"
                  />
                </svg>
                <figcaption>
                  {s.spread}. {s.emotionalPurpose}
                </figcaption>
              </figure>
            ))}
          </div>
        </details>
      )}
      {o?.artHashes?.length ? (
        <div className="lab-contact-sheet">
          {(o.renderedHashes?.length ? o.renderedHashes : o.artHashes).map(
            (h, i) => (
              <a
                href={`/api/projects/${run.projectId}/art/${h}`}
                target="_blank"
                rel="noreferrer"
                key={h}
              >
                <img
                  src={`/api/projects/${run.projectId}/art/${h}`}
                  alt={`Illustration ${i + 1}, version ${run.side}`}
                />
              </a>
            ),
          )}
        </div>
      ) : null}
      {o?.spreads?.map((s, i) => (
        <div className="lab-spread" key={i}>
          <span>{String(i + 1).padStart(2, "0")}</span>
          <p>{s.text}</p>
        </div>
      ))}
      {o?.manuscript?.trueParts && (
        <details>
          <summary>The True Parts</summary>
          <p>{o.manuscript.trueParts}</p>
        </details>
      )}
      {!o && (
        <p>The retained artifact will appear here after this stage finishes.</p>
      )}
      {run.projectId && o?.artHashes?.length === 12 && (
        <a href={`#/story/${run.projectId}`}>Read the complete book ↗</a>
      )}
      {run.error && <p className="alert">{run.error}</p>}
      <details>
        <summary>
          {run.calls.length} recorded calls · {run.attempts.length} checkpoints
        </summary>
        {run.calls.map((c, i) => (
          <p className="muted" key={i}>
            {c.stage}: {c.status} · {money(c.estimatedCents)} reserved ·{" "}
            {c.latencyMs ?? "?"} ms
          </p>
        ))}
      </details>
    </article>
  );
}
