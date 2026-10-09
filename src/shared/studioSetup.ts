import { z } from "zod";

// One source for the bounded production cycle, in integer cents. Keep the
// setup preview and worker reservation identical when generation stages change.
export const STUDIO_REQUEST_LIMITS = { audio: 1, text: 70, image: 42 } as const;
export function studioReservation(c: {
  audioReserve: number;
  textReserve: number;
  imageReserve: number;
}) {
  return (
    STUDIO_REQUEST_LIMITS.audio * c.audioReserve +
    STUDIO_REQUEST_LIMITS.text * c.textReserve +
    STUDIO_REQUEST_LIMITS.image * c.imageReserve
  );
}
export const usdCents = (value: number) => Math.round(value * 100);
const dollars = (label: string, maximum: number) =>
  z
    .number({ error: `Enter a valid ${label}.` })
    .min(0.01, `Enter a ${label} of at least $0.01.`)
    .max(maximum, `The ${label} cannot exceed $${maximum.toFixed(2)}.`)
    .refine(
      (n) => Math.abs(n * 100 - usdCents(n)) < 0.000001,
      `Use at most two decimal places for the ${label}.`,
    );
export const StudioSettingsInput = z.object({
  apiKey: z
    .string()
    .trim()
    .max(500, "The API key is too long.")
    .refine((v) => !v || v.length >= 20, "Paste the complete API key.")
    .refine((v) => !/[\r\n]/.test(v), "The API key must be a single line."),
  budgetUsd: dollars("total allowance", 10000),
  audioReserveUsd: dollars("audio request reserve", 100),
  textReserveUsd: dollars("editorial request reserve", 100),
  imageReserveUsd: dollars("illustration request reserve", 100),
  authorizeCosts: z.literal(true, {
    error: "Check the allowance authorization box before saving.",
  }),
});
export function studioSettingsIssue(
  input: unknown,
  hasKey: boolean,
  usedCents: number,
) {
  const result = StudioSettingsInput.safeParse(input);
  if (!result.success) return result.error.issues[0].message;
  if (!hasKey && !result.data.apiKey)
    return "Paste an API key before saving the connection.";
  if (usdCents(result.data.budgetUsd) < usedCents)
    return `The total allowance must cover the $${(usedCents / 100).toFixed(2)} already reserved.`;
  return null;
}
export interface StudioSetupView {
  ready: boolean;
  canStart: boolean;
  canManage: boolean;
  hasKey: boolean;
  budgetUsd: number;
  audioReserveUsd: number;
  textReserveUsd: number;
  imageReserveUsd: number;
  cycleReserveUsd: number;
  usedReserveUsd: number;
  message: string;
}
