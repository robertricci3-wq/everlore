import { z } from "zod";
export const POETICS_VERSION = "child-poetics-1";
export const lenses = [
  "desire",
  "causality",
  "specificity",
  "voice",
  "word_picture_relation",
  "earned_ending",
  "rereading",
] as const;
export const PoeticsReview = z.object({
  version: z.literal(POETICS_VERSION),
  findings: z
    .array(
      z.object({
        lens: z.enum(lenses),
        status: z.enum(["effective", "weak", "uncertain"]),
        spread: z.number().int().min(1).max(12),
        quote: z.string().min(1).max(700),
        analysis: z.string().min(8).max(1500),
        repair: z.string().max(1500),
        preserve: z.string().min(3).max(1000),
      }),
    )
    .length(7),
});
