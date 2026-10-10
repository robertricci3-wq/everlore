import { Purchase } from "./Purchase.js";
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  Download,
  Grid2X2,
  Pencil,
  X,
} from "lucide-react";
import type {
  BookDocument,
  EditionView,
  ProjectView,
} from "../shared/contracts.js";
import { api } from "./api.js";
import { StudioRepair } from "./StudioReviews.js";
import "./Reader.css";

export function Reader({
  project,
  refresh,
  editionId,
}: {
  project: ProjectView;
  refresh: () => Promise<void>;
  editionId?: string;
}) {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);
  const [page, setPage] = useState(-1),
    [view, setView] = useState("book"),
    [modal, setModal] = useState(""),
    [kind, setKind] = useState("name"),
    [person, setPerson] = useState(project.book!.people[0]?.id ?? ""),
    [name, setName] = useState(""),
    [detail, setDetail] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [editionError, setEditionError] = useState(""),
    [snapshot, setSnapshot] = useState<{
      id: string;
      book: BookDocument;
    } | null>(null);
  useEffect(() => {
    let alive = true;
    if (editionId) {
      void api<{ book: BookDocument }>(
        `/projects/${project.id}/editions/${editionId}`,
      )
        .then(({ book }) => {
          if (alive) {
            setSnapshot({ id: editionId, book });
            setPage(-1);
            setEditionError("");
          }
        })
        .catch(() => {
          if (alive)
            setEditionError(
              "This saved edition could not be opened. Your current book is still available.",
            );
        });
    } else {
      setSnapshot(null);
      setEditionError("");
    }
    return () => {
      alive = false;
    };
  }, [editionId, project.id]);
  const book = snapshot?.book ?? project.book!;
  const art = (i: number) =>
    `/api/projects/${project.id}/art/${book.spreads[i].artHash}`;
  const selectedEdition = snapshot
    ? project.editions.find((e) => e.id === snapshot.id)
    : project.editions.find(
        (e) =>
          e.revision === book.revision && e.contentHash === book.contentHash,
      );
  async function download() {
    setBusy(true);
    setError("");
    try {
      const edition = await api<EditionView>(
        `/projects/${project.id}/editions`,
        {
          baseRevision: book.revision,
          contentHash: book.contentHash,
        },
      );
      location.assign(`/api/projects/${project.id}/editions/${edition.id}/pdf`);
      await refresh();
      setMessage(
        "This edition is saved. Its words, pictures, and review PDF are now fixed.",
      );
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function correct() {
    setBusy(true);
    setError("");
    try {
      if (kind === "name") {
        await api(`/projects/${project.id}/rename`, {
          baseRevision: book.revision,
          personId: person,
          newName: name,
          key: crypto.randomUUID(),
        });
        setMessage(
          "Name corrected throughout the book. The original source and earlier editions are preserved.",
        );
      } else {
        await api(`/projects/${project.id}/corrections`, {
          baseRevision: book.revision,
          kind,
          detail,
          spreadId: page < 0 ? null : book.spreads[page].id,
        });
        setMessage(
          "Your request is saved for editorial review. The book has not changed; an editor needs to apply this revision.",
        );
      }
      await refresh();
      setModal("");
      setName("");
      setDetail("");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function openEdition(edition: EditionView) {
    location.hash = `/story/${project.id}/edition/${edition.id}`;
  }
  if (editionId && snapshot?.id !== editionId) {
    return (
      <section className="reader-page">
        {editionError ? (
          <p className="alert" role="alert">
            {editionError}
          </p>
        ) : (
          <p role="status">Opening your saved edition…</p>
        )}
        <a href={`#/story/${project.id}`}>Read your current book</a>
      </section>
    );
  }
  const pendingChange =
    !snapshot &&
    (project.corrections.length > 0 ||
      (!!project.engine && project.engine.status !== "complete"));
  return (
    <section className="reader-page enter">
      <div className="reader-heading">
        <div>
          <div className="eyebrow">A LITTLE STORY, READY TO READ</div>
          <h1>{book.title}</h1>
          <p>
            {book.byline} <span className="dot-separator">·</span> Ages 4–7{" "}
            <span className="dot-separator">·</span> 12 spreads
          </p>
        </div>
        <span className="pill">
          {book.adaptation ? "Inspired by your family" : "Synthetic example"}
        </span>
      </div>
      {snapshot && (
        <div className="edition-banner">
          You’re reading a saved edition.{" "}
          <a href={`#/story/${project.id}`}>Return to current book</a>
        </div>
      )}
      {error && !modal && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="success" role="status">
          <Check size={18} />
          {message}
        </p>
      )}
      {(book.production?.editorialStatus === "revision_recommended" ||
        book.production?.artStatus === "revision_recommended") && (
        <details className="source-details">
          <summary>Illustrated review copy · refinements remain</summary>
          <p>
            The full book is available to read. These model review notes remain
            open; this is not a claim of final literary approval or observed
            child engagement.
          </p>
          <ul>
            {[
              ...(book.production.editorialNotes ?? []),
              ...(book.production.artNotes ?? []),
            ].map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </details>
      )}
      {view === "book" && (
        <>
          <div className={`open-book ${page < 0 ? "cover" : ""}`}>
            <div className="art-page">
              <img
                src={art(Math.max(0, page))}
                alt={book.spreads[Math.max(0, page)].artDescription}
              />
            </div>
            <div className="words-page">
              {page < 0 ? (
                <div className="cover-words">
                  <span className="eyebrow">EVERLORE · STORIES TO KEEP</span>
                  <h2>{book.title}</h2>
                  <div className="little-rule" />
                  <p>{book.byline}</p>
                  <span className="small muted">
                    {book.production
                      ? "Your family. A world of wonder."
                      : "A little patience. Three little buttons."}
                    <br />A memory for always.
                  </span>
                </div>
              ) : (
                <>
                  <span className="spread-label">
                    EVERLORE / A FAMILY STORY
                  </span>
                  <svg
                    className="measured-text"
                    viewBox="600 0 600 600"
                    role="img"
                    aria-label={book.spreads[page].text}
                  >
                    <text
                      x="680"
                      fill="currentColor"
                      fontFamily="EverloreBook"
                      fontSize="24"
                    >
                      {book.spreads[page].lines.map((line, i) => (
                        <tspan
                          key={i}
                          x="680"
                          y={
                            (600 - book.spreads[page].lines.length * 38) / 2 +
                            22 +
                            i * 38
                          }
                        >
                          {line}
                        </tspan>
                      ))}
                    </text>
                  </svg>
                  <p className="mobile-story">{book.spreads[page].text}</p>
                  <span className="page-number">
                    {String(page + 1).padStart(2, "0")}
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="pagination">
            <button
              className="button secondary"
              disabled={page === -1}
              onClick={() => setPage((p) => p - 1)}
              aria-label="Previous spread"
            >
              <ArrowLeft size={20} /> Back
            </button>
            <span aria-live="polite">
              {page < 0 ? "The cover" : `Spread ${page + 1} of 12`}
            </span>
            <button
              className="button secondary"
              disabled={page === 11}
              onClick={() => setPage((p) => p + 1)}
              aria-label="Next spread"
            >
              Next <ArrowRight size={20} />
            </button>
          </div>
        </>
      )}
      {view === "text" && (
        <article className="manuscript">
          {book.spreads.map((spread, i) => (
            <section key={spread.id}>
              <span className="eyebrow">SPREAD {i + 1}</span>
              <p>{spread.text}</p>
              <details>
                <summary>
                  {book.adaptation
                    ? "The memory behind this imagined scene"
                    : "From the memory"}
                </summary>
                {spread.claimIds.map((cid) => {
                  const claim = book.ledger.find((c) => c.id === cid)!;
                  return (
                    <blockquote key={cid}>
                      <p>{claim.text}</p>
                      <small>
                        Source {claim.sourceIds.join(", ")}
                        {claim.clarification ? ` · ${claim.clarification}` : ""}
                      </small>
                    </blockquote>
                  );
                })}
              </details>
            </section>
          ))}
        </article>
      )}
      {view === "grid" && (
        <div className="contact-grid">
          {book.spreads.map((spread, i) => (
            <button
              key={spread.id}
              onClick={() => {
                setPage(i);
                setView("book");
              }}
            >
              <img src={art(i)} alt={spread.artDescription} />
              <span>
                {String(i + 1).padStart(2, "0")}
                <span>{spread.text.split(". ")[0]}.</span>
              </span>
            </button>
          ))}
        </div>
      )}
      <p className="reader-disclosure">
        {book.adaptation
          ? "An imaginative story inspired by a family memory, with AI-generated illustrations. Scenes and dialogue may be invented. Your original recording is preserved."
          : "This is a synthetic story with designed sample illustrations. Human creative review is still pending."}
      </p>
      {!!project.corrections.length && !snapshot && (
        <div className="notice">
          <strong>Your requested changes are being reviewed</strong>
          {project.corrections.map((correction) => (
            <p key={correction.id}>{correction.detail}</p>
          ))}
          <p>
            This book has not changed yet. We’ll keep the current version
            available while the changes are resolved.
          </p>
        </div>
      )}
      <Purchase
        key={`${project.id}:${snapshot?.id ?? book.contentHash}`}
        projectId={project.id}
        book={book}
        editionId={snapshot?.id ?? selectedEdition?.id}
        blockedReason={
          pendingChange
            ? "Your requested changes need to finish before ordering this version."
            : undefined
        }
        refresh={refresh}
      />
      <details className="reader-options">
        <summary>Book options</summary>
        <div className="reader-options-content">
          <div className="reader-tools">
            <div className="segmented" aria-label="Reader views">
              {[
                ["book", "Book"],
                ["text", "Read the words"],
                ["grid", "All pictures"],
              ].map(([id, label]) => (
                <button
                  key={id}
                  className={view === id ? "selected" : ""}
                  onClick={() => {
                    setView(id);
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                >
                  {id === "book" ? (
                    <BookOpen size={16} />
                  ) : id === "grid" ? (
                    <Grid2X2 size={16} />
                  ) : null}
                  {label}
                </button>
              ))}
            </div>
            <span className="small muted">
              {snapshot ? "Saved edition" : "Working copy"} · Revision{" "}
              {book.revision}
            </span>
          </div>
          <div className="reader-secondary-actions">
            {selectedEdition || snapshot ? (
              <a
                className="button secondary"
                href={`/api/projects/${project.id}/editions/${snapshot?.id ?? selectedEdition!.id}/pdf`}
              >
                <Download size={18} /> Download review PDF
              </a>
            ) : (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void download()}
              >
                <Download size={18} />{" "}
                {busy ? "Preparing your PDF…" : "Download review PDF"}
              </button>
            )}
            {!snapshot && !book.production && (
              <button
                className="button secondary"
                onClick={() => {
                  setError("");
                  setModal("correction");
                }}
              >
                <Pencil size={18} /> Change something
              </button>
            )}
          </div>
          {book.production && !snapshot && (
            <StudioRepair project={project} refresh={refresh} />
          )}
          {book.adaptation && (
            <details className="source-details">
              <summary>The heart of the story & what we imagined</summary>
              <p>{book.adaptation.emotionalInheritance}</p>
              <p>{book.adaptation.premise}</p>
              <ul>
                {book.adaptation.inventions.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </details>
          )}
          {book.production && (
            <details className="source-details">
              <summary>The True Parts</summary>
              <p>{book.production.manuscript.trueParts}</p>
              <p className="small muted">
                The original voice, the remembered details, and the imagined
                adventure are kept together.
              </p>
            </details>
          )}
          <details className="source-details editions">
            <summary>Saved editions · {project.editions.length}</summary>
            <p>
              Downloading or ordering keeps those exact words and pictures, even
              if you make changes later.
            </p>
            {project.editions.length ? (
              project.editions.map((edition) => (
                <button key={edition.id} onClick={() => openEdition(edition)}>
                  <BookOpen size={18} />
                  <span>
                    Edition {edition.revision}
                    <small>
                      {new Date(edition.createdAt).toLocaleDateString(
                        undefined,
                        { month: "short", day: "numeric" },
                      )}
                    </small>
                  </span>
                  <ArrowRight size={17} />
                </button>
              ))
            ) : (
              <p className="muted">
                No editions saved yet. Your current book is kept here.
              </p>
            )}
          </details>
          <p className="small reader-archive">
            <a href={`/api/projects/${project.id}/archive`}>
              Download a family archive
            </a>{" "}
            — original audio, source, artwork and saved editions. Keep this
            private file somewhere safe.
          </p>
        </div>
      </details>
      {modal && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="correction-title"
          >
            <button
              className="close"
              aria-label="Close correction"
              onClick={() => setModal("")}
            >
              <X />
            </button>
            <span className="eyebrow">LET’S GET IT RIGHT</span>
            <h2 id="correction-title">Change something</h2>
            <label>
              What would you like to change?
              <select
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value);
                  setError("");
                }}
              >
                <option value="name">Change a name</option>
                <option value="fact">Correct a detail</option>
                <option value="picture">Change this picture</option>
              </select>
            </label>
            {kind === "name" ? (
              <>
                <label>
                  Whose name?
                  <select
                    value={person}
                    onChange={(e) => setPerson(e.target.value)}
                  >
                    {book.people.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.relationship})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  The correct name
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={40}
                    placeholder="Write the name here"
                    autoFocus
                  />
                </label>
                <p className="small muted">
                  Updates the memory notes, story text, and picture
                  descriptions. The pictures contain no names and will be kept.
                  Previous editions stay as they are.
                </p>
              </>
            ) : (
              <>
                <label>
                  {kind === "picture"
                    ? "What should be different in the picture?"
                    : "What should the story say?"}
                  <textarea
                    value={detail}
                    onChange={(e) => setDetail(e.target.value)}
                    rows={4}
                  />
                </label>
                <p className="notice">
                  We can keep this request for review. Automatic story and
                  picture changes are not connected yet.
                </p>
              </>
            )}
            {error && (
              <p className="alert" role="alert">
                {error}
              </p>
            )}
            <button
              className="button full"
              disabled={
                busy ||
                (kind === "name" ? !name.trim() : detail.trim().length < 3)
              }
              onClick={() => void correct()}
            >
              {busy
                ? "Saving…"
                : kind === "name"
                  ? "Apply name correction"
                  : "Save request for review"}
            </button>
          </section>
        </div>
      )}
    </section>
  );
}
