import { OrderPage, OrderHistory, CommerceOperations } from "./Purchase.js";
import { PublicExample } from "./PublicExample.js";
import {
  PUBLIC_ART_SHOWCASE,
  PUBLIC_HERO_ARTWORK,
} from "../shared/publicArt.js";
import { OperatorAccess } from "./OperatorAccess.js";
import { CreativeLab } from "./CreativeLab.js";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  LockKeyhole,
  Mic,
  ShieldCheck,
  Sprout,
  Trash2,
} from "lucide-react";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "@fontsource/literata/400.css";
import "@fontsource/literata/400-italic.css";
import "./styles.css";
import "./Almanac.css";
import { Almanac } from "./Almanac.js";
import { MemoryInvitationPage, MemoryInterview } from "./MemoryInterview.js";
import { OperatorCosts } from "./OperatorCosts.js";
import { api, deleteDraft, go, type SessionUser } from "./api.js";
import { sampleSource } from "../shared/fixture.js";
import type { ProjectView } from "../shared/contracts.js";
import { Capture } from "./Capture.js";
import { Reader } from "./Reader.js";
import { StoryStudio, StudioStatus, OperatorStudioSetup } from "./StoryStudio.js";

function App() {
  const [path, setPath] = useState(location.hash.slice(1) || "/"),
    [user, setUser] = useState<SessionUser | null>(null),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState("");
  async function session() {
    const data = await api<{ user: SessionUser | null }>("/session");
    setUser(data.user);
    setLoaded(true);
  }
  useEffect(() => {
    void session().catch(() => {
      setError(
        "Everlore could not connect. Please refresh this page and try again.",
      );
      setLoaded(true);
    });
    const change = () => {
      setPath(location.hash.slice(1) || "/");
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  function explore() {
    setError("");
    go("/example");
  }
  function tell() {
    go(user?.kind === "private" ? "/shelf" : "/join");
  }
  async function logout() {
    setError("");
    try {
      await api("/logout", {});
      setUser(null);
      go("/");
    } catch (cause) {
      setError((cause as Error).message);
    }
  }
  return (
    <>
      <a
        href="#main-content"
        className="skip-link"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        Skip to content
      </a>
      <div className="top-note">
        Your family’s stories <span>·</span> Private to your shelf. Shared with
        AI only when you choose.
      </div>
      <header className="site-header">
        <a className="wordmark" href="#/" aria-label="Everlore home">
          <Sprout strokeWidth={1.3} size={31} />
          <span>
            everlore<span className="wordmark-dot">.</span>
          </span>
        </a>
        <nav aria-label="Main navigation">
          <a href="#/shelf" className={path === "/shelf" ? "active" : ""}>
            Your almanac
          </a>
          {user?.labOwner && (
            <a className="nav-link" href="#/lab">
              Creative Lab
            </a>
          )}
          {user?.kind === "private" && (
            <a className="nav-link" href="#/orders">
              Your orders
            </a>
          )}
          {user?.operator && (
            <a className="nav-link" href="#/operator/access">
              Manage pilot
            </a>
          )}
          {user?.kind === "private" ? (
            <button className="nav-link" onClick={() => void logout()}>
              Sign out
            </button>
          ) : (
            <a className="nav-link" href="#/login">
              Sign in
            </a>
          )}
          <button className="header-cta" onClick={tell}>
            Tell a story <ArrowRight size={16} />
          </button>
        </nav>
      </header>
      <div id="main-content" tabIndex={-1}>
        {error && (
          <p className="alert global-alert" role="alert">
            {error}
          </p>
        )}
        {!loaded ? (
          <main className="narrow">
            <p className="loading">Opening your story space…</p>
          </main>
        ) : path === "/" ? (
          <Home tell={tell} explore={explore} />
        ) : path === "/example" ? (
          <PublicExample />
        ) : path.split("?")[0] === "/join" || path === "/login" ? (
          <Account
            login={path === "/login"}
            onDone={async () => {
              await session();
              go("/shelf");
            }}
          />
        ) : path === "/capture" ? (
          user?.kind === "private" ? (
            <Capture user={user} />
          ) : (
            <Account
              login={false}
              onDone={async () => {
                await session();
              }}
            />
          )
        ) : path === "/lab" ? (
          <CreativeLab />
        ) : ["/shelf", "/reading"].includes(path) ? (
          user?.kind === "private" ? <Almanac key={path} reading={path === "/reading"} /> : <Account login onDone={session} />
        ) : path.startsWith("/name-page/") ? (
          user?.kind === "private" ? <MemoryInvitationPage key={path} pageId={path.split("/")[2]} titleOnly /> : <Account login onDone={session} />
        ) : path.startsWith("/memory/") ? (
          user?.kind === "private" ? <MemoryInvitationPage key={path} pageId={path.split("/")[2]} /> : <Account login onDone={session} />
        ) : path.startsWith("/interview/") ? (
          user?.kind === "private" ? <MemoryInterview key={path} sessionId={path.split("/")[2]} user={user} /> : <Account login onDone={session} />
        ) : path === "/orders" ? (
          <OrderHistory />
        ) : path === "/operator/orders" ? (
          <CommerceOperations />
        ) : path === "/operator/costs" ? (
          <OperatorCosts />
        ) : path === "/operator/studio" ? (
          <OperatorStudioSetup />
        ) : path === "/operator/access" ? (
          <OperatorAccess />
        ) : path.startsWith("/order/") ? (
          <OrderPage id={path.split("/")[2].split("?")[0]} />
        ) : path.startsWith("/story/") ? (
          <Project key={path.split("/")[2]} projectId={path.split("/")[2]} />
        ) : (
          <main className="narrow">
            <h1>Let’s find your story.</h1>
            <button className="button" onClick={() => go("/")}>
              Back to home
            </button>
          </main>
        )}
      </div>
      <footer className="site-footer">
        <a className="wordmark small-logo" href="#/">
          <Sprout size={23} />
          <span>everlore.</span>
        </a>
        <p>Your life. Their wonder. A lasting legacy.</p>
        <span>
          <LockKeyhole size={13} /> Made to be private.
        </span>
      </footer>
    </>
  );
}
function Home({ tell, explore }: { tell: () => void; explore: () => void }) {
  return (
    <main className="home enter">
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="tiny-rule" /> FOR GRANDPARENTS. FOR GENERATIONS.
          </div>
          <h1>
            Your legacy.
            <br />
            Their favorite
            <br />
            <em>stories.</em>
          </h1>
          <p>{PUBLIC_ART_SHOWCASE.description}</p>
          <div className="hero-actions">
            <button className="button" onClick={tell}>
              <Mic size={21} /> Tell a story <ArrowRight size={18} />
            </button>
            <button className="example-link" onClick={explore}>
              <BookOpen size={20} /> Explore the illustrations
            </button>
          </div>
          <span className="hero-footnote">
            <ShieldCheck size={16} /> Just your voice. One memory is enough.
          </span>
        </div>
        <div className="hero-art">
          <div className="book-kicker">
            <span>A LITTLE TRUTH. A WORLD OF WONDER.</span>
            <svg width="69" height="38" viewBox="0 0 69 38" aria-hidden="true">
              <path
                d="M2 2Q53-1 55 29M47 20L55 31L65 22"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
              />
            </svg>
          </div>
          <a
            className="hero-book animal-storybook"
            href="#/example"
            aria-label="Explore the illustrations"
          >
            <div className="hero-book-art">
              <img
                src={PUBLIC_HERO_ARTWORK.src}
                alt={PUBLIC_HERO_ARTWORK.alt}
                width={PUBLIC_HERO_ARTWORK.width}
                height={PUBLIC_HERO_ARTWORK.height}
                fetchPriority="high"
              />
            </div>
            <div className="hero-book-cover">
              <span className="eyebrow">A STORY TO KEEP</span>
              <h2>
                A story
                <br />
                only you
                <br />
                could tell
              </h2>
              <div className="little-rule" />
              <p>Your family. A world of wonder.</p>
              <Sprout size={25} strokeWidth={1.1} />
            </div>
          </a>
          <div className="book-shadow" />
          <div className="sample-caption">
            <span className="caption-dot" />
            <span>{PUBLIC_ART_SHOWCASE.attribution}</span>
          </div>
          <span className="handwritten">
            The wonder is part of the inheritance.
          </span>
        </div>
      </section>
      <section className="journey">
        <div className="journey-intro">
          <span className="eyebrow">
            FROM YOUR VOICE TO THEIR FAVORITE STORY
          </span>
          <h2>
            The life you’ve lived.
            <br />
            <em>The stories they’ll carry.</em>
          </h2>
        </div>
        <div className="journey-steps">
          {[
            [
              "01",
              "Start with your voice",
              "A brave moment. A family adventure. Someone who showed you love. Tell it your way.",
            ],
            [
              "02",
              "Let the story grow",
              "A child-sized adventure, a little wonder, and pictures worth getting lost in. Rooted in you.",
            ],
            [
              "03",
              "Pass on more than a memory",
              "Read it together. Share a laugh. Give the next generation a way to know you, again and again.",
            ],
          ].map(([number, title, copy]) => (
            <div key={number}>
              <span className="step-number">{number}</span>
              <h3>{title}</h3>
              <p>{copy}</p>
            </div>
          ))}
        </div>
      </section>
      <section className="honesty">
        <Sprout size={37} strokeWidth={1.1} />
        <div>
          <h3>You bring the life. We bring the storytelling.</h3>
          <p>
            Our story studio shapes memories into adventures with heart,
            read-aloud rhythm and a visual world of their own. Step inside the
            art of an Everlore family story.
          </p>
          <StudioStatus />
        </div>
        <button className="text-button" onClick={explore}>
          Explore the illustrations <ArrowRight size={17} />
        </button>
      </section>
    </main>
  );
}
function Account({
  login,
  onDone,
}: {
  login: boolean;
  onDone: () => Promise<void>;
}) {
  const [name, setName] = useState(""),
    [password, setPassword] = useState(""),
    [inviteCode, setInviteCode] = useState(
      () =>
        new URLSearchParams(location.hash.split("?")[1] ?? "").get("invite") ??
        "",
    ),
    [inviteRequired, setInviteRequired] = useState(false),
    [adult, setAdult] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    void api<{ inviteRequired?: boolean }>("/session").then((s) =>
      setInviteRequired(!!s.inviteRequired),
    );
  }, []);
  async function submit(event: React.SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(
        login ? "/login" : "/register",
        login ? { name, password } : { name, password, adult, inviteCode },
      );
      await onDone();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="narrow account enter">
      <span className="eyebrow">A PLACE FOR YOUR STORIES</span>
      <h1>{login ? "Welcome back." : "Your private shelf."}</h1>
      <p className="lead">
        {login
          ? "Open the stories you’ve kept."
          : "Choose a shelf name and password to keep your recordings and family stories private."}
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <label>
          Shelf name
          <input
            required
            minLength={2}
            maxLength={40}
            autoComplete="username"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="For example, Nell stories"
            pattern="[a-zA-Z0-9 _-]+"
            title="Use letters, numbers, spaces, hyphens, or underscores."
          />
        </label>
        <label>
          Password
          <input
            required
            type="password"
            minLength={10}
            maxLength={128}
            autoComplete={login ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 10 characters"
          />
        </label>
        {!login && inviteRequired && (
          <label>
            Invitation code
            <input
              type="password"
              required
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              autoComplete="off"
            />
          </label>
        )}
        {!login && (
          <label className="consent">
            <input
              type="checkbox"
              checked={adult}
              onChange={(e) => setAdult(e.target.checked)}
              required
            />
            <span>
              I’m 18 or older and have permission to save these family stories.
            </span>
          </label>
        )}
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        <button className="button full" disabled={busy || (!login && !adult)}>
          {busy
            ? "Opening your shelf…"
            : login
              ? "Open your shelf"
              : "Create your private shelf"}
          <ArrowRight size={19} />
        </button>
      </form>
      <p className="small muted">
        Keep your password somewhere safe. Password recovery and cloud backup
        are not connected.
      </p>
      <button
        className="text-button"
        onClick={() => go(login ? "/join" : "/login")}
      >
        {login ? "New here? Create a shelf" : "Already have a shelf? Sign in"}
      </button>
    </main>
  );
}
function Project({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<ProjectView>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [manual, setManual] = useState(false),
    [text, setText] = useState(""),
    [attested, setAttested] = useState(false),
    [deleting, setDeleting] = useState(false);
  async function refresh() {
    const p = await api<ProjectView>(`/projects/${projectId}`);
    setProject(p);
  }
  useEffect(() => {
    let live = true;
    const load = () =>
      void api<ProjectView>(`/projects/${projectId}`)
        .then((p) => {
          if (live) setProject(p);
        })
        .catch((cause) => {
          if (live) setError(cause.message);
        });
    load();
    const timer = setInterval(load, 1200);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [projectId]);
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await api(`/projects/${projectId}/confirm`, { confirmed: true });
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function retry() {
    setBusy(true);
    setError("");
    try {
      await api(`/projects/${projectId}/retry`, {});
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function saveWords() {
    setBusy(true);
    setError("");
    try {
      await api(`/projects/${projectId}/transcript`, {
        rawText: text,
        attested,
      });
      setManual(false);
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    setError("");
    try {
      await api(`/projects/${projectId}`, {}, "DELETE");
      await deleteDraft(projectId).catch(() => undefined);
      go("/shelf");
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  }
  if (!project)
    return (
      <main className="narrow">
        {error ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : (
          <p className="loading">Opening your memory…</p>
        )}
        <button className="text-button" onClick={() => go("/shelf")}>
          Back to bookshelf
        </button>
      </main>
    );
  const job = project.jobs[0],
    sample = project.mode === "synthetic_fixture";
  return (
    <main className="project-page">
      <button className="back-link" onClick={() => go("/shelf")}>
        <ArrowLeft size={17} /> Your bookshelf
      </button>
      {project.book ? (
        <>
          {project.engine && project.engine.status !== "complete" && (
            <div className="narrow">
              <StoryStudio project={project} refresh={refresh} />
            </div>
          )}
          <Reader project={project} refresh={refresh} />
        </>
      ) : (
        <section className="narrow project-state enter">
          {sample && (
            <span className="pill">Synthetic example · no live generation</span>
          )}
          {error && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}
          {project.engine && (
            <StoryStudio project={project} refresh={refresh} />
          )}
          {project.status === "needs_confirmation" && !project.engine ? (
            <>
              <div className="eyebrow">THE HEART OF THE MEMORY</div>
              <h1>
                {sample
                  ? "A coat. Three buttons.\nA little patience."
                  : "Keep it in your words."}
              </h1>
              <p className="lead">
                {sample
                  ? "Before making a book, the important details come first."
                  : "These words were entered manually. Please read them against your recording before continuing."}
              </p>
              {sample && (
                <div className="fact-list">
                  <p>
                    <Check size={20} />
                    <span>
                      <strong>Nell was five.</strong> The narrator appears as a
                      child in this memory.
                    </span>
                  </p>
                  <p>
                    <Check size={20} />
                    <span>
                      <strong>Aunt Ada was there.</strong> She waited, and
                      showed Nell a little trick.
                    </span>
                  </p>
                  <p>
                    <Check size={20} />
                    <span>
                      <strong>A blue coat. Three round buttons.</strong> One
                      small thing, learned together.
                    </span>
                  </p>
                </div>
              )}
              <details className="source-details" open={!sample}>
                <summary>
                  {sample
                    ? "Read the original synthetic memory"
                    : "Read your manually entered transcript"}{" "}
                  <ChevronRight size={16} />
                </summary>
                {(project.transcript ?? sampleSource).segments.map((s) => (
                  <p key={s.id}>{s.text}</p>
                ))}
              </details>
              <button
                className="button full"
                disabled={busy}
                onClick={() => void confirm()}
              >
                {busy
                  ? "Continuing…"
                  : sample
                    ? "Make the example book"
                    : "Confirm these words"}
                <ArrowRight size={20} />
              </button>
              <p className="small muted">
                {sample
                  ? "The example uses a prepared manuscript and designed sample art. It is not generated from a recording."
                  : "Your original words will be preserved. Next, you can choose to make an imaginative story in the story studio."}
              </p>
            </>
          ) : null}
          {project.status === "composing" && (
            <div className="making">
              <Sprout size={60} strokeWidth={1} />
              <h1>
                Bringing the little
                <br />
                things together.
              </h1>
              <p>Assembling the synthetic example.</p>
              <ol className="progress-steps">
                {[
                  "Finding the heart of the story",
                  "Planning the pictures",
                  "Making the book",
                ].map((step, i) => (
                  <li
                    key={step}
                    className={
                      (job?.stage === "ledger"
                        ? 0
                        : job?.stage === "manuscript"
                          ? 1
                          : 2) >= i
                        ? "active"
                        : ""
                    }
                  >
                    {(job?.stage === "ledger"
                      ? 0
                      : job?.stage === "manuscript"
                        ? 1
                        : 2) > i ? (
                      <Check size={18} />
                    ) : (
                      <span>{i + 1}</span>
                    )}
                    {step}
                  </li>
                ))}
              </ol>
              <p className="small muted">
                Your progress is stored. You can leave this page and return.
              </p>
            </div>
          )}
          {project.status === "needs_attention" && (
            <>
              <h1>A little pause.</h1>
              <p className="lead">
                {job?.error ?? "Something stopped before the book was ready."}
              </p>
              <p>
                Completed pages are safe. Retrying will continue from the
                unfinished step.
              </p>
              <button
                className="button full"
                disabled={busy || job?.attempt >= 3}
                onClick={() => void retry()}
              >
                Continue making the book
              </button>
            </>
          )}
          {["awaiting_transcription", "awaiting_editorial", "draft"].includes(
            project.status,
          ) && (
            <>
              <div className="saved-symbol">
                <ShieldCheck size={32} />
              </div>
              <span className="eyebrow">
                {project.recording
                  ? "SAFELY ON YOUR PRIVATE SHELF"
                  : "YOUR MEMORY SPACE"}
              </span>
              <h1>
                {project.recording
                  ? "Your voice.\nKept with care."
                  : "Ready when you are."}
              </h1>
              <p className="lead">
                {project.recording
                  ? "Your recording is saved in your private shelf. You can close this page and come back to it."
                  : "Start recording from the Tell a story screen."}
              </p>
              {project.recording && (
                <div className="saved-audio">
                  <audio
                    controls
                    src={`/api/projects/${projectId}/audio`}
                    aria-label="Your saved recording"
                  />
                  <p className="small">
                    <Check size={14} /> Saved ·{" "}
                    {(project.recording.bytes / 1024 / 1024).toFixed(2)} MB ·
                    Private
                  </p>
                </div>
              )}
              {project.recording && !project.engine && (
                <StoryStudio project={project} refresh={refresh} />
              )}
              {project.status === "awaiting_transcription" && !manual && (
                <button
                  className="button secondary full"
                  onClick={() => setManual(true)}
                >
                  Add a transcript yourself
                </button>
              )}
              {project.status === "draft" && (
                <button className="button full" onClick={() => go("/capture")}>
                  Tell a story
                </button>
              )}
              {project.status === "awaiting_editorial" && (
                <details className="source-details">
                  <summary>Your confirmed transcript</summary>
                  <p className="preserve-whitespace">
                    {project.transcript?.rawText}
                  </p>
                </details>
              )}
              {manual && (
                <section className="manual-transcript">
                  <h2>Your words, written down.</h2>
                  <label>
                    Enter the transcript
                    <textarea
                      rows={8}
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      maxLength={50000}
                    />
                  </label>
                  <label className="consent">
                    <input
                      type="checkbox"
                      checked={attested}
                      onChange={(e) => setAttested(e.target.checked)}
                    />
                    <span>
                      I checked these words against my recording. This is a
                      manual transcript.
                    </span>
                  </label>
                  <button
                    className="button full"
                    disabled={!attested || text.trim().length < 10 || busy}
                    onClick={() => void saveWords()}
                  >
                    Save manual transcript
                  </button>
                </section>
              )}
            </>
          )}
        </section>
      )}
      <div className="delete-section">
        {deleting ? (
          <div className="delete-confirm">
            <p>
              Delete this memory, its recording, book, and all saved editions
              from your shelf? This cannot be undone.
            </p>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              Delete this memory
            </button>
            <button
              className="button secondary"
              onClick={() => setDeleting(false)}
            >
              Keep it
            </button>
          </div>
        ) : (
          <button
            className="text-button muted"
            onClick={() => setDeleting(true)}
          >
            <Trash2 size={15} /> Delete this memory
          </button>
        )}
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
