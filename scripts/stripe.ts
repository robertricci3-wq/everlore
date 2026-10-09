import {
  loadStripeConnection,
  StripeConnectionError,
  saveVerifiedStripeConnection,
  verifyStripeConnection,
} from "../src/server/payments/connection.js";

// Credentials are read from hidden terminal input or stdin, never command arguments.
async function readKey(): Promise<string> {
  if (!process.stdin.isTTY) {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    return input.trim();
  }
  process.stdout.write("Stripe API key (hidden): ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          finish();
          reject(new StripeConnectionError("Connection entry cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          resolve(value.trim());
          return;
        }
        if (character === "\u007f" || character === "\b")
          value = value.slice(0, -1);
        else if (value.length < 500) value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}

try {
  const [command] = process.argv.slice(2);
  const directory = process.env.DATA_DIR ?? ".data";
  if (command === "connect") {
    const result = await saveVerifiedStripeConnection(
      directory,
      await readKey(),
    );
    console.log(JSON.stringify({ ...result, saved: true }));
  } else if (command === "check") {
    const saved = loadStripeConnection(directory);
    if (!saved)
      throw new StripeConnectionError("No Stripe connection has been saved.");
    console.log(JSON.stringify(await verifyStripeConnection(saved.apiKey)));
  } else
    throw new StripeConnectionError("Use stripe connect, or stripe check.");
} catch (error) {
  console.error(
    error instanceof StripeConnectionError
      ? error.message
      : "The private Stripe connection could not be saved.",
  );
  process.exitCode = 1;
}
