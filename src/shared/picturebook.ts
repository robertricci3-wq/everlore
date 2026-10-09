import { z } from "zod";
const text = z.string().trim().min(1).max(1500);
const spread = z.number().int().min(1).max(12);
export const ReaderExperience = z.object({
  version: z.literal(1),
  dramaticPossibilities: z
    .array(
      z.object({
        nuggetIds: z.array(text).min(1),
        remembered: text,
        possibleMotivation: text,
        imaginativeTransformation: text,
        status: z.literal("interpretation_and_invention"),
      }),
    )
    .min(1)
    .max(5),
  spreads: z
    .array(
      z.object({
        spread,
        understands: text,
        anticipates: text,
        discovers: text,
        feels: text,
        turnInvitation: text,
        wordsReveal: text,
        picturesReveal: text,
      }),
    )
    .length(12),
  language: z.object({
    voice: text,
    rhythm: text,
    repetitionWithChange: text,
    silence: text,
  }),
  specificityTests: z
    .array(
      z.object({
        nuggetId: text,
        removedDetail: text,
        affectedSpreads: z.array(spread).min(1),
        whatStopsWorking: text,
      }),
    )
    .min(1)
    .max(5),
});
const point = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});
export const VisualDirection = z.object({
  version: z.literal(1),
  emotionalColorProgression: text,
  recurringMotifs: z.array(text).max(4),
  spreads: z
    .array(
      z.object({
        spread,
        emotionalPurpose: text,
        colorIntent: text,
        density: z.enum(["quiet", "balanced", "dense"]),
        focalPoint: point,
        staging: z
          .array(
            z.object({
              characterId: text,
              center: point,
              scale: z.number().min(0.03).max(0.8),
              posture: text,
            }),
          )
          .min(1)
          .max(5),
        wordPictureRelationship: text,
        visualSurprise: text,
      }),
    )
    .length(12),
});
export const PremiseDiversity = z.object({
  version: z.literal(1),
  comparisons: z
    .array(
      z.object({
        firstId: text,
        secondId: text,
        distinct: z.boolean(),
        differenceInAction: text,
        differenceInPayoff: text,
      }),
    )
    .length(3),
});
