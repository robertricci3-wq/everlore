import { z } from "zod";
import { ImageReview } from "../../shared/studio.js";

// Correctness and artistic distinction are separate evidence. Review-copy
// eligibility never changes the original scores or declares final acceptance.
export const ProductionImageReview = ImageReview.extend({
  correctnessDefects: z.array(z.string().min(1)),
});
export function imageAccepted(
  r: z.infer<typeof ImageReview> & { correctnessDefects?: string[] },
) {
  return (
    !r.defects.length &&
    !r.correctnessDefects?.length &&
    Math.min(r.identity, r.style, r.actionReadability, r.physicalCoherence) >= 4
  );
}
export function imageReviewCopyEligible(
  r: z.infer<typeof ProductionImageReview> & { meaningVerified?: boolean },
) {
  return (
    !r.correctnessDefects.length &&
    r.style >= 3 &&
    r.identity >= 4 &&
    Math.min(r.actionReadability, r.physicalCoherence) >=
      (r.meaningVerified ? 3 : 4)
  );
}
