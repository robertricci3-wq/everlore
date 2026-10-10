import { z } from "zod";

/** Policy snapshots are immutable; changed behavior requires a new identifier. */
export const MemoryGuideProfile = z.discriminatedUnion("id", [
  z
    .object({
      version: z.literal(1),
      id: z.literal("memory-guide-rules-v1"),
      suppressCompleteRitualPrompt: z.literal(false),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      id: z.literal("memory-guide-complete-ritual-v1"),
      suppressCompleteRitualPrompt: z.literal(true),
    })
    .strict(),
]);
export type MemoryGuideProfileRecord = z.infer<typeof MemoryGuideProfile>;
export const LEGACY_MEMORY_GUIDE = Object.freeze(
  MemoryGuideProfile.parse({
    version: 1,
    id: "memory-guide-rules-v1",
    suppressCompleteRitualPrompt: false,
  }),
);
export const COMPLETE_RITUAL_MEMORY_GUIDE = Object.freeze(
  MemoryGuideProfile.parse({
    version: 1,
    id: "memory-guide-complete-ritual-v1",
    suppressCompleteRitualPrompt: true,
  }),
);
// Offline policy evidence does not activate a production creative release.
export const DEFAULT_MEMORY_GUIDE = LEGACY_MEMORY_GUIDE;
