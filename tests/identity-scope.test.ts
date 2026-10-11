import { test } from "node:test";
import assert from "node:assert/strict";
import { identityScopePasses } from "../src/server/engine/identity-scope.js";
test("identity scope requires complete canonical evidence and retains every material gate", () => {
  const good = { characters:[{id:"a",recognizable:true,evidence:"Same species, face and colors."},{id:"b",recognizable:true,evidence:"Same silhouette and muzzle."}], unexpectedNamedCharacters:[], materialContradictions:[], actionReadable:true, physicalCoherence:true, childAppropriate:true };
  assert(identityScopePasses(good,["a","b"]));
  assert(!identityScopePasses({...good,characters:[good.characters[0],good.characters[0]]},["a","b"]));
  assert(!identityScopePasses({...good,characters:[good.characters[0]]},["a","b"]));
  assert(!identityScopePasses({...good,characters:good.characters.map(c=>({...c,recognizable:false}))},["a","b"]));
  assert(!identityScopePasses({...good,unexpectedNamedCharacters:["extra child"]},["a","b"]));
  assert(!identityScopePasses({...good,materialContradictions:["Contradicts source"]},["a","b"]));
  for (const key of ["actionReadable","physicalCoherence","childAppropriate"] as const)
    assert(!identityScopePasses({...good,[key]:false},["a","b"]));
});
