import { z } from "zod";
import sharp from "sharp";
import { createHash } from "node:crypto";
import {
  ImageRenderSpec,
  legacyImageRender,
  type ImageRenderSpecification,
  type ImageRenderReceipt,
} from "../../shared/imageRender.js";
import type { EngineAvailability } from "../../shared/engine.js";
import {
  assertSupportedCostPlan,
  audioRequestCost,
  estimatedAudioRequestCost,
  estimatedImageRequestCost,
  estimatedStructuredRequestCost,
  imageRequestCost,
  meteredCostEstimate,
  parseEstimatedRequestPolicy,
  REQUEST_RATE_CARD,
  structuredRequestCost,
  type EstimatedRequestPolicy,
  type EstimatedRequestReservation,
  type MeteredCostEstimate,
  type RequestCostBound,
} from "./request-cost.js";
import {
  providerFailureMessage,
  type ProviderFailure,
} from "../../shared/providerFailure.js";

export class ProviderRequestError extends Error {
  constructor(readonly failure: ProviderFailure) {
    super(providerFailureMessage(failure));
  }
}
export async function rejectedResponse(
  response: Response,
): Promise<ProviderRequestError> {
  // Inspect only to classify. Never retain or display provider text, which can
  // echo credentials or family input. Unknown responses remain conservative.
  const body = (await response.json().catch(() => null)) as {
    error?: { code?: unknown; param?: unknown };
  } | null;
  const status = response.status,
    code = body?.error?.code;
  const kind =
    status === 401
      ? "authentication"
      : status === 403
        ? "permission"
        : status === 404
          ? "model"
          : status === 429 &&
              [
                "insufficient_quota",
                "billing_hard_limit_reached",
                "credit_balance_exhausted",
                "organization_spend_limit_exceeded",
                "project_spend_limit_exceeded",
                "organization_usage_limit_exceeded",
              ].includes(String(code))
            ? "quota"
            : status === 429
              ? "rate_limit"
              : status === 400 &&
                  typeof body?.error?.param === "string" &&
                  body.error.param.startsWith("text.format")
                ? "schema"
                : [400, 422].includes(status)
                  ? "request"
                  : "server";
  return new ProviderRequestError({
    kind,
    httpStatus: status,
    retrySafe: [400, 401, 403, 404, 422, 429].includes(status),
  });
}
export async function checkProviderConnection(
  apiKey: string,
  model: string,
  request: typeof fetch = fetch,
) {
  let response: Response;
  try {
    response = await request(
      `https://api.openai.com/v1/models/${encodeURIComponent(model)}`,
      {
        method: "GET",
        redirect: "error",
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15000),
      },
    );
  } catch {
    throw new ProviderRequestError({
      kind: "connection",
      httpStatus: null,
      retrySafe: false,
    });
  }
  if (!response.ok) throw await rejectedResponse(response);
}

/** Keep only documented numeric counters. Flatten known input detail fields so
 * old numeric usage readers remain compatible; never persist provider text. */
export function sanitizedProviderUsage(
  value: unknown,
): Record<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usage = value as Record<string, unknown>;
  const result: Record<string, number> = {};
  for (const key of [
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "seconds",
  ]) {
    const n = usage[key];
    if (
      typeof n === "number" &&
      Number.isFinite(n) &&
      n >= 0 &&
      (key === "seconds" || Number.isSafeInteger(n))
    )
      result[key] = n;
  }
  const details = usage.input_tokens_details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    for (const [key, target] of [
      ["text_tokens", "input_text_tokens"],
      ["image_tokens", "input_image_tokens"],
    ]) {
      const n = (details as Record<string, unknown>)[key];
      if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0)
        result[target] = n;
    }
  }
  return Object.keys(result).length ? result : null;
}

export interface ProviderReceipt {
  requestId: string | null;
  usage: Record<string, number> | null;
  imageRender?: ImageRenderReceipt;
  requestCostBound?: RequestCostBound;
  estimatedRequestReservation?: EstimatedRequestReservation;
  meteredCost?: MeteredCostEstimate | null;
}
export interface Provider {
  withModels?(models: { text: string; image: string; audio: string }): Provider;
  withImageRender?(specification: ImageRenderSpecification): Provider;
  withRequestGuard?(guard: (bound: RequestCostBound) => void): Provider;
  withEstimatedPolicy?(
    policy: EstimatedRequestPolicy,
    policyHash: string,
    guard: (reservation: EstimatedRequestReservation) => void,
  ): Provider;
  validateRequestCosts?(): void;
  takeReceipt?(): ProviderReceipt | null;
  transcribe(bytes: Buffer, mime: string): Promise<string>;
  structured<T>(
    name: string,
    schema: z.ZodType<T>,
    instructions: string,
    data: unknown,
    images?: Buffer[],
  ): Promise<T>;
  image(prompt: string, reference?: Buffer | Buffer[]): Promise<Buffer>;
}
export interface EngineConfig {
  enabled: boolean;
  apiKey: string;
  budgetCents: number;
  audioReserve: number;
  textReserve: number;
  imageReserve: number;
  textModel: string;
  imageModel: string;
  audioModel: string;
  imageRender?: ImageRenderSpecification;
  connectionError?: string;
  strictCostGuard?: boolean;
  /** Runtime-scoped dispatch context; never loaded implicitly from environment. */
  pilotCampaignId?: string;
  pilotCreationId?: string;
}
// No implicit paid allowance. The operator sets conservative per-request reserves
// against current pricing; reserves are not a claim about actual provider billing.
export function engineConfig(env = process.env): EngineConfig {
  const cents = (name: string) => {
    const n = Number(env[name]);
    return Number.isFinite(n) && n > 0 ? Math.ceil(n * 100) : 0;
  };
  return {
    enabled: env.EVERMORE_LIVE_ENABLED === "1",
    apiKey: env.OPENAI_API_KEY ?? "",
    budgetCents: cents("EVERMORE_BUDGET_USD"),
    audioReserve: cents("EVERMORE_AUDIO_RESERVE_USD"),
    textReserve: cents("EVERMORE_TEXT_RESERVE_USD"),
    imageReserve: cents("EVERMORE_IMAGE_RESERVE_USD"),
    textModel: "gpt-5.4",
    imageModel: "gpt-image-2",
    audioModel: "gpt-4o-transcribe",
    strictCostGuard: env.EVERLORE_STRICT_COST_GUARD === "1",
  };
}
export function availability(config: EngineConfig): EngineAvailability {
  const ready =
    !config.connectionError &&
    config.enabled &&
    !!config.apiKey &&
    [
      config.budgetCents,
      config.audioReserve,
      config.textReserve,
      config.imageReserve,
    ].every((n) => n > 0);
  return {
    ready,
    message:
      config.connectionError ??
      (ready
        ? "The story studio is configured. You choose when to send a memory to OpenAI."
        : "Your recording can be saved now. The AI story studio needs a provider key and an approved spending allowance before it can make your book."),
  };
}
export class OpenAIProvider implements Provider {
  withRequestGuard(guard: (bound: RequestCostBound) => void) {
    if (this.estimatedPolicy)
      throw new Error(
        "Strict and estimated request policies cannot be combined.",
      );
    return new OpenAIProvider(this.config, this.request, guard);
  }
  withEstimatedPolicy(
    policy: EstimatedRequestPolicy,
    policyHash: string,
    guard: (reservation: EstimatedRequestReservation) => void,
  ) {
    if (this.requestGuard)
      throw new Error(
        "Strict and estimated request policies cannot be combined.",
      );
    if (!/^[a-f0-9]{64}$/.test(policyHash))
      throw new Error("A frozen pilot policy hash is required.");
    return new OpenAIProvider(this.config, this.request, undefined, {
      policy: Object.freeze(parseEstimatedRequestPolicy(policy)),
      policyHash,
      guard,
    });
  }
  validateRequestCosts() {
    if (this.estimatedPolicy) {
      const { policy, policyHash } = this.estimatedPolicy;
      const specification =
        this.config.imageRender ?? legacyImageRender(this.config.imageModel);
      if (specification.model !== this.config.imageModel)
        throw new Error(
          "The render specification must match the pinned image model.",
        );
      estimatedStructuredRequestCost(
        {
          model: this.config.textModel,
          serviceTier: "default",
          maxOutputTokens: 12000,
          serializedText: "Preflight only; never transmitted.",
          highDetailImageCount: 0,
        },
        policy,
        policyHash,
      );
      estimatedImageRequestCost(
        specification,
        "Preflight only; never transmitted.",
        1,
        policy,
        policyHash,
      );
      estimatedAudioRequestCost(this.config.audioModel, 1, policy, policyHash);
      return;
    }
    if (!this.requestGuard) return;
    assertSupportedCostPlan(
      {
        text: this.config.textModel,
        image: this.config.imageModel,
        audio: this.config.audioModel,
      },
      this.config.imageRender ?? legacyImageRender(this.config.imageModel),
    );
  }
  withImageRender(specification: ImageRenderSpecification) {
    const imageRender = ImageRenderSpec.parse(specification);
    if (imageRender.model !== this.config.imageModel)
      throw new Error(
        "The render specification must match the pinned image model.",
      );
    return new OpenAIProvider(
      { ...this.config, imageRender },
      this.request,
      this.requestGuard,
      this.estimatedPolicy,
    );
  }
  withModels(models: { text: string; image: string; audio: string }) {
    return new OpenAIProvider(
      {
        ...this.config,
        textModel: models.text,
        imageModel: models.image,
        audioModel: models.audio,
      },
      this.request,
      this.requestGuard,
      this.estimatedPolicy,
    );
  }
  private receipt: ProviderReceipt | null = null;
  takeReceipt() {
    const result = this.receipt;
    this.receipt = null;
    return result;
  }
  constructor(
    private config: EngineConfig,
    private request: typeof fetch = fetch,
    private requestGuard?: (bound: RequestCostBound) => void,
    private estimatedPolicy?: {
      policy: EstimatedRequestPolicy;
      policyHash: string;
      guard: (reservation: EstimatedRequestReservation) => void;
    },
  ) {
    if (requestGuard && estimatedPolicy)
      throw new Error(
        "Strict and estimated request policies cannot be combined.",
      );
  }
  private async post(
    path: string,
    body: FormData | object,
    cost: () => RequestCostBound,
    estimatedCost?: (
      policy: EstimatedRequestPolicy,
      policyHash: string,
    ) => EstimatedRequestReservation,
  ) {
    if (!availability(this.config).ready)
      throw new Error("Provider is disabled");
    this.receipt = null;
    const multipart = body instanceof FormData;
    // Serialize before reserving funds. A local encoding failure is not a paid
    // provider attempt. Guard failures stay outside the ambiguous network catch.
    const payload = multipart ? body : JSON.stringify(body);
    const bound = this.requestGuard ? cost() : undefined;
    if (bound) this.requestGuard!(bound);
    let estimate: EstimatedRequestReservation | undefined;
    if (this.estimatedPolicy) {
      if (!estimatedCost)
        throw new Error("This request has no pilot cost policy.");
      estimate = estimatedCost(
        this.estimatedPolicy.policy,
        this.estimatedPolicy.policyHash,
      );
      this.estimatedPolicy.guard(estimate);
    }
    const costMetadata = {
      ...(bound ? { requestCostBound: bound } : {}),
      ...(estimate ? { estimatedRequestReservation: estimate } : {}),
      meteredCost: null,
    };
    this.receipt = {
      requestId: null,
      usage: null,
      ...costMetadata,
    };
    let response: Response;
    try {
      response = await this.request(`https://api.openai.com/v1/${path}`, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          ...(!multipart ? { "Content-Type": "application/json" } : {}),
        },
        body: payload,
        signal: AbortSignal.timeout(180000),
      });
    } catch {
      throw new ProviderRequestError({
        kind: "connection",
        httpStatus: null,
        retrySafe: false,
      });
    }
    this.receipt = {
      requestId: /^[a-zA-Z0-9_-]{1,128}$/.test(
        response.headers.get("x-request-id") ?? "",
      )
        ? response.headers.get("x-request-id")
        : null,
      usage: null,
      ...costMetadata,
    };
    // Never include provider response bodies, source text or credentials in errors.
    if (!response.ok) throw await rejectedResponse(response);
    const result = (await response.json()) as Record<string, unknown>;
    if (result.usage && typeof result.usage === "object") {
      this.receipt.usage = sanitizedProviderUsage(result.usage);
      const kind = path.startsWith("images/")
        ? "image"
        : path.startsWith("audio/")
          ? "audio"
          : "text";
      const model =
        kind === "image"
          ? this.config.imageModel
          : kind === "audio"
            ? this.config.audioModel
            : this.config.textModel;
      this.receipt.meteredCost = meteredCostEstimate(
        bound ??
          estimate ?? {
            model,
            kind,
            rateCardVersion: REQUEST_RATE_CARD.version,
          },
        this.receipt.usage,
      );
    }
    return result;
  }
  async transcribe(bytes: Buffer, mime: string) {
    const extension = mime.includes("wav")
      ? "wav"
      : mime.includes("webm")
        ? "webm"
        : mime.includes("ogg")
          ? "ogg"
          : mime.includes("mpeg")
            ? "mp3"
            : "m4a";
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(bytes)], { type: mime }),
      `memory.${extension}`,
    );
    form.append("model", this.config.audioModel);
    form.append("response_format", "json");
    const result = await this.post(
      "audio/transcriptions",
      form,
      () => audioRequestCost(this.config.audioModel, bytes.length),
      (policy, policyHash) =>
        estimatedAudioRequestCost(
          this.config.audioModel,
          bytes.length,
          policy,
          policyHash,
        ),
    );
    // A short clarification ("My dad.") is a valid interview answer.
    // Narrative sufficiency belongs to the story workflow, not transcription.
    return z.string().trim().min(1).max(50000).parse(result.text);
  }
  async structured<T>(
    name: string,
    schema: z.ZodType<T>,
    instructions: string,
    data: unknown,
    images: Buffer[] = [],
  ): Promise<T> {
    const content: object[] = [
      { type: "input_text", text: JSON.stringify(data) },
    ];
    for (const [index, bytes] of images.entries()) {
      content.push({
        type: "input_text",
        text: `IMAGE ${index + 1} of ${images.length}`,
      });
      content.push({
        type: "input_image",
        image_url: `data:image/png;base64,${bytes.toString("base64")}`,
        detail: "high",
      });
    }
    const body = {
      model: this.config.textModel,
      store: false,
      service_tier: "default",
      max_output_tokens: 12000,
      instructions,
      input: [{ role: "user", content }],
      text: {
        format: {
          type: "json_schema",
          name,
          strict: true,
          schema: z.toJSONSchema(schema),
        },
      },
    };
    const costInput = {
      model: body.model,
      serviceTier: body.service_tier,
      maxOutputTokens: body.max_output_tokens,
      serializedText: JSON.stringify(body, (key, value) =>
        key === "image_url" ? "" : value,
      ),
      highDetailImageCount: images.length,
    };
    const result = await this.post(
      "responses",
      body,
      () => structuredRequestCost(costInput),
      (policy, policyHash) =>
        estimatedStructuredRequestCost(costInput, policy, policyHash),
    );
    if (result.status !== "completed")
      throw new Error("Incomplete editorial response");
    const envelope = z
      .object({
        output: z.array(
          z.object({
            type: z.string(),
            content: z
              .array(
                z.object({ type: z.string(), text: z.string().optional() }),
              )
              .optional(),
          }),
        ),
      })
      .parse(result);
    const blocks = envelope.output.flatMap((item) => item.content ?? []);
    if (blocks.some((b) => b.type === "refusal"))
      throw new Error("Editorial response declined");
    const text = blocks
      .filter((b) => b.type === "output_text")
      .map((b) => b.text ?? "")
      .join("");
    return schema.parse(JSON.parse(text));
  }
  async image(prompt: string, reference?: Buffer | Buffer[]) {
    let result: Record<string, unknown>;
    const specification = ImageRenderSpec.parse(
      this.config.imageRender ?? legacyImageRender(this.config.imageModel),
    );
    if (specification.model !== this.config.imageModel)
      throw new Error(
        "The render specification must match the pinned image model.",
      );
    const references = reference
      ? Array.isArray(reference)
        ? reference
        : [reference]
      : [];
    const params = {
      model: this.config.imageModel,
      prompt,
      size: `${specification.width}x${specification.height}`,
      quality: specification.quality,
      output_format: "png",
      n: 1,
    };
    if (reference) {
      const form = new FormData();
      for (const [key, value] of Object.entries(params))
        form.append(key, String(value));
      for (const [index, bytes] of (Array.isArray(reference)
        ? reference
        : [reference]
      ).entries())
        form.append(
          "image[]",
          new Blob([new Uint8Array(bytes)], { type: "image/png" }),
          `reference-${index + 1}.png`,
        );
      result = await this.post(
        "images/edits",
        form,
        () => imageRequestCost(specification, prompt, references.length),
        (policy, policyHash) =>
          estimatedImageRequestCost(
            specification,
            prompt,
            references.length,
            policy,
            policyHash,
          ),
      );
    } else
      result = await this.post(
        "images/generations",
        params,
        () => imageRequestCost(specification, prompt, 0),
        (policy, policyHash) =>
          estimatedImageRequestCost(
            specification,
            prompt,
            0,
            policy,
            policyHash,
          ),
      );
    const output = z
      .object({
        data: z.array(z.object({ b64_json: z.string().min(1) })).length(1),
      })
      .parse(result);
    const bytes = Buffer.from(output.data[0].b64_json, "base64");
    const metadata = await sharp(bytes, {
      limitInputPixels: 16777216,
    }).metadata();
    const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    const dimensionsMatch =
      metadata.width === specification.width &&
      metadata.height === specification.height;
    if (this.receipt)
      this.receipt.imageRender = {
        version: 1,
        specification,
        actual: {
          width: metadata.width ?? 0,
          height: metadata.height ?? 0,
          format: metadata.format ?? "unknown",
        },
        referenceHashes: references.map(digest),
        outputHash: digest(bytes),
        transformation: "provider_original",
        dimensionsMatch,
      };
    if (metadata.format !== "png" || !dimensionsMatch)
      throw new Error("Unexpected illustration format");
    return bytes;
  }
}
