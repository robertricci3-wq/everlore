import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BookOpen,
  Eye,
  EyeOff,
  List,
  Mic,
  Plus,
  Settings2,
} from "lucide-react";
import { ALMANAC_CHAPTERS } from "../shared/almanac.js";
import { api, go } from "./api.js";
import type {
  AlmanacView,
  AlmanacPageView,
  AlmanacBookView,
} from "./almanacApi.js";
import { AlmanacMotif } from "./AlmanacMotif.js";
import { ArchiveRestore } from "./ArchiveRestore.js";

export function Almanac({ reading = false }: { reading?: boolean }) {
  const [data, setData] = useState<AlmanacView>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [chapter, setChapter] = useState(""),
    [offset, setOffset] = useState(0),
    [overview, setOverview] = useState(false),
    [manage, setManage] = useState(false),
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
  const selectedChapter = chapters.find((c) => c.id === chapter);
  const visiblePages =
    data?.pages.filter(
      (p) => !p.hidden && (!chapter || p.chapterId === chapter),
    ) ?? [];
  const pages = visiblePages.slice(offset, offset + 2);
  const finished = data?.books.filter((b) => b.revision > 0) ?? [];
  const drafts =
    data?.drafts
      .filter(
        (d) =>
          d.turnCount > 0 &&
          (d.status === "open" ||
            !data.books.some((b) => b.sourceSessionId === d.id)),
      )
      .slice(0, 4) ?? [];
  const titleDrafts = data?.titleDrafts ?? [];
  const inProgress =
    data?.books.filter((b) => b.revision === 0).slice(0, 4) ?? [];
  const chapterNumber = (p: AlmanacPageView) =>
    Math.max(
      0,
      chapters.findIndex((c) => c.id === p.chapterId),
    );
  return (
    <main className="almanac-page enter">
      <header className="almanac-heading">
        <div>
          <span className="eyebrow">THE STORIES ONLY YOUR FAMILY CAN TELL</span>
          <h1>
            {reading ? (
              "A little world to return to."
            ) : (
              <>
                Your family, <em>in stories.</em>
              </>
            )}
          </h1>
          <p>
            {reading
              ? "Familiar faces. Favourite adventures. Open a book and settle in."
              : "A place for the little adventures, the familiar rituals, and the people who made you, you."}
          </p>
        </div>
        <div className="almanac-view-switch" aria-label="Almanac view">
          <a href="#/shelf" aria-current={!reading ? "page" : undefined}>
            <Mic size={17} /> Remember
          </a>
          <a href="#/reading" aria-current={reading ? "page" : undefined}>
            <BookOpen size={17} /> Read
          </a>
        </div>
      </header>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <p className="loading">Opening your almanac…</p>}
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
          <nav className="chapter-nav" aria-label="Almanac chapters">
            <button
              aria-pressed={!chapter}
              onClick={() => {
                setChapter("");
                setOffset(0);
              }}
            >
              All chapters
            </button>
            {chapters.map((c, index) => (
              <button
                key={c.id}
                aria-pressed={chapter === c.id}
                onClick={() => {
                  setChapter(c.id);
                  setOffset(0);
                }}
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                {c.title}
              </button>
            ))}
          </nav>
          <section
            className="almanac-invitations"
            aria-label="Memory invitations"
          >
            <div className="almanac-section-heading">
              <div>
                <span className="eyebrow">
                  {selectedChapter
                    ? selectedChapter.title
                    : "OPEN A PAGE. SEE WHAT COMES BACK."}
                </span>
                <h2>
                  {selectedChapter
                    ? "Every life has a story here."
                    : "Where shall we begin?"}
                </h2>
              </div>
              <button
                className="text-button"
                aria-expanded={overview}
                onClick={() => setOverview(!overview)}
              >
                <List size={17} />
                {overview ? "Close overview" : "All the invitations"}
              </button>
            </div>
            {overview ? (
              <div className="almanac-overview">
                {chapters.map((c, index) => (
                  <section key={c.id}>
                    <span className="eyebrow">CHAPTER {index + 1}</span>
                    <h3>{c.title}</h3>
                    {data.pages
                      .filter((p) => !p.hidden && p.chapterId === c.id)
                      .map((p) => (
                        <a key={p.id} href={`#/memory/${p.id}`}>
                          {p.title}
                          <ArrowRight size={15} />
                        </a>
                      ))}
                  </section>
                ))}
                {data.pages.some((p) => !p.hidden && p.custom) && (
                  <section>
                    <h3>Pages of your own</h3>
                    {data.pages
                      .filter((p) => !p.hidden && p.custom)
                      .map((p) => (
                        <a key={p.id} href={`#/memory/${p.id}`}>
                          {p.title}
                          <ArrowRight size={15} />
                        </a>
                      ))}
                  </section>
                )}
              </div>
            ) : (
              <>
                <div className="almanac-open-book">
                  {pages.length ? (
                    pages.map((page) => (
                      <article className="almanac-leaf" key={page.id}>
                        <a
                          className="almanac-leaf-main"
                          href={
                            page.coverProjectId
                              ? `#/story/${page.coverProjectId}`
                              : `#/memory/${page.id}`
                          }
                          aria-label={
                            page.coverProjectId
                              ? `Read ${page.title}`
                              : `Remember ${page.title}`
                          }
                        >
                          {page.coverUrl ? (
                            <img
                              className="almanac-page-cover"
                              src={page.coverUrl}
                              alt={`Illustration for ${page.title}`}
                            />
                          ) : (
                            <AlmanacMotif index={chapterNumber(page)} />
                          )}
                          <span className="eyebrow">
                            {page.custom
                              ? "A PAGE OF YOUR OWN"
                              : chapters[chapterNumber(page)]?.title}
                          </span>
                          <h3>{page.title}</h3>
                          <p>{page.description}</p>
                          <span className="almanac-leaf-action">
                            {page.coverProjectId
                              ? "Open the story"
                              : "Tell this memory"}
                            <ArrowRight size={19} />
                          </span>
                        </a>
                        {page.coverProjectId && (
                          <a
                            className="text-button"
                            href={`#/memory/${page.id}`}
                          >
                            Another story from this page
                          </a>
                        )}
                      </article>
                    ))
                  ) : (
                    <div className="almanac-empty">
                      <p>
                        You can bring back hidden invitations in “Arrange your
                        almanac,” or make a page of your own.
                      </p>
                    </div>
                  )}
                </div>
                <div className="almanac-turn-controls">
                  <button
                    className="text-button"
                    disabled={offset === 0}
                    aria-label="Previous invitations"
                    onClick={() => setOffset(Math.max(0, offset - 2))}
                  >
                    <ArrowLeft size={20} /> Earlier pages
                  </button>
                  <span>Follow your curiosity. There’s no right order.</span>
                  <button
                    className="text-button"
                    disabled={offset + 2 >= visiblePages.length}
                    aria-label="Next invitations"
                    onClick={() => setOffset(offset + 2)}
                  >
                    More invitations
                    <ArrowRight size={20} />
                  </button>
                </div>
              </>
            )}
          </section>
          {(drafts.length > 0 ||
            inProgress.length > 0 ||
            titleDrafts.length > 0) && (
            <section className="almanac-saved" aria-label="Saved memories">
              <div className="almanac-section-heading">
                <div>
                  <span className="eyebrow">RIGHT WHERE YOU LEFT IT</span>
                  <h2>Pick up a thread.</h2>
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
                  <a key={d.id} href={`#/interview/${d.id}`}>
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
          {finished.length > 0 && (
            <section className="almanac-finished">
              <div className="almanac-section-heading">
                <div>
                  <span className="eyebrow">YOUR FAMILY’S GROWING WORLD</span>
                  <h2>Stories to come back to.</h2>
                </div>
                <a className="text-button" href="#/reading">
                  Settle in to read <ArrowRight size={17} />
                </a>
              </div>
              <div className="almanac-books">
                {finished.slice(0, 4).map((b) => (
                  <BookCard key={b.projectId} book={b} />
                ))}
              </div>
            </section>
          )}
          <section className="almanac-personalize">
            <div>
              <h2>Make room for your own story.</h2>
              <p>
                These pages are invitations, not a checklist. Keep the ones that
                speak to you, and add whatever’s missing.
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
              Arrange your almanac
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
                A few words are enough. You can tell the whole memory by voice.
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
              aria-label="Arrange your almanac"
            >
              <p>
                Hidden invitations can be brought back here. Your recordings and
                finished books stay safe.
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
          <button className="text-button" onClick={() => go("/example")}>
            Explore the illustrations <ArrowRight size={16} />
          </button>
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
