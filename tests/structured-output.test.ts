import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import * as contracts from "../src/shared/studio.js";
import { structuredOutput } from "../src/server/engine/structured-output.js";

test("all exported story/art contracts emit strict object properties", () => {
  const inspect = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const s = value as { properties?: Record<string, unknown>; required?: string[]; additionalProperties?: unknown };
    if (s.properties) {
      assert.deepEqual(s.required, Object.keys(s.properties));
      assert.equal(s.additionalProperties, false);
    }
    Object.values(value).forEach(inspect);
  };
  for (const contract of Object.values(contracts))
    if (contract instanceof z.ZodType) inspect(structuredOutput<unknown>(contract).schema);
});

test("optional transport nulls round-trip without changing saved semantics", () => {
  const contract = z.object({
    nested: z.array(z.object({ optional: z.string().optional(), explicitNull: z.string().nullable().optional(), required: z.string() })),
    future: z.object({ text: z.string() }).optional(),
  });
  const wire = structuredOutput(contract);
  assert.deepEqual(wire.parse({nested:[{optional:null, explicitNull:null,required:"kept"}],future:null}), {nested:[{explicitNull:null,required:"kept"}]});
  assert.throws(() => wire.parse({nested:[{required:null}]}));
  assert.throws(() => wire.parse({nested:[{required:"kept",optional:42}]}));
});

test("concept review nullable diversity does not demand an unselected feature", () => {
  const assessments = [1,2,3].map(n => ({conceptId:`c${n}`,heartViolations:[],childAppeal:4,familySpecificity:4,imaginativePotential:4,evidence:"Specific evidence"}));
  assert.deepEqual(structuredOutput(contracts.ConceptReview).parse({assessments,diversity:null}), {assessments});
});
