import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { z } from "zod";
import {
  estimatedImageRequestCost,
  estimatedStructuredRequestCost,
  estimatedAudioRequestCost,
  parseEstimatedRequestPolicy,
  REQUEST_RATE_CARD,
  meteredCostEstimate,
  imageRequestCost,
  structuredRequestCost,
  type EstimatedRequestPolicy,
  type EstimatedRequestReservation,
} from "../src/server/engine/request-cost.js";
import {
  OpenAIProvider,
  ProviderRequestError,
  sanitizedProviderUsage,
  engineConfig,
} from "../src/server/engine/provider.js";
import { legacyImageRender } from "../src/shared/imageRender.js";
import { testConfig } from "./support/studio-fixtures.js";

const policy: EstimatedRequestPolicy = {
  version: 1,
  mode: "estimated_pilot",
  textInputTokensPerByte: 1,
  imagePromptTokensPerByte: 1,
  imageInputTokensPerReference: 4096,
  imageInputOverheadTokens: 1024,
  safetyMultiplier: 1.25,
};
const policyHash = "a".repeat(64);
const spec = legacyImageRender("gpt-image-2");
const models = {
  text: "gpt-5.4",
  image: "gpt-image-2",
  audio: "gpt-4o-transcribe",
};
const config = {
  ...testConfig,
  textModel: models.text,
  imageModel: models.image,
  audioModel: models.audio,
};
const textInput = {
  model: models.text,
  serviceTier: "default",
  maxOutputTokens: 12000,
  serializedText: '{"test":"synthetic"}',
  highDetailImageCount: 0,
};

test("pilot estimates require explicit assumptions, record those assumptions, and do not alter strict bounds", () => {
  assert.deepEqual(parseEstimatedRequestPolicy(policy), policy);
  for (const invalid of [
    undefined,
    {},
    { ...policy, safetyMultiplier: 0 },
    { ...policy, textInputTokensPerByte: 0.25 },
    { ...policy, imageInputTokensPerReference: NaN },
    { ...policy, imageInputOverheadTokens: -1 },
    { ...policy, unknown: true },
  ])
    assert.throws(() => parseEstimatedRequestPolicy(invalid));
  const plain = estimatedImageRequestCost(
    spec,
    "An original synthetic fox.",
    0,
    policy,
    policyHash,
  );
  const references = estimatedImageRequestCost(
    spec,
    "An original synthetic fox.",
    3,
    policy,
    policyHash,
  );
  assert.equal(references.costConfidence, "estimate");
  assert.equal(references.policyHash, policyHash);
  assert.equal(references.evidence.estimatedImageInputTokens, 12288);
  assert(references.reservationCents > plain.reservationCents);
  assert.equal("maxCostCents" in references, false);
  assert.equal(REQUEST_RATE_CARD.imageInputUsdPerMillion, 8);
  assert.equal(REQUEST_RATE_CARD.imageTextInputUsdPerMillion, 5);
  assert.equal(REQUEST_RATE_CARD.imageOutputUsdPerMillion, 30);
  const text = estimatedStructuredRequestCost(
    { ...textInput, highDetailImageCount: 2 },
    policy,
    policyHash,
  );
  assert.equal(text.evidence.visionTokens, 6002);
  assert.equal(text.evidence.maxOutputTokens, 12000);
  assert(text.reservationCents < structuredRequestCost(textInput).maxCostCents);
  assert.equal(
    estimatedAudioRequestCost(models.audio, 32, policy, policyHash)
      .reservationCents,
    24,
  );
  assert.throws(() =>
    estimatedImageRequestCost(spec, "Synthetic", 1, policy, "bad-hash"),
  );
  assert.throws(
    () => imageRequestCost(spec, "Synthetic", 1),
    /reference-image charges/,
  );
  assert.equal(structuredRequestCost(textInput).evidence.fullContextCeiling, 1);
  assert.equal(
    engineConfig({ EVERLORE_PILOT_CAMPAIGN_ID: "not-runtime-scoped" })
      .pilotCampaignId,
    undefined,
  );
});

test("numeric image usage preserves text/image input detail, rejects unknown content, and produces an estimate not billing", () => {
  const usage = sanitizedProviderUsage({
    input_tokens: 500,
    output_tokens: 1000,
    total_tokens: 1500,
    source_text: "private source must not be retained",
    secret: "private-secret",
    input_tokens_details: {
      text_tokens: 100,
      image_tokens: 400,
      secret: "private-secret",
    },
    output_tokens_details: { text: "private source" },
  });
  assert.deepEqual(usage, {
    input_tokens: 500,
    output_tokens: 1000,
    total_tokens: 1500,
    input_text_tokens: 100,
    input_image_tokens: 400,
  });
  const reservation = estimatedImageRequestCost(
    spec,
    "Synthetic",
    1,
    policy,
    policyHash,
  );
  const cost = meteredCostEstimate(reservation, usage)!;
  assert(Math.abs(cost.estimatedCostCents - 3.37) < 1e-10);
  assert.equal(cost.billedCostCents, null);
  assert.equal(cost.source, "provider_usage");
  const incompleteUsage: Record<string, number>[] = [
    { input_tokens: 500, output_tokens: 1000 },
    {
      input_tokens: 500,
      output_tokens: 1000,
      input_text_tokens: 100,
      input_image_tokens: 399,
    },
  ];
  for (const incomplete of incompleteUsage)
    assert.equal(meteredCostEstimate(reservation, incomplete), null);
  assert.equal(
    sanitizedProviderUsage({
      input_tokens: Infinity,
      output_tokens: -1,
      input_tokens_details: { text_tokens: "100" },
    }),
    null,
  );
  assert.equal(sanitizedProviderUsage([]), null);
});

test("estimated guards survive clones and run before every image, critic and transcription dispatch", async () => {
  const png = await sharp({
    create: { width: 1024, height: 1024, channels: 3, background: "#ffffff" },
  })
    .png()
    .toBuffer();
  const reservations: EstimatedRequestReservation[] = [];
  let calls = 0;
  const provider = new OpenAIProvider(config, async (url, init) => {
    calls++;
    assert.equal(reservations.length, calls);
    assert.equal(reservations.at(-1)?.policyHash, policyHash);
    if (String(url).includes("images/")) {
      assert(init?.body instanceof FormData);
      assert.equal(init.body.get("model"), models.image);
      return new Response(
        JSON.stringify({
          data: [{ b64_json: png.toString("base64") }],
          usage: {
            input_tokens: 500,
            output_tokens: 1000,
            input_tokens_details: { text_tokens: 100, image_tokens: 400 },
          },
        }),
      );
    }
    if (String(url).includes("audio/"))
      return new Response(JSON.stringify({ text: "My dad." }));
    const body = JSON.parse(String(init?.body));
    assert.equal(body.max_output_tokens, 12000);
    assert.equal(reservations.at(-1)?.evidence.highDetailImageCount, 1);
    return new Response(
      JSON.stringify({
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: '{"ok":true}' }],
          },
        ],
        usage: { input_tokens: 1000, output_tokens: 200 },
      }),
    );
  })
    .withEstimatedPolicy(policy, policyHash, (reservation) =>
      reservations.push(reservation),
    )
    .withModels(models)
    .withImageRender(spec);
  assert.doesNotThrow(() => provider.validateRequestCosts());
  assert.deepEqual(await provider.image("Synthetic fox", png), png);
  const imageReceipt = provider.takeReceipt()!;
  assert.equal(imageReceipt.requestCostBound, undefined);
  assert.equal(
    imageReceipt.estimatedRequestReservation?.costConfidence,
    "estimate",
  );
  assert.equal(imageReceipt.usage?.input_image_tokens, 400);
  assert(imageReceipt.meteredCost);
  await provider.structured(
    "critic",
    z.object({ ok: z.boolean() }),
    "Inspect this synthetic image",
    {},
    [png],
  );
  assert.equal(provider.takeReceipt()?.meteredCost?.billedCostCents, null);
  assert.equal(
    await provider.transcribe(Buffer.from("synthetic"), "audio/wav"),
    "My dad.",
  );
  assert.equal(
    provider.takeReceipt()?.estimatedRequestReservation?.kind,
    "audio",
  );
  assert.deepEqual(
    reservations.map((value) => value.kind),
    ["image", "text", "audio"],
  );
  assert.throws(
    () => provider.withRequestGuard(() => undefined),
    /cannot be combined/,
  );
  assert.throws(
    () =>
      new OpenAIProvider(config)
        .withRequestGuard(() => undefined)
        .withEstimatedPolicy(policy, policyHash, () => undefined),
    /cannot be combined/,
  );
});

test("pilot refusal happens before dispatch and ambiguous transport retains its reservation", async () => {
  let calls = 0;
  const refusal = Object.assign(new Error("Pilot limit reached"), {
    preDispatch: true,
  });
  const stopped = new OpenAIProvider(config, async () => {
    calls++;
    throw Error("must not be called");
  }).withEstimatedPolicy(policy, policyHash, () => {
    throw refusal;
  });
  await assert.rejects(
    stopped.structured("test", z.object({ ok: z.boolean() }), "Synthetic", {}),
    (error) => error === refusal,
  );
  assert.equal(calls, 0);
  assert.equal(stopped.takeReceipt(), null);
  const ambiguous = new OpenAIProvider(config, async () => {
    calls++;
    throw Error("network interrupted");
  }).withEstimatedPolicy(policy, policyHash, () => undefined);
  await assert.rejects(
    ambiguous.structured(
      "test",
      z.object({ ok: z.boolean() }),
      "Synthetic",
      {},
    ),
    (error) =>
      error instanceof ProviderRequestError && !error.failure.retrySafe,
  );
  const receipt = ambiguous.takeReceipt()!;
  assert(receipt.estimatedRequestReservation);
  assert.equal(receipt.usage, null);
  assert.equal(receipt.meteredCost, null);
  assert.equal(calls, 1);
});

test("unguarded historical providers also retain usage-derived estimates without inventing a reservation", async () => {
  const provider = new OpenAIProvider(
    config,
    async () =>
      new Response(
        JSON.stringify({
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: '{"ok":true}' }],
            },
          ],
          usage: { input_tokens: 1000, output_tokens: 200 },
        }),
      ),
  );
  await provider.structured(
    "test",
    z.object({ ok: z.boolean() }),
    "Synthetic",
    {},
  );
  const receipt = provider.takeReceipt()!;
  assert(receipt.meteredCost);
  assert.equal(receipt.requestCostBound, undefined);
  assert.equal(receipt.estimatedRequestReservation, undefined);
});
