import {
  ImageRenderSpec,
  type ImageRenderSpecification,
} from "../../shared/imageRender.js";
import { z } from "zod";

/** Rates are for synchronous, global-endpoint, default-tier requests, not Batch.
 * Reviewed 2026-10-10 against the official model pages, images-vision guide,
 * pricing page and image-generation output calculator. This is a reservation
 * model, never a representation of an account balance or provider billing cap.
 */
export const REQUEST_RATE_CARD = {
  version: "openai-global-default-2026-10-10-v2",
  sources: [
    "https://developers.openai.com/api/docs/models/gpt-5.4",
    "https://developers.openai.com/api/docs/models/gpt-4o-transcribe",
    "https://developers.openai.com/api/docs/guides/images-vision",
    "https://developers.openai.com/api/docs/guides/image-generation",
    "https://developers.openai.com/api/docs/pricing",
    "https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create",
  ],
  textInputUsdPerMillion: 2.5,
  textOutputUsdPerMillion: 15,
  imageTextInputUsdPerMillion: 5,
  imageInputUsdPerMillion: 8,
  imageOutputUsdPerMillion: 30,
} as const;

// These are explicit pilot assumptions, not a published input-token formula or
// provider billing ceiling. There are no defaults and no environment opt-in.
const EstimatedPolicySchema = z
  .object({
    version: z.literal(1),
    mode: z.literal("estimated_pilot"),
    textInputTokensPerByte: z.number().min(1).max(8),
    imageInputTokensPerReference: z.number().int().positive().max(1000000),
    imagePromptTokensPerByte: z.number().min(1).max(8),
    imageInputOverheadTokens: z.number().int().nonnegative().max(1000000),
    safetyMultiplier: z.number().min(1).max(10),
  })
  .strict();
export type EstimatedRequestPolicy = z.infer<typeof EstimatedPolicySchema>;
export function parseEstimatedRequestPolicy(
  input: unknown,
): EstimatedRequestPolicy {
  return EstimatedPolicySchema.parse(input);
}
export interface EstimatedRequestReservation {
  version: 1;
  costConfidence: "estimate";
  policyHash: string;
  rateCardVersion: string;
  model: string;
  kind: "text" | "image" | "audio";
  reservationCents: number;
  evidence: Record<string, number>;
}

export interface RequestCostBound {
  version: 1;
  rateCardVersion: string;
  model: string;
  kind: "text" | "image" | "audio";
  maxCostCents: number;
  evidence: Record<string, number>;
}
export interface MeteredCostEstimate {
  version: 1;
  rateCardVersion: string;
  estimatedCostCents: number;
  source: "provider_usage";
  billedCostCents: null;
}
export class RequestCostBoundError extends Error {
  readonly preDispatch = true;
  constructor(
    readonly code:
      | "unsupported_model"
      | "unsupported_settings"
      | "unbounded_image_input"
      | "unbounded_audio_input"
      | "input_too_large",
    message: string,
  ) {
    super(message);
    this.name = "RequestCostBoundError";
  }
}
function rejectSettings(): never {
  throw new RequestCostBoundError(
    "unsupported_settings",
    "This request has settings that the verified spending guard does not support. Nothing was sent to OpenAI.",
  );
}
function checkModel(model: string, expected: string) {
  if (model !== expected)
    throw new RequestCostBoundError(
      "unsupported_model",
      "The pinned model has no verified request cost rule. Nothing was sent to OpenAI.",
    );
}
function finish(
  model: string,
  kind: RequestCostBound["kind"],
  usd: number,
  evidence: Record<string, number>,
): RequestCostBound {
  if (
    !Number.isFinite(usd) ||
    usd < 0 ||
    Object.values(evidence).some((n) => !Number.isFinite(n) || n < 0)
  )
    rejectSettings();
  return {
    version: 1,
    rateCardVersion: REQUEST_RATE_CARD.version,
    model,
    kind,
    maxCostCents: Math.ceil(usd * 100),
    evidence,
  };
}

function estimatedReservation(
  policy: EstimatedRequestPolicy,
  policyHash: string,
  model: string,
  kind: EstimatedRequestReservation["kind"],
  usd: number,
  evidence: Record<string, number>,
): EstimatedRequestReservation {
  parseEstimatedRequestPolicy(policy);
  if (!/^[a-f0-9]{64}$/.test(policyHash)) rejectSettings();
  const amount = finish(model, kind, usd * policy.safetyMultiplier, evidence);
  return {
    version: 1,
    costConfidence: "estimate",
    policyHash,
    rateCardVersion: REQUEST_RATE_CARD.version,
    model,
    kind,
    reservationCents: Math.max(1, amount.maxCostCents),
    evidence: { ...evidence, safetyMultiplier: policy.safetyMultiplier },
  };
}

export interface StructuredCostInput {
  model: string;
  serviceTier: string;
  maxOutputTokens: number;
  /** Complete serialized request with each base64 image replaced by an empty URL. */
  serializedText: string;
  highDetailImageCount: number;
}
export function structuredRequestCost(
  input: StructuredCostInput,
): RequestCostBound {
  checkModel(input.model, "gpt-5.4");
  if (
    input.serviceTier !== "default" ||
    !Number.isSafeInteger(input.maxOutputTokens) ||
    input.maxOutputTokens < 1 ||
    input.maxOutputTokens > 128000 ||
    !Number.isSafeInteger(input.highDetailImageCount) ||
    input.highDetailImageCount < 0 ||
    input.highDetailImageCount > 500
  )
    rejectSettings();
  // Record actual input size, but do not mistake a byte count plus a guessed
  // protocol overhead for a verified token bound. Until exact server token
  // counting is integrated, use the documented full model context ceiling.
  // This intentionally over-reserves; it cannot silently relax the allowance.
  const textBytes = Buffer.byteLength(input.serializedText, "utf8");
  // GPT-5.4 high detail: <=2500 patches *1.2; include the documented rounding token.
  const visionTokens = input.highDetailImageCount * 3001;
  const inputTokens = 1050000;
  if (textBytes + visionTokens + input.maxOutputTokens > inputTokens)
    throw new RequestCostBoundError(
      "input_too_large",
      "This request exceeds the spending guard's supported context size. Nothing was sent to OpenAI.",
    );
  const longContext = true;
  const inputRate =
      REQUEST_RATE_CARD.textInputUsdPerMillion * (longContext ? 2 : 1),
    outputRate =
      REQUEST_RATE_CARD.textOutputUsdPerMillion * (longContext ? 1.5 : 1);
  return finish(
    input.model,
    "text",
    (inputTokens * inputRate + input.maxOutputTokens * outputRate) / 1e6,
    {
      textBytes,
      fullContextCeiling: 1,
      highDetailImageCount: input.highDetailImageCount,
      visionTokens,
      maxInputTokens: inputTokens,
      maxOutputTokens: input.maxOutputTokens,
      inputUsdPerMillion: inputRate,
      outputUsdPerMillion: outputRate,
      longContextPremium: Number(longContext),
    },
  );
}

export function estimatedStructuredRequestCost(
  input: StructuredCostInput,
  policy: EstimatedRequestPolicy,
  policyHash: string,
): EstimatedRequestReservation {
  // Preserve supported-model/settings/context validation. Only this separately
  // selected pilot policy substitutes an estimate for the full-context reserve.
  structuredRequestCost(input);
  parseEstimatedRequestPolicy(policy);
  const textBytes = Buffer.byteLength(input.serializedText, "utf8");
  const visionTokens = input.highDetailImageCount * 3001;
  const estimatedInputTokens =
    Math.ceil(textBytes * policy.textInputTokensPerByte) + visionTokens;
  if (estimatedInputTokens + input.maxOutputTokens > 1050000)
    throw new RequestCostBoundError(
      "input_too_large",
      "This request exceeds the pilot policy's supported context size. Nothing was sent to OpenAI.",
    );
  const longContext = estimatedInputTokens > 272000;
  const inputRate =
    REQUEST_RATE_CARD.textInputUsdPerMillion * (longContext ? 2 : 1);
  const outputRate =
    REQUEST_RATE_CARD.textOutputUsdPerMillion * (longContext ? 1.5 : 1);
  return estimatedReservation(
    policy,
    policyHash,
    input.model,
    "text",
    (estimatedInputTokens * inputRate + input.maxOutputTokens * outputRate) /
      1e6,
    {
      textBytes,
      highDetailImageCount: input.highDetailImageCount,
      visionTokens,
      estimatedInputTokens,
      maxOutputTokens: input.maxOutputTokens,
      inputUsdPerMillion: inputRate,
      outputUsdPerMillion: outputRate,
      longContextPremium: Number(longContext),
      textInputTokensPerByte: policy.textInputTokensPerByte,
    },
  );
}

/** Exact output-token formula published by the official output calculator.
 * This does NOT estimate input-image tokens, for which Image2 has no published
 * rule in that calculator. In particular, Image1 tile rules must not be reused.
 */
export function imageOutputTokens(spec: ImageRenderSpecification): number {
  const parsed = ImageRenderSpec.safeParse(spec);
  if (!parsed.success) rejectSettings();
  checkModel(spec.model, "gpt-image-2");
  const longGrid = { low: 16, medium: 48, high: 96 }[spec.quality];
  const short =
      (longGrid * Math.min(spec.width, spec.height)) /
      Math.max(spec.width, spec.height),
    floor = Math.floor(short);
  const shortGrid =
    short - floor === 0.5 ? floor + (floor % 2) : Math.round(short);
  return Math.ceil(
    (longGrid * shortGrid * (2000000 + spec.width * spec.height)) / 4000000,
  );
}
export function imageRequestCost(
  spec: ImageRenderSpecification,
  prompt: string,
  referenceCount: number,
): RequestCostBound {
  imageOutputTokens(spec);
  if (!Number.isSafeInteger(referenceCount) || referenceCount < 0)
    rejectSettings();
  if (referenceCount > 0)
    throw new RequestCostBoundError(
      "unbounded_image_input",
      "The strict spending guard cannot yet bound GPT Image 2 reference-image charges from published pricing rules. No generation was sent. Configure a verified reference-image cost rule before starting this book.",
    );
  const textBytes = Buffer.byteLength(prompt, "utf8");
  if (!textBytes || textBytes > 128000) rejectSettings();
  throw new RequestCostBoundError(
    "unbounded_image_input",
    "The strict spending guard has a verified image output calculation but no published GPT Image 2 input-context ceiling or complete input-token bound. No generation was sent.",
  );
}

export function estimatedImageRequestCost(
  spec: ImageRenderSpecification,
  prompt: string,
  referenceCount: number,
  policy: EstimatedRequestPolicy,
  policyHash: string,
): EstimatedRequestReservation {
  const outputTokens = imageOutputTokens(spec);
  parseEstimatedRequestPolicy(policy);
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  if (
    !promptBytes ||
    promptBytes > 128000 ||
    !Number.isSafeInteger(referenceCount) ||
    referenceCount < 0
  )
    rejectSettings();
  const estimatedTextInputTokens =
    Math.ceil(promptBytes * policy.imagePromptTokensPerByte) +
    policy.imageInputOverheadTokens;
  const estimatedImageInputTokens =
    referenceCount * policy.imageInputTokensPerReference;
  return estimatedReservation(
    policy,
    policyHash,
    spec.model,
    "image",
    (estimatedTextInputTokens * REQUEST_RATE_CARD.imageTextInputUsdPerMillion +
      estimatedImageInputTokens * REQUEST_RATE_CARD.imageInputUsdPerMillion +
      outputTokens * REQUEST_RATE_CARD.imageOutputUsdPerMillion) /
      1e6,
    {
      promptBytes,
      referenceCount,
      width: spec.width,
      height: spec.height,
      estimatedTextInputTokens,
      estimatedImageInputTokens,
      outputTokens,
      imageInputTokensPerReference: policy.imageInputTokensPerReference,
      imageInputOverheadTokens: policy.imageInputOverheadTokens,
      imagePromptTokensPerByte: policy.imagePromptTokensPerByte,
      textInputUsdPerMillion: REQUEST_RATE_CARD.imageTextInputUsdPerMillion,
      imageInputUsdPerMillion: REQUEST_RATE_CARD.imageInputUsdPerMillion,
      outputUsdPerMillion: REQUEST_RATE_CARD.imageOutputUsdPerMillion,
    },
  );
}

export function audioRequestCost(
  model: string,
  byteLength: number,
): RequestCostBound {
  checkModel(model, "gpt-4o-transcribe");
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < 1 ||
    byteLength > 25000000
  )
    rejectSettings();
  // The adapter deliberately omits chunking_strategy: the documented default
  // transcribes a single block. Reserve the complete 16k input context and 2k
  // output limit at the highest $10/M rate, plus one cent rounding headroom.
  // File bytes alone cannot bound duration; never apply this to chunked audio.
  return finish(model, "audio", 0.19, {
    byteLength,
    maxInputTokens: 16000,
    maxOutputTokens: 2000,
    inputUsdPerMillion: 10,
    outputUsdPerMillion: 10,
    singleBlock: 1,
    roundingMarginCents: 1,
  });
}

export function estimatedAudioRequestCost(
  model: string,
  byteLength: number,
  policy: EstimatedRequestPolicy,
  policyHash: string,
): EstimatedRequestReservation {
  const bound = audioRequestCost(model, byteLength);
  return estimatedReservation(
    policy,
    policyHash,
    model,
    "audio",
    bound.maxCostCents / 100,
    { ...bound.evidence, usesVerifiedAudioReservation: 1 },
  );
}

export function assertSupportedCostPlan(
  models: { text: string; image: string; audio: string },
  spec: ImageRenderSpecification,
  usesReferences = true,
): void {
  checkModel(models.text, "gpt-5.4");
  checkModel(models.audio, "gpt-4o-transcribe");
  checkModel(models.image, "gpt-image-2");
  if (spec.model !== models.image) rejectSettings();
  imageRequestCost(
    spec,
    "Preflight only; never transmitted.",
    usesReferences ? 1 : 0,
  );
}

/** Usage-derived estimate; the provider's invoice remains the billing source.
 * Missing or unfamiliar usage is left unknown instead of priced as zero.
 */
export function meteredCostEstimate(
  bound: Pick<RequestCostBound, "model" | "kind" | "rateCardVersion">,
  usage: Record<string, number> | null,
): MeteredCostEstimate | null {
  if (!usage) return null;
  const input = usage.input_tokens,
    output = usage.output_tokens;
  if (![input, output].every((n) => Number.isSafeInteger(n) && n >= 0))
    return null;
  let usd: number;
  if (bound.kind === "text" && bound.model === "gpt-5.4") {
    const longContext = input > 272000;
    usd =
      (input *
        REQUEST_RATE_CARD.textInputUsdPerMillion *
        (longContext ? 2 : 1) +
        output *
          REQUEST_RATE_CARD.textOutputUsdPerMillion *
          (longContext ? 1.5 : 1)) /
      1e6;
  } else if (bound.kind === "image" && bound.model === "gpt-image-2") {
    const textInput = usage.input_text_tokens,
      imageInput = usage.input_image_tokens;
    // Direct Images API usage reports text/image input separately. Do not
    // classify aggregate input as text or silently assume unknown inputs cost 0.
    if (
      ![textInput, imageInput].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      ) ||
      textInput + imageInput !== input
    )
      return null;
    usd =
      (textInput * REQUEST_RATE_CARD.imageTextInputUsdPerMillion +
        imageInput * REQUEST_RATE_CARD.imageInputUsdPerMillion +
        output * REQUEST_RATE_CARD.imageOutputUsdPerMillion) /
      1e6;
  } else return null;
  return {
    version: 1,
    rateCardVersion: bound.rateCardVersion,
    estimatedCostCents: usd * 100,
    source: "provider_usage",
    billedCostCents: null,
  };
}
