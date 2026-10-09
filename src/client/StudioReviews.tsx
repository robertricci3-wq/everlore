import { useState } from "react";
import type { StudioView, Heart } from "../shared/studio.js";
import type { ProjectView } from "../shared/contracts.js";
import { api } from "./api.js";
export function HeartReviewForm({
  heart,
  heartHash,
  busy,
  act,
}: {
  heart: Heart;
  heartHash: string;
  busy: boolean;
  act: (path: string, data: object) => Promise<void>;
}) {
  const [summary, setSummary] = useState(heart.summary),
    [meaning, setMeaning] = useState(heart.emotionalInheritance),
    [notes, setNotes] = useState(heart.adultNotes),
    [protectedIds, setProtectedIds] = useState(
      heart.ledger.filter((e) => e.tier === "protected").map((e) => e.nuggetId),
    ),
    [answers, setAnswers] = useState(
      heart.questions.map((q) => ({ id: q.id, answer: q.answer })),
    );
  return (
    <div className="heart-review">
      <span className="eyebrow">THE HEART, BEFORE THE ADVENTURE</span>
      <h2>What we’ll carry into the story.</h2>
      <p>
        This is our reading of your memory. Keep what feels true, change what
        doesn’t, and leave room for a little wonder.
      </p>
      <label>
        Your story’s heart
        <textarea
          rows={3}
          value={summary}
          maxLength={3000}
          onChange={(e) => setSummary(e.target.value)}
        />
      </label>
      <label>
        What you hope will live on
        <textarea
          rows={3}
          value={meaning}
          maxLength={3000}
          onChange={(e) => setMeaning(e.target.value)}
        />
      </label>
      <fieldset>
        <legend>These details make it yours</legend>
        <p className="small muted">
          Keep a tick beside the details the imagined story must protect.
        </p>
        {heart.nuggets.map((n) => (
          <label className="consent" key={n.id}>
            <input
              type="checkbox"
              checked={protectedIds.includes(n.id)}
              onChange={(e) =>
                setProtectedIds(
                  e.target.checked
                    ? [...protectedIds, n.id]
                    : protectedIds.filter((id) => id !== n.id),
                )
              }
            />
            <span>
              {n.text}
              <small className="source-quote">You said: “{n.quote}”</small>
            </span>
          </label>
        ))}
      </fieldset>
      {heart.questions.map((q) => (
        <label key={q.id}>
          {q.question} {q.essential ? "(Needed before we begin)" : "(Optional)"}
          <small className="source-quote">{q.whyItMatters}</small>
          <textarea
            rows={2}
            value={answers.find((a) => a.id === q.id)?.answer ?? ""}
            onChange={(e) =>
              setAnswers(
                answers.map((a) =>
                  a.id === q.id ? { ...a, answer: e.target.value } : a,
                ),
              )
            }
            maxLength={1500}
          />
        </label>
      ))}
      <label>
        Anything else we should keep in mind?{" "}
        <span className="small muted">(Optional)</span>
        <textarea
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={3000}
        />
      </label>
      <button
        className="button full"
        disabled={
          busy ||
          !summary.trim() ||
          !meaning.trim() ||
          !protectedIds.length ||
          heart.questions.some(
            (q) =>
              q.essential && !answers.find((a) => a.id === q.id)?.answer.trim(),
          )
        }
        onClick={() =>
          void act("/heart", {
            heartHash,
            summary,
            emotionalInheritance: meaning,
            protectedIds,
            adultNotes: notes,
            answers,
          })
        }
      >
        That’s the heart. Let it grow.
      </button>
    </div>
  );
}
export function StudioReviews({
  run,
  projectId,
  busy,
  act,
}: {
  run: StudioView;
  projectId: string;
  busy: boolean;
  act: (path: string, data: object) => Promise<void>;
}) {
  return (
    <>
      {run.status === "awaiting_heart" && run.heart && run.heartHash && (
        <HeartReviewForm
          key={run.heartHash}
          heart={run.heart}
          heartHash={run.heartHash}
          busy={busy}
          act={act}
        />
      )}
      {run.status === "awaiting_cast" && run.world && (
        <>
          <span className="eyebrow">A FAMILY YOU’LL RECOGNIZE</span>
          <h2>Your family, in a new little world.</h2>
          <p>
            These animal characters will carry your family’s names and
            relationships from one story to the next. Check their ages, colors,
            and meaningful details before we paint the book.
          </p>
          <ul>
            {run.world.characters.map((c) => (
              <li key={c.id}>
                <strong>{c.name}</strong> — {c.relationship}, represented as a{" "}
                {c.species}. {c.ageState}. {c.signatureDetail}
              </li>
            ))}
          </ul>
          <div className="studio-preview canon-preview">
            {run.references.map((r) => (
              <figure key={r.hash}>
                <img
                  src={`/api/projects/${projectId}/art/${r.hash}`}
                  alt={
                    r.role === "identity"
                      ? "Proposed family character views"
                      : "Proposed family gestures and meaningful objects"
                  }
                />
                <figcaption>
                  {r.role === "identity"
                    ? "Meet the family"
                    : "How they move together"}
                </figcaption>
              </figure>
            ))}
          </div>
          <button
            className="button full"
            disabled={busy}
            onClick={() => void act("/cast", { approved: true })}
          >
            Keep this family cast
          </button>
          <p className="small muted">
            Approve only when every view feels consistent. Your original memory
            stays unchanged.
          </p>
        </>
      )}
      {run.kind === "generation" &&
        ["awaiting_cast", "awaiting_art", "needs_editor"].includes(
          run.status,
        ) &&
        run.concepts && (
          <details className="source-details">
            <summary>Try a different story direction</summary>
            <p>
              We explored three ways to tell your memory. Choosing another keeps
              the heart and creates a new draft; it uses another reserved
              generation allowance.
            </p>
            {run.concepts.concepts.map((c) => (
              <article className="concept-card" key={c.id}>
                <h3>{c.title}</h3>
                <p>{c.premise}</p>
                <p className="small muted">{c.whyThisServesTheHeart}</p>
                <button
                  className="button secondary"
                  disabled={busy || c.id === run.selectedConceptId}
                  onClick={() =>
                    void act("/direction", { conceptId: c.id, jobId: run.id })
                  }
                >
                  {c.id === run.selectedConceptId
                    ? "Current direction"
                    : "Tell it this way"}
                </button>
              </article>
            ))}
          </details>
        )}
    </>
  );
}
export function StudioRepair({
  project,
  refresh,
}: {
  project: ProjectView;
  refresh: () => Promise<void>;
}) {
  const [kind, setKind] = useState("wording"),
    [spread, setSpread] = useState(1),
    [characterId, setCharacterId] = useState(project.book!.people[0]?.id ?? ""),
    [defect, setDefect] = useState(""),
    [change, setChange] = useState(""),
    [preserve, setPreserve] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const active = !!project.engine && project.engine.status !== "complete";
  async function submit() {
    setBusy(true);
    setError("");
    try {
      await api(`/projects/${project.id}/engine/repair`, {
        key: crypto.randomUUID(),
        baseRevision: project.book!.revision,
        kind,
        spreads:
          kind === "character"
            ? project.book!.spreads.flatMap((s, i) =>
                s.characterIds.includes(characterId) ? [i + 1] : [],
              )
            : [spread],
        characterId: kind === "character" ? characterId : null,
        defect,
        intendedChange: change,
        preserve,
      });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="source-details">
      <summary>Refine this story</summary>
      <p>
        Tell us what needs care. The current book and saved editions stay intact
        while a new revision is prepared.
      </p>
      <label>
        What needs changing?
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="wording">The words on one spread</option>
          <option value="scene">A picture on one spread</option>
          <option value="character">A character’s appearance throughout</option>
        </select>
      </label>
      {kind === "character" ? (
        <label>
          Family character
          <select
            value={characterId}
            onChange={(e) => setCharacterId(e.target.value)}
          >
            {project.book!.people.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label>
          Spread
          <select
            value={spread}
            onChange={(e) => setSpread(Number(e.target.value))}
          >
            {Array.from({ length: 12 }, (_, i) => (
              <option key={i} value={i + 1}>
                Spread {i + 1}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        What doesn’t feel right?
        <textarea
          rows={2}
          value={defect}
          maxLength={1500}
          onChange={(e) => setDefect(e.target.value)}
        />
      </label>
      <label>
        What would you like instead?
        <textarea
          rows={2}
          value={change}
          maxLength={1500}
          onChange={(e) => setChange(e.target.value)}
        />
      </label>
      <label>
        Anything we should be careful to keep?{" "}
        <span className="small muted">(Optional)</span>
        <textarea
          rows={2}
          value={preserve}
          maxLength={1500}
          onChange={(e) => setPreserve(e.target.value)}
        />
      </label>
      <button
        className="button"
        disabled={
          busy || active || defect.trim().length < 3 || change.trim().length < 3
        }
        onClick={() => void submit()}
      >
        {busy ? "Saving your request…" : "Prepare a revised draft"}
      </button>
      {active && (
        <p className="notice">
          Your current revision is still being prepared or reviewed.
        </p>
      )}
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
    </details>
  );
}
