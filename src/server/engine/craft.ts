// Adapted from the user-supplied Big Fish engine. Editorial tools, not plot laws.
export const CRAFT_VERSION = "everlore-craft-2";
export const SHAPES = {
  crossing: {
    spine: "familiar world → threshold → strangeness → choice → belonging",
    lookFor:
      "What was carried from home? What made the new place feel possible?",
  },
  trial: {
    spine:
      "ordinary life → difficulty → repeated effort → small mercy → what endured",
    lookFor: "The concrete act of care hidden inside 'it was hard'.",
  },
  meeting: {
    spine:
      "separate lives → encounter → mistaken impression → connection → shared life",
    lookFor: "A particular gesture; do not invent a near-miss as family fact.",
  },
  catch: {
    spine: "want → attempts → changed approach → encounter → the real prize",
    lookFor: "The want beneath the stated prize; label this as interpretation.",
  },
  mischief: {
    spine: "temptation → plan → comic complication → choice → consequence",
    lookFor:
      "Admitted flaws can be funny with affection; do not invent humiliating behavior.",
  },
  kindness: {
    spine: "need → unexpected helper → specific act → ripple → passing it on",
    lookFor: "What became possible because someone cared?",
  },
  loss: {
    spine: "what was loved → absence → what remains → an act of keeping",
    lookFor:
      "Use the family's beliefs, not invented spiritual certainty. No forced joke or tidy cure.",
  },
  craft: {
    spine:
      "teacher → first effort → practice → a choice → hands understand → passing on",
    lookFor:
      "The particular tool, instruction or gesture. Failure is not assumed historical fact.",
  },
  creature: {
    spine:
      "encounter → distinctive nature → misunderstanding → changed attention → connection",
    lookFor:
      "What passed between them? Animal family casting is distinct from a remembered pet.",
  },
  secret: {
    spine:
      "ordinary surface → discovery → changed understanding → shared meaning",
    lookFor:
      "Use safe discoveries and surprises; never burden a child with concealing harm from trusted adults.",
  },
  discovery: {
    spine:
      "notice → wonder → try → surprising detail → see the familiar differently",
    lookFor: "A quiet story can move through attention rather than danger.",
  },
} as const;
export const AMPLIFICATION_MOVES = {
  scale:
    "Heighten scale to make a sourced feeling visible; protect meaningful object identity.",
  name: "Give an unnamed imagined element a memorable name; preserve protected real names.",
  talisman:
    "A source-specific object matters early, during a choice, and at the ending.",
  personify:
    "Give an obstacle a personality without inventing damaging claims about real people.",
  centralWonder:
    "A coherent imaginative premise serves the heart; no required count of impossible events.",
  attempts:
    "Vary attempts with causal consequences, avoiding a mandatory three-attempt formula.",
  refrain:
    "Return to a speakable phrase, preferably sourced; transform its meaning at the payoff.",
  helper:
    "Make an existing relationship visible through action, without the helper solving everything.",
  slowMoment:
    "Slow the meaningful turning point through precise sensory action and a visual beat.",
  tallTaleFrame:
    "Let a playful frame signal exaggeration; never fabricate attribution as sourced testimony.",
  callback: "Plant a detail early and return to it with changed meaning.",
  listener:
    "Invite the next generation into the consequence without requiring the child's real name.",
} as const;
export const HOUSE_STYLE = {
  version: "folk-gouache-1",
  medium:
    "Opaque chalky gouache-like painted masses, selective washes, dry-brush skips and broken colored-pencil contours.",
  form: "Substantial species-specific silhouettes. Small dark eyes, restrained mouths. Emotion in posture, ears, gaze and meaningful contact.",
  palette: {
    cream: "#F1EAD5",
    mint: "#C6D8CC",
    sage: "#A5B69A",
    pine: "#465E51",
    slate: "#56687D",
    periwinkle: "#778AB4",
    rust: "#CC633C",
    ochre: "#CEA454",
    ink: "#343F44",
  },
  staging:
    "Shared ground, coherent object geometry, selective texture, gently flattened depth. One clear focal action; quieter peripheral discovery.",
  exclusions:
    "No lettering, signatures, logos, die-cut halos, camera glare, tabletop, glossy 3D, giant eyes, hyperreal fur, indiscriminate noise or default sparkle effects.",
};
export function explicitAudioCues(text: string) {
  return [
    ...text.matchAll(
      /\[(pause|long[ _]pause|laughs?|voice[ _]breaks|sigh|trails[ _]off|repeats)\]/gi,
    ),
  ].map((m) => ({
    kind: m[1].toLowerCase().replaceAll(" ", "_"),
    quote: m[0],
    offset: m.index,
  }));
}
