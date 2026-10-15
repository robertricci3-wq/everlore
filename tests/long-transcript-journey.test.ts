import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Store, canonical, hash, now } from "../src/server/store.js";
import { configureAccess } from "../src/server/access.js";
import { engineConfig } from "../src/server/engine/provider.js";
import { latestStudio, runStudio } from "../src/server/engine/studio.js";
import {
  advanceCreationRequest,
  createJourney,
  journeyView,
  startJourney,
} from "../src/server/almanac/journey.js";
import {
  saveTurnText,
  sessionView,
  setSessionStatus,
} from "../src/server/almanac/service.js";
import { Book, Transcript } from "../src/shared/contracts.js";
import { FAMILY_CONSENT_VERSION } from "../src/shared/journey.js";
import { StudioFake, fixtureHeart } from "./support/studio-fixtures.js";

// Entirely invented transport/orchestration evidence, not a model-quality
// benchmark. Digressions surround the small event used by the scripted story.
function ramblingSource() {
  const opening = "This is a fictional rehearsal, not a family recording.";
  const ending =
    "At the end I remember the patient waiting, although the date and the order of our imaginary errands remain uncertain.";
  const central = "Ada waited while Nell tried her three blue coat buttons.";
  const topics = [
    [
      "the rainy kitchen window",
      "a chipped yellow bowl",
      "Tuesday",
      "sorting the café receipts",
    ],
    [
      "the crowded village station",
      "a green paper ticket",
      "Wednesday",
      "finding a folded street map",
    ],
    [
      "the quiet garden gate",
      "a crooked watering can",
      "Thursday",
      "counting the new bean leaves",
    ],
    [
      "the windy library steps",
      "a borrowed picture book",
      "Friday",
      "returning the library umbrella",
    ],
    [
      "the narrow bakery doorway",
      "a warm paper parcel",
      "Saturday",
      "choosing a loaf for lunch",
    ],
    [
      "the cluttered hallway shelf",
      "a wooden toy boat",
      "Sunday",
      "untangling a length of string",
    ],
    [
      "the sunny sitting room",
      "an empty biscuit tin",
      "Monday",
      "looking behind the old cushion",
    ],
    [
      "the market beside the bridge",
      "a small orange bag",
      "Tuesday",
      "comparing two bunches of carrots",
    ],
    [
      "the path past the pond",
      "a spotted wool scarf",
      "Wednesday",
      "watching a leaf turn slowly",
    ],
    [
      "the table near the stove",
      "a blue enamel jug",
      "Thursday",
      "rinsing cups after the visitors",
    ],
    [
      "the bus stop beyond the square",
      "a bent silver spoon",
      "Friday",
      "checking the timetable once more",
    ],
    [
      "the porch outside the workshop",
      "a red cotton ribbon",
      "Saturday",
      "putting the loose buttons away",
    ],
    [
      "the doorway under the stairs",
      "a smooth grey pebble",
      "Sunday",
      "searching for the spare mitten",
    ],
  ];
  const blocks: string[][] = [[opening]];
  for (let i = 0; i < 27; i++) {
    const [place, object, day, activity] = topics[i % topics.length];
    blocks.push([
      `Before I reach the part about the blue coat, I remember ${place} and ${object}, though those ordinary details only explain why the morning felt so busy.`,
      `I first called that ${day}, but I might be mixing it with another visit; the uncertain date is not something this fictional family is asking the story to invent.`,
      `Then my thoughts wander to ${activity}, before I return to Ada giving Nell room to try something herself, because the patient waiting matters more than the exact order of errands.`,
    ]);
    if (i === 16) blocks.push([central, "She never rushed Nell."]);
  }
  blocks.push([ending]);
  return {
    raw: `  ${blocks.map((sentences) => sentences.join(" ")).join("\n\n")}\n  `,
    // Independent expected boundaries: constructed sentences, not the product's
    // splitting expression. This detects dropped, merged or reordered segments.
    sentences: blocks.flat(),
    central,
    opening,
    ending,
  };
}

test("a long rambling typed memory reaches Heart intact and completes once through the normal injected-provider journey", async (t) => {
  const source = ramblingSource();
  const rawText = source.raw.trim();
  const words = rawText.split(/\s+/).length;
  assert(
    words >= 2500 && words <= 2900,
    `Unexpected rehearsal length: ${words}`,
  );
  assert(rawText.length < 50000);
  assert(
    Buffer.byteLength(JSON.stringify({ rawText: source.raw })) < 100 * 1024,
  );
  const network = t.mock.method(globalThis, "fetch", async () => {
    throw new Error(
      "This synthetic regression must not make network requests.",
    );
  });
  const dir = mkdtempSync(join(tmpdir(), "everlore-long-typed-"));
  let store = new Store(dir);
  const config = {
    ...engineConfig({}),
    enabled: true,
    apiKey: "synthetic-key-never-sent",
    budgetCents: 100000,
    audioReserve: 100,
    textReserve: 100,
    imageReserve: 100,
  };
  const consent = {
    consent: true,
    consentVersion: FAMILY_CONSENT_VERSION,
    processWithOpenAI: true,
    imaginativeAdaptation: true,
  } as const;
  try {
    configureAccess(store, false);
    store.run(
      "INSERT INTO users VALUES('owner','owner','unused','private',?)",
      now(),
    );
    const session = startJourney(
      store,
      "owner",
      { key: "long-typed", ...consent },
      config,
    ).session.session;
    const turn = session.turns[0];
    saveTurnText(store, "owner", session.id, turn.id, { rawText: source.raw });
    setSessionStatus(store, "owner", session.id, "finished");
    const saved = sessionView(store, "owner", session.id).session.turns[0];
    assert.equal(saved.transcript?.rawText, rawText);
    assert.equal(saved.audio, null);
    const expectedSegments = source.sentences.map((text, i) => ({
      id: `t${turn.sequence}-s${i + 1}`,
      text,
      startMs: null,
      endMs: null,
    }));
    assert.deepEqual(
      saved.transcript?.segments.map((s) => s.text),
      source.sentences,
    );
    assert.equal(store.all("SELECT * FROM studio_jobs").length, 0);
    const requested = createJourney(
      store,
      "owner",
      session.id,
      { key: "make-long-typed", ...consent },
      config,
    );
    store.close();
    store = new Store(dir);
    advanceCreationRequest(store, config);
    const projectId = journeyView(
      store,
      "owner",
      session.id,
      config,
    ).projectId!;
    assert(projectId);
    const frozen = store.one<{ body: string; sourceHash: string }>(
      "SELECT body,sourceHash FROM almanac_sources WHERE generationProjectId=?",
      projectId,
    )!;
    assert.equal(hash(canonical(JSON.parse(frozen.body))), frozen.sourceHash);
    assert.deepEqual(
      JSON.parse(frozen.body).turns[0].transcript,
      saved.transcript,
    );
    const expectedSource = Transcript.parse({
      version: 1,
      mode: "manual",
      rawText,
      recordingId: null,
      segments: expectedSegments,
    });
    const projectSource = store.one<{ transcript: string }>(
      "SELECT transcript FROM projects WHERE id=?",
      projectId,
    )!;
    assert.deepEqual(JSON.parse(projectSource.transcript), expectedSource);

    class LongJourneyFake extends StudioFake {
      heartInputs: unknown[] = [];
      override async transcribe(): Promise<string> {
        assert.fail("A typed source must never request audio transcription.");
      }
      override async structured<T>(
        name: string,
        schema: z.ZodType<T>,
        instruction: string,
        data: unknown,
        images: Buffer[] = [],
      ): Promise<T> {
        if (name !== "heart")
          return super.structured(name, schema, instruction, data, images);
        this.calls.push(name);
        const actual = (data as { source: unknown }).source;
        this.heartInputs.push(structuredClone(actual));
        assert.deepEqual(actual, expectedSource);
        const segmentFor = (quote: string) =>
          expectedSegments.find((s) => s.text === quote)!.id;
        // Beginning/middle/end evidence all remain addressable. The incidental
        // opening/end are deliberately flexible, not extra story obligations.
        return schema.parse({
          ...fixtureHeart,
          nuggets: [
            {
              ...fixtureHeart.nuggets[0],
              sourceId: segmentFor(source.central),
            },
            {
              ...fixtureHeart.nuggets[0],
              id: "opening",
              text: source.opening,
              quote: source.opening,
              sourceId: segmentFor(source.opening),
            },
            {
              ...fixtureHeart.nuggets[0],
              id: "ending",
              text: source.ending,
              quote: source.ending,
              sourceId: segmentFor(source.ending),
              certainty: "uncertain",
            },
          ],
          ledger: [
            ...fixtureHeart.ledger,
            {
              nuggetId: "opening",
              tier: "open",
              rule: "Synthetic provenance is not story material.",
              check: "Retain the original source separately.",
            },
            {
              nuggetId: "ending",
              tier: "flexible",
              rule: "Do not invent an exact historical date.",
              check: "The date may remain unspecified.",
            },
          ],
        });
      }
    }
    const provider = new LongJourneyFake();
    await runStudio(store, provider, config);
    const completed = latestStudio(store, projectId)!;
    assert.equal(
      completed.status,
      "complete",
      completed.error ?? completed.stage,
    );
    advanceCreationRequest(store, config);
    assert.equal(
      journeyView(store, "owner", session.id, config).bookReady,
      true,
    );
    assert.equal(provider.heartInputs.length, 1);
    assert.equal(
      provider.calls.filter((name) => /^draft_\d$/.test(name)).length,
      3,
    );
    assert(provider.calls.includes("scenes"));
    const book = Book.parse(
      JSON.parse(
        store.one<{ book: string }>(
          "SELECT book FROM revisions WHERE projectId=?",
          projectId,
        )!.book,
      ),
    );
    assert.deepEqual(book.transcript, expectedSource);
    assert.equal(book.spreads.length, 12);
    assert(book.spreads.every((spread) => !!spread.artHash));
    assert.equal(
      store.all("SELECT * FROM editions WHERE projectId=?", projectId).length,
      1,
    );
    assert.equal(store.all("SELECT * FROM almanac_transcriptions").length, 0);
    assert.equal(store.all("SELECT * FROM recordings").length, 0);
    const calls = provider.calls.length;
    const repeated = createJourney(
      store,
      "owner",
      session.id,
      { key: "same-source-again", ...consent },
      config,
    );
    assert.equal(repeated.requestId, requested.requestId);
    advanceCreationRequest(store, config);
    assert.equal(await runStudio(store, provider, config), false);
    assert.equal(provider.calls.length, calls);
    assert.equal(store.all("SELECT * FROM almanac_sources").length, 1);
    assert.equal(network.mock.callCount(), 0);
    t.diagnostic(
      JSON.stringify({
        words,
        characters: rawText.length,
        segments: expectedSegments.length,
        jsonBytes: Buffer.byteLength(JSON.stringify({ rawText: source.raw })),
        heartCalls: provider.heartInputs.length,
        spreads: book.spreads.length,
        networkCalls: 0,
        creativeEvidence: "scripted fixtures only",
      }),
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
