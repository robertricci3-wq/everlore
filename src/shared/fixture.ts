import type { BookDocument, TranscriptDocument } from "./contracts.js";

export const sampleSource: TranscriptDocument = {
  version: 1,
  mode: "synthetic_fixture",
  recordingId: null,
  rawText: "",
  segments: [
    {
      id: "s1",
      text: "My name is Nell. When I was five, my aunt Ada taught me to button my blue coat.",
    },
    {
      id: "s2",
      text: "We sat together on the wooden step by her kitchen door. My coat had three big round buttons.",
    },
    {
      id: "s3",
      text: "The first button kept slipping away from my fingers. Ada waited beside me.",
    },
    {
      id: "s4",
      text: "She showed me how to turn the button sideways and push its edge into the hole. I tried it myself.",
    },
    {
      id: "s5",
      text: "The first one went through. I could feel its smooth round face under my thumb.",
    },
    {
      id: "s6",
      text: "I did the second button, slowly. On the last one I pushed the wrong way, pulled it back, and tried again.",
    },
    {
      id: "s7",
      text: "When all three were done, I counted them with my finger. One, two, three.",
    },
    {
      id: "s8",
      text: "Ada smiled. We went into the garden together. I kept touching those buttons as we walked.",
    },
    {
      id: "s9",
      text: "It was only a coat. But I remember her waiting, and how proud I felt doing that little thing myself.",
    },
  ].map((s) => ({ ...s, startMs: null, endMs: null })),
};
sampleSource.rawText = sampleSource.segments.map((s) => s.text).join("\n\n");

const story = [
  [
    "When Nell was five, her blue coat had three big buttons. Three little circles. Three little puzzles. Aunt Ada knew how to do them. Nell was still learning.",
    ["c1", "c2"],
  ],
  [
    "They sat on the wooden step beside the kitchen door. Ada sat close, and Nell gathered the blue coat into her hands. They would begin with one button.",
    ["c1", "c2"],
  ],
  [
    "Nell caught the first button between her fingers. She pushed. It slipped. She caught it again. The button was round, but it would not go through.",
    ["c3"],
  ],
  [
    "Ada waited. There was no need to do all three at once. Nell had the coat in her hands. Ada had a small trick to show her.",
    ["c3", "c4"],
  ],
  [
    "Ada turned the button sideways. Now its narrow edge could find the hole. Nell watched the little turn. A round button could be narrow, too.",
    ["c4"],
  ],
  [
    "Then Nell tried. Sideways first. A little push. Through went the button! Under her thumb was its smooth, round face. One button done. Two still waiting.",
    ["c4", "c5"],
  ],
  [
    "The second button needed the same small turn. Nell took her time. Fingers, edge, hole. Slowly, she worked it through. Now two round buttons held her coat together.",
    ["c6"],
  ],
  [
    "The last one would not go. Nell had pushed the wrong way. She pulled it back. That was all right. She could turn it and try again.",
    ["c6"],
  ],
  [
    "Nell tried again. And there it was: the last button, through at last. Her fingers had done the work. All three circles sat along her blue coat.",
    ["c6", "c7"],
  ],
  [
    "She counted them with one finger. One. Two. Three. Not a button left to do. Ada smiled beside her on the step. Nell felt proud.",
    ["c7", "c8", "c9"],
  ],
  [
    "Together, they went into the garden. As they walked, Nell touched the buttons. One, two, three. The coat was the same coat. She had buttoned it herself.",
    ["c8", "c7"],
  ],
  [
    "Long afterward, Nell remembered that blue coat. She remembered the buttons, and Ada waiting beside her. Such a little thing to learn. Such a lovely thing to keep.",
    ["c9", "c1"],
  ],
] as const;

export function sampleBook(): BookDocument {
  return {
    version: 1,
    revision: 1,
    title: "The little things we learn",
    byline: "A memory from Nell",
    mode: "synthetic_fixture",
    artMode: "designed_sample",
    ageBand: "4–7",
    transcript: structuredClone(sampleSource),
    ledger: sampleSource.segments.map((s, i) => ({
      id: `c${i + 1}`,
      type: i === 0 ? "person" : "event",
      text: s.text,
      sourceIds: [s.id],
      certainty: "stated",
      clarification: null,
    })),
    people: [
      {
        id: "nell",
        name: "Nell",
        relationship: "narrator",
        depictedAge: 5,
        appearance:
          "Child proportions, simple brown bob, blue coat with three round ochre buttons. Skin and hair are illustrative design choices, not likeness claims.",
        appearanceSource: "artistic_design",
      },
      {
        id: "ada",
        name: "Ada",
        relationship: "aunt",
        depictedAge: null,
        appearance:
          "Adult proportions, dark hair in a bun, muted rust dress. Appearance is a design choice, not source biography.",
        appearanceSource: "artistic_design",
      },
    ],
    spreads: story.map(([text, claimIds], i) => ({
      id: `spread-${i + 1}`,
      text,
      claimIds: [...claimIds],
      scene: i,
      artHash: "",
      artDescription: `Designed sample scene ${i + 1}: Nell at age five and aunt Ada; blue coat, three round buttons.`,
      characterIds:
        i === 4 || i === 5 || i === 6 || i === 8 ? ["nell"] : ["nell", "ada"],
      lines: [],
    })),
    sourceHash: "",
    contentHash: "",
    printReady: false,
    reviewFlags: [
      "Synthetic memory; not generated from a recording.",
      "Designed vector sample art; not a live illustration provider.",
      "Human editorial and whole-book art review pending.",
      "Physical print format is unverified.",
    ],
    layout: {
      version: 1,
      width: 1200,
      height: 600,
      fontSize: 24,
      lineHeight: 38,
      textX: 680,
      textWidth: 450,
      textY: 200,
    },
  };
}
