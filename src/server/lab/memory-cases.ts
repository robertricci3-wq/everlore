import { getMemoryInvitation } from "../../shared/invitations.js";
import {
  InterviewSession,
  type InterviewTurnRecord,
} from "../../shared/almanac.js";
import type { MemoryPolicyCase } from "../../shared/memoryLab.js";

export const MEMORY_POLICY_CASE_VERSION = "complete-ritual-cases-v1";
const at = "2026-10-10T00:00:00.000Z";
type Expected = MemoryPolicyCase["expected"]["baseline"];
const finish: Expected = { action: "finish" };
const ask = (promptSuffix: string): Expected => ({
  action: "ask",
  promptSuffix,
});
function caseOf(
  id: string,
  title: string,
  category: string,
  text: string,
  baseline: Expected,
  candidate: Expected = baseline,
  extra: Array<{ text: string | null; suffix: string }> = [],
): MemoryPolicyCase {
  const invitation = getMemoryInvitation("particular-family-language")!;
  const answer = (
    rawText: string | null,
    suffix: string,
    sequence: number,
  ): InterviewTurnRecord => ({
    version: 1,
    id: `${id}-turn-${sequence}`,
    sessionId: id,
    sequence,
    promptId: `${invitation.id}:${suffix}`,
    promptText:
      sequence === 0
        ? invitation.opening
        : invitation.followUps.find((p) => p.id.endsWith(`:${suffix}`))!.text,
    promptVersion: invitation.revision,
    status: rawText === null ? "skipped" : "complete",
    audio: null,
    transcript:
      rawText === null
        ? null
        : {
            version: 1,
            mode: "manual",
            recordingId: null,
            rawText,
            segments: [
              {
                id: `${id}-segment-${sequence}`,
                text: rawText,
                startMs: null,
                endMs: null,
              },
            ],
          },
    createdAt: at,
  });
  return {
    id,
    title,
    category,
    synthetic: true,
    invitation,
    session: InterviewSession.parse({
      version: 1,
      purpose: "memory",
      id,
      projectId: `${id}-source`,
      pageId: invitation.id,
      invitationId: invitation.id,
      invitationVersion: invitation.revision,
      status: "open",
      createdAt: at,
      updatedAt: at,
      turns: [
        answer(text, "opening", 0),
        ...extra.map((x, i) => answer(x.text, x.suffix, i + 1)),
      ],
    }),
    expected: { baseline, candidate },
  };
}
/** Authored control-flow expectations, never observations of real narrators. */
export const memoryPolicyCases: MemoryPolicyCase[] = [
  caseOf(
    "ordinary-ritual",
    "The green cup",
    "ordinary",
    "Every morning we shared a green cup. It mattered because we had time together.",
    ask("occasion"),
    finish,
  ),
  caseOf(
    "rambling-ritual",
    "A roundabout telling",
    "rambling",
    "Well, before school, no, not school. Usually we sat by the blue door. I forgot the bread. Anyway I loved that we could sit together.",
    ask("occasion"),
    finish,
  ),
  caseOf(
    "cultural-ritual",
    "Poco a poco",
    "culturally-specific",
    "Every Sunday she said “poco a poco” over rice. It meant we could take our time.",
    ask("occasion"),
    finish,
  ),
  caseOf(
    "humorous-ritual",
    "The dancing bread",
    "humorous",
    "Every Saturday Uncle Ren called the bread “the dancing loaf.” It mattered because we laughed together.",
    ask("occasion"),
    finish,
  ),
  caseOf(
    "thin-ritual",
    "A fragment of a routine",
    "fragmented",
    "Usually we went together.",
    ask("occasion"),
  ),
  caseOf(
    "missing-meaning",
    "A particular without an explanation",
    "ordinary",
    "Every Sunday we carried the blue cup.",
    ask("occasion"),
  ),
  caseOf(
    "uncertain-ritual",
    "A place left uncertain",
    "uncertain",
    "Usually we carried a blue cup. I am not sure where. It mattered because we were together.",
    finish,
  ),
  caseOf(
    "uncertain-relationship",
    "A relationship left open",
    "uncertain",
    "Every Sunday we shared rice. It meant we had time. I am not sure whether Jo was my aunt or cousin.",
    ask("relationship"),
  ),
  caseOf(
    "sensitive-ritual",
    "Remembering someone",
    "sensitive",
    "My brother died. Every Sunday we shared bread. It mattered because we had time together.",
    finish,
  ),
  caseOf(
    "declined-ritual",
    "Enough for today",
    "sensitive",
    "Every Sunday we shared bread. It mattered because we had time together. No more questions.",
    finish,
  ),
  caseOf(
    "single-event",
    "A single remembered morning",
    "ordinary",
    "One morning we shared a green cup. It mattered because we had time together.",
    finish,
  ),
  caseOf(
    "three-followups",
    "The question limit",
    "fragmented",
    "Usually we went together.",
    finish,
    finish,
    [
      { text: null, suffix: "occasion" },
      { text: null, suffix: "detail" },
      { text: null, suffix: "meaning" },
    ],
  ),
];
