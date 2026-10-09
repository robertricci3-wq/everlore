import type { z } from "zod";
import {
  CRAFT_WEIGHTS,
  type Heart,
  type Manuscript2,
  type HeartReview,
  type EditorialReview,
  type StoryVerdict,
  type StoryPlan,
  type ConceptSet,
  type ConceptReview,
} from "../../shared/studio.js";
import { wordCount, type TranscriptDocument } from "../../shared/contracts.js";
import { AMPLIFICATION_MOVES, explicitAudioCues } from "./craft.js";
const normalized = (s: string) => s.replace(/\s+/g, " ").trim();
// Audio evidence is deterministic metadata, not a model's interpretation.
// Preserve all family facts/quotes; an unsupported cue flag becomes ordinary.
export function reconcileHeartCues(heart: Heart, source: TranscriptDocument) {
  const correctedIds: string[] = [];
  const nuggets = heart.nuggets.map((nugget) => {
    const segment = source.segments.find((s) => s.id === nugget.sourceId);
    if (
      nugget.emphasis !== "explicit_cue" ||
      explicitAudioCues(segment?.text ?? "").length
    )
      return nugget;
    correctedIds.push(nugget.id);
    return { ...nugget, emphasis: "ordinary" as const };
  });
  return { version: 1, heart: { ...heart, nuggets }, correctedIds };
}
export function heartProblems(heart: Heart, source: TranscriptDocument) {
  const errors: string[] = [],
    ids = new Set(heart.nuggets.map((n) => n.id));
  if (ids.size !== heart.nuggets.length)
    errors.push("Duplicate memory nugget IDs.");
  for (const nugget of heart.nuggets) {
    const segment = source.segments.find((s) => s.id === nugget.sourceId);
    if (
      !segment ||
      !normalized(segment.text).includes(normalized(nugget.quote))
    )
      errors.push(`Nugget ${nugget.id} does not quote its source passage.`);
    if (
      nugget.emphasis === "explicit_cue" &&
      !/\[(pause|long[ _]pause|laughs?|voice[ _]breaks|sigh|trails[ _]off|repeats)\]/i.test(
        segment?.text ?? "",
      )
    )
      errors.push(`Nugget ${nugget.id} invents an audio cue.`);
  }
  if (
    new Set(heart.ledger.map((e) => e.nuggetId)).size !== heart.ledger.length ||
    heart.ledger.length !== ids.size ||
    heart.ledger.some((e) => !ids.has(e.nuggetId))
  )
    errors.push("Every source nugget needs exactly one ledger entry.");
  if (!heart.ledger.some((e) => e.tier === "protected"))
    errors.push("Identify at least one protected particular.");
  for (const phrase of heart.protectedPhrases)
    if (!normalized(source.rawText).includes(normalized(phrase)))
      errors.push("A protected phrase is not present in the source.");
  return errors;
}
export function chooseConcept(
  set: z.infer<typeof ConceptSet>,
  review: z.infer<typeof ConceptReview>,
  heart: Heart,
) {
  const ids = new Set(set.concepts.map((c) => c.id));
  const known = new Set(heart.nuggets.map((n) => n.id));
  if (
    ids.size !== 3 ||
    new Set(set.concepts.map((c) => c.premise.trim().toLowerCase())).size !==
      3 ||
    new Set(review.assessments.map((a) => a.conceptId)).size !== 3 ||
    review.assessments.some((a) => !ids.has(a.conceptId)) ||
    set.concepts.some((c) => c.protectedNuggetIds.some((n) => !known.has(n)))
  )
    throw new Error("Invalid premise comparison");
  const ranked = [...review.assessments]
    .filter((a) => !a.heartViolations.length)
    .sort(
      (a, b) =>
        2 * b.familySpecificity +
        b.childAppeal +
        b.imaginativePotential -
        (2 * a.familySpecificity + a.childAppeal + a.imaginativePotential),
    );
  if (!ranked.length) throw new Error("No premise protects this memory");
  return set.concepts.find((c) => c.id === ranked[0].conceptId)!;
}
export function planProblems(plan: z.infer<typeof StoryPlan>, heart: Heart) {
  const ids = new Set(heart.nuggets.map((n) => n.id)),
    errors: string[] = [];
  if (
    plan.beats.some(
      (b, i) => b.spread !== i + 1 || b.nuggetIds.some((n) => !ids.has(n)),
    )
  )
    errors.push("Story beats must be ordered and linked to real nuggets.");
  if (
    plan.amplifications.some(
      (a) =>
        !(a.move in AMPLIFICATION_MOVES) ||
        a.nuggetIds.some((n) => !ids.has(n)),
    )
  )
    errors.push(
      "Every amplification must name a recognized move and source nugget.",
    );
  if (plan.setups.some((s) => s.plantedAt >= s.paidOffAt))
    errors.push("A setup must precede its payoff.");
  return errors;
}
export function evaluateStory(
  heart: Heart,
  manuscript: Manuscript2,
  auditor: z.infer<typeof HeartReview>,
  critic: z.infer<typeof EditorialReview>,
): StoryVerdict {
  const heartFailures = [...auditor.failures],
    craftFailures = [...critic.blockingIssues],
    mechanical: string[] = [];
  const known = new Set(heart.nuggets.map((n) => n.id));
  if (
    new Set(auditor.checks.map((c) => c.nuggetId)).size !==
      auditor.checks.length ||
    auditor.checks.some((c) => !known.has(c.nuggetId))
  )
    heartFailures.push("Audit contains duplicate or unknown nugget IDs.");
  for (const entry of heart.ledger.filter((e) => e.tier === "protected")) {
    const check = auditor.checks.find((c) => c.nuggetId === entry.nuggetId);
    if (!check || !check.present || check.contradicted || check.spread === null)
      heartFailures.push(
        `Protected nugget ${entry.nuggetId} is missing, contradicted, or lacks a spread citation.`,
      );
  }
  if (
    !auditor.meaningPreserved ||
    !auditor.tellerNotDiminished ||
    !auditor.inventionsDisclosed
  )
    heartFailures.push("Meaning, respect, or invention disclosure failed.");
  const prose = normalized(manuscript.spreads.map((s) => s.text).join(" "));
  for (const phrase of heart.protectedPhrases)
    if (!prose.includes(normalized(phrase)))
      heartFailures.push(`Protected phrase missing: ${phrase}`);
  if (manuscript.spreads.some((s) => s.nuggetIds.some((id) => !known.has(id))))
    mechanical.push("A spread references a missing nugget.");
  const count = wordCount(prose);
  if (count < 250 || count > 450)
    mechanical.push(`The story has ${count} words; require 250–450.`);
  manuscript.spreads.forEach((s, i) => {
    if (wordCount(s.text) > 45)
      mechanical.push(`Spread ${i + 1} exceeds 45 words.`);
  });
  if (new Set(manuscript.spreads.map((s) => s.text)).size !== 12)
    mechanical.push("Repeated spread text.");
  const expected = Object.keys(CRAFT_WEIGHTS),
    scored = new Set(critic.scores.map((s) => s.criterion));
  if (scored.size !== expected.length || scored.size !== critic.scores.length)
    craftFailures.push("Every craft dimension needs exactly one score.");
  if (!critic.ageAppropriate)
    craftFailures.push("The story needs age-sensitive editing.");
  if (critic.genericStory)
    craftFailures.push(`Generic story: ${critic.genericnessEvidence}`);
  const mean =
    scored.size === expected.length && scored.size === critic.scores.length
      ? critic.scores.reduce(
          (sum, s) => sum + s.score * CRAFT_WEIGHTS[s.criterion],
          0,
        ) / Object.values(CRAFT_WEIGHTS).reduce((a, b) => a + b, 0)
      : 0;
  const minimum = Math.min(...critic.scores.map((s) => s.score), 5);
  if (minimum < 3 || mean < 4)
    craftFailures.push("Craft scores are below the provisional threshold.");
  return {
    heartFailures,
    craftFailures,
    mechanical,
    weightedMean: Math.round(mean * 100) / 100,
    minimum,
    passed:
      !heartFailures.length &&
      !craftFailures.length &&
      !mechanical.length &&
      !critic.repairs.length,
  };
}
export function notWorse(next: StoryVerdict, previous: StoryVerdict) {
  const rank = (v: StoryVerdict) => [
    Number(v.passed),
    -v.heartFailures.length,
    -v.mechanical.length,
    -v.craftFailures.length,
    v.minimum,
    v.weightedMean,
  ];
  const a = rank(next),
    b = rank(previous);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

// Assembly of a clearly labeled review copy is distinct from passing all
// editorial gates. Never waive protected truth, structural or age safeguards.
export function canAssembleReviewCopy(
  verdict: StoryVerdict,
  critic: z.infer<typeof EditorialReview>,
) {
  return (
    !verdict.heartFailures.length &&
    !verdict.mechanical.length &&
    critic.ageAppropriate &&
    !critic.genericStory &&
    verdict.minimum >= 3 &&
    verdict.weightedMean >= 4
  );
}
