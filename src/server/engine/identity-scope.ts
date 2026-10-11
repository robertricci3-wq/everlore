import { z } from "zod";
export const IdentityScopeReview = z.object({
  characters: z.array(z.object({ id: z.string(), recognizable: z.boolean(), evidence: z.string().min(1) })),
  unexpectedNamedCharacters: z.array(z.string()),
  materialContradictions: z.array(z.string()),
  actionReadable: z.boolean(), physicalCoherence: z.boolean(), childAppropriate: z.boolean(),
});
export function identityScopePasses(review: z.infer<typeof IdentityScopeReview>, expected: string[]) {
  const ids = new Set(review.characters.map(c => c.id));
  return ids.size === review.characters.length && ids.size === expected.length &&
    expected.every(id => ids.has(id)) && review.characters.every(c => c.recognizable) &&
    !review.unexpectedNamedCharacters.length && !review.materialContradictions.length &&
    review.actionReadable && review.physicalCoherence && review.childAppropriate;
}
