// Evaluation-only corpus. Never expose individual cases in development views.
import { LabCase, type EvaluationCase } from "../../shared/lab.js";
import { cases } from "./library.js";
import { now, type Store } from "../store.js";
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

export function seedReleaseCases(store: Store) {
  for (const c of heldOutCases)
    store.run(
      "INSERT OR IGNORE INTO lab_cases VALUES(?,NULL,?,?)",
      c.id,
      JSON.stringify(c),
      now(),
    );
}
