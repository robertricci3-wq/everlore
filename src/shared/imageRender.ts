import { z } from "zod";

// Rendering choices are part of the immutable profile, not ambient server state.
export const ImageRenderSpec = z
  .object({
    version: z.literal(1),
    model: z.string().min(1),
    width: z
      .number()
      .int()
      .min(256)
      .max(3840)
      .refine((n) => n % 16 === 0),
    height: z
      .number()
      .int()
      .min(256)
      .max(3840)
      .refine((n) => n % 16 === 0),
    quality: z.enum(["low", "medium", "high"]),
    format: z.literal("png"),
    capability: z.enum(["legacy_baseline", "unverified", "verified"]),
    capabilityEvidenceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  })
  .superRefine((s, ctx) => {
    if (
      s.width * s.height > 8294400 ||
      s.width * s.height < 655360 ||
      Math.max(s.width, s.height) / Math.min(s.width, s.height) > 3
    )
      ctx.addIssue({
        code: "custom",
        message: "Unsupported render dimensions",
      });
    if (s.capability === "verified" && !s.capabilityEvidenceHash)
      ctx.addIssue({
        code: "custom",
        message: "Verified capability requires retained evidence",
      });
  });
export type ImageRenderSpecification = z.infer<typeof ImageRenderSpec>;
export const legacyImageRender = (model: string): ImageRenderSpecification => ({
  version: 1,
  model,
  width: 1024,
  height: 1024,
  quality: "high",
  format: "png",
  capability: "legacy_baseline",
  capabilityEvidenceHash: null,
});
export const PRINT_RENDER_CANDIDATE: ImageRenderSpecification = {
  ...legacyImageRender("gpt-image-2"),
  width: 2560,
  height: 2560,
  capability: "unverified",
};
export interface ImageRenderReceipt {
  version: 1;
  specification: ImageRenderSpecification;
  actual: { width: number; height: number; format: string };
  referenceHashes: string[];
  outputHash: string;
  transformation: "provider_original";
  dimensionsMatch: boolean;
}
