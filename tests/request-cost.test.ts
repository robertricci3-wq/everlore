import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  RequestCostBoundError,
  structuredRequestCost,
  imageRequestCost,
  imageOutputTokens,
  audioRequestCost,
  assertSupportedCostPlan,
  meteredCostEstimate,
  type RequestCostBound,
} from "../src/server/engine/request-cost.js";
import {
  OpenAIProvider,
  ProviderRequestError,
  engineConfig,
} from "../src/server/engine/provider.js";
import {
  legacyImageRender,
  PRINT_RENDER_CANDIDATE,
} from "../src/shared/imageRender.js";
import { testConfig } from "./support/studio-fixtures.js";

const textInput = {
  model: "gpt-5.4",
  serviceTier: "default",
  maxOutputTokens: 12000,
  serializedText: '{"text":"synthetic"}',
  highDetailImageCount: 0,
};
const models = {
  text: "gpt-5.4",
  image: "gpt-image-2",
  audio: "gpt-4o-transcribe",
};
const pricedConfig = {
  ...testConfig,
  textModel: models.text,
  imageModel: models.image,
  audioModel: models.audio,
};
const success = () =>
  new Response(
    JSON.stringify({
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: '{"ok":true}' }],
        },
      ],
      usage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 },
    }),
    { headers: { "x-request-id": "req_synthetic" } },
  );
const schema = z.object({ ok: z.boolean() });

test("text bound counts complete UTF-8 request, schema envelope, output and vision with premium", () => {
  const one = structuredRequestCost(textInput);
  assert.equal(one.evidence.maxInputTokens, 1050000);
  const unicode = structuredRequestCost({
    ...textInput,
    serializedText: "你好",
  });
  assert.equal(unicode.evidence.textBytes, 6);
  const images = structuredRequestCost({
    ...textInput,
    highDetailImageCount: 12,
  });
  assert.equal(images.evidence.visionTokens, 12 * 3001);
  assert.equal(images.maxCostCents, one.maxCostCents);
  assert.equal(one.evidence.fullContextCeiling, 1);
  const large = structuredRequestCost({
    ...textInput,
    serializedText: "x".repeat(272001),
  });
  assert.equal(large.evidence.inputUsdPerMillion, 5);
  assert.equal(large.evidence.outputUsdPerMillion, 22.5);
  assert.throws(
    () =>
      structuredRequestCost({
        ...textInput,
        serializedText: "x".repeat(1050000),
      }),
    RequestCostBoundError,
  );
  for (const change of [
    { model: "unknown-model" },
    { serviceTier: "priority" },
    { maxOutputTokens: 0 },
    { maxOutputTokens: Infinity },
    { highDetailImageCount: -1 },
  ])
    assert.throws(
      () => structuredRequestCost({ ...textInput, ...change }),
      RequestCostBoundError,
    );
});

test("image output follows published calculator without inventing reference input pricing", () => {
  const spec = legacyImageRender("gpt-image-2");
  assert.equal(imageOutputTokens(spec), 7024);
  assert.equal(imageOutputTokens({ ...spec, quality: "medium" }), 1756);
  assert.equal(imageOutputTokens({ ...spec, quality: "low" }), 196);
  assert.equal(imageOutputTokens(PRINT_RENDER_CANDIDATE), 19708);
  assert.throws(
    () => imageRequestCost(spec, "An original fox family", 0),
    /input-context ceiling/,
  );
  assert.throws(
    () => imageRequestCost(spec, "A fox", 1),
    (e) =>
      e instanceof RequestCostBoundError &&
      e.code === "unbounded_image_input" &&
      e.preDispatch,
  );
  assert.throws(
    () => assertSupportedCostPlan(models, spec),
    /reference-image charges/,
  );
  assert.throws(
    () => assertSupportedCostPlan(models, spec, false),
    /input-context ceiling/,
  );
});

test("transcription reserves whole single-block context and output plus rounding margin", () => {
  const bound = audioRequestCost(models.audio, 12345);
  assert.equal(bound.maxCostCents, 19);
  assert.equal(bound.evidence.singleBlock, 1);
  for (const size of [0, -1, Infinity, 25000001])
    assert.throws(
      () => audioRequestCost(models.audio, size),
      RequestCostBoundError,
    );
});

test("guard sees actual request before fetch, schema bytes and default tier, with separate usage estimate", async () => {
  let calls = 0,
    reserved: RequestCostBound | undefined;
  const provider = new OpenAIProvider(pricedConfig, async (_url, init) => {
    calls++;
    assert(reserved);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.service_tier, "default");
    assert.equal(body.max_output_tokens, 12000);
    assert.equal(
      reserved.evidence.textBytes,
      Buffer.byteLength(JSON.stringify(body)),
    );
    return success();
  }).withRequestGuard((bound) => {
    reserved = bound;
  });
  assert.deepEqual(
    await provider.structured("test", schema, "Instructions", {
      private: "input",
    }),
    { ok: true },
  );
  assert.equal(calls, 1);
  const receipt = provider.takeReceipt()!;
  assert.deepEqual(receipt.requestCostBound, reserved);
  assert.equal(receipt.meteredCost?.billedCostCents, null);
  assert(Math.abs(receipt.meteredCost!.estimatedCostCents - 0.55) < 1e-10);
  assert.equal(provider.takeReceipt(), null);
});

test("guard failure is pre-dispatch, leaves no receipt and cannot become an ambiguous provider failure", async () => {
  let calls = 0;
  const error = Object.assign(new Error("Allowance exhausted"), {
    preDispatch: true,
  });
  const provider = new OpenAIProvider(pricedConfig, async () => {
    calls++;
    return success();
  }).withRequestGuard(() => {
    throw error;
  });
  await assert.rejects(
    provider.structured("test", schema, "Instructions", {}),
    (e) => e === error,
  );
  assert.equal(calls, 0);
  assert.equal(provider.takeReceipt(), null);
});

test("unsupported image preflight prevents paid work and clones retain guard", async () => {
  let calls = 0,
    reservations = 0;
  const provider = new OpenAIProvider(pricedConfig, async () => {
    calls++;
    return success();
  })
    .withRequestGuard(() => {
      reservations++;
    })
    .withModels(models)
    .withImageRender(legacyImageRender(models.image));
  assert.throws(
    () => provider.validateRequestCosts(),
    /reference-image charges/,
  );
  await assert.rejects(
    provider.image("A scene", Buffer.from("reference")),
    RequestCostBoundError,
  );
  assert.equal(calls, 0);
  assert.equal(reservations, 0);
  await provider.structured("test", schema, "Instructions", {});
  assert.equal(reservations, 1);
  assert.equal(calls, 1);
  const unsupported = provider.withModels({ ...models, text: "unpriced" });
  await assert.rejects(
    unsupported.structured("test", schema, "Instructions", {}),
    RequestCostBoundError,
  );
  assert.equal(calls, 1);
});

test("network uncertainty retains reserved bound without pretending usage or billing is known", async () => {
  const provider = new OpenAIProvider(pricedConfig, async () => {
    throw Error("transport details");
  }).withRequestGuard(() => {});
  await assert.rejects(
    provider.structured("test", schema, "Instructions", {}),
    (e) => e instanceof ProviderRequestError && !e.failure.retrySafe,
  );
  const receipt = provider.takeReceipt()!;
  assert(receipt.requestCostBound);
  assert.equal(receipt.usage, null);
  assert.equal(receipt.meteredCost, null);
  assert.equal(
    meteredCostEstimate(receipt.requestCostBound, {
      input_tokens: NaN,
      output_tokens: 4,
    }),
    null,
  );
});

test("guarded short audio answer uses one block and preserves request bound and receipt", async () => {
  let bound: RequestCostBound | undefined;
  const provider = new OpenAIProvider(pricedConfig, async (_url, init) => {
    assert(bound);
    assert(init?.body instanceof FormData);
    assert.equal(init.body.has("chunking_strategy"), false);
    return new Response(JSON.stringify({ text: "My dad." }), {
      headers: { "x-request-id": "short-answer-fixture" },
    });
  }).withRequestGuard((value) => {
    bound = value;
  });
  assert.equal(
    await provider.transcribe(Buffer.from("synthetic"), "audio/wav"),
    "My dad.",
  );
  assert.equal(bound?.maxCostCents, 19);
  const receipt = provider.takeReceipt()!;
  assert.equal(receipt.requestId, "short-answer-fixture");
  assert.deepEqual(receipt.requestCostBound, bound);
  assert.equal(receipt.meteredCost, null);
  assert.doesNotThrow(() =>
    new OpenAIProvider(pricedConfig).validateRequestCosts(),
  );
  assert.equal(
    engineConfig({ EVERLORE_STRICT_COST_GUARD: "1" }).strictCostGuard,
    true,
  );
  assert.equal(engineConfig({}).strictCostGuard, false);
});
