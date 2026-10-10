import { test } from "node:test";
import assert from "node:assert/strict";
import { worldProblems } from "../src/server/engine/scene-validation.js";
import { fixtureWorld, fixtureManuscript, fixtureScenes } from "./support/studio-fixtures.js";

test("pictures may include a known supporting character beyond the manuscript foreground cast", () => {
  const world = structuredClone(fixtureWorld);
  world.characters.push({...world.characters[0], id:"supporting",name:"Supporting relative"});
  const scenes = structuredClone(fixtureScenes);
  scenes.scenes[1].characterIds.push("supporting");
  assert.deepEqual(worldProblems(world,fixtureManuscript,scenes),[]);
  scenes.scenes[1].characterIds.push("unknown");
  assert.match(worldProblems(world,fixtureManuscript,scenes).join(" "),/Scene 2/);
});

test("missing required cast, duplicated identities and invalid objects remain blocking", () => {
  for (const change of [
    (s: typeof fixtureScenes) => { s.scenes[0].characterIds=[]; },
    (s: typeof fixtureScenes) => { s.scenes[0].characterIds.push(s.scenes[0].characterIds[0]); },
    (s: typeof fixtureScenes) => { s.scenes[0].objectIds.push("not-canon"); },
  ]) {
    const scenes=structuredClone(fixtureScenes);change(scenes);
    assert.match(worldProblems(fixtureWorld,fixtureManuscript,scenes).join(" "),/Scene 1/);
  }
});
