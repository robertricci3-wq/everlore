import { z } from "zod";
import { ImageRenderSpec } from "./imageRender.js";
export const ProfileBody = z.object({
  version: z.literal(1),
  name: z.string().min(1).max(100),
  parentHash: z.string().nullable(),
  engineVersion: z.literal("legacy-2"),
  styleVersion: z.literal("folk-gouache-1"),
  models: z.object({ text: z.string(), image: z.string(), audio: z.string() }),
  imageRender: ImageRenderSpec.optional(),
  storySystem: z.string(),
  artSystem: z.string(),
  instructions: z.record(z.string(), z.string()),
  craftRules: z.record(z.string(), z.unknown()),
  rubric: z.object({
    version: z.literal("craft-2"),
    minimum: z.literal(3),
    mean: z.literal(4),
  }),
  change: z.object({
    target: z.enum([
      "baseline",
      "concepts",
      "plan",
      "compose",
      "refine",
      "art",
    ]),
    mechanism: z.string(),
    amendment: z.string(),
  }),
});
export const EngineProfile = ProfileBody.extend({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type Profile = z.infer<typeof EngineProfile>;
