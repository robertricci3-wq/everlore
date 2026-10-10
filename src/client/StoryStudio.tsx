import { useEffect, useRef, useState } from "react";
import type { ContinuityQuestion } from "../shared/continuity.js";
import { ArrowRight, Sparkles } from "lucide-react";
import type { ProjectView } from "../shared/contracts.js";

import type { StudioSetupView } from "../shared/studioSetup.js";
import { api } from "./api.js";
import { StudioSetup } from "./StudioSetup.js";
import { StudioReviews } from "./StudioReviews.js";

export function StudioStatus() {
  const [status, setStatus] = useState<{ ready: boolean }>();
  useEffect(() => {
    void api<{ ready: boolean }>("/engine")
      .then(setStatus)
      .catch(() => undefined);
  }, []);
  return (
    <p className="small muted">
      {status
        ? status.ready
          ? "Your story studio is ready."
          : "Story creation is not enabled right now. Your saved memories are safe."
        : "Checking story availability…"}
    </p>
  );
}
const stageName = (stage: string) => {
  if (stage === "transcription") return "Listening to your memory";
  if (stage.startsWith("picture_") || stage.startsWith("canon_") || stage.startsWith("art_review") || ["character_reference", "whole_book_review"].includes(stage)) return "Illustrating your book";
  return "Creating your story";
};
/* Internal stages stay internal; the customer sees a stable, honest summary. */
export function IdentityQuestion({question, busy, act}: {question: ContinuityQuestion; busy: boolean; act: (path:string, body:object)=>Promise<void>}) {
  const [text, setText] = useState("");
  const key = useRef(crypto.randomUUID());
  return <section className="identity-question">
    <span className="eyebrow">ONE DETAIL BEFORE WE CONTINUE</span>
    <h2>{question.prompt}</h2>
    {question.kind === "relationship" && <label>Your answer<textarea rows={2} value={text} maxLength={1500} onChange={(e) => setText(e.target.value)}/></label>}
    <div className="memory-choices">{question.options.map((option) => <button key={option.id} className={option.id === "unspecified" ? "text-button" : "button secondary identity-choice"} disabled={busy || (option.id === "answer" && !text.trim())} onClick={() => void act("/continuity", {questionId:question.id, answerId:option.id, key:key.current, ...(option.id === "answer" ? {text} : {})})}><span>{option.label}</span>{option.detail && <small>{option.detail}</small>}</button>)}</div>
    {question.allowUnspecified && !question.options.some((o) => o.id === "unspecified") && <button className="text-button" disabled={busy} onClick={() => void act("/continuity", {questionId:question.id, answerId:"unspecified", key:key.current})}>I’m not sure</button>}
    <p className="small muted">We’ll keep your original memory as you told it.</p>
  </section>;
}
export function StoryStudio({
  project,
  refresh,
}: {
  project: ProjectView;
  refresh: () => Promise<void>;
}) {
  const [connection, setConnection] = useState<StudioSetupView>(),
    [families, setFamilies] = useState<{ id: string; name: string }[]>([]),
    [familyId, setFamilyId] = useState(""),
    [consent, setConsent] = useState(false),
    [wish, setWish] = useState(""),
    [source, setSource] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const run = project.engine;
  const consentRef = useRef<HTMLInputElement>(null);
  async function loadConnection() {
    try {
      setConnection(await api<StudioSetupView>("/studio-setup"));
      setError("");
    } catch {
      setError(
        "The story studio could not be reached. Retry the connection check below.",
      );
    }
  }
  useEffect(() => {
    void api<{ id: string; name: string }[]>("/families")
      .then((saved) => {
        setFamilies(saved);
        setFamilyId(saved[0]?.id ?? "");
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    void loadConnection();
  }, []);
  async function act(path: string, data: object) {
    setBusy(true);
    setError("");
    try {
      await api(`/projects/${project.id}/engine${path}`, data);
      await refresh();
    } catch {
      setError(
        "This step could not finish yet. Your memory and completed work are saved. Please try again later or contact Everlore.",
      );
      if (path === "/resume")
        void api<StudioSetupView>("/studio-setup")
          .then(setConnection)
          .catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="story-studio">
      {!run && <span className="eyebrow"><Sparkles size={18} /> YOUR MEMORY, MADE EXTRAORDINARY</span>}
      {!run && (
        <>
          <h2>
            A memory from you.
            <br />
            <em>A whole world for them.</em>
          </h2>
          <p>
            Your story doesn’t need to come out perfectly. We look for its
            heart, give it an adventure, and build a richly illustrated world
            around it.
          </p>
          <label>
            What would you love your grandchild to carry with them?{" "}
            <span className="small muted">(Optional)</span>
            <textarea
              rows={3}
              maxLength={1000}
              placeholder="That they can be brave, even when they feel small…"
              value={wish}
              onChange={(e) => setWish(e.target.value)}
            />
          </label>
          {!!families.length && (
            <label>
              Use these characters
              <select
                value={familyId}
                onChange={(e) => setFamilyId(e.target.value)}
              >
                <option value="">Create a new animal family</option>
                {families.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!!families.length && (
            <p className="small muted">
              Your most recently saved family is selected. This choice is for
              this new book; earlier books stay as they are.
            </p>
          )}
          <p className="studio-note">
            Inspired by your life. Free to be magical. The story can add
            imagined scenes, dialogue and adventures; your original voice stays
            preserved.
          </p>
          <p className="notice">
            {connection
              ? connection.canStart
                ? "Your story studio is ready."
                : "Story creation is not enabled right now. Your memory is saved; contact Everlore for help."
              : "Checking story availability…"}
          </p>
          {connection?.canStart && (
            <label className="consent">
              <input
                type="checkbox"
                ref={consentRef}
                checked={consent}
                onChange={(e) => {
                  setConsent(e.target.checked);
                  setError("");
                }}
              />
              <span>
                I want an imaginative adaptation. Send this recording and its
                story materials to OpenAI to create my book.
              </span>
            </label>
          )}
          {!connection && error && (
            <button
              className="button secondary"
              onClick={() => void loadConnection()}
            >
              Retry connection check
            </button>
          )}
          <button
            className="button full"
            disabled={busy}
            onClick={() => {
              if (!connection?.canStart) {
                setError(
                  "Story creation is not enabled right now. Your memory is saved; contact Everlore for help.",
                );
                return;
              }
              if (!consent) {
                setError(
                  "Check the recording-sharing box above to allow OpenAI to create this book.",
                );
                consentRef.current?.focus();
                return;
              }
              void act("", {
                processWithOpenAI: true,
                imaginativeAdaptation: true,
                legacyWish: wish,
                familyVersionId: familyId || null,
              });
            }}
          >
            Make my legacy story <ArrowRight size={19} />
          </button>
          <p className="small muted">
            {!connection?.canStart
              ? "Your memory is saved while story creation is unavailable."
              : !consent
                ? "One last step: check the recording-sharing box above."
                : "Ready when you are. We will take care of creating your book."}
          </p>
          <p className="small muted">
            The studio develops, checks and refines your story and illustrations
            automatically. You can make changes afterward.
          </p>
        </>
      )}
      {run && "kind" in run && (
        <StudioReviews run={run} projectId={project.id} busy={busy} act={act} />
      )}
      {run && "continuity" in run && run.continuity?.question && <IdentityQuestion key={run.continuity.question.id} question={run.continuity.question} busy={busy} act={act}/>}
      {run && ["queued", "running"].includes(run.status) && (
        <div aria-live="polite">
          <h2>{stageName(run.stage)}</h2>
          {"progressPreview" in run && run.progressPreview && <figure className="progress-art"><img src={`/api/projects/${project.id}/art/${run.progressPreview.artHash}`} alt={run.progressPreview.alt}/><figcaption>A first look inside your book.</figcaption></figure>}
          <p>
            Each completed step is saved. You can leave this page and come back.
          </p>
        </div>
      )}
      {run?.status === "awaiting_source" && (
        <>
          <h2>Your voice is the beginning.</h2>
          <p>
            Check names and the important details. The story will grow from
            these words; it can be much more imaginative than the memory itself.
          </p>
          <audio
            controls
            src={`/api/projects/${project.id}/audio`}
            aria-label="Your original memory"
          />
          <label>
            Your words
            <textarea
              rows={10}
              maxLength={50000}
              readOnly={!!project.transcript}
              value={source ?? run.transcript ?? ""}
              onChange={(e) => setSource(e.target.value)}
            />
          </label>
          <button
            className="button full"
            disabled={
              busy || (source ?? run.transcript ?? "").trim().length < 10
            }
            onClick={() =>
              void act("/source", {
                confirmed: true,
                rawText: source ?? run.transcript,
              })
            }
          >
            These words are ready <ArrowRight size={19} />
          </button>
        </>
      )}
      {run?.status === "awaiting_art" && run.preview && (
        <>
          <h2>{run.preview.title}</h2>
          <p className="lead">{run.preview.heart}</p>
          <p>
            Here’s the beginning, middle and near-ending. Look at the
            characters, warmth and sense of wonder before we paint the remaining
            pages.
          </p>
          <div className="studio-preview">
            {run.preview.spreads.map((spread, i) => (
              <figure key={spread.artHash}>
                <img
                  src={`/api/projects/${project.id}/art/${spread.artHash}`}
                  alt={spread.artDescription}
                />
                <figcaption>
                  <span className="eyebrow">
                    {["THE BEGINNING", "THE MIDDLE", "NEAR THE END"][i]}
                  </span>
                  <p>{spread.text}</p>
                </figcaption>
              </figure>
            ))}
          </div>
          <details className="source-details">
            <summary>What the story imagines</summary>
            <ul>
              {run.preview.inventions.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </details>
          <button
            className="button full"
            disabled={busy}
            onClick={() => void act("/art", { approved: true })}
          >
            I love this direction. Finish the book <ArrowRight size={19} />
          </button>
          <p className="small muted">
            If this direction doesn’t feel right, leave it here for an editor.
            The remaining pages won’t be commissioned.
          </p>
        </>
      )}
      {run && ["needs_attention", "needs_editor"].includes(run.status) && (
        <>
          <h2>Your story is safely paused.</h2>
          <p role="status">
            The studio needs attention before it can continue. Everlore can help
            recover this story from its saved progress.
          </p>
          <p>Your original memory and completed work are saved.</p>
          {"kind" in run && run.recovery && (
            <p className="small muted">
              {stageName(run.recovery.stage)}
            </p>
          )}
        </>
      )}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** Render only on the authenticated operator route. The API independently enforces ownership. */
export function OperatorStudioSetup() {
  const [state, setState] = useState<StudioSetupView>();
  const [error, setError] = useState("");
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    void api<StudioSetupView>("/operator/studio-setup")
      .then(setState)
      .catch((cause) => setError((cause as Error).message));
  }, []);
  return (
    <section className="narrow project-state">
      <span className="eyebrow">EVERLORE OPERATOR</span>
      <h1>Story service</h1>
      <p>
        Manage the service connection and existing generation allowance here.
        Families only choose their memory and consent to story creation.
      </p>
      <p>
        <a href="#/operator/costs">
          View book costs and saved recovery checkpoints
        </a>
      </p>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      {state ? (
        <>
          <p className="notice">{state.message}</p>
          <StudioSetup
            state={state}
            detailsRef={detailsRef}
            onConnected={setState}
            endpoint="/operator/studio-setup"
            nextAction="Service settings saved. Families can create stories when their invitation and the service are ready."
          />
        </>
      ) : (
        !error && <p>Loading service settings…</p>
      )}
    </section>
  );
}
