import {
  CraftPrinciple,
  LabCase,
  type EvaluationCase,
} from "../../shared/lab.js";
import { HeartContract } from "../../shared/studio.js";
import type { Store } from "../store.js";
import { now } from "../store.js";
const newbery = "https://www.ala.org/alsc/awardsgrants/bookmedia/newbery";
const caldecott = "https://www.ala.org/alsc/awardsgrants/bookmedia/caldecott";
const picturebooks =
  "https://www.routledge.com/How-Picturebooks-Work/Nikolajeva-Scott/p/book/9780415979689";
const evals =
  "https://developers.openai.com/api/docs/guides/evaluation-best-practices";
const imageEvals =
  "https://developers.openai.com/cookbook/examples/multimodal/image_evals";
export const principles = [
  [
    "desire",
    "The desire beneath the anecdote",
    "story",
    "Developmental editing",
    newbery,
    "Newbery criteria",
    "read",
    "Character, plot and style must work for the intended child audience. A deeper desire is a hypothesis, not a recovered fact.",
    "Translate “we waited for the bus” into a concrete want, an obstacle and a relationship whose gestures matter.",
    "Assigning an unspoken motive as fact or adding a generic rescue adventure.",
    "Identify what the child wants by spread two and the source-supported action it changes.",
  ],
  [
    "causality",
    "Choices make a story move",
    "story",
    "Narrative structure",
    newbery,
    "Newbery criteria",
    "read",
    "Plot evaluation includes development, with consequential decisions as our practical hypothesis.",
    "Link each consequential beat with because/therefore; let a small act of noticing or asking count as agency.",
    "Twelve events joined only by “and then”; an adult solves everything.",
    "Remove the protagonist’s choice: does the outcome change? Cite before/after beats.",
  ],
  [
    "specificity",
    "Particulars carry the action",
    "story",
    "Family memory and developmental editing",
    newbery,
    "Newbery criteria",
    "read",
    "Distinction should emerge from characterization and particulars rather than decorative names. This removal test is Everlore’s hypothesis.",
    "Give a remembered phrase, object or ritual a job in the obstacle, choice or payoff.",
    "A blue coat described once, followed by an unrelated generic magical quest.",
    "Name three story moments that stop making sense when the family particulars are removed.",
  ],
  [
    "voice",
    "Language made for a listening child",
    "story",
    "Poetry and oral storytelling",
    newbery,
    "Newbery criteria",
    "read",
    "Style includes precise language. Oral cadence, breath and repetition are operational hypotheses to test.",
    "Use concrete verbs, varied breath groups, distinctive dialogue and a refrain whose meaning changes.",
    "Rhyming every line at the cost of sense; ornate synonyms; a paragraph explaining the lesson.",
    "Cite tongue-twisting clauses, ambiguous pronouns, predictable repetition and an actual revised line. Model judgment is not a read-aloud observation.",
  ],
  [
    "payoff",
    "Surprise with a remembered root",
    "story",
    "Narrative structure",
    newbery,
    "Newbery criteria",
    "read",
    "A satisfying whole can reinterpret an earlier detail without announcing a moral.",
    "Plant an object or gesture, complicate its use and return it through the child’s consequential choice.",
    "A new magical helper fixes the problem on spread twelve; a final lecture.",
    "Cite the setup, the change in meaning and the action earning the last image.",
  ],
  [
    "embodiment",
    "Emotion in a whole animal body",
    "art",
    "Illustration",
    caldecott,
    "Caldecott criteria",
    "read",
    "Pictorial interpretation and child presentation depend on expressive action, not surface polish alone.",
    "Use substantial species-specific silhouettes, restrained faces, weight, posture and coherent contact.",
    "A beautiful floating paw that cannot touch the protected object.",
    "Inspect silhouette at thumbnail size, emotional action at reading size and contact at detail size.",
  ],
  [
    "visual_discovery",
    "Pictures have something of their own to say",
    "book",
    "Picture-book design",
    picturebooks,
    "How Picturebooks Work — reading agenda",
    "proposed_reading",
    "The book is in the reading agenda; its full text has not been read. Word–image complementarity here is our testable hypothesis.",
    "Let pictures carry a secondary joke, a clue or the shift in a relationship while words preserve clarity.",
    "Art literally repeats every sentence, or contradicts a protected event.",
    "Identify each medium’s contribution and test whether the central action is still comprehensible.",
  ],
  [
    "rhythm",
    "A sequence, not twelve posters",
    "art",
    "Picture-book design",
    caldecott,
    "Caldecott criteria",
    "read",
    "Pictures interpret a complete story. Variation should support its emotional progression.",
    "Plan wide/close, dense/quiet and warm/cool contrasts before final illustration.",
    "Twelve centered smiling portraits with identical staging.",
    "Inspect a contact sheet and then each spread in order, including quiet text regions.",
  ],
  [
    "calibration",
    "Retain disagreement and failed attempts",
    "evaluation",
    "Evaluation methods",
    evals,
    "OpenAI evaluation best practices",
    "read",
    "Matched comparisons and position-bias checks support measurement. With human calibration removed, judgments remain provisional model evidence.",
    "Freeze the criterion, compare identical inputs twice in reversed order, retain ties and contradictions.",
    "Changing the rubric after a candidate loses, or calling model preference child engagement.",
    "Require complete coverage and report every failure, tie, disagreement and unresolved limitation.",
  ],
  [
    "edit_integrity",
    "A correction must preserve the rest",
    "evaluation",
    "Image evaluation",
    imageEvals,
    "OpenAI image evaluation guidance",
    "read",
    "Separate requirement correctness, edit preservation and aesthetic preference.",
    "Supply actual canon and before/after pixels; inspect the entire edited image, not only the requested region.",
    "Accepting an attractive edit that silently changes a protected prop or another character.",
    "Require exact object, identity, action and preservation findings separately from artistic preference.",
  ],
].map(
  ([
    id,
    title,
    area,
    perspective,
    url,
    sourceTitle,
    status,
    interpretation,
    application,
    counterexample,
    evaluation,
  ]) =>
    CraftPrinciple.parse({
      version: 1,
      id,
      title,
      area,
      perspective,
      source: { url, title: sourceTitle, status },
      interpretation,
      application,
      counterexample,
      evaluation,
      evidence: [],
    }),
);

const rawCases = [
  {
    id: "ordinary",
    title: "The three blue buttons",
    source:
      "When I was five, Aunt Ada waited on the doorstep while I tried the three buttons on my blue coat. She said, “I have time.” I managed the middle one myself. We were late for the bus.",
    meaning: "Patient company gives a child room to become capable.",
    want: "Fasten the coat without being hurried.",
    phrase: "I have time.",
    boundary:
      "Keep Ada as the aunt, and the middle button as the child’s own achievement; do not turn lateness into a punishment.",
  },
  {
    id: "rambling",
    title: "The bent red watering can",
    source:
      "Well, our garden was tiny. There was this red watering can, dented, my granddad had it. I wanted the tallest sunflower. Oh, the fence was green then. Anyway I kept pouring. Granddad put his hand over the spout. “Even thirsty things need a breath,” he said. Mine stayed short, but a wren nested beside it. We watched together.",
    meaning: "Attention can reveal a different kind of abundance from winning.",
    want: "Grow the tallest sunflower.",
    phrase: "Even thirsty things need a breath",
    boundary:
      "The sunflower stays short. Do not invent a first prize. Granddad and child watch the wren together.",
  },
  {
    id: "fragmented",
    title: "The yellow umbrella",
    source:
      "Rain. Yellow umbrella. My older sister Jo held it. I was small. Water down my neck. I moved closer. Jo moved the umbrella. We both laughed. That is what I remember. I do not remember where we were going.",
    meaning: "Belonging can be a small adjustment made for another person.",
    want: "Find room under the umbrella.",
    phrase: "",
    boundary:
      "Do not claim a destination or reason for the trip. Jo is the older sister, not a parent.",
  },
  {
    id: "humorous",
    title: "Uncle’s crooked dumplings",
    source:
      "Uncle Ren let me fold dumplings. Mine looked like socks. One opened in the pot and the filling floated out. I called it a swimming dumpling. Uncle laughed so hard his glasses slid down. We ate it from a bowl with a spoon.",
    meaning:
      "Making something together leaves room for imperfection and laughter.",
    want: "Make a dumpling that holds together.",
    phrase: "swimming dumpling",
    boundary:
      "No competition or humiliation. Preserve the spoon, the broken dumpling and affectionate shared laughter.",
  },
  {
    id: "culturally-specific",
    title: "Abuela’s paper flower",
    source:
      "Abuela Inés showed me how she makes paper flowers for our family’s Día de Muertos ofrenda. Mine tore. We tucked that torn orange flower beside a photograph of her brother Tomás. She told me he used to whistle while fixing bicycles. “He would like this one,” she said.",
    meaning:
      "A family can make space for love and remembrance without perfection.",
    want: "Make a flower worthy of a remembered person.",
    phrase: "He would like this one",
    boundary:
      "Preserve names, family relationships and the specific practice. Do not generalize this family’s custom to all Mexican families. No invented sacred ritual or supernatural claim about the deceased.",
  },
  {
    id: "sensitive",
    title: "Dad’s tin of screws",
    source:
      "After Dad died, I kept his round tin of screws. I did not want anyone to move it. One day my little brother’s toy cart broke. I found a short screw in the tin and we fixed the wheel together. I still missed Dad. The tin stayed on my shelf.",
    meaning:
      "Care can continue through an ordinary object without erasing grief.",
    want: "Keep a loved person’s things safe and help a sibling.",
    phrase: "",
    boundary:
      "No new death, reunion, resurrection or claim that grief is cured. Dad has died; the little brother is alive. Keep the tin and repaired wheel.",
  },
];
export const cases: EvaluationCase[] = rawCases.map((c) =>
  LabCase.parse({
    version: 1,
    id: c.id,
    title: c.title,
    category: c.id,
    synthetic: true,
    source: c.source,
    projectId: null,
    consentAt: null,
    heart: HeartContract.parse({
      version: 2,
      summary: c.meaning,
      emotionalInheritance: c.meaning,
      relationshipHeart: c.boundary,
      statedWant: c.want,
      deeperWant: c.meaning,
      deeperWantIsInterpretation: true,
      childConnection: c.want,
      nuggets: [
        {
          id: "n1",
          kind: "event",
          text: c.source,
          sourceId: "s1",
          quote: c.source,
          certainty: "stated",
          emphasis: "ordinary",
        },
      ],
      ledger: [
        {
          nuggetId: "n1",
          tier: "protected",
          rule: c.boundary,
          check:
            "Cite the corresponding action and relationship in the manuscript; no contrary claim.",
        },
      ],
      protectedPhrases: c.phrase ? [c.phrase] : [],
      creativeOpportunities: [
        "Build wonder from this particular object, gesture or remembered phrase.",
        "Change scale, point of view or a playful rule while preserving the protected heart.",
      ],
      sensitiveBoundaries: [c.boundary],
      questions: [],
      adultNotes:
        "Synthetic evaluation input, authored for engineering and craft experiments; not a real family account.",
    }),
  }),
);

// Original synthetic release inputs. Never included in candidate prompts or the study library.
export const heldOutCases: EvaluationCase[] = [
  [
    "ordinary",
    "The crooked bookmark",
    "Grandma June cut a bookmark from an old envelope. I wanted mine straight. Mine leaned sideways. She put it in her favorite book and said, ‘It knows where we stopped.’",
    "Being useful does not require being perfect.",
  ],
  [
    "rambling",
    "The yellow trolley",
    "We missed the trolley, my uncle and I. Yellow, I think. Or the sign was yellow. Anyway he had a bag of oranges. One rolled down the hill. We went after it, slowly because his knee hurt. We shared it on the bench. Never did get to the market that day.",
    "Unexpected shared time matters more than finishing an errand.",
  ],
  [
    "fragmented",
    "The window signal",
    "Rain. School gate. My brother on the other side of the window. Three taps. That meant wait for me. I waited. We walked home under his coat.",
    "A small familiar signal can make someone feel accompanied.",
  ],
  [
    "humorous",
    "The hat that held lunch",
    "Aunt Sal packed the sandwiches in Grandpa's hat by mistake. He lifted it and lettuce fell on his nose. He laughed first. We ate under the tree. The hat still smelled of mustard.",
    "Shared laughter can turn a mistake into belonging.",
  ],
  [
    "culturally-specific",
    "The word on the doorstep",
    "My grandmother greeted me with ‘Bari luys’ each morning. She told me it meant good morning in Armenian. I practiced quietly. One morning I said it before she did. She smiled and moved over on the doorstep so I could sit beside her.",
    "A family's language can become an act of connection.",
  ],
  [
    "sensitive",
    "The empty chair's cushion",
    "After Nana died, I kept the cushion from her chair. My cousin asked to hold it. I said no at first. Later we put it between us while we looked at her photographs. I still missed her.",
    "Sharing remembrance need not erase grief.",
  ],
].map(([category, title, source, meaning]) => {
  const template = structuredClone(cases.find((c) => c.category === category)!);
  const boundary =
    "Preserve the stated relationships, meaningful objects and actual outcome. Leave uncertain facts uncertain; imagination must not become new biography.";
  return LabCase.parse({
    ...template,
    id: `heldout-${category}`,
    partition: "held_out",
    title,
    source,
    heart: {
      ...template.heart,
      summary: meaning,
      emotionalInheritance: meaning,
      relationshipHeart: boundary,
      statedWant: "Find connection through this specific remembered event.",
      deeperWant: meaning,
      childConnection: meaning,
      nuggets: [
        {
          id: "n1",
          kind: "event",
          text: source,
          sourceId: "s1",
          quote: source,
          certainty: "stated",
          emphasis: "ordinary",
        },
      ],
      ledger: [
        {
          nuggetId: "n1",
          tier: "protected",
          rule: boundary,
          check:
            "No contradictory relationship, outcome or fabricated source claim.",
        },
      ],
      protectedPhrases: [],
      sensitiveBoundaries: [boundary],
    },
  });
});
const techniqueStudies = [
  [
    "anticipation",
    "Anticipation",
    "An understandable want with a withheld outcome",
    "Curiosity or an approaching small event",
    "The parcel rattled once. Ada put her ear to the quiet side.",
    "Withholding basic orientation rather than creating curiosity.",
  ],
  [
    "cumulative",
    "Cumulative patterns",
    "A pattern grows through consequential additions",
    "Tasks, rituals and gathering stories",
    "One cup for Ada. One for the visitor. A thimble for whoever knocked next.",
    "Repetition adds length but changes nothing.",
  ],
  [
    "comic-escalation",
    "Comic escalation",
    "Attempts complicate a specific predicament",
    "Affectionate mishaps without humiliation",
    "He caught the rolling pear with his hat. Now the hat was rolling too.",
    "Random disasters replace causal humor.",
  ],
  [
    "quiet-change",
    "Quiet emotional change",
    "A gesture changes distance or understanding",
    "Belonging, patience, memory and grief",
    "She did not say come closer. She moved the teacup.",
    "Nothing changes, or narration explains the feeling twice.",
  ],
  [
    "repetition-variation",
    "Repetition with variation",
    "A familiar phrase returns with changed meaning",
    "Read-aloud participation and emotional callbacks",
    "‘I have time,’ Ada said at the button. Years later, the child said it at Ada's door.",
    "A refrain repeats mechanically or distorts a protected quote.",
  ],
  [
    "visual-counterpoint",
    "Visual counterpoint",
    "Pictures reveal a second, understandable layer",
    "Small jokes, anticipation and understated affection",
    "Words say the room was ready; the picture shows one chair turned toward the arriving friend.",
    "The image contradicts a protected memory or confuses the main action.",
  ],
  [
    "earned-endings",
    "Earned endings",
    "A planted particular returns through a changed choice",
    "Stories whose resolution grows from a relationship",
    "The crooked bookmark finds its place in the book they read together.",
    "A late helper solves everything or a moral explains the ending.",
  ],
].map(([id, title, technique, appropriateUses, originalExample, failure]) =>
  CraftPrinciple.parse({
    version: 1,
    id: `study-${id}`,
    title,
    area: id === "visual-counterpoint" ? "book" : "story",
    perspective: "Original Everlore technique hypothesis",
    source: {
      url: id === "visual-counterpoint" ? caldecott : newbery,
      title: "ALA criteria — critical lens, not attribution of this technique",
      status: "hypothesis",
    },
    study: {
      version: 1,
      technique,
      appropriateUses,
      originalExample,
      evidenceStatus: "hypothesis_pending_experiment",
    },
    interpretation: technique,
    application: appropriateUses,
    counterexample: failure,
    evaluation:
      "Compare matched outputs and cite the action, language or image that changes; retain contradictory results.",
    evidence: [],
  }),
);
principles.push(...techniqueStudies);

export const artCases = [
  [
    "front",
    "Front silhouette",
    "Neutral frontal standing view. Keep species, body-region colors, age and outfit exact.",
  ],
  [
    "side",
    "Side silhouette",
    "Side profile in a clear walking gesture. Keep the same anatomy and weight.",
  ],
  [
    "three-quarter",
    "Three-quarter view",
    "Three-quarter seated pose, hands resting on knees, same identity.",
  ],
  [
    "child",
    "Child age state",
    "Depict the explicitly specified child age state from the world contract. Do not infer age from an adult family role.",
  ],
  [
    "adult",
    "Adult age state",
    "Depict the explicitly specified adult age state. Keep species and inherited identity consistent.",
  ],
  [
    "night",
    "Night light",
    "Moonlit doorstep: blue ambient light with one warm window; body colors remain identifiable.",
  ],
  [
    "carry",
    "Shared weight",
    "Two cast members carry the same meaningful object. Show believable grip, gravity and contact.",
  ],
  [
    "handoff",
    "Passing an object",
    "A single meaningful object passes from one paw to another. Exact geometry and color; no duplication.",
  ],
  [
    "quiet",
    "Quiet emotion",
    "Show hesitant affection through posture and distance, with small restrained faces.",
  ],
  [
    "wide",
    "Wide composition",
    "Wide establishing view, small characters with readable action; a deliberate quiet area.",
  ],
  [
    "close",
    "Close discovery",
    "Close view of the meaningful object and a visual discovery the prose does not state.",
  ],
  [
    "edit",
    "Targeted edit preservation",
    "Change only the intended lighting from the supplied baseline scene to late afternoon. Preserve cast, pose, prop geometry, action and composition.",
  ],
].map(([id, title, instruction]) => ({ id, title, instruction }));
export const agenda = [
  {
    id: "reader-experience",
    title: "Compose the child's experience across twelve spreads",
    target: "plan" as const,
    criterion: "read_aloud" as const,
    principle: "voice",
    amendment:
      "Supply readerExperience version 1. Link dramatic possibilities to source nuggets: remembered must be an EXACT excerpt of a linked nugget quote; possibleMotivation is interpretation, imaginativeTransformation is invention. For each spread state what a listening child understands, anticipates, discovers and feels, and a natural reason to turn the page. Allocate distinct information to words and pictures. Specify voice, breath/rhythm, repetition with changed meaning and silence; no forced rhyme or final moral. Test what stops working when a meaningful family detail is removed. This is intended craft, never observed child response.",
    risk: "Overplanning may make language mechanical or force suspense into a quiet story.",
  },
  {
    id: "premise-diversity",
    title: "Compare genuinely different story possibilities",
    target: "concepts" as const,
    criterion: "family_specificity" as const,
    principle: "specificity",
    amendment:
      "Make three alternatives differ in consequential action and ending, not just titles, scenery or magical decoration. A quiet discovery, comic complication and act of care are possible alternatives, never a mandatory set. Retain the same protected heart.",
    risk: "Novelty may distract from the family's emotional truth.",
  },
  {
    id: "visual-direction",
    title: "Design a whole picture book before final artwork",
    target: "art" as const,
    criterion: "visual_discovery" as const,
    principle: "rhythm",
    amendment:
      "Design pictures as a sequence with purposeful expansive/intimate and dense/quiet contrasts. A single image is not proof of a strong book. Keep folk-gouache identity; distinguish intended emotional color from protected body colors. Pictures contribute discoveries without obscuring the action.",
    risk: "Forced variation can undermine a coherent quiet sequence.",
  },
  {
    id: "particulars",
    title: "Make family particulars cause the story",
    target: "plan" as const,
    criterion: "family_specificity" as const,
    principle: "specificity",
    amendment:
      "Build a counterfactual specificity map before planning: choose up to three protected particulars and give each a causal role in a desire, obstacle, decision, visual discovery or payoff. If removing a particular leaves every action unchanged, rebuild that action. Keep quiet stories quiet when appropriate. Do not merely repeat the object’s name. The last action must return one family-specific detail with changed meaning.",
    risk: "Overengineering the plot could make an intimate memory feel contrived.",
  },
  {
    id: "agency",
    title: "A small child can change what happens",
    target: "plan" as const,
    criterion: "child_agency" as const,
    principle: "causality",
    amendment:
      "Trace motivation → choice → consequence across the twelve beats. Distinguish an attempted action from a result and from an emotion. Build at least one consequential choice that uses the protagonist’s particular strength while exposing their vulnerability; asking, noticing, sharing or waiting may be the decisive action. Supportive adults create conditions, not the entire solution. Avoid forced danger and mechanical three-attempt plots.",
    risk: "Overstated agency could erase the value of receiving care.",
  },
  {
    id: "voice",
    title: "Speech, breath, rhythm and purposeful repetition",
    target: "compose" as const,
    criterion: "read_aloud" as const,
    principle: "voice",
    amendment:
      "Compose by listening: use concrete verbs and clear referents, alternate short landing lines with longer flowing sentences, place the revealing word where breath and emphasis can carry it. Use dialogue to expose distinct desires instead of narrating them. Repeat a phrase only when the situation changes its meaning. Preserve the family phrase’s natural idiom. Cut explanatory moral endings, inflated adjectives and forced rhyme. Give each spread one dominant audible movement without uniform sentence length.",
    risk: "Excessive smoothing could erase a family’s distinctive dialect or phrase.",
  },
  {
    id: "ending",
    title: "An earned surprise carried by a small detail",
    target: "plan" as const,
    criterion: "earned_ending" as const,
    principle: "payoff",
    amendment:
      "Design backward from a final concrete action or image whose emotional meaning changes because of an earlier choice. Plant its material detail before it is needed. Make the payoff surprising in interpretation, not dependent on a newly introduced magical solution. Let an unfinished wish coexist with a changed relationship. Preserve protected outcomes; stop before explaining the lesson.",
    risk: "A clever ending could overpower the memory’s quiet emotional truth.",
  },
  {
    id: "posture",
    title: "Expressive bodies and tactile shapes",
    target: "art" as const,
    criterion: "visual_expression" as const,
    principle: "embodiment",
    amendment:
      "Explore expressive silhouette, weight and negative space within the established folk-gouache house style. Small faces, substantial species-specific bodies, selective broken contours and chalky paint. Let the body’s lean and the distance between characters reveal the emotional turn. Avoid extra ornament that hides action; maintain exact identity and contact with protected objects.",
    risk: "More expressive distortion could break species or object continuity.",
  },
  {
    id: "discovery",
    title: "A visual discovery worth returning to",
    target: "art" as const,
    criterion: "visual_discovery" as const,
    principle: "visual_discovery",
    amendment:
      "Add one restrained secondary visual discovery rooted in the scene’s meaningful object or relationship. It may anticipate a later payoff or reveal affection the words leave unstated. Keep the central action instantly legible, preserve the quiet area and original cast, and do not add arbitrary creatures or new family facts.",
    risk: "Secondary discoveries could distract from the central action.",
  },
];
export function seedLibrary(store: Store) {
  for (const p of principles)
    store.run(
      "INSERT OR IGNORE INTO lab_principles VALUES(?,?,?)",
      p.id,
      p.version,
      JSON.stringify(p),
    );
  for (const c of [...cases, ...heldOutCases])
    store.run(
      "INSERT OR IGNORE INTO lab_cases VALUES(?,NULL,?,?)",
      c.id,
      JSON.stringify(c),
      now(),
    );
}
