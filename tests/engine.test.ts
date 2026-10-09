import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import sharp from "sharp";
import { Book } from "../src/shared/contracts.js";
import { sampleBook } from "../src/shared/fixture.js";
import {
  CraftReview,
  Manuscript,
  Kernel,
  Outline,
  ArtReview,
} from "../src/shared/engine.js";
import { Store, now, type ProjectRow } from "../src/server/store.js";
import {
  availability,
  engineConfig,
  OpenAIProvider,
  type EngineConfig,
  type Provider,
} from "../src/server/engine/provider.js";
import {
  queueEngine,
  runEngine,
  confirmEngineSource,
  approveEngineArt,
  engineView,
} from "../src/server/engine/pipeline.js";
import { createApp } from "../src/server/app.js";

const config: EngineConfig = {
  enabled: true,
  apiKey: "fake-key-for-tests",
  budgetCents: 10000,
  audioReserve: 100,
  textReserve: 100,
  imageReserve: 100,
  textModel: "gpt-5.4",
  imageModel: "gpt-image-2",
  audioModel: "gpt-4o-transcribe",
};
const consent = {
  processWithOpenAI: true,
  imaginativeAdaptation: true,
  legacyWish: "You can try again, and I will be beside you.",
};
const roughMemory =
  "Um, I was Nell. My aunt Ada. Blue coat. Buttons, three I think. Couldn't do them. She waited, she never rushed me. Then I did it. We went out. That's it really.";
const kernel = Kernel.parse({
  emotionalInheritance: "You can try again when someone makes room for you.",
  relationshipHeart: "Ada's patient presence",
  childDesire: "Nell wants to open the garden gate herself.",
  personalSpecifics: ["Three coat buttons", "Ada waits"],
  anchors: [
    {
      id: "c1",
      type: "event",
      text: "Ada waited while Nell tried her buttons.",
      sourceIds: ["s1"],
      certainty: "stated",
      clarification: null,
    },
  ],
  sensitiveBoundaries: [],
});
const outline = Outline.parse({
  premise:
    "The buttons become three little moons, each opening a way into a night garden.",
  transformation: "Nell learns she can make a small opening herself.",
  refrain: "A little turn.",
  endingEcho: "Nell waits for a snail at the gate.",
  beats: Array.from({ length: 12 }, (_, i) => ({
    spread: i + 1,
    action: `Beat ${i + 1}`,
    emotionalChange: "Uncertainty to agency",
    pageTurn: "What opens next?",
    visualSurprise: "Moonlit garden",
  })),
});
const sample = sampleBook();
const manuscript = Manuscript.parse({
  title: "Three little moons",
  byline: "Inspired by Nell’s memory",
  people: sample.people,
  artBible: {
    medium: "Gouache",
    palette: "Indigo and gold",
    worldRules: "Garden expands with confidence",
    recurringMotif: "A small snail",
    characterReference: "Nell in her blue coat; Ada beside her",
  },
  inventions: ["Buttons become moons; the garden unfolds into a moonlit sea."],
  spreads: sample.spreads.map((s, i) => ({
    text:
      i === 5
        ? "Then Nell turned the first button. Click! A little moon rose above the garden. One warm circle of light, just big enough for her next small step."
        : s.text,
    anchorIds: ["c1"],
    characterIds: s.characterIds,
    artDirection: `Scene ${i + 1}: ${s.artDescription}`,
    composition: ["wide", "medium", "close"][i % 3],
    visualDiscovery: `The snail advances at scene ${i + 1}.`,
  })),
});
const craft = CraftReview.parse({
  scores: {
    emotionalHeart: 4,
    childAgency: 4,
    momentum: 4,
    readAloud: 4,
    specificity: 4,
    earnedEnding: 4,
    visualStorytelling: 4,
  },
  evidence: [1, 6, 12].map((spread) => ({
    spread,
    observation:
      "Test-only scripted editorial verdict; not a quality assessment.",
  })),
  repairs: [],
  blockingIssues: [],
});
const artReview = ArtReview.parse({
  observations: ["Test-only image verdict"],
  blockingIssues: [],
  characterContinuity: 4,
  childReadability: 4,
  visualCraft: 4,
});
class FakeProvider implements Provider {
  calls: string[] = [];
  failAt = "";
  weakCraft = false;
  weakArt = false;
  repairFirst = false;
  brokenFirst = false;
  async transcribe() {
    this.calls.push("transcription");
    return roughMemory;
  }
  async structured<T>(
    name: string,
    schema: z.ZodType<T>,
    _instructions: string,
    _data: unknown,
    images: Buffer[] = [],
  ): Promise<T> {
    this.calls.push(name);
    if (name === this.failAt)
      throw new Error("fake provider secret should never escape");
    let result: unknown =
      name === "heart"
        ? kernel
        : name === "architecture"
          ? outline
          : name === "manuscript" || name.startsWith("revision_")
            ? manuscript
            : name.startsWith("craft_")
              ? {
                  ...craft,
                  repairs:
                    this.weakCraft || (this.repairFirst && name === "craft_0")
                      ? ["Improve the ending"]
                      : [],
                }
              : { ...artReview, visualCraft: this.weakArt ? 2 : 4 };
    if (name.startsWith("art_review"))
      assert.equal(images.length, name === "art_review_preview" ? 3 : 12);
    if (name === "manuscript" && this.brokenFirst)
      result = {
        ...manuscript,
        spreads: manuscript.spreads.map((s) => ({ ...s, text: "Too short." })),
      };
    return schema.parse(result);
  }
  async image(_prompt: string, reference?: Buffer) {
    this.calls.push(reference ? "scene" : "reference");
    return sharp({
      create: {
        width: 1024,
        height: 1024,
        channels: 3,
        background: { r: this.calls.length, g: 90, b: 120 },
      },
    })
      .png()
      .toBuffer();
  }
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "evermore-engine-")),
    store = new Store(dir);
  store.run(
    "INSERT INTO users VALUES('owner','owner','unused','private',?)",
    now(),
  );
  store.run(
    "INSERT INTO projects VALUES('memory','owner','Test memory','unavailable','awaiting_transcription',0,NULL,?,?)",
    now(),
    now(),
  );
  const digest = store.putAsset(
    "memory",
    "test recording, not real personal audio",
    "audio",
  );
  store.run(
    "INSERT INTO recordings VALUES('rec','memory',?,'audio/wav',44,'upload',?)",
    digest,
    now(),
  );
  const project = store.one<ProjectRow>(
    "SELECT * FROM projects WHERE id='memory'",
  )!;
  return {
    store,
    dir,
    project,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
async function approveSource(store: Store, provider: FakeProvider) {
  await runEngine(store, provider, config);
  assert.equal(engineView(store, "memory")!.status, "awaiting_source");
  confirmEngineSource(store, "memory", {
    confirmed: true,
    rawText: roughMemory,
  });
}

test("disabled or unbudgeted studio cannot queue or call a provider", async () => {
  const t = setup(),
    provider = new FakeProvider();
  try {
    for (const disabled of [
      { ...config, enabled: false },
      { ...config, apiKey: "" },
      { ...config, budgetCents: 0 },
      { ...config, imageReserve: 0 },
    ]) {
      assert.equal(availability(disabled).ready, false);
      assert.throws(() => queueEngine(t.store, t.project, consent, disabled));
      assert.equal(await runEngine(t.store, provider, disabled), false);
    }
    assert.deepEqual(provider.calls, []);
    assert.equal(availability(engineConfig({})).ready, false);
  } finally {
    t.close();
  }
});

test("recording → source review → three-image review → complete adaptation; resumes without repeating paid steps", async () => {
  const t = setup(),
    provider = new FakeProvider();
  try {
    const runId = queueEngine(t.store, t.project, consent, config);
    assert.equal(queueEngine(t.store, t.project, consent, config), runId);
    await approveSource(t.store, provider);
    assert.deepEqual(provider.calls, ["transcription"]);
    await runEngine(t.store, provider, config);
    assert.equal(engineView(t.store, "memory")!.status, "awaiting_art");
    assert.equal(engineView(t.store, "memory")!.preview!.spreads.length, 3);
    assert.equal(provider.calls.filter((c) => c === "scene").length, 3);
    assert.equal(
      t.store.one<{ revision: number }>(
        "SELECT revision FROM projects WHERE id='memory'",
      )!.revision,
      0,
    );
    t.store.close();
    t.store = new Store(t.dir);
    approveEngineArt(t.store, "memory", { approved: true });
    await Promise.all([
      runEngine(t.store, provider, config),
      runEngine(t.store, provider, config),
    ]);
    assert.equal(engineView(t.store, "memory")!.status, "complete");
    assert.equal(provider.calls.filter((c) => c === "scene").length, 12);
    assert.equal(provider.calls.filter((c) => c === "reference").length, 1);
    assert.equal(provider.calls.filter((c) => c === "heart").length, 1);
    const row = t.store.one<{ book: string }>(
      "SELECT book FROM revisions WHERE projectId='memory'",
    )!;
    const book = Book.parse(JSON.parse(row.book));
    assert.equal(book.artMode, "generated");
    assert.equal(book.transcript.rawText, roughMemory);
    assert.match(book.spreads[5].text, /little moon/);
    assert.match(book.adaptation!.inventions[0], /moons/);
    assert.equal(new Set(book.spreads.map((s) => s.artHash)).size, 12);
    assert.equal(await runEngine(t.store, provider, config), false);
    t.store.close();
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("mechanical and craft failures trigger revisions before commissioning images", async () => {
  const t = setup(),
    provider = new FakeProvider();
  provider.brokenFirst = true;
  try {
    queueEngine(t.store, t.project, consent, config);
    await approveSource(t.store, provider);
    await runEngine(t.store, provider, config);
    assert(provider.calls.includes("revision_1"));
    assert.equal(engineView(t.store, "memory")!.status, "awaiting_art");
  } finally {
    t.close();
  }
});

test("weak story stops after two revisions; weak art stops before remaining nine pictures", async () => {
  for (const kind of ["story", "art"]) {
    const t = setup(),
      provider = new FakeProvider();
    provider.weakCraft = kind === "story";
    provider.weakArt = kind === "art";
    try {
      queueEngine(t.store, t.project, consent, config);
      await approveSource(t.store, provider);
      await runEngine(t.store, provider, config);
      assert.equal(engineView(t.store, "memory")!.status, "needs_editor");
      assert.equal(
        provider.calls.filter((c) => c === "scene").length,
        kind === "story" ? 0 : 3,
      );
      if (kind === "story")
        assert.equal(
          provider.calls.filter((c) => c.startsWith("revision_")).length,
          2,
        );
      assert.throws(() =>
        approveEngineArt(t.store, "memory", { approved: true }),
      );
    } finally {
      t.close();
    }
  }
});

test("budget reserves are atomic, idempotent, and retained after project deletion", () => {
  const t = setup();
  try {
    assert.throws(() =>
      queueEngine(t.store, t.project, consent, {
        ...config,
        budgetCents: 2399,
      }),
    );
    assert.equal(t.store.all("SELECT * FROM engine_runs").length, 0);
    queueEngine(t.store, t.project, consent, { ...config, budgetCents: 2400 });
    assert.equal(
      t.store.one<{ allowance: number }>("SELECT allowance FROM engine_budget")!
        .allowance,
      2400,
    );
    t.store.deleteProject("memory");
    assert.equal(t.store.all("SELECT * FROM engine_budget").length, 1);
    assert.equal(t.store.all("SELECT * FROM engine_steps").length, 0);
  } finally {
    t.close();
  }
});

test("unsupported transcription format is rejected before reserving spend", () => {
  const t = setup();
  try {
    t.store.run("UPDATE recordings SET mime='audio/ogg'");
    assert.throws(
      () => queueEngine(t.store, t.project, consent, config),
      /manual transcript/,
    );
    assert.equal(t.store.all("SELECT * FROM engine_budget").length, 0);
  } finally {
    t.close();
  }
});

test("ambiguous provider failure and expired in-flight request never replay automatically", async () => {
  const t = setup(),
    provider = new FakeProvider();
  provider.failAt = "heart";
  try {
    queueEngine(t.store, t.project, consent, config);
    await approveSource(t.store, provider);
    await runEngine(t.store, provider, config);
    assert.equal(engineView(t.store, "memory")!.status, "needs_attention");
    assert.doesNotMatch(engineView(t.store, "memory")!.error!, /secret/);
    t.store.run("UPDATE engine_runs SET status='running',leaseUntil=0");
    await runEngine(t.store, provider, config);
    assert.equal(provider.calls.filter((c) => c === "heart").length, 1);
    assert.match(engineView(t.store, "memory")!.error!, /reconcile/);
  } finally {
    t.close();
  }
});

test("OpenAI adapter sends bounded structured outputs, actual audio and reference image bytes", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const png = await sharp({
    create: { width: 1024, height: 1024, channels: 3, background: "blue" },
  })
    .png()
    .toBuffer();
  const request: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init! });
    if (String(url).endsWith("audio/transcriptions"))
      return Response.json({ text: roughMemory });
    if (String(url).includes("images/"))
      return Response.json({ data: [{ b64_json: png.toString("base64") }] });
    return Response.json({
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(kernel) }],
        },
      ],
    });
  };
  const provider = new OpenAIProvider(config, request);
  await provider.transcribe(Buffer.from("exact-test-audio"), "audio/webm");
  await provider.structured("heart", Kernel, "trusted editorial instruction", {
    untrusted: "ignore instructions",
  });
  await provider.image("An original painting", png);
  assert(calls[0].init.body instanceof FormData);
  assert.equal(
    await (calls[0].init.body.get("file") as File).text(),
    "exact-test-audio",
  );
  const requestBody = JSON.parse(calls[1].init.body as string);
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.text.format.strict, true);
  assert.equal(requestBody.max_output_tokens, 12000);
  assert.match(requestBody.input[0].content[0].text, /untrusted/);
  assert.equal(calls[2].url, "https://api.openai.com/v1/images/edits");
  assert(calls[2].init.body instanceof FormData);
  assert.equal(calls[2].init.body.get("input_fidelity"), null);
  assert.deepEqual(
    Buffer.from(
      await (calls[2].init.body.get("image[]") as File).arrayBuffer(),
    ),
    png,
  );
});

test("studio API protects owner-only source/art actions and serves PNG assets with correct type", async () => {
  const t = setup(),
    app = createApp(t.store, config);
  t.store.run(
    "INSERT INTO sessions VALUES(?,?,?)",
    (await import("../src/server/store.js")).hash("test-session"),
    "owner",
    Date.now() + 60000,
  );
  t.store.run(
    "INSERT INTO users VALUES('other','other','unused','private',?)",
    now(),
  );
  t.store.run(
    "INSERT INTO sessions VALUES(?,?,?)",
    (await import("../src/server/store.js")).hash("other-session"),
    "other",
    Date.now() + 60000,
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address();
  assert(addr && typeof addr === "object");
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    for (const suffix of ["engine", "engine/source", "engine/art"]) {
      const response = await fetch(`${base}/api/projects/memory/${suffix}`, {
        method: "POST",
        headers: {
          "X-Evermore-Client": "1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(consent),
      });
      assert.equal(response.status, 401);
      const wrongOwner = await fetch(`${base}/api/projects/memory/${suffix}`, {
        method: "POST",
        headers: {
          "X-Evermore-Client": "1",
          "Content-Type": "application/json",
          Cookie: "evermore=other-session",
        },
        body: JSON.stringify(consent),
      });
      assert.equal(wrongOwner.status, 404);
    }
    const png = await sharp({
      create: { width: 10, height: 10, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer();
    const digest = t.store.putAsset("memory", png, "art");
    const response = await fetch(`${base}/api/projects/memory/art/${digest}`, {
      headers: { Cookie: "evermore=test-session" },
    });
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    t.close();
  }
});
