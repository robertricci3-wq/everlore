import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BookOpen,
  Eye,
  EyeOff,
  Mic,
  Plus,
  Settings2,
} from "lucide-react";
import { RecordEntry } from "./MemoryComposer.js";
import { ALMANAC_CHAPTERS } from "../shared/almanac.js";
import { api, go } from "./api.js";
import type {
  AlmanacView,
  AlmanacPageView,
  AlmanacBookView,
} from "./almanacApi.js";
import { AlmanacMotif } from "./AlmanacMotif.js";
import { ArchiveRestore } from "./ArchiveRestore.js";

export function Almanac({ reading = false, organizing = false }: { reading?: boolean; organizing?: boolean }) {
  const [data, setData] = useState<AlmanacView>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [manage, setManage] = useState(false),
    [adding, setAdding] = useState(false),
    [title, setTitle] = useState(""),
    [renameId, setRenameId] = useState(""),
    [renameTitle, setRenameTitle] = useState("");
  async function load() {
    setData(await api<AlmanacView>("/almanac"));
  }
  useEffect(() => {
    void load().catch((cause) => setError(cause.message));
  }, []);
  async function change(page: AlmanacPageView, body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      await api(`/almanac/pages/${page.id}`, body, "PATCH");
      await load();
      setRenameId("");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function add(byVoice = false) {
    if (!byVoice && !title.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ page: AlmanacPageView }>("/almanac/pages", {
        title: title.trim() || "A page of my own",
      });
      go(`/${byVoice ? "name-page" : "memory"}/${result.page.id}`);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const chapters = ALMANAC_CHAPTERS;
  const visiblePages = data?.pages.filter((p) => !p.hidden) ?? [];
  const finished = data?.books.filter((b) => b.revision > 0) ?? [];
  const drafts =
    data?.drafts
      .filter(
        (d) =>
          d.turnCount > 0 &&
          (d.status === "open" ||
            !data.books.some((b) => b.sourceSessionId === d.id)),
      )
      .slice(0, 1) ?? [];
  const titleDrafts = data?.titleDrafts ?? [];
  const inProgress =
    data?.books.filter((b) => b.revision === 0).slice(0, 4) ?? [];
  return (
    <main className="almanac-page enter">
      <header className={`almanac-heading ${reading ? "" : "family-heading"}`}>
        <div>
          {reading && <span className="eyebrow">THE STORIES ONLY YOUR FAMILY CAN TELL</span>}
          <h1>
            {reading ? (
              "A little world to return to."
            ) : (
              <>
                Your family, <em>in stories.</em>
              </>
            )}
          </h1>
          {reading && <p>
            {reading
              ? "Familiar faces. Favourite adventures. Open a book and settle in."
              : "Tell it as you remember it. We’ll find the story inside."}
          </p>}
        </div>
      </header>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <p className="loading">Opening your stories…</p>}
      {data && reading && (
        <section aria-label="Finished family books">
          {finished.length ? (
            <div className="almanac-books">
              {finished.map((book) => (
                <BookCard key={book.projectId} book={book} />
              ))}
            </div>
          ) : (
            <div className="almanac-empty">
              <BookOpen size={42} strokeWidth={1} />
              <h2>Your stories will live here.</h2>
              <p>
                Whenever you feel like telling one, there’s a gentle place to
                begin.
              </p>
              <a className="button secondary" href="#/shelf">
                Find a memory <ArrowRight size={17} />
              </a>
            </div>
          )}
        </section>
      )}
      {data && !reading && (
        <>
          {!organizing && <RecordEntry />}
          {!organizing && (drafts.length > 0 ||
            inProgress.length > 0 ||
            titleDrafts.length > 0) && (
            <section className="almanac-saved" aria-label="Saved memories">
              <div className="almanac-section-heading">
                <div>
                  <span className="eyebrow">RIGHT WHERE YOU LEFT IT</span>
                  <h2>Continue your story.</h2>
                </div>
              </div>
              <div className="almanac-drafts">
                {titleDrafts.map((d) => (
                  <a key={d.id} href={`#/interview/${d.id}`}>
                    <Mic size={22} />
                    <span>
                      <strong>Name your page</strong>
                      <small>Return to your saved page name</small>
                    </span>
                    <ArrowRight size={17} />
                  </a>
                ))}
                {drafts.map((d) => (
                  <a key={d.id} href={`#/tell/${d.id}`}>
                    <Mic size={22} />
                    <span>
                      <strong>
                        {data.pages.find((p) => p.id === d.pageId)?.title ??
                          "A memory of your own"}
                      </strong>
                      <small>Your saved telling</small>
                    </span>
                    <ArrowRight size={17} />
                  </a>
                ))}
                {inProgress.map((b) => (
                  <a key={b.projectId} href={`#/story/${b.projectId}`}>
                    <BookOpen size={22} />
                    <span>
                      <strong>{b.title}</strong>
                      <small>
                        {b.status === "creating_legacy"
                          ? "Your story is taking shape"
                          : "A saved memory"}
                      </small>
                    </span>
                    <ArrowRight size={17} />
                  </a>
                ))}
              </div>
            </section>
          )}
          {!organizing && finished.length > 0 && (
            <section className="almanac-finished">
              <div className="almanac-section-heading">
                <div>
                  <span className="eyebrow">YOUR FAMILY’S GROWING WORLD</span>
                  <h2>Stories to come back to.</h2>
                </div>
                <a className="text-button" href="#/reading">
                  All your books <ArrowRight size={17} />
                </a>
              </div>
              <div className="almanac-books">
                {finished.slice(0, 4).map((b) => (
                  <BookCard key={b.projectId} book={b} />
                ))}
              </div>
            </section>
          )}
          {organizing && <>
          <a className="back-link" href="#/shelf">Back to your stories</a>
          <details className="story-ideas">
            <summary>Find a different memory</summary>
            <div className="almanac-overview">
              {chapters.map((c) => (
                <section key={c.id}>
                  <h3>{c.title}</h3>
                  {visiblePages
                    .filter((p) => p.chapterId === c.id)
                    .map((p) => (
                      <a key={p.id} href={`#/memory/${p.id}`}>
                        {p.title}
                        <ArrowRight size={15} />
                      </a>
                    ))}
                </section>
              ))}
              {visiblePages.some((p) => p.custom) && (
                <section>
                  <h3>Your own ideas</h3>
                  {visiblePages
                    .filter((p) => p.custom)
                    .map((p) => (
                      <a key={p.id} href={`#/memory/${p.id}`}>
                        {p.title}
                        <ArrowRight size={15} />
                      </a>
                    ))}
                </section>
              )}
            </div>
          </details>
          <details className="story-organize">
            <summary>Personalize your collection</summary>
            <section className="almanac-personalize">
              <div>
                <h2>Your collection, your way.</h2>
                <p>
                  These pages are invitations, not a checklist. Keep the ones
                  that speak to you, and add whatever’s missing.
                </p>
              </div>
              <button
                className="button secondary"
                onClick={() => setAdding(!adding)}
                aria-expanded={adding}
              >
                <Plus size={19} />A page of my own
              </button>
              <button
                className="text-button"
                onClick={() => setManage(!manage)}
                aria-expanded={manage}
              >
                <Settings2 size={17} />
                Arrange your topics
              </button>
            </section>
            {adding && (
              <form
                className="almanac-add"
                onSubmit={(e) => {
                  e.preventDefault();
                  void add();
                }}
              >
                <label>
                  Name your page
                  <input
                    autoFocus
                    value={title}
                    maxLength={100}
                    placeholder="The summer we built a boat"
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </label>
                <p className="small muted">
                  A few words are enough. You can tell the whole memory by
                  voice.
                </p>
                <div className="memory-choices">
                  <button className="button" disabled={busy || !title.trim()}>
                    Open my page <ArrowRight size={18} />
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void add(true)}
                  >
                    <Mic size={18} />
                    Name it by voice
                  </button>
                </div>
              </form>
            )}
            {manage && (
              <section
                className="almanac-arrange"
                aria-label="Arrange your topics"
              >
                <p>
                  Hidden invitations can be brought back here. Your recordings
                  and finished books stay safe.
                </p>
                {data.pages.map((p, index) => (
                  <div className="almanac-arrange-row" key={p.id}>
                    {renameId === p.id ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void change(p, { title: renameTitle });
                        }}
                      >
                        <label className="sr-only" htmlFor={`rename-${p.id}`}>
                          New page title
                        </label>
                        <input
                          id={`rename-${p.id}`}
                          value={renameTitle}
                          maxLength={100}
                          onChange={(e) => setRenameTitle(e.target.value)}
                        />
                        <button
                          className="text-button"
                          disabled={busy || !renameTitle.trim()}
                        >
                          Save
                        </button>
                        <button
                          className="text-button"
                          type="button"
                          onClick={() => setRenameId("")}
                        >
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <button
                        className="text-button page-name"
                        onClick={() => {
                          setRenameId(p.id);
                          setRenameTitle(p.title);
                        }}
                      >
                        {p.title}
                        <span className="small muted">Rename</span>
                      </button>
                    )}
                    <div>
                      <button
                        className="icon-control"
                        disabled={busy || index === 0}
                        aria-label={`Move ${p.title} earlier`}
                        onClick={() => void change(p, { position: index - 1 })}
                      >
                        <ArrowUp size={18} />
                      </button>
                      <button
                        className="icon-control"
                        disabled={busy || index === data.pages.length - 1}
                        aria-label={`Move ${p.title} later`}
                        onClick={() => void change(p, { position: index + 1 })}
                      >
                        <ArrowDown size={18} />
                      </button>
                      <button
                        className="icon-control"
                        disabled={busy}
                        aria-label={`${p.hidden ? "Restore" : "Hide"} ${p.title}`}
                        onClick={() => void change(p, { hidden: !p.hidden })}
                      >
                        {p.hidden ? <Eye size={18} /> : <EyeOff size={18} />}
                      </button>
                    </div>
                  </div>
                ))}
              </section>
            )}
            <details className="almanac-archive">
              <summary>Bring a saved family archive</summary>
              <ArchiveRestore />
            </details>
          </details>
          </>}
        </>
      )}
    </main>
  );
}
export function BookCard({ book }: { book: AlmanacBookView }) {
  return (
    <a className="almanac-book-card" href={`#/story/${book.projectId}`}>
      {book.coverUrl ? (
        <img
          src={book.coverUrl}
          alt={`Cover illustration for ${book.title}`}
          loading="lazy"
        />
      ) : (
        <AlmanacMotif index={7} />
      )}
      <div>
        <span className="eyebrow">A FAMILY STORY</span>
        <h3>{book.title}</h3>
        <span>
          Open the book <ArrowRight size={16} />
        </span>
      </div>
    </a>
  );
}
