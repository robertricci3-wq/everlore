import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { hash, type Store } from "../store.js";

export class OpenAIConnectionError extends Error {}
const Key = z
  .string()
  .trim()
  .max(500)
  .regex(/^sk-[A-Za-z0-9_-]{20,}$/);
const Connection = z
  .object({
    ownerId: z.string().min(1),
    apiKey: z.string(),
    budgetCents: z.number().int().nonnegative(),
    audioReserve: z.number().int().nonnegative(),
    textReserve: z.number().int().nonnegative(),
    imageReserve: z.number().int().nonnegative(),
  })
  .passthrough();
const path = (store: Store) => join(store.dir, "studio-connection.json");
function saved(store: Store) {
  if (!existsSync(path(store)))
    throw new OpenAIConnectionError(
      "No saved story-studio connection exists. Configure the operator connection before replacing its key.",
    );
  if (lstatSync(path(store)).isSymbolicLink())
    throw new OpenAIConnectionError(
      "The connection file must be a private regular file.",
    );
  try {
    const raw = readFileSync(path(store), "utf8"),
      value = JSON.parse(raw) as unknown;
    if (!Connection.safeParse(value).success) throw new Error();
    return { raw, value: value as z.infer<typeof Connection> };
  } catch {
    throw new OpenAIConnectionError(
      "The saved story-studio settings could not be read. They were not changed.",
    );
  }
}
function noActiveJobs(store: Store) {
  if (
    store.one(
      "SELECT id FROM studio_jobs WHERE status IN ('queued','running') LIMIT 1",
    ) ||
    store.one(
      "SELECT id FROM engine_runs WHERE status IN ('queued','running') LIMIT 1",
    )
  )
    throw new OpenAIConnectionError(
      "Wait for active story work to reach a saved checkpoint before replacing the key.",
    );
}
export function savedOpenAIKey(store: Store) {
  return saved(store).value.apiKey;
}
export async function verifyOpenAIConnection(
  apiKey: string,
  model: string,
  request: typeof fetch = fetch,
) {
  const parsed = Key.safeParse(apiKey);
  if (!parsed.success)
    throw new OpenAIConnectionError(
      "Paste the complete OpenAI project API key. The key was not saved or sent.",
    );
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$/.test(model))
    throw new OpenAIConnectionError(
      "The configured text model is invalid. No request was sent.",
    );
  let response: Response;
  try {
    response = await request(
      `https://api.openai.com/v1/models/${encodeURIComponent(model)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${parsed.data}`,
          Accept: "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      },
    );
  } catch {
    throw new OpenAIConnectionError(
      "Could not reach OpenAI. No generation was requested and the saved connection was not changed.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new OpenAIConnectionError(
      response.status === 401
        ? "OpenAI rejected this key. Create a new project API key and paste it into this private prompt."
        : response.status === 403
          ? "OpenAI denied this key access. Check its project permissions; the saved connection was not changed."
          : response.status === 404
            ? "This key cannot access the configured text model. Check the project's model access; no model or budget was changed."
            : response.status === 429
              ? "OpenAI temporarily refused the verification request. Check the project's limits and try again later."
              : "OpenAI could not verify this key. No generation was requested and the saved connection was not changed.",
    );
  }
  try {
    const result = z
      .object({ object: z.literal("model"), id: z.string() })
      .parse(await response.json());
    if (result.id !== model) throw new Error();
  } catch {
    throw new OpenAIConnectionError(
      "OpenAI returned an unexpected model response. The key was not saved.",
    );
  }
  return {
    provider: "openai" as const,
    model,
    authenticated: true as const,
    checkedAt: new Date().toISOString(),
    generationStarted: false as const,
    billingVerified: false as const,
  };
}
// This replacement deliberately keeps every other field, including future
// settings unknown to this helper. It never creates ownership or spending rights.
export async function replaceOpenAIConnection(
  store: Store,
  apiKey: string,
  model: string,
  request: typeof fetch = fetch,
) {
  const before = saved(store);
  noActiveJobs(store);
  const checked = await verifyOpenAIConnection(apiKey, model, request);
  const temporary = join(
    store.dir,
    `studio-connection.json.${randomUUID()}.tmp`,
  );
  try {
    store.transaction(() => {
      if (saved(store).raw !== before.raw)
        throw new OpenAIConnectionError(
          "The connection changed while its key was being checked. Nothing was replaced; try again.",
        );
      noActiveJobs(store);
      const next = { ...before.value, apiKey: apiKey.trim() };
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(next));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      store.run(
        "INSERT OR REPLACE INTO studio_connection_checks VALUES(?,NULL,?)",
        hash(next.apiKey),
        checked.checkedAt,
      );
      renameSync(temporary, path(store));
    });
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return { ...checked, saved: true as const, restartRequired: true as const };
}
