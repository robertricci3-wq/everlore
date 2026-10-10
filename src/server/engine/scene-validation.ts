import type { Snapshot } from "../../shared/studio.js";

// Manuscript cast is required, not exhaustive: pictures may include known
// supporting characters. Unknown identities and missing protagonists still fail.
export function worldProblems(
  world: Snapshot["world"],
  manuscript: Snapshot["manuscript"],
  scenes: Snapshot["scenes"],
) {
  const people = new Set(world.characters.map((c) => c.id)),
    objects = new Set(world.objects.map((o) => o.id)),
    issues: string[] = [];
  if (
    people.size !== world.characters.length ||
    objects.size !== world.objects.length
  )
    issues.push("Duplicate cast or object IDs.");
  for (const [i, s] of scenes.scenes.entries()) {
    if (
      s.spread !== i + 1 ||
      s.characterIds.some((c) => !people.has(c)) ||
      s.objectIds.some((o) => !objects.has(o)) ||
      new Set(s.characterIds).size !== s.characterIds.length ||
      new Set(s.objectIds).size !== s.objectIds.length ||
      manuscript.spreads[i].characterIds.some((c) => !s.characterIds.includes(c))
    )
      issues.push(`Scene ${i + 1} has inconsistent cast or object references.`);
    if (
      s.quietRegion[0] + s.quietRegion[2] > 1 ||
      s.quietRegion[1] + s.quietRegion[3] > 1
    )
      issues.push(`Scene ${i + 1} has invalid composition bounds.`);
  }
  if (new Set(scenes.scenes.map((s) => s.composition)).size < 3)
    issues.push("The scene sequence needs more composition variety.");
  return issues;
}
