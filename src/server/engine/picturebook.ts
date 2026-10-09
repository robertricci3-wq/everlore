import type { z } from "zod";
import type {
  Heart,
  StoryPlan,
  ScenePlan,
  ConceptSet,
  VisualWorld,
} from "../../shared/studio.js";
import type { PremiseDiversity } from "../../shared/picturebook.js";

export function readerExperienceProblems(
  plan: z.infer<typeof StoryPlan>,
  heart: Heart,
) {
  const p = plan.readerExperience;
  if (!p) return ["Reader-experience plan is missing."];
  const errors: string[] = [];
  if (new Set(p.spreads.map((s) => s.spread)).size !== 12)
    errors.push("Reader experience must cover each spread exactly once.");
  const ids = new Set(heart.nuggets.map((n) => n.id));
  for (const d of p.dramaticPossibilities) {
    if (d.nuggetIds.some((id) => !ids.has(id)))
      errors.push("Dramatic possibility references an unknown source nugget.");
    // The remembered column is an exact source excerpt, not newly inferred biography.
    if (
      !heart.nuggets.some(
        (n) => d.nuggetIds.includes(n.id) && n.quote.includes(d.remembered),
      )
    )
      errors.push("Remembered evidence must quote a linked source nugget.");
  }
  for (const t of p.specificityTests)
    if (!ids.has(t.nuggetId))
      errors.push("Specificity test references an unknown source nugget.");
  return errors;
}
export function premiseDiversityProblems(
  set: z.infer<typeof ConceptSet>,
  review: z.infer<typeof PremiseDiversity>,
) {
  const ids = set.concepts.map((c) => c.id),
    seen = new Set<string>(),
    errors: string[] = [];
  if (new Set(ids).size !== 3) errors.push("Premise IDs must be unique.");
  for (const pair of review.comparisons) {
    const key = [pair.firstId, pair.secondId].sort().join("|");
    if (
      !ids.includes(pair.firstId) ||
      !ids.includes(pair.secondId) ||
      pair.firstId === pair.secondId ||
      seen.has(key)
    )
      errors.push(
        "Premise diversity requires all three distinct pairs exactly once.",
      );
    seen.add(key);
    if (!pair.distinct)
      errors.push(
        `Premises ${pair.firstId} and ${pair.secondId} differ only superficially: ${pair.differenceInAction} ${pair.differenceInPayoff}`,
      );
  }
  return errors;
}
export function visualDirectionProblems(
  scenes: z.infer<typeof ScenePlan>,
  world: z.infer<typeof VisualWorld>,
) {
  const d = scenes.visualDirection;
  if (!d) return ["Whole-book visual direction is missing."];
  const errors: string[] = [];
  if (new Set(d.spreads.map((s) => s.spread)).size !== 12)
    errors.push("Visual direction must cover all twelve spreads exactly once.");
  for (const s of d.spreads) {
    const cast =
      scenes.scenes.find((c) => c.spread === s.spread)?.characterIds ?? [];
    const staged = s.staging.map((c) => c.characterId);
    if (
      new Set(staged).size !== staged.length ||
      cast.some((id) => !staged.includes(id)) ||
      staged.some(
        (id) =>
          !cast.includes(id) || !world.characters.some((c) => c.id === id),
      )
    )
      errors.push(
        `Spread ${s.spread}: rough composition must stage exactly its contracted cast.`,
      );
  }
  return errors;
}
// Geometric storyboard, explicitly not finished artwork or an aesthetic verdict.
export function roughCompositionSvg(scenes: z.infer<typeof ScenePlan>) {
  const d = scenes.visualDirection;
  if (!d) throw new Error("Visual direction required.");
  const panels = [...d.spreads]
    .sort((a, b) => a.spread - b.spread)
    .map((s, i) => {
      const x = (i % 4) * 240,
        y = Math.floor(i / 4) * 180;
      return `<g transform="translate(${x},${y})"><rect x="2" y="2" width="232" height="172" fill="#f1ead5" stroke="#465e51"/><text x="12" y="22" font-size="12">${s.spread} · ${s.density}</text>${s.staging.map((c, j) => `<ellipse cx="${12 + c.center.x * 212}" cy="${30 + c.center.y * 130}" rx="${c.scale * 70}" ry="${c.scale * 90}" fill="${j % 2 ? "#cc633c" : "#56687d"}" opacity=".7"/>`).join("")}<circle cx="${12 + s.focalPoint.x * 212}" cy="${30 + s.focalPoint.y * 130}" r="4" fill="#343f44"/></g>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">${panels}</svg>`;
}
