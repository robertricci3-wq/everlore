import { existsSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/server/store.js";
import { engineConfig } from "../src/server/engine/provider.js";
import { loadStudioConnection } from "../src/server/engine/setup.js";
import {
  OpenAIConnectionError,
  replaceOpenAIConnection,
  savedOpenAIKey,
  verifyOpenAIConnection,
} from "../src/server/engine/connection.js";

async function readKey(): Promise<string> {
  if (process.env.EVERLORE_NEW_OPENAI_API_KEY !== undefined)
    return process.env.EVERLORE_NEW_OPENAI_API_KEY.trim();
  if (!process.stdin.isTTY) {
    let value = "";
    for await (const chunk of process.stdin) {
      value += chunk;
      if (value.length > 501)
        throw new OpenAIConnectionError(
          "The pasted key is too long. No key was saved.",
        );
    }
    return value.trim();
  }
  process.stdout.write(
    "New OpenAI project API key (hidden; press Enter when pasted): ",
  );
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      process.stdin.off("data", onData);
      process.off("SIGTERM", abort);
      process.off("SIGINT", abort);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const abort = () => {
      finish();
      reject(
        new OpenAIConnectionError(
          "Key entry cancelled. The saved connection was not changed.",
        ),
      );
    };
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003" || character === "\u0004") {
          abort();
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          resolve(value.trim());
          return;
        }
        if (character === "\u007f" || character === "\b")
          value = value.slice(0, -1);
        else if (value.length < 501) value += character;
      }
    };
    process.once("SIGTERM", abort);
    process.once("SIGINT", abort);
    process.stdin.on("data", onData);
  });
}
let store: Store | undefined;
try {
  const [command, ...extra] = process.argv.slice(2);
  if (extra.length || !["connect", "check"].includes(command ?? ""))
    throw new OpenAIConnectionError(
      "Use openai connect, or openai check. Never pass an API key as a command argument.",
    );
  const directory = process.env.DATA_DIR ?? ".data";
  if (!existsSync(join(directory, "studio-connection.json")))
    throw new OpenAIConnectionError(
      "No saved story-studio connection was found. Check DATA_DIR before continuing.",
    );
  store = new Store(directory);
  const config = engineConfig();
  loadStudioConnection(store, config);
  if (command === "connect") {
    const result = await replaceOpenAIConnection(
      store,
      await readKey(),
      config.textModel,
    );
    console.log(JSON.stringify(result));
    console.log(
      "Your key is saved privately. Existing ownership, models, allowances and stories are unchanged. Restart Everlore to load the new key; this did not run or retry a story.",
    );
  } else
    console.log(
      JSON.stringify(
        await verifyOpenAIConnection(savedOpenAIKey(store), config.textModel),
      ),
    );
} catch (error) {
  console.error(
    error instanceof OpenAIConnectionError
      ? error.message
      : "The private OpenAI connection could not be updated. Existing work is preserved.",
  );
  process.exitCode = 1;
} finally {
  store?.close();
}
