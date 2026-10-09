import { useEffect, useRef, useState } from "react";
import { ArrowRight, Sparkles } from "lucide-react";
import type { ProjectView } from "../shared/contracts.js";
import type { EngineAvailability } from "../shared/engine.js";
import type { StudioSetupView } from "../shared/studioSetup.js";
import { api } from "./api.js";
import { StudioSetup } from "./StudioSetup.js";
import { StudioReviews } from "./StudioReviews.js";

export function StudioStatus() {
  const [status, setStatus] = useState<EngineAvailability>();
  useEffect(() => {
    void api<EngineAvailability>("/engine")
      .then(setStatus)
      .catch(() => undefined);
  }, []);
  return (
    <p className="small muted">
      {status?.message ?? "Checking the story studio connection…"}
    </p>
  );
}
const stageName = (stage: string) => {
  if (stage.startsWith("picture_"))
    return `${stage.includes("review") ? "Checking illustration" : "Painting illustration"} ${stage.split("_")[1]} of 12`;
  if (stage.startsWith("draft_") || stage.startsWith("refine_"))
    return "Finding the telling that feels just right";
  if (stage.startsWith("canon_"))
    return "Painting your family’s recurring characters";
  if (stage.startsWith("craft_") || stage.startsWith("revision_"))
    return "Polishing the read-aloud story";
  if (stage.startsWith("art_review") || stage === "whole_book_review")
    return "Checking all twelve illustrations together";
  if (stage.startsWith("heart_")) return "Checking the heart of your memory";
  if (stage.startsWith("evidence_") || stage.startsWith("editorial_"))
    return "Checking the story and its connection to your memory";
  return (
    (
      {
        transcription: "Listening to your memory",
        heart: "Finding what you want to pass on",
        concepts: "Exploring three ways to tell your story",
        concept_review: "Choosing a story full of possibility",
        story_plan: "Building anticipation, wonder and a meaningful ending",
        world: "Imagining your family as animal characters",
        scenes: "Planning the book’s visual journey",
        architecture: "Finding the adventure in your memory",
        manuscript: "Writing a story to read together",
        character_reference: "Designing your story’s visual world",
        accepted_manuscript: "Preparing the illustrations",
      } as Record<string, string>
    )[stage] ?? "Preparing your story"
  );
};
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
    [retryConsent, setRetryConsent] = useState(false),
    [error, setError] = useState("");
  const run = project.engine;
  const setupRef = useRef<HTMLDetailsElement>(null);
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
      .then(setFamilies)
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
    } catch (cause) {
      setError((cause as Error).message);
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
      <span className="eyebrow">
        <Sparkles size={18} /> THE EVERLORE STORY STUDIO
      </span>
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
              Your family in this book
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
          <p className="studio-note">
            Inspired by your life. Free to be magical. The story can add
            imagined scenes, dialogue and adventures; your original voice stays
            preserved.
          </p>
          <p className="notice">
            {connection?.message ?? "Checking the studio connection…"}
          </p>
          {connection && (
            <StudioSetup
              state={connection}
              detailsRef={setupRef}
              onConnected={(updated) => {
                setConnection(updated);
                setError("");
              }}
            />
          )}
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
                  connection?.message ??
                    "Check the studio connection before starting your story.",
                );
                if (setupRef.current) {
                  setupRef.current.open = true;
                  setupRef.current.querySelector("summary")?.focus();
                  setupRef.current.scrollIntoView({
                    block: "start",
                    behavior: "smooth",
                  });
                }
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
              ? "First save your private connection and an allowance that covers one book."
              : !consent
                ? "One last step: check the recording-sharing box above."
                : "Ready when you are. Creating the book uses your saved allowance."}
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
      {run && ["queued", "running"].includes(run.status) && (
        <div aria-live="polite">
          <h2>{stageName(run.stage)}</h2>
          {connection?.ready ? (
            <p className="loading">Making room for wonder…</p>
          ) : (
            <p className="notice">
              {connection?.message ?? "Checking the studio connection…"}
            </p>
          )}
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
          <h2>
            {"kind" in run && run.recovery
              ? "Your story is safely paused."
              : "A little more care is needed."}
          </h2>
          <p role="status">
            {"kind" in run && run.recovery ? run.recovery.message : run.error}
          </p>
          <p>Your original memory and completed work are saved.</p>
          {"kind" in run && run.recovery && (
            <>
              <p className="small muted">
                Saved stage: {stageName(run.recovery.stage)}
              </p>
              {connection?.message !== run.recovery.message && (
                <p className="notice">
                  {connection?.message ?? "Checking your connection…"}
                </p>
              )}
              {connection && (
                <StudioSetup
                  state={connection}
                  detailsRef={setupRef}
                  additionalReserveUsd={
                    run.recovery.resumeReserveUsd ??
                    run.recovery.extraReserveUsd
                  }
                  nextAction="Connection checked and saved. Resume your saved story below."
                  onConnected={(updated) => {
                    setConnection(updated);
                    setError("");
                  }}
                />
              )}
              {run.recovery.uncertain && (
                <label className="consent">
                  <input
                    type="checkbox"
                    checked={retryConsent}
                    onChange={(event) => setRetryConsent(event.target.checked)}
                  />
                  <span>
                    I understand the earlier attempt may have been charged.
                    Retry this unfinished step using up to $
                    {run.recovery.extraReserveUsd.toFixed(2)} more of my saved
                    allowance. Keep completed steps.
                  </span>
                </label>
              )}
              <button
                className="button full"
                disabled={busy}
                onClick={() => {
                  if (!connection?.ready) {
                    setError(
                      connection?.message ??
                        "Check your connection before resuming.",
                    );
                    if (setupRef.current) {
                      setupRef.current.open = true;
                      setupRef.current.querySelector("summary")?.focus();
                    }
                    return;
                  }
                  if (run.recovery!.uncertain && !retryConsent) {
                    setError(
                      "Check the possible-charge acknowledgment above before retrying this older attempt.",
                    );
                    return;
                  }
                  const acknowledgePossibleCharge = retryConsent;
                  setRetryConsent(false);
                  void act("/resume", {
                    jobId: run.id,
                    callId: run.recovery!.callId,
                    acknowledgePossibleCharge,
                  });
                }}
              >
                {busy ? "Resuming your saved story…" : "Resume saved story"}
              </button>
              <p className="small muted">
                Completed stages will be reused. This resumes the existing book
                and reserves only its remaining work again.
              </p>
              {run.recovery.requestId && (
                <details className="source-details">
                  <summary>Technical details for this attempt</summary>
                  <p>Provider request: {run.recovery.requestId}</p>
                </details>
              )}
            </>
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
