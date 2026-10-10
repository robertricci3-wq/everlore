import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALMANAC_CHAPTERS,
  ALMANAC_PAGES,
  InterviewSession,
  MemoryBrief,
  buildMemoryBrief,
  nextMemoryPrompt,
  type InterviewSessionRecord,
  type InterviewTurnRecord,
} from "../src/shared/almanac.js";
import {
  INVITATION_REVISION,
  MEMORY_INVITATIONS,
  MEMORY_RESEARCH,
  getMemoryInvitation,
} from "../src/shared/invitations.js";

const date = "2026-10-09T12:00:00.000Z";
const invitation = getMemoryInvitation("people-how-we-met")!;
function session(): InterviewSessionRecord {
  return {
    version: 1,
    purpose: "memory",
    id: "interview-fixture",
    projectId: "project-fixture",
    pageId: invitation.id,
    invitationId: invitation.id,
    invitationVersion: INVITATION_REVISION,
    status: "open",
    turns: [],
    createdAt: date,
    updatedAt: date,
  };
}
function addTurn(
  current: InterviewSessionRecord,
  text: string | null,
  promptId = `${invitation.id}:opening`,
  status: InterviewTurnRecord["status"] = text === null
    ? "skipped"
    : "complete",
) {
  const sequence = current.turns.length;
  current.turns.push({
    version: 1,
    id: `turn-${sequence}`,
    sessionId: current.id,
    sequence,
    promptId,
    promptText: "A snapshotted fixture invitation.",
    promptVersion: INVITATION_REVISION,
    status,
    audio: null,
    transcript:
      text === null
        ? null
        : {
            version: 1,
            mode: "manual",
            recordingId: null,
            rawText: text,
            segments: [
              { id: `segment-${sequence}`, text, startMs: null, endMs: null },
            ],
          },
    createdAt: date,
  });
  return current;
}
function choose(current: InterviewSessionRecord, chosen = invitation) {
  return nextMemoryPrompt(chosen, buildMemoryBrief(current), current.turns);
}

// Deliberately authored synthetic tellings: these test rules, not memory quality,
// narrator psychology, book quality or observed child engagement.
test("32 authored invitations follow the accepted eight chapters with one topic per page", () => {
  assert.deepEqual(
    ALMANAC_CHAPTERS.map((chapter) => [chapter.id, chapter.title]),
    [
      ["before", "Before you knew me"],
      ["people", "The people who changed everything"],
      ["places", "Places we called home"],
      ["table", "Around our table"],
      ["outdoors", "Out into the world"],
      ["trying", "Things we tried"],
      ["particular", "Our particular way"],
      ["lasting", "What stays with us"],
    ],
  );
  assert.equal(MEMORY_INVITATIONS.length, 32);
  assert.equal(ALMANAC_PAGES.length, 32);
  assert.equal(new Set(MEMORY_INVITATIONS.map((item) => item.id)).size, 32);
  assert.equal(
    new Set(MEMORY_INVITATIONS.map((item) => item.opening)).size,
    32,
  );
  for (const chapter of ALMANAC_CHAPTERS) {
    assert.equal(
      ALMANAC_PAGES.filter((page) => page.chapterId === chapter.id).length,
      4,
    );
  }
  for (const page of ALMANAC_PAGES) {
    const item = getMemoryInvitation(page.invitationIds[0])!;
    assert.deepEqual(page.invitationIds, [page.id]);
    assert.equal(item.chapterId, page.chapterId);
    assert.equal(item.version, 1);
    assert.equal(item.revision, INVITATION_REVISION);
    assert(item.alternativeEntries.length >= 2);
    assert(item.sensitiveGuidance.allowSkip);
    assert(
      item.research.some((source) => source.id === "storycorps-conversation"),
    );
    assert.match(item.evidenceLabel, /not been empirically validated/);
    assert.match(item.creativeBoundary, /never present.*remembered facts/);
    assert(item.creativeOpportunities.length > 0);
  }
  assert.equal(getMemoryInvitation("not-an-invitation"), undefined);
  assert.equal(
    MEMORY_RESEARCH.find((source) => source.id === "herz-schooler-2002")
      ?.readScope,
    "abstract",
  );
  assert.equal(
    MEMORY_RESEARCH.find((source) => source.id === "storycorps-conversation")
      ?.evidenceType,
    "professional_guidance",
  );
});

test("a sparse answer receives an optional authored prompt without invented details or motives", () => {
  const current = addTurn(session(), "We met. That is the beginning.");
  const brief = buildMemoryBrief(current);
  const decision = choose(current);
  assert.deepEqual(brief.sources, [
    { turnId: "turn-0", transcript: "We met. That is the beginning." },
  ]);
  assert.equal(brief.method, "rule_based");
  assert.equal(brief.modelValidated, false);
  assert.equal(decision.action, "ask");
  assert.equal(decision.promptId, `${invitation.id}:detail`);
  assert.equal(
    decision.promptText,
    invitation.followUps.find((prompt) => prompt.when === "missing_detail")
      ?.text,
  );
  assert.deepEqual(decision.evidence, []);
  assert(
    !brief.signals.some((signal) => signal.kind === "relationship_ambiguity"),
  );
  assert.doesNotMatch(decision.promptText!, /love|lonel|fright|happy|sad/i);
});

test("a rambling telling retains every word and stops when detail and expressed meaning are present", () => {
  const text =
    "Well, the train, no, before the train. One day Jo stood at the blue door. I forgot to say we had bread. Anyway, it mattered because we waited together. [pause] That is the part I remember.";
  const current = addTurn(session(), text);
  const brief = buildMemoryBrief(current);
  assert.equal(brief.sources[0].transcript, text);
  assert.equal(choose(current).action, "finish");
  for (const { evidence } of brief.signals) {
    assert.equal(text.slice(evidence.start, evidence.end), evidence.quote);
    assert.equal(evidence.turnId, "turn-0");
  }
  // A typed pause is preserved, not interpreted as a suppressed want or emotion.
  assert(
    !brief.signals.some((signal) => signal.evidence.quote.includes("pause")),
  );
});

test("uncertainty blocks requests for sensory detail and a specific occasion without blocking preservation", () => {
  const current = addTurn(
    session(),
    "We usually went somewhere together. I don't know where. Maybe it was after school.",
  );
  const decision = choose(current);
  assert.equal(decision.action, "ask");
  assert.equal(decision.promptId, `${invitation.id}:meaning`);
  assert(!decision.promptText!.includes("where"));
  addTurn(current, "I cannot remember anything else.", decision.promptId);
  assert.equal(choose(current).action, "finish");
  assert.equal(buildMemoryBrief(current).sources.length, 2);
});

test("a cultural routine keeps original language and accepts remaining a routine", () => {
  const cultural = getMemoryInvitation("particular-family-language")!;
  const current = session();
  current.pageId = current.invitationId = cultural.id;
  const text =
    "Every Sunday she said “poco a poco” over rice. It meant we could take our time.";
  addTurn(current, text, `${cultural.id}:opening`);
  const decision = choose(current, cultural);
  assert.equal(decision.promptId, `${cultural.id}:occasion`);
  assert.match(decision.promptText!, /fine.*usual routine/);
  assert.doesNotMatch(
    decision.promptText!,
    /translate|tradition.*all|culture.*means/,
  );
  addTurn(current, null, decision.promptId);
  assert.equal(choose(current, cultural).action, "finish");
  assert.equal(buildMemoryBrief(current).sources[0].transcript, text);
});

test("a sensitive or declined telling ends automatic probing without a forced lesson", () => {
  for (const text of [
    "My brother died. I want to keep the day we sat together.",
    "I don't want to talk about that part.",
    "Please leave this out.",
    "That is private; I'd rather not.",
  ]) {
    const current = addTurn(session(), text);
    const decision = choose(current);
    assert.equal(decision.action, "finish", text);
    assert.equal(decision.promptText, undefined);
    assert(decision.evidence.length > 0);
    assert.equal(buildMemoryBrief(current).sources[0].transcript, text);
    assert.doesNotMatch(
      decision.reason,
      /diagnos|trauma|forgiv|silver lining|happy ending/i,
    );
  }
});

test("plain stop, pause, decline and no-more-question requests end automatic probing", () => {
  for (const text of [
    "I’m done.",
    "I am finished.",
    "Please stop.",
    "Can we pause?",
    "I need a break.",
    "Don't ask about it.",
    "Please do not ask me any more.",
    "No more questions.",
    "That's enough for today.",
    "I don't want to answer.",
    "No, thank you.",
    "No thanks.",
    "Not now.",
    "Skip.",
  ]) {
    const current = addTurn(session(), text);
    const decision = choose(current);
    assert.equal(decision.action, "finish", text);
    assert.equal(decision.promptText, undefined);
    assert.equal(buildMemoryBrief(current).sources[0].transcript, text);
  }
});

test("relationship clarification requires explicit uncertainty, never pronouns or pauses alone", () => {
  const current = addTurn(
    session(),
    "I'm not sure whether Jo was my aunt or cousin. We walked together.",
  );
  const decision = choose(current);
  assert.equal(decision.promptId, `${invitation.id}:relationship`);
  assert.match(decision.promptText!, /leave it uncertain/);
  assert(
    decision.evidence.every(
      (evidence) =>
        current.turns[0].transcript!.rawText.slice(
          evidence.start,
          evidence.end,
        ) === evidence.quote,
    ),
  );
  addTurn(current, "I still don't know.", decision.promptId);
  assert.notEqual(choose(current).promptId, decision.promptId);
  for (const text of [
    "He went there. She came too. [long pause]",
    "Jo was my aunt. I think it was Wednesday.",
    "I am not sure where my aunt lived.",
    "I do not know whether my aunt arrived before lunch.",
    "I don’t know whether the coat was my aunt’s favorite.",
  ]) {
    assert.notEqual(
      choose(addTurn(session(), text)).promptId,
      `${invitation.id}:relationship`,
      text,
    );
  }
});

test("three follow-ups include skipped prompts, never repeat, and extra material is not a fourth automatic prompt", () => {
  const current = addTurn(
    session(),
    "I am not sure whether Jo was my aunt or cousin.",
  );
  const relationship = `${invitation.id}:relationship`;
  const detail = `${invitation.id}:detail`;
  const meaning = `${invitation.id}:meaning`;
  addTurn(current, null, relationship);
  addTurn(current, null, detail);
  addTurn(current, "It mattered to us.", meaning);
  assert.equal(choose(current).action, "finish");
  addTurn(current, "Another bit I want to keep.", "additional-memory");
  assert.equal(choose(current).action, "finish");
  assert.equal(buildMemoryBrief(current).sources.length, 3);
  assert.deepEqual(buildMemoryBrief(current).answeredPromptIds, [
    `${invitation.id}:opening`,
    relationship,
    detail,
    meaning,
    "additional-memory",
  ]);
});

test("the guide waits for an unfinished recording, accepts a skipped opening, and honors a finished session", () => {
  const empty = session();
  assert.equal(choose(empty).promptText, invitation.opening);
  assert.equal(choose(empty).promptVersion, INVITATION_REVISION);
  assert.equal(
    choose(
      addTurn(session(), null, `${invitation.id}:opening`, "awaiting_audio"),
    ).action,
    "wait",
  );
  assert.equal(choose(addTurn(session(), null)).action, "finish");
  const done = session();
  done.status = "finished";
  assert.equal(choose(done).action, "finish");
});

test("evidence is verifiable and rejects invented, reassigned or out-of-range quotes", () => {
  const current = addTurn(
    session(),
    "One day the blue door opened. It mattered.",
  );
  const brief = buildMemoryBrief(current);
  for (const mutation of [
    { quote: "a wonderful loving family" },
    { turnId: "someone-elses-turn" },
    { end: 9000 },
    { start: 4, end: 2 },
  ]) {
    const bad = structuredClone(brief);
    Object.assign(bad.signals[0].evidence, mutation);
    assert.equal(MemoryBrief.safeParse(bad).success, false);
  }
  const invalid = structuredClone(current);
  invalid.turns.push(structuredClone(invalid.turns[0]));
  assert.equal(InterviewSession.safeParse(invalid).success, false);
  invalid.turns = [structuredClone(current.turns[0])];
  invalid.turns[0].sessionId = "another-session";
  assert.equal(InterviewSession.safeParse(invalid).success, false);
});

test("guide calls are deterministic and preserve non-English and Unicode source text in sequence order", () => {
  const current = addTurn(
    session(),
    "🍞 “Despacio.” Every morning we shared bread. It mattered.",
  );
  addTurn(current, "  Et puis, nous attendions.\n", "additional-memory");
  current.turns.reverse();
  const first = buildMemoryBrief(current);
  assert.deepEqual(first, buildMemoryBrief(current));
  assert.deepEqual(choose(current), choose(current));
  assert.equal(first.sources[0].turnId, "turn-0");
  assert.equal(first.sources[1].transcript, "  Et puis, nous attendions.\n");
  assert.equal(first.sourceRevision, 2);
  for (const { evidence } of first.signals) {
    const source = first.sources.find(
      (item) => item.turnId === evidence.turnId,
    )!;
    assert.equal(
      source.transcript.slice(evidence.start, evidence.end),
      evidence.quote,
    );
  }
});
