import { z } from "zod";
import { canonical, hash, id, now, type Store } from "../store.js";
import {
  VisualWorld,
  ProductionSnapshot,
  type Snapshot,
} from "../../shared/studio.js";
import { Transcript, type TranscriptDocument } from "../../shared/contracts.js";
import {
  PinnedContinuity,
  type ContinuityMode,
  type ContinuityQuestion,
  type ContinuityState,
} from "../../shared/continuity.js";

type Character = Snapshot["world"]["characters"][number];
interface Evidence {
  sourceHash: string;
  sourceId: string;
  quote: string;
}
interface Binding {
  characterId: string;
  personId: string | null;
  evidence: Evidence;
  remember?: boolean;
}
export interface ContinuityFamily {
  id: string;
  world: Snapshot["world"];
  references: Snapshot["references"];
}
export interface ContinuityResolution {
  world: Snapshot["world"];
  bindings: Binding[];
  question: ContinuityQuestion | null;
  referenceFamilies: ContinuityFamily[];
  reuseFamilyVersionId: string | null;
}
const normalized = (value: string) =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
function evidenceFor(
  source: TranscriptDocument,
  name: string,
): Evidence | null {
  const needle = ` ${normalized(name)} `;
  if (!needle.trim()) return null;
  const segment = source.segments.find((s) =>
    ` ${normalized(s.text)} `.includes(needle),
  );
  return segment
    ? {
        sourceHash: hash(canonical(source)),
        sourceId: segment.id,
        quote: segment.text,
      }
    : null;
}

export function continuityFamilies(
  store: Store,
  ownerId: string,
  pin: PinnedContinuity,
): ContinuityFamily[] {
  return PinnedContinuity.parse(pin).familyVersionIds.map((familyId) => {
    const row = store.one<{ world: string; referenceData: string }>(
      "SELECT world,referenceData FROM family_versions WHERE id=? AND ownerId=?",
      familyId,
      ownerId,
    );
    if (!row)
      throw new Error("That saved family is not available on your shelf.");
    const world = VisualWorld.parse(JSON.parse(row.world));
    const references = ProductionSnapshot.shape.references.parse(
      JSON.parse(row.referenceData),
    );
    if (
      !references.length ||
      references.some(
        (r) =>
          !r.approved ||
          !store.one(
            "SELECT hash FROM family_assets WHERE familyId=? AND hash=?",
            familyId,
            r.hash,
          ),
      )
    )
      throw new Error(
        "This family does not have approved character references.",
      );
    return { id: familyId, world, references };
  });
}

/** Pin IDs, never a moving latest-family query, at the family's creation action. */
export function pinStudioContinuity(
  store: Store,
  ownerId: string,
  mode: ContinuityMode,
  familyVersionId?: string | null,
): PinnedContinuity {
  if (mode === "new") return { mode, familyVersionIds: [] };
  const ids =
    mode === "specific"
      ? [familyVersionId || ""]
      : store
          .all<{ id: string }>(
            `SELECT f.id FROM family_versions f WHERE f.ownerId=?
        ORDER BY (SELECT MAX(j.rowid) FROM studio_jobs j JOIN projects p ON p.id=j.projectId
        WHERE p.ownerId=f.ownerId AND json_extract(j.state,'$.familyVersionId')=f.id) DESC, f.rowid DESC LIMIT 200`,
            ownerId,
          )
          .map((f) => f.id);
  const approved: string[] = [];
  for (const candidate of ids) {
    try {
      continuityFamilies(store, ownerId, {
        mode,
        familyVersionIds: [candidate],
      });
      approved.push(candidate);
    } catch (error) {
      if (
        mode === "specific" ||
        !(error instanceof Error) ||
        error.message !==
          "This family does not have approved character references."
      )
        throw error;
      // An unapproved/review-only legacy snapshot is never reusable canon.
    }
  }
  return { mode, familyVersionIds: approved };
}

/** Index only exact source-evidenced names. Relationship text stays in the book. */
export function rememberContinuityCast(
  store: Store,
  ownerId: string,
  familyVersionId: string,
  world: Snapshot["world"],
  source: TranscriptDocument,
  bindings: Binding[] = [],
) {
  for (const character of world.characters) {
    if (
      bindings.find((b) => b.characterId === character.id)?.remember === false
    )
      continue;
    const evidence = evidenceFor(source, character.name);
    if (
      !evidence ||
      store.one(
        "SELECT personId FROM continuity_cast WHERE familyVersionId=? AND characterId=?",
        familyVersionId,
        character.id,
      )
    )
      continue;
    const assigned = bindings.find(
      (b) => b.characterId === character.id,
    )?.personId;
    const personId = assigned ?? id();
    if (
      assigned &&
      !store.one(
        "SELECT id FROM continuity_people WHERE id=? AND ownerId=?",
        assigned,
        ownerId,
      )
    )
      throw new Error("Character identity belongs to another shelf.");
    if (!assigned)
      store.run(
        "INSERT INTO continuity_people VALUES(?,?,?,?,?)",
        personId,
        ownerId,
        character.name,
        normalized(character.name),
        now(),
      );
    store.run(
      "INSERT OR IGNORE INTO continuity_origins VALUES(?,?,?)",
      ownerId,
      personId,
      personId,
    );
    store.run(
      "INSERT INTO continuity_cast VALUES(?,?,?,?)",
      familyVersionId,
      character.id,
      personId,
      JSON.stringify(evidence),
    );
  }
  store.run(
    "INSERT OR IGNORE INTO continuity_indexed_versions VALUES(?)",
    familyVersionId,
  );
}

/** Legacy evidence is read from immutable completed books, never invented from art. */
export function indexPriorContinuity(
  store: Store,
  ownerId: string,
  families: ContinuityFamily[],
) {
  for (const family of families) {
    if (
      store.one(
        "SELECT familyVersionId FROM continuity_indexed_versions WHERE familyVersionId=?",
        family.id,
      )
    )
      continue;
    const row = store.one<{ book: string }>(
      `SELECT r.book FROM revisions r JOIN projects p ON p.id=r.projectId
      WHERE p.ownerId=? AND json_extract(r.book,'$.production.familyVersionId')=? ORDER BY r.revision DESC LIMIT 1`,
      ownerId,
      family.id,
    );
    if (!row) continue;
    const book = JSON.parse(row.book) as { transcript?: TranscriptDocument };
    if (book.transcript)
      rememberContinuityCast(
        store,
        ownerId,
        family.id,
        family.world,
        book.transcript,
      );
  }
}

function explicitAge(
  source: TranscriptDocument,
  character: Character,
): boolean {
  if (character.depictedAge === null) return false;
  const name = character.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `\\b${name}\\s+(?:was|is|aged|turned|at)\\s+(?:age\\s+)?(?:just\\s+|only\\s+)?${character.depictedAge}\\b`,
    "iu",
  ).test(source.rawText);
}

function identityUncertainOrDistinct(quote: string, name: string) {
  const text = normalized(quote);
  const n = normalized(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    /\b(?:maybe|perhaps|not sure|might|may have|i think|i believe|i guess|cannot remember|can t remember)\b/.test(
      text,
    ) ||
    quote.includes("?") ||
    /\b(?:different person|another person|separate person|unrelated person|namesake|same name|looked like)\b/.test(
      text,
    ) ||
    new RegExp(
      `\\b(?:different|another|other|second|separate|unrelated|not the same)\\s+(?:(?:person|cousin|relative|friend)\\s+(?:named|called)\\s+)?${n}\\b`,
    ).test(text) ||
    new RegExp(
      `\\b${n}\\b.{0,30}\\b(?:different person|someone else|not the same|not my|not our|wasn t|isn t)\\b`,
    ).test(text) ||
    new RegExp(
      `\\b(?:not|never|isn t|wasn t)\\s+(?:(?:my|our|his|her|their)\\s+\\w+\\s+)?${n}\\b`,
    ).test(text)
  );
}

/** Directly stated role only: never 'Nell waited while her cousin arrived'. */
function relationshipAnchor(
  quote: string,
  name: string,
  relationship: string,
): string | null {
  if (identityUncertainOrDistinct(quote, name)) return null;
  const role = normalized(relationship);
  if (
    !/^(?:mother|father|grandmother|grandfather|grandma|grandpa|aunt|uncle|cousin|sister|brother|daughter|son|granddaughter|grandson|grandchild|niece|nephew|wife|husband|spouse|friend|neighbor|neighbour)$/.test(
      role,
    )
  )
    return null;
  const n = normalized(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const text = normalized(quote);
  const before = new RegExp(
    `\\b(my|our|his|her|their)\\s+${role}\\s+${n}\\b`,
  ).exec(text);
  const after = new RegExp(
    `\\b${n}\\s+(?:(?:is|was)\\s+)?(my|our|his|her|their)\\s+${role}\\b(?!\\s+s\\b)`,
  ).exec(text);
  const match = before ?? after;
  return match ? `${match[1]} ${role}` : null;
}

/** Match people conservatively; only artistic descriptors are inherited. */
export function resolveContinuity(
  store: Store,
  ownerId: string,
  pin: PinnedContinuity,
  candidate: Snapshot["world"],
  source: TranscriptDocument,
  state: ContinuityState,
): ContinuityResolution {
  const families = continuityFamilies(store, ownerId, pin);
  indexPriorContinuity(store, ownerId, families);
  const usedFamilies = new Map<string, ContinuityFamily>();
  const bindings: Binding[] = [];
  let question: ContinuityQuestion | null = null;
  let changed = false;
  const characters = candidate.characters.map((character) => {
    const evidence = evidenceFor(source, character.name);
    if (!evidence) {
      changed = true;
      return character;
    }
    const matches = families.flatMap((family) =>
      family.world.characters.flatMap((old) => {
        if (normalized(old.name) !== normalized(character.name)) return [];
        const identity = store.one<{ personId: string; evidence: string }>(
          `SELECT c.personId,c.evidence FROM continuity_cast c JOIN continuity_people p ON p.id=c.personId
        WHERE c.familyVersionId=? AND c.characterId=? AND p.ownerId=?`,
          family.id,
          old.id,
          ownerId,
        );
        return identity
          ? [
              {
                family,
                old,
                personId: identity.personId,
                evidence: JSON.parse(identity.evidence) as Evidence,
              },
            ]
          : [];
      }),
    );
    // Prefer an already approved depiction at the explicitly remembered age.
    if (explicitAge(source, character))
      matches.sort(
        (a, b) =>
          Number(b.old.depictedAge === character.depictedAge) -
          Number(a.old.depictedAge === character.depictedAge),
      );
    const unique = matches.filter(
      (m, i) =>
        matches.findIndex((other) => other.personId === m.personId) === i,
    );
    const qid = `identity-${hash(canonical({ source: evidence.sourceHash, id: character.id })).slice(0, 20)}`;
    const response = state.responses[qid];
    let match = response
      ? matches.find((m) => m.personId === response.answerId)
      : undefined;
    if (
      !response &&
      unique.length === 1 &&
      normalized(unique[0].old.relationship) ===
        normalized(character.relationship) &&
      !identityUncertainOrDistinct(evidence.quote, character.name) &&
      !identityUncertainOrDistinct(unique[0].evidence.quote, character.name) &&
      (unique[0].evidence.sourceHash === evidence.sourceHash ||
        (relationshipAnchor(
          evidence.quote,
          character.name,
          character.relationship,
        ) !== null &&
          relationshipAnchor(
            evidence.quote,
            character.name,
            character.relationship,
          ) ===
            relationshipAnchor(
              unique[0].evidence.quote,
              character.name,
              unique[0].old.relationship,
            )))
    )
      match = unique[0];
    if (!response && unique.length && !match) {
      question ??= {
        id: qid,
        kind: "identity",
        prompt: `Who is ${character.name} in this memory?`,
        options: [
          ...unique.map((m) => {
            const book = store.one<{ title: string }>(
              `SELECT json_extract(r.book,'$.title') AS title FROM revisions r JOIN projects p ON p.id=r.projectId
              WHERE p.ownerId=? AND json_extract(r.book,'$.production.familyVersionId')=? ORDER BY r.rowid DESC LIMIT 1`,
              ownerId,
              m.family.id,
            );
            const at = Math.max(
              0,
              m.evidence.quote
                .toLocaleLowerCase()
                .indexOf(m.old.name.toLocaleLowerCase()) - 35,
            );
            const excerpt = `${at ? "…" : ""}${m.evidence.quote.slice(at, at + 150)}${m.evidence.quote.length > at + 150 ? "…" : ""}`;
            return {
              id: m.personId,
              label: `${m.old.name} — ${m.old.relationship}`,
              detail: `${book?.title ?? m.family.world.name} (${m.old.species}).${excerpt ? ` “${excerpt}”` : " Saved character reference; its original memory was removed."}`,
            };
          }),
          { id: "new", label: "Someone else" },
        ],
        allowUnspecified: true,
      };
    }
    if (!match) {
      changed = true;
      bindings.push({
        characterId: character.id,
        personId: null,
        evidence,
        remember: response?.answerId !== "unspecified",
      });
      return character;
    }
    usedFamilies.set(match.family.id, match.family);
    const ageChanged =
      explicitAge(source, character) &&
      character.depictedAge !== match.old.depictedAge;
    const merged = ageChanged
      ? {
          ...match.old,
          ageState: character.ageState,
          depictedAge: character.depictedAge,
          proportions: character.proportions,
          relationship: character.relationship,
        }
      : { ...match.old, relationship: character.relationship };
    changed ||= canonical(merged) !== canonical(match.old);
    bindings.push({
      characterId: merged.id,
      personId: match.personId,
      evidence,
    });
    return merged;
  });
  if (new Set(characters.map((c) => c.id)).size !== characters.length)
    throw new Error(
      "This memory has overlapping character identities. Its source and progress are saved.",
    );
  const referenceFamilies = [...usedFamilies.values()];
  return {
    world: VisualWorld.parse({
      ...candidate,
      ...(referenceFamilies[0]
        ? {
            palette: referenceFamilies[0].world.palette,
            worldRules: referenceFamilies[0].world.worldRules,
          }
        : {}),
      characters,
    }),
    bindings,
    question,
    referenceFamilies,
    reuseFamilyVersionId:
      !changed && referenceFamilies.length === 1
        ? referenceFamilies[0].id
        : null,
  };
}

export function inheritedContinuityBindings(
  store: Store,
  familyVersionId: string | null | undefined,
  world: Snapshot["world"],
  source: TranscriptDocument,
): Binding[] {
  if (!familyVersionId) return [];
  return world.characters.flatMap((character) => {
    const evidence = evidenceFor(source, character.name);
    const prior = store.one<{ personId: string }>(
      "SELECT personId FROM continuity_cast WHERE familyVersionId=? AND characterId=?",
      familyVersionId,
      character.id,
    );
    return evidence && prior
      ? [{ characterId: character.id, personId: prior.personId, evidence }]
      : [];
  });
}

export function rememberStoryContinuity(
  store: Store,
  projectId: string,
  revision: number,
  familyVersionId: string,
  world: Snapshot["world"],
) {
  for (const character of world.characters) {
    const identity = store.one<{ personId: string }>(
      "SELECT personId FROM continuity_cast WHERE familyVersionId=? AND characterId=?",
      familyVersionId,
      character.id,
    );
    if (identity)
      store.run(
        "INSERT OR IGNORE INTO continuity_story_uses VALUES(?,?,?,?,?)",
        projectId,
        revision,
        identity.personId,
        familyVersionId,
        character.id,
      );
  }
}

export const ContinuityAnswer = z.object({
  questionId: z.string().min(1),
  key: z.string().uuid(),
  answerId: z.string().min(1),
  text: z.string().trim().max(1500).optional(),
});

export const ContinuityArchive = z
  .array(
    z.object({
      identityId: z.string().min(1),
      characterId: z.string().min(1),
      name: z.string().min(1),
      evidence: z.object({
        sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
        sourceId: z.string().min(1),
        quote: z.string().min(1),
      }),
    }),
  )
  .max(5);

export function exportContinuityArchive(
  store: Store,
  ownerId: string,
  projectId: string,
  familyVersionId: string | null,
  world: Snapshot["world"],
  source: TranscriptDocument,
) {
  if (
    familyVersionId &&
    store.one(
      "SELECT id FROM family_versions WHERE id=? AND ownerId=?",
      familyVersionId,
      ownerId,
    ) &&
    !store.one(
      "SELECT familyVersionId FROM continuity_indexed_versions WHERE familyVersionId=?",
      familyVersionId,
    )
  )
    rememberContinuityCast(store, ownerId, familyVersionId, world, source);
  return world.characters.flatMap((character) => {
    const evidence = evidenceFor(source, character.name);
    const record = store.one<{ personId: string; originalId: string }>(
      `SELECT c.personId, COALESCE(o.originalId,c.personId) AS originalId
      FROM continuity_cast c JOIN continuity_people p ON p.id=c.personId
      LEFT JOIN continuity_origins o ON o.personId=p.id AND o.ownerId=p.ownerId
      WHERE p.ownerId=? AND c.characterId=? AND (c.familyVersionId=? OR EXISTS(
        SELECT 1 FROM continuity_story_uses u WHERE u.projectId=? AND u.familyVersionId=c.familyVersionId AND u.characterId=c.characterId))
      ORDER BY o.rowid LIMIT 1`,
      ownerId,
      character.id,
      familyVersionId,
      projectId,
    );
    return record && evidence
      ? [
          {
            identityId: record.originalId,
            characterId: character.id,
            name: character.name,
            evidence,
          },
        ]
      : [];
  });
}

export function validateContinuityArchive(
  records: z.infer<typeof ContinuityArchive>,
  world: Snapshot["world"] | undefined,
  source: TranscriptDocument | undefined,
) {
  if (!world || !source)
    throw new Error("Character continuity needs its original source and cast.");
  if (
    new Set(records.map((r) => r.characterId)).size !== records.length ||
    new Set(records.map((r) => r.identityId)).size !== records.length
  )
    throw new Error("Duplicate character continuity evidence.");
  for (const record of records) {
    const character = world.characters.find((c) => c.id === record.characterId);
    if (
      !character ||
      character.name !== record.name ||
      canonical(evidenceFor(source, record.name)) !== canonical(record.evidence)
    )
      throw new Error("Character continuity is not supported by this source.");
  }
}

export function restoreContinuityArchive(
  store: Store,
  ownerId: string,
  familyVersionId: string,
  records: z.infer<typeof ContinuityArchive>,
) {
  for (const record of records) {
    const existing = store.one<{ personId: string; normalizedName: string }>(
      `SELECT o.personId,p.normalizedName FROM continuity_origins o JOIN continuity_people p ON p.id=o.personId
      WHERE o.ownerId=? AND o.originalId=? AND p.ownerId=?`,
      ownerId,
      record.identityId,
      ownerId,
    );
    if (existing && existing.normalizedName !== normalized(record.name))
      throw new Error(
        "Restored character provenance conflicts with this shelf.",
      );
    const personId = existing?.personId ?? id();
    if (!existing) {
      store.run(
        "INSERT INTO continuity_people VALUES(?,?,?,?,?)",
        personId,
        ownerId,
        record.name,
        normalized(record.name),
        now(),
      );
      store.run(
        "INSERT INTO continuity_origins VALUES(?,?,?)",
        ownerId,
        record.identityId,
        personId,
      );
    }
    store.run(
      "INSERT INTO continuity_cast VALUES(?,?,?,?)",
      familyVersionId,
      record.characterId,
      personId,
      JSON.stringify(record.evidence),
    );
  }
  store.run(
    "INSERT OR IGNORE INTO continuity_indexed_versions VALUES(?)",
    familyVersionId,
  );
}

/** Called in the project's deletion transaction. Never retains an erased excerpt. */
export function forgetProjectContinuity(store: Store, projectId: string) {
  const project = store.one<{ ownerId: string; transcript: string | null }>(
    "SELECT ownerId,transcript FROM projects WHERE id=?",
    projectId,
  );
  if (!project) return;
  const removedHashes = new Set<string>();
  const storedRecord = (text: string): Record<string, unknown> | null => {
    try {
      const parsed: unknown = JSON.parse(text);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      // Old/minimized records can contain plain text. They must never make a
      // family's delete action fail or be treated as structured source proof.
      return null;
    }
  };
  const rememberHash = (value: unknown) => {
    const transcript = Transcript.safeParse(value);
    if (transcript.success) removedHashes.add(hash(canonical(transcript.data)));
  };
  if (project.transcript) rememberHash(storedRecord(project.transcript));
  for (const row of store.all<{ state: string }>(
    "SELECT state FROM studio_jobs WHERE projectId=?",
    projectId,
  ))
    rememberHash(storedRecord(row.state)?.source);
  for (const row of store.all<{ book: string }>(
    "SELECT book FROM revisions WHERE projectId=?",
    projectId,
  ))
    rememberHash(storedRecord(row.book)?.transcript);
  if (!removedHashes.size) return;
  const links = store.all<{
    familyVersionId: string;
    characterId: string;
    personId: string;
    name: string;
    evidence: string;
  }>(
    `SELECT c.familyVersionId,c.characterId,c.personId,p.name,c.evidence
    FROM continuity_cast c JOIN continuity_people p ON p.id=c.personId WHERE p.ownerId=?`,
    project.ownerId,
  );
  const affectedPeople = new Set<string>();
  for (const link of links) {
    const evidence = JSON.parse(link.evidence) as Evidence;
    if (!removedHashes.has(evidence.sourceHash)) continue;
    affectedPeople.add(link.personId);
    const survivors = store.all<{ book: string }>(
      `SELECT r.book FROM revisions r JOIN projects p ON p.id=r.projectId
      WHERE p.ownerId=? AND p.id!=? AND (CASE WHEN json_valid(r.book) THEN json_extract(r.book,'$.sourceHash') END=? OR EXISTS (
        SELECT 1 FROM continuity_story_uses u WHERE u.projectId=r.projectId AND u.revision=r.revision AND u.personId=?))
      ORDER BY r.rowid DESC`,
      project.ownerId,
      projectId,
      evidence.sourceHash,
      link.personId,
    );
    let replacement: Evidence | null = null;
    for (const survivor of survivors) {
      const transcript = Transcript.safeParse(
        storedRecord(survivor.book)?.transcript,
      );
      if (transcript.success)
        replacement = evidenceFor(transcript.data, link.name);
      if (replacement) break;
    }
    // Keep the approved visual identity, but no quote or recoverable source
    // pointer. Future reuse needs the family's explicit identity answer.
    store.run(
      "UPDATE continuity_cast SET evidence=? WHERE familyVersionId=? AND characterId=?",
      JSON.stringify(
        replacement ?? { sourceHash: "", sourceId: "", quote: "" },
      ),
      link.familyVersionId,
      link.characterId,
    );
    store.run(
      "INSERT OR IGNORE INTO continuity_indexed_versions VALUES(?)",
      link.familyVersionId,
    );
  }
  // A question is a private saved snapshot too. Remove copies of the earlier
  // source excerpt without changing its choices, saved answers, or job state.
  if (affectedPeople.size) {
    for (const row of store.all<{ id: string; state: string }>(
      `SELECT j.id,j.state FROM studio_jobs j JOIN projects p ON p.id=j.projectId WHERE p.ownerId=? AND p.id!=?`,
      project.ownerId,
      projectId,
    )) {
      const state = storedRecord(row.state);
      const continuity = state?.continuity as
        | { questions?: { options?: { id?: string; detail?: string }[] }[] }
        | undefined;
      if (!Array.isArray(continuity?.questions)) continue;
      let changed = false;
      for (const question of continuity.questions) {
        if (!Array.isArray(question.options)) continue;
        for (const option of question.options) {
          if (
            option.id &&
            affectedPeople.has(option.id) &&
            typeof option.detail === "string"
          ) {
            delete option.detail;
            changed = true;
          }
        }
      }
      if (changed)
        store.run(
          "UPDATE studio_jobs SET state=? WHERE id=?",
          JSON.stringify(state),
          row.id,
        );
    }
  }
}
