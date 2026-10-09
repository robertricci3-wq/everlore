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

export interface ProviderReceipt {
  requestId: string | null;
  usage: Record<string, number> | null;
  imageRender?: ImageRenderReceipt;
}
export interface Provider {
  withModels?(models: { text: string; image: string; audio: string }): Provider;
  withImageRender?(specification: ImageRenderSpecification): Provider;
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
  withImageRender(specification: ImageRenderSpecification) {
    const imageRender = ImageRenderSpec.parse(specification);
    if (imageRender.model !== this.config.imageModel)
      throw new Error(
        "The render specification must match the pinned image model.",
      );
    return new OpenAIProvider({ ...this.config, imageRender }, this.request);
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
  ) {}
  private async post(path: string, body: FormData | object) {
    if (!availability(this.config).ready)
      throw new Error("Provider is disabled");
    this.receipt = null;
    const multipart = body instanceof FormData;
    let response: Response;
    try {
      response = await this.request(`https://api.openai.com/v1/${path}`, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          ...(!multipart ? { "Content-Type": "application/json" } : {}),
        },
        body: multipart ? body : JSON.stringify(body),
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
    };
    // Never include provider response bodies, source text or credentials in errors.
    if (!response.ok) throw await rejectedResponse(response);
    const result = (await response.json()) as Record<string, unknown>;
    if (result.usage && typeof result.usage === "object") {
      this.receipt.usage = Object.fromEntries(
        Object.entries(result.usage).filter(
          ([key, value]) =>
            [
              "input_tokens",
              "output_tokens",
              "total_tokens",
              "seconds",
            ].includes(key) && typeof value === "number",
        ),
      ) as Record<string, number>;
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
    const result = await this.post("audio/transcriptions", form);
    return z.string().trim().min(10).max(50000).parse(result.text);
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
    const result = await this.post("responses", {
      model: this.config.textModel,
      store: false,
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
    });
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
      result = await this.post("images/edits", form);
    } else result = await this.post("images/generations", params);
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
