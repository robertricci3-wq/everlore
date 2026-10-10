import { z } from "zod";
import { Transcript } from "./contracts.js";
import {
  MEMORY_INVITATIONS,
  type MemoryInvitationRecord,
} from "./invitations.js";

export const MEMORY_GUIDE_VERSION = "memory-guide-rules-v1" as const;
export const AlmanacPage = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  chapterId: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  invitationIds: z.array(z.string().min(1)).min(1),
});
export type AlmanacPageRecord = z.infer<typeof AlmanacPage>;
export const ALMANAC_CHAPTERS = [
  {
    id: "before",
    title: "Before you knew me",
    description:
      "Childhood games, mischief, secret places and small ambitions.",
  },
  {
    id: "people",
    title: "The people who changed everything",
    description: "Meetings, friendships, help and becoming a family.",
  },
  {
    id: "places",
    title: "Places we called home",
    description: "Rooms, familiar routes, moving and arriving.",
  },
  {
    id: "table",
    title: "Around our table",
    description: "Recipes, celebrations, ordinary meals and familiar words.",
  },
  {
    id: "outdoors",
    title: "Out into the world",
    description: "Adventures, unexpected turns, discoveries and journeys.",
  },
  {
    id: "trying",
    title: "Things we tried",
    description: "Making, working, mistakes and learning.",
  },
  {
    id: "particular",
    title: "Our particular way",
    description: "Family language, traditions, objects and habits.",
  },
  {
    id: "lasting",
    title: "What stays with us",
    description:
      "Kindness, change, people we miss and things to carry forward.",
  },
] as const;
export const ALMANAC_PAGES: AlmanacPageRecord[] = MEMORY_INVITATIONS.map(
  (invitation) =>
    AlmanacPage.parse({
      version: 1,
      id: invitation.id,
      chapterId: invitation.chapterId,
      title: invitation.title,
      description: invitation.opening,
      invitationIds: [invitation.id],
    }),
);
export const DEFAULT_ALMANAC_PAGES = ALMANAC_PAGES;
export const getAlmanacPage = (id: string) =>
  ALMANAC_PAGES.find((page) => page.id === id);

export const InterviewTurn = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  sessionId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  promptId: z.string().min(1),
  promptText: z.string().min(1),
  promptVersion: z.string().min(1),
  status: z.enum([
    "awaiting_audio",
    "audio_saved",
    "transcribing",
    "complete",
    "skipped",
    "needs_attention",
  ]),
  audio: z
    .object({
      recordingId: z.string().min(1),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      mime: z.string().min(1),
      bytes: z.number().int().positive(),
      captureMode: z.enum(["microphone", "upload"]),
    })
    .nullable(),
  transcript: Transcript.extend({
    mode: z.enum(["manual", "live"]),
  }).nullable(),
  createdAt: z.string().min(1),
});
export type InterviewTurnRecord = z.infer<typeof InterviewTurn>;
export const InterviewSession = z
  .object({
    version: z.literal(1),
    purpose: z.enum(["memory", "page_title"]).default("memory"),
    id: z.string().min(1),
    projectId: z.string().min(1),
    pageId: z.string().min(1),
    invitationId: z.string().min(1),
    invitationVersion: z.string().min(1),
    status: z.enum(["open", "finished"]),
    turns: z.array(InterviewTurn),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .superRefine((session, ctx) => {
    const ids = new Set<string>(),
      sequences = new Set<number>();
    session.turns.forEach((turn, index) => {
      if (
        ids.has(turn.id) ||
        sequences.has(turn.sequence) ||
        turn.sessionId !== session.id
      )
        ctx.addIssue({
          code: "custom",
          path: ["turns", index],
          message:
            "Turns must belong to this session with unique IDs and sequence numbers.",
        });
      if (turn.status === "complete" && !turn.transcript)
        ctx.addIssue({
          code: "custom",
          path: ["turns", index, "transcript"],
          message: "A completed turn requires a transcript.",
        });
      ids.add(turn.id);
      sequences.add(turn.sequence);
    });
  });
export type InterviewSessionRecord = z.infer<typeof InterviewSession>;
export const MemoryEvidence = z.object({
  turnId: z.string().min(1),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  quote: z.string().min(1),
});
export type MemoryEvidenceRecord = z.infer<typeof MemoryEvidence>;
export const MemorySignalKind = z.enum([
  "event",
  "ritual",
  "detail",
  "stated_meaning",
  "relationship_ambiguity",
  "uncertainty",
  "sensitive",
  "declined",
]);
export const MemoryBrief = z
  .object({
    version: z.literal(1),
    method: z.literal("rule_based"),
    modelValidated: z.literal(false),
    sessionId: z.string().min(1),
    projectId: z.string().min(1),
    sourceRevision: z.number().int().nonnegative(),
    status: z.enum(["open", "finished"]),
    sources: z.array(
      z.object({ turnId: z.string().min(1), transcript: z.string().min(1) }),
    ),
    signals: z.array(
      z.object({ kind: MemorySignalKind, evidence: MemoryEvidence }),
    ),
    answeredPromptIds: z.array(z.string().min(1)),
    boundary: z.literal(
      "Exact transcript evidence only. Rule signals are provisional retrieval aids, not facts, emotions, diagnoses or creative inventions.",
    ),
  })
  .superRefine((brief, ctx) => {
    const sources = new Map(
      brief.sources.map((source) => [source.turnId, source.transcript]),
    );
    if (sources.size !== brief.sources.length)
      ctx.addIssue({
        code: "custom",
        path: ["sources"],
        message: "Duplicate source turns are not allowed.",
      });
    brief.signals.forEach((signal, index) => {
      const { turnId, start, end, quote } = signal.evidence;
      if (end <= start || sources.get(turnId)?.slice(start, end) !== quote)
        ctx.addIssue({
          code: "custom",
          path: ["signals", index, "evidence"],
          message:
            "Evidence must match an exact span of the source transcript.",
        });
    });
  });
export type MemoryBriefRecord = z.infer<typeof MemoryBrief>;

// These transparent lexical cues only choose an optional question. They do not
// classify someone's cognitive health, infer feelings, or extract new facts.
const rules: Array<[z.infer<typeof MemorySignalKind>, RegExp]> = [
  [
    "event",
    /\b(?:once|one (?:day|morning|evening|afternoon|night)|that (?:day|morning|evening|afternoon|night))\b/gi,
  ],
  [
    "ritual",
    /\b(?:(?:every|each) (?:morning|evening|night|day|week|year|sunday|monday|tuesday|wednesday|thursday|friday|saturday)|used to|usually|always|our tradition|our custom)\b/gi,
  ],
  [
    "detail",
    /[“"][^”"\n]{2,160}[”"]|\b(?:smell(?:ed)?|scent|sound|heard|tast(?:e|ed)|red|blue|green|yellow|wooden|striped|wool|cotton|brass|buttons?|cups?|coat|door|table|bread|rice|song)\b/gi,
  ],
  [
    "stated_meaning",
    /\b(?:(?:I|we) (?:learned|realized|realised|valued)|it (?:mattered|meant)|important to me|what stayed with me|I still think|I (?:loved|love) (?:that|those|it))\b/gi,
  ],
  [
    "relationship_ambiguity",
    /\b(?:I|we)(?:['’](?:m|re))?\s+(?:(?:am|was|were)\s+)?(?:not sure|(?:don['’]t|do not) know|don['’]t remember|didn['’]t know|can['’]t remember|cannot remember)\s+(?:(?:whether|if|which)\b[^.!?\n]{1,90}?\b(?:was|is|were|are)\s+(?:(?:my|our|his|her|their|an?|the)\s+)?(?:uncle|aunt|cousin|brother|sister|father|mother|grandparent)s?\b(?!['’]s)|how\b[^.!?\n]{0,70}\brelated\b|who\s+(?:(?:my|our|his|her|their|the)\s+)?(?:uncle|aunt|cousin|brother|sister|father|mother|grandparent)\s+(?:was|is)\b)/gi,
  ],
  [
    "uncertainty",
    /\b(?:maybe|perhaps|not sure|I think|can['’]t remember|cannot remember|don['’]t remember|(?:I|we) (?:don['’]t|do not) know|might have)\b/gi,
  ],
  [
    "sensitive",
    /\b(?:died|death|funeral|abuse|assault|violence|grief|miscarriage|estranged|painful to remember|hard to talk about)\b/gi,
  ],
  [
    "declined",
    /\b(?:I (?:don['’]t|do not) want to (?:say|share|discuss|talk|answer)|I['’]d rather not|leave (?:that|this) out|keep (?:that|this) private|nothing (?:else|more) to add|that['’]s all I (?:remember|want to say))\b/gi,
  ],
  [
    "declined",
    /\b(?:(?:I['’]m|I am|we['’]re|we are) (?:done|finished)|(?:I|we) (?:would like|want|need) to (?:stop|pause|finish)|(?:I|we) need a break|(?:please )?(?:don['’]t|do not) ask|no more questions|(?:that['’]s|that is) enough|(?:can we|let['’]s|please) (?:stop|pause|finish))\b|^\s*(?:stop|skip|pass|no|no,? thanks|no,? thank you|not now|enough|all done)[.!?\s]*$/gim,
  ],
];
export function buildMemoryBrief(
  input: InterviewSessionRecord,
): MemoryBriefRecord {
  const session = InterviewSession.parse(input);
  const turns = [...session.turns].sort((a, b) => a.sequence - b.sequence);
  const sources = turns
    .filter((turn) => turn.status === "complete" && turn.transcript)
    .map((turn) => ({ turnId: turn.id, transcript: turn.transcript!.rawText }));
  const signals = sources.flatMap((source) =>
    rules.flatMap(([kind, regex]) => {
      // matchAll clones each expression so calls never share lastIndex state.
      return [...source.transcript.matchAll(regex)].map((match) => ({
        kind,
        evidence: {
          turnId: source.turnId,
          start: match.index,
          end: match.index + match[0].length,
          quote: match[0],
        },
      }));
    }),
  );
  return MemoryBrief.parse({
    version: 1,
    method: "rule_based",
    modelValidated: false,
    sessionId: session.id,
    projectId: session.projectId,
    sourceRevision: sources.length,
    status: session.status,
    sources,
    signals,
    answeredPromptIds: [
      ...new Set(
        turns
          .filter(
            (turn) => turn.status === "complete" || turn.status === "skipped",
          )
          .map((turn) => turn.promptId),
      ),
    ],
    boundary:
      "Exact transcript evidence only. Rule signals are provisional retrieval aids, not facts, emotions, diagnoses or creative inventions.",
  });
}
export const GuideDecision = z.object({
  version: z.literal(1),
  guideVersion: z.literal(MEMORY_GUIDE_VERSION),
  method: z.literal("rule_based"),
  modelValidated: z.literal(false),
  action: z.enum(["ask", "finish", "wait"]),
  reason: z.string().min(1),
  evidence: z.array(MemoryEvidence),
  promptId: z.string().optional(),
  promptText: z.string().optional(),
  promptVersion: z.string().optional(),
});
export type GuideDecisionRecord = z.infer<typeof GuideDecision>;
export function nextMemoryPrompt(
  invitation: MemoryInvitationRecord,
  input: MemoryBriefRecord,
  turns: InterviewTurnRecord[],
): GuideDecisionRecord {
  const brief = MemoryBrief.parse(input);
  const result = (
    action: GuideDecisionRecord["action"],
    reason: string,
    prompt?: { id: string; text: string },
    evidence: MemoryEvidenceRecord[] = [],
  ) =>
    GuideDecision.parse({
      version: 1,
      guideVersion: MEMORY_GUIDE_VERSION,
      method: "rule_based",
      modelValidated: false,
      action,
      reason,
      evidence,
      ...(prompt
        ? {
            promptId: prompt.id,
            promptText: prompt.text,
            promptVersion: invitation.revision,
          }
        : {}),
    });
  if (brief.status === "finished")
    return result("finish", "The narrator has finished this memory.");
  if (
    turns.some(
      (turn) => turn.status !== "complete" && turn.status !== "skipped",
    )
  )
    return result(
      "wait",
      "Keep the existing turn; its recording or transcript is still pending.",
    );
  if (!turns.length)
    return result("ask", "Start with the narrator's chosen invitation.", {
      id: `${invitation.id}:opening`,
      text: invitation.opening,
    });
  const followUpIds = new Set(invitation.followUps.map((prompt) => prompt.id));
  if (turns.filter((turn) => followUpIds.has(turn.promptId)).length >= 3)
    return result(
      "finish",
      "Three optional follow-ups have been offered. This memory can stay as it is.",
    );
  if (!brief.sources.length)
    return result("finish", "A skipped invitation does not need an answer.");
  const signals = (kind: z.infer<typeof MemorySignalKind>) =>
    brief.signals
      .filter((signal) => signal.kind === kind)
      .map((signal) => signal.evidence);
  if (signals("declined").length)
    return result(
      "finish",
      "Respect the narrator's stated boundary; do not probe further.",
      undefined,
      signals("declined"),
    );
  if (signals("sensitive").length)
    return result(
      "finish",
      "Keep this sensitive memory as shared. Further detail is optional and narrator-led.",
      undefined,
      signals("sensitive"),
    );
  const asked = new Set([
    ...brief.answeredPromptIds,
    ...turns.map((turn) => turn.promptId),
  ]);
  for (const prompt of invitation.followUps) {
    if (asked.has(prompt.id)) continue;
    let eligible = false,
      evidence: MemoryEvidenceRecord[] = [];
    switch (prompt.when) {
      case "explicit_relationship_ambiguity":
        evidence = signals("relationship_ambiguity");
        eligible = evidence.length > 0;
        break;
      case "ritual_without_event":
        evidence = signals("ritual");
        eligible =
          evidence.length > 0 &&
          !signals("event").length &&
          !signals("uncertainty").length;
        break;
      case "missing_detail":
        eligible = !signals("detail").length && !signals("uncertainty").length;
        break;
      case "missing_meaning":
        eligible = !signals("stated_meaning").length;
        break;
    }
    if (eligible)
      return result(
        "ask",
        `Optional ${prompt.when.replaceAll("_", " ")} question; no answer is required.`,
        prompt,
        evidence,
      );
  }
  return result(
    "finish",
    "There is enough to preserve this telling. Further memories can be added later.",
  );
}
