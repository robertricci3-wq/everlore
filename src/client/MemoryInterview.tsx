import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Mic, Plus, Volume2 } from "lucide-react";
import {
  ALMANAC_CHAPTERS,
  type GuideDecisionRecord,
  type InterviewSessionRecord,
  type InterviewTurnRecord,
  type MemoryBriefRecord,
} from "../shared/almanac.js";
import { api, go, type SessionUser } from "./api.js";
import type { AlmanacPageDetail } from "./almanacApi.js";
import { AlmanacMotif } from "./AlmanacMotif.js";
import { BookCard } from "./Almanac.js";
import { VoiceTurnRecorder } from "./VoiceTurnRecorder.js";
import { MemoryTextAnswer } from "./MemoryTextAnswer.js";

interface SessionView {
  session: InterviewSessionRecord;
  brief: MemoryBriefRecord;
  nextPrompt: GuideDecisionRecord;
  aiProcessingConsented: boolean;
  titleApplication?: { title: string } | null;
  sourceRevisions: {
    id: string;
    revision: number;
    sourceHash: string;
    projectId: string;
  }[];
  transcriptionJobs: { jobId: string; turnId: string; status: string }[];
}
function listen(text: string) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.92;
  const local = window.speechSynthesis
    .getVoices()
    .find((v) => v.localService && v.lang.startsWith("en"));
  if (local) utterance.voice = local;
  window.speechSynthesis.speak(utterance);
}
export function MemoryInvitationPage({
  pageId,
  titleOnly = false,
}: {
  pageId: string;
  titleOnly?: boolean;
}) {
  const [data, setData] = useState<AlmanacPageDetail>(),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const createKey = useRef(crypto.randomUUID());
  useEffect(() => {
    let active = true;
    void api<AlmanacPageDetail>(`/almanac/pages/${pageId}`)
      .then((v) => {
        if (active) setData(v);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
      window.speechSynthesis?.cancel();
    };
  }, [pageId]);
  const invitation = data?.invitations[0],
    opening = titleOnly
      ? "What would you like to call this page? A few words are enough."
      : (invitation?.opening ??
        `What comes to mind when you think about ${data?.page.title ?? "this memory"}? Start wherever you like.`);
  async function begin() {
    if (!consent) {
      setError("Please confirm that you have permission to share this memory.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const session = await api<SessionView>(
        `/almanac/pages/${pageId}/${titleOnly ? "title-session" : "sessions"}`,
        {
          consent: true,
          processWithOpenAI: true,
          key: createKey.current,
          invitationId: invitation?.id,
        },
      );
      go(`/interview/${session.session.id}`);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="memory-page enter">
      <a className="back-link" href="#/shelf">
        <ArrowLeft size={17} />
        Your almanac
      </a>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {!data ? (
        <p className="loading">Opening your invitation…</p>
      ) : (
        <>
          <span className="eyebrow">
            {ALMANAC_CHAPTERS.find((c) => c.id === data.page.chapterId)
              ?.title ?? "A PAGE OF YOUR OWN"}
          </span>
          <h1>{titleOnly ? "Give your page a name." : data.page.title}</h1>
          <p className="lead">
            An ordinary memory is enough. Pause, skip a question, or finish
            whenever you like. There’s no need to tell it perfectly.
          </p>
          {data.titleSessions.map((s) => (
            <div className="memory-status" key={s.id}>
              <p>You have a page name in progress.</p>
              <a className="text-button" href={`#/interview/${s.id}`}>
                Return to your page name <ArrowRight size={16} />
              </a>
            </div>
          ))}
          {!titleOnly &&
            data.sessions.map((s) => (
              <div className="memory-status" key={s.id}>
                <p>
                  {s.status === "finished"
                    ? "A telling you’ve saved on this page."
                    : "You’ve already begun a telling on this page."}
                </p>
                <a className="text-button" href={`#/interview/${s.id}`}>
                  Return to your saved memory <ArrowRight size={16} />
                </a>
              </div>
            ))}
          <section className="memory-invitation">
            <AlmanacMotif
              index={Math.max(
                0,
                ALMANAC_CHAPTERS.findIndex((c) => c.id === data.page.chapterId),
              )}
            />
            <span className="eyebrow">A PLACE TO BEGIN</span>
            <h2>{opening}</h2>
            {"speechSynthesis" in window && (
              <button className="text-button" onClick={() => listen(opening)}>
                <Volume2 size={18} />
                Listen to the invitation
              </button>
            )}
          </section>
          {!titleOnly && invitation && (
            <details className="memory-hints">
              <summary>Another way into this memory</summary>
              {invitation.alternativeEntries.map((t) => (
                <p key={t}>{t}</p>
              ))}
              <p>{invitation.sensitiveGuidance.message}</p>
            </details>
          )}
          <label className="consent">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            <span>
              I’m an adult and have permission to share this memory. Everlore
              may use AI to transcribe each part I save. My recordings stay
              private; I choose when to make the story.
            </span>
          </label>
          <div className="memory-choices">
            <button
              className="button"
              disabled={busy}
              onClick={() => void begin()}
            >
              <Mic size={21} />
              {busy
                ? "Opening your memory…"
                : !titleOnly && data.sessions.length
                  ? "Begin another telling"
                  : "Let’s begin"}
              <ArrowRight size={18} />
            </button>
            <a className="text-button" href="#/shelf">
              Choose a different page
            </a>
          </div>
          {data.books.some((b) => b.revision > 0) && (
            <section className="almanac-finished">
              <h2>Stories from this page.</h2>
              <div className="almanac-books">
                {data.books
                  .filter((b) => b.revision > 0)
                  .map((book) => (
                    <BookCard key={book.projectId} book={book} />
                  ))}
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}

export function MemoryInterview({
  sessionId,
  user,
}: {
  sessionId: string;
  user: SessionUser;
}) {
  const [data, setData] = useState<SessionView>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [aiConsent, setAiConsent] = useState(false),
    [storyConsent, setStoryConsent] = useState(false),
    [exclude, setExclude] = useState<string[]>([]);
  const [unsavedAudio, setUnsavedAudio] = useState(false),
    [unsavedText, setUnsavedText] = useState(false);
  const [titleInput, setTitleInput] = useState<string | null>(null);
  const [families, setFamilies] = useState<{ id: string; name: string }[]>([]),
    [familyId, setFamilyId] = useState("");
  const turnKey = useRef<{ prompt: string; key: string } | null>(null),
    loaded = useRef(false);
  async function load() {
    const value = await api<SessionView>(`/interviews/${sessionId}`);
    setData(value);
    setAiConsent(value.aiProcessingConsented);
    loaded.current = true;
    return value;
  }
  useEffect(() => {
    let live = true;
    const poll = () =>
      void api<SessionView>(`/interviews/${sessionId}`)
        .then((value) => {
          if (live) {
            setData(value);
            if (!loaded.current) {
              setAiConsent(value.aiProcessingConsented);
              loaded.current = true;
            }
          }
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    poll();
    const timer = setInterval(poll, 2000);
    void api<{ id: string; name: string }[]>("/families")
      .then((value) => {
        if (live) {
          setFamilies(value);
          setFamilyId(value[0]?.id ?? "");
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
      clearInterval(timer);
      window.speechSynthesis?.cancel();
    };
  }, [sessionId]);
  const active = data?.session.turns.find(
    (t) => !["complete", "skipped"].includes(t.status),
  );
  const completed =
    data?.session.turns.filter((t) => t.status === "complete") ?? [];
  const titleSession = data?.session.purpose === "page_title";
  const selected = completed.filter((t) => !exclude.includes(t.id));
  async function act(action: () => Promise<unknown>) {
    setError("");
    setBusy(true);
    try {
      await action();
      await load();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function newTurn(promptId: string) {
    await act(async () => {
      if (data?.session.status === "finished")
        await api(`/interviews/${sessionId}/reopen`, {});
      if (!turnKey.current || turnKey.current.prompt !== promptId)
        turnKey.current = { prompt: promptId, key: crypto.randomUUID() };
      await api(`/interviews/${sessionId}/turns`, {
        promptId,
        key: turnKey.current.key,
      });
      turnKey.current = null;
    });
  }
  async function transcribe(turnId: string) {
    if (!aiConsent) {
      setError(
        "Please allow AI transcription before continuing. Your recording is already saved.",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api(`/interviews/${sessionId}/turns/${turnId}/transcribe`, {
        processWithOpenAI: true,
      });
      await load();
    } catch {
      setError(
        "Your recording is safe. Everlore cannot listen to it right now. You can return later, or add the words yourself below.",
      );
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }
  async function saved(turn: InterviewTurnRecord) {
    setUnsavedAudio(false);
    await load();
    if (aiConsent) await transcribe(turn.id);
  }
  async function makeStory() {
    if (!selected.length) {
      setError("Save at least one part of your memory first.");
      return;
    }
    if (!storyConsent) {
      setError(
        "Please allow Everlore to use your selected memory to create an imaginative story.",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      const source = await api<{ projectId: string }>(
        `/interviews/${sessionId}/freeze`,
        { consent: true, turnIds: selected.map((t) => t.id) },
      );
      await api(`/projects/${source.projectId}/engine`, {
        processWithOpenAI: true,
        imaginativeAdaptation: true,
        legacyWish: "",
        familyVersionId: familyId || null,
      });
      await api(`/interviews/${sessionId}/finish`, {});
      go(`/story/${source.projectId}`);
    } catch {
      setError(
        "Your memory is saved. Story creation is not available right now. You can return to this page and try again when Everlore is ready.",
      );
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }
  const promptText = active?.promptText ?? data?.nextPrompt.promptText;
  return (
    <main className="memory-page enter">
      <a className="back-link" href="#/shelf">
        <ArrowLeft size={17} />
        Your almanac
      </a>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {!data ? (
        <p className="loading">Finding your saved memory…</p>
      ) : (
        <>
          <span className="eyebrow">
            ONE MEMORY. YOUR OWN WAY OF TELLING IT.
          </span>
          <h1>
            {completed.length ? (
              "A little more of your world."
            ) : (
              <>
                Take your time.
                <br />
                <em>We’re listening.</em>
              </>
            )}
          </h1>
          {data.session.status === "finished" && !titleSession && (
            <div className="memory-status">
              <p>
                <Check size={17} />
                This telling is saved.
              </p>
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  void act(() => api(`/interviews/${sessionId}/reopen`, {}))
                }
              >
                Add something to this memory
              </button>
            </div>
          )}
          {promptText && data.session.status !== "finished" && (
            <section className="memory-invitation">
              <span className="eyebrow">
                {completed.length
                  ? "ONLY IF YOU’D LIKE TO ADD MORE"
                  : "A PLACE TO BEGIN"}
              </span>
              <h2>{promptText}</h2>
              {"speechSynthesis" in window && !active && (
                <button
                  className="text-button"
                  onClick={() => listen(promptText)}
                >
                  <Volume2 size={18} />
                  Listen to the question
                </button>
              )}
              {!active && data.nextPrompt.action === "ask" && (
                <div className="memory-choices">
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => void newTurn(data.nextPrompt.promptId!)}
                  >
                    <Mic size={20} />
                    Answer in your own time
                  </button>
                  {completed.length > 0 && (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() =>
                        void act(() =>
                          api(`/interviews/${sessionId}/finish`, {}),
                        )
                      }
                    >
                      That’s enough for now
                    </button>
                  )}
                </div>
              )}
              {active?.status === "awaiting_audio" && (
                <>
                  <VoiceTurnRecorder
                    key={active.id}
                    ownerId={user.id}
                    sessionId={sessionId}
                    turnId={active.id}
                    onSaved={() => saved(active)}
                    onDraftState={setUnsavedAudio}
                    disabled={unsavedText}
                  />
                  <button
                    className="text-button"
                    disabled={busy || unsavedAudio || unsavedText}
                    onClick={() =>
                      void act(() =>
                        api(
                          `/interviews/${sessionId}/turns/${active.id}/skip`,
                          {},
                        ),
                      )
                    }
                  >
                    Skip this question
                  </button>
                </>
              )}
              {active?.audio && active.status !== "awaiting_audio" && (
                <div className="memory-saved-turn">
                  <p>
                    <Check size={17} />
                    This part is safely saved.
                  </p>
                  <audio
                    controls
                    aria-label="Your saved answer"
                    src={`/api/interviews/${sessionId}/turns/${active.id}/audio`}
                  />
                </div>
              )}
              {active?.status === "audio_saved" && (
                <>
                  {!data.aiProcessingConsented && (
                    <label className="consent">
                      <input
                        type="checkbox"
                        checked={aiConsent}
                        onChange={(e) => setAiConsent(e.target.checked)}
                      />
                      <span>Use AI to transcribe my saved recording.</span>
                    </label>
                  )}
                  <button
                    className="button full"
                    disabled={busy}
                    onClick={() => void transcribe(active.id)}
                  >
                    Listen and continue <ArrowRight size={18} />
                  </button>
                </>
              )}
              {active?.status === "transcribing" && (
                <p className="memory-status" role="status">
                  Listening to your saved answer… You can leave this page and
                  return.
                </p>
              )}
              {active?.status === "needs_attention" && (
                <p className="memory-status">
                  Your recording is safe. This part needs help from Everlore
                  before it can continue. It won’t be sent again automatically.
                </p>
              )}
              {active && active.status !== "transcribing" && (
                <MemoryTextAnswer
                  key={active.id}
                  ownerId={user.id}
                  turnId={active.id}
                  disabled={busy || unsavedAudio}
                  onDraftState={setUnsavedText}
                  onSave={async (text) => {
                    await api(
                      `/interviews/${sessionId}/turns/${active.id}/text`,
                      { rawText: text },
                    );
                    setUnsavedText(false);
                    await load();
                  }}
                />
              )}
            </section>
          )}
          {titleSession && data.titleApplication && (
            <div className="memory-status">
              <p>
                <Check size={17} />
                Your page name is saved.
              </p>
              <a
                className="text-button"
                href={`#/memory/${data.session.pageId}`}
              >
                Open your page <ArrowRight size={16} />
              </a>
            </div>
          )}
          {titleSession && !data.titleApplication && completed.length > 0 && (
            <section className="almanac-add">
              <h2>A name for this page.</h2>
              <p>
                Your original words are kept below. You can shorten or edit the
                page name before saving it.
              </p>
              <label>
                Page name
                <input
                  maxLength={100}
                  value={
                    titleInput ??
                    completed[0].transcript?.rawText.slice(0, 100) ??
                    ""
                  }
                  onChange={(e) => setTitleInput(e.target.value)}
                />
              </label>
              <button
                className="button"
                disabled={
                  busy ||
                  !(titleInput ?? completed[0].transcript?.rawText ?? "").trim()
                }
                onClick={() =>
                  void act(async () => {
                    const result = await api<{ pageId: string }>(
                      `/interviews/${sessionId}/apply-title`,
                      {
                        title: (
                          titleInput ??
                          completed[0].transcript?.rawText ??
                          ""
                        )
                          .trim()
                          .slice(0, 100),
                      },
                    );
                    go(`/memory/${result.pageId}`);
                  })
                }
              >
                Save page name <ArrowRight size={18} />
              </button>
              <details className="memory-hints">
                <summary>Your recorded title</summary>
                {completed.map((turn) => (
                  <div key={turn.id}>
                    {turn.audio && (
                      <audio
                        controls
                        aria-label="Your spoken page name"
                        src={`/api/interviews/${sessionId}/turns/${turn.id}/audio`}
                      />
                    )}
                    <p>{turn.transcript?.rawText}</p>
                  </div>
                ))}
              </details>
            </section>
          )}
          {!titleSession && completed.length > 0 && (
            <section aria-label="Your memory so far">
              <span className="eyebrow">IN YOUR WORDS</span>
              <blockquote className="memory-reflection">
                <p>
                  “
                  {selected[0]?.transcript?.rawText.slice(0, 220) ??
                    completed[0].transcript?.rawText.slice(0, 220)}
                  {(selected[0]?.transcript?.rawText.length ??
                    completed[0].transcript?.rawText.length ??
                    0) > 220
                    ? "…"
                    : ""}
                  ”
                </p>
              </blockquote>
              <p className="muted">
                The people, particulars and meaning you’ve shared will guide the
                story. Your original words stay with it.
              </p>
              <details className="memory-source-selection">
                <summary>
                  Listen to your answers or choose what goes into the story
                </summary>
                {completed.map((turn) => (
                  <div className="memory-saved-turn" key={turn.id}>
                    <p className="small">{turn.promptText}</p>
                    {turn.audio && (
                      <audio
                        controls
                        aria-label={`Saved answer ${turn.sequence}`}
                        src={`/api/interviews/${sessionId}/turns/${turn.id}/audio`}
                      />
                    )}
                    <label>
                      <input
                        type="checkbox"
                        checked={!exclude.includes(turn.id)}
                        onChange={(e) =>
                          setExclude((current) =>
                            e.target.checked
                              ? current.filter((id) => id !== turn.id)
                              : [...current, turn.id],
                          )
                        }
                      />
                      <span>{turn.transcript?.rawText}</span>
                    </label>
                  </div>
                ))}
              </details>
              {active && active.status !== "awaiting_audio" && (
                <p className="notice">
                  Your latest part is still waiting to be transcribed. Finish it
                  before making a story so it can be included.
                </p>
              )}
              {!!families.length && (
                <div className="memory-cast">
                  <label>
                    Use these characters
                    <select
                      value={familyId}
                      onChange={(e) => setFamilyId(e.target.value)}
                    >
                      {families.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                      <option value="">Begin a new animal family</option>
                    </select>
                  </label>
                  <p className="small muted">
                    Familiar characters, a new story. Earlier books keep their
                    original characters.
                  </p>
                </div>
              )}
              <label className="consent">
                <input
                  type="checkbox"
                  checked={storyConsent}
                  onChange={(e) => setStoryConsent(e.target.checked)}
                />
                <span>
                  Use my selected memory with AI to create an imaginative family
                  story. Keep its heart and meaningful particulars.
                </span>
              </label>
              <div className="memory-choices">
                <button
                  className="button"
                  disabled={
                    busy ||
                    unsavedAudio ||
                    unsavedText ||
                    !selected.length ||
                    !!active?.audio
                  }
                  onClick={() => void makeStory()}
                >
                  Make my story <ArrowRight size={18} />
                </button>
                {!active && (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void newTurn("additional-memory")}
                  >
                    <Plus size={18} />
                    Add something
                  </button>
                )}
                <a className="text-button" href="#/shelf">
                  Save for later
                </a>
              </div>
              {data.sourceRevisions.length > 0 && (
                <details className="memory-hints">
                  <summary>Stories started from this memory</summary>
                  {data.sourceRevisions.map((source) => (
                    <p key={source.id}>
                      <a
                        className="text-button"
                        href={`#/story/${source.projectId}`}
                      >
                        Open saved story {source.revision}{" "}
                        <ArrowRight size={15} />
                      </a>
                    </p>
                  ))}
                </details>
              )}
            </section>
          )}
          {!completed.length && (
            <>
              <p className="small muted">
                Every part you save stays on your private shelf. You can leave
                and return whenever you like.
              </p>
              {!active &&
                data.nextPrompt.action === "finish" &&
                !titleSession && (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void newTurn("additional-memory")}
                  >
                    <Mic size={18} />
                    Tell it your own way
                  </button>
                )}
              <a className="text-button" href="#/shelf">
                Save for later
              </a>
            </>
          )}
        </>
      )}
    </main>
  );
}
