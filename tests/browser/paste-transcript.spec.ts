import { test, expect, type Page, type Route } from "@playwright/test";

async function family(page: Page) {
  await page.goto("/#/join");
  await page
    .getByLabel("Shelf name")
    .fill(`paste transcript ${crypto.randomUUID()}`);
  await page
    .getByLabel("Password", { exact: true })
    .fill("Synthetic transcript password");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create your private shelf" }).click();
  await expect(
    page.getByRole("button", { name: "Paste a transcript", exact: true }),
  ).toBeVisible();
}

async function begin(page: Page, paste = true) {
  await family(page);
  const button = page.getByRole("button", {
    name: paste ? "Paste a transcript" : "Save a memory",
    exact: true,
  });
  await button.click();
  await page.getByRole("checkbox").check();
  await button.click();
  await expect(page).toHaveURL(/#\/tell\//);
  if (paste)
    await expect(page.getByLabel("Your words", { exact: true })).toBeFocused();
  else
    await expect(page.locator(".timer")).toHaveText("00:02", { timeout: 6000 });
  return page.url().split("/tell/")[1];
}

async function paste(page: Page, text: string) {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  const input = page.getByLabel("Your words", { exact: true });
  await input.focus();
  await input.press("ControlOrMeta+V");
  await expect(input).toHaveValue(text);
}

async function stored(page: Page, sid: string) {
  const result = await (
    await page.request.get(`/api/interviews/${sid}`)
  ).json();
  expect(result.transcriptionJobs).toHaveLength(0);
  const journey = await (await page.request.get(`/api/journey/${sid}`)).json();
  expect(journey.requestId).toBeNull();
  expect(journey.projectId).toBeNull();
  return result.session;
}

test("paste transcript stays readable on desktop and narrow screens", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const sid = await begin(page);
  await paste(
    page,
    "Nana carried the blue basket across the garden. We laughed all the way home.",
  );
  await expect(
    page.getByRole("status").filter({ hasText: "Draft saved on this device." }),
  ).toBeVisible();
  await page.screenshot({
    path: "work/evidence/paste-transcript-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("Your words", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save these words", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "work/evidence/paste-transcript-narrow.png",
    fullPage: true,
    animations: "disabled",
  });
  expect((await stored(page, sid)).turns[0].transcript).toBeNull();
});

test("paste without a microphone preserves a long transcript through rejection, reload and save", async ({
  page,
}) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new Error("This text-only path must not open a microphone.");
    };
  });
  const sid = await begin(page);
  // Approximately 2,500 words: a long telling, with paragraph/Unicode fidelity.
  const text = `  Nana said, “Let’s go home.” — café 🌿\n\n${Array.from({ length: 200 }, (_, i) => `Memory ${i}: we carried the blue basket across the garden together in spring.`).join("\n")}\n  `;
  await paste(page, text);
  await page.route("**/api/interviews/*/turns/*/text", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "Synthetic transcript save conflict." }),
    }),
  );
  await page
    .getByRole("button", { name: "Save these words", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Synthetic transcript save conflict.",
  );
  await expect(page.getByLabel("Your words", { exact: true })).toHaveValue(
    text,
  );
  await page.reload();
  await expect(page.getByLabel("Your words", { exact: true })).toHaveValue(
    text,
  );
  await page.unroute("**/api/interviews/*/turns/*/text");
  await page
    .getByRole("button", { name: "Save these words", exact: true })
    .click();
  await expect
    .poll(async () => (await stored(page, sid)).turns[0].transcript?.rawText)
    .toBe(text.trim());
  const session = await stored(page, sid);
  expect(session.turns).toHaveLength(1);
  expect(session.turns[0].audio).toBeNull();
  await page.reload();
  expect((await stored(page, sid)).turns[0].transcript.rawText).toBe(
    text.trim(),
  );
});

test("over-limit clipboard text is never truncated and a timed-out text save retains the corrected draft", async ({
  page,
}) => {
  const sid = await begin(page);
  const oversized = "Full pasted transcript. ".repeat(2300);
  await paste(page, oversized);
  await expect(page.getByRole("alert")).toContainText(
    "All your pasted words are still here",
  );
  await expect(
    page.getByRole("button", { name: "Save these words", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("status").filter({ hasText: "Draft saved on this device." }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Your words", { exact: true })).toHaveValue(
    oversized,
  );
  const corrected =
    "The complete first part is kept here. A second part can be saved separately.";
  await page.getByLabel("Your words", { exact: true }).fill(corrected);
  await page.clock.install();
  let writes = 0;
  let held: Route | undefined;
  await page.route("**/api/interviews/*/turns/*/text", (route) => {
    writes++;
    held = route;
  });
  await page
    .getByRole("button", { name: "Save these words", exact: true })
    .click();
  await expect.poll(() => writes).toBe(1);
  await page.clock.fastForward(15001);
  await expect(page.getByRole("alert")).toContainText(
    "Saving your words is taking too long.",
  );
  await expect(page.getByLabel("Your words", { exact: true })).toHaveValue(
    corrected,
  );
  expect(writes).toBe(1);
  expect((await stored(page, sid)).turns[0].transcript).toBeNull();
  await held?.abort().catch(() => undefined);
  await page.unroute("**/api/interviews/*/turns/*/text");
  await page.reload();
  await expect(page.getByLabel("Your words", { exact: true })).toHaveValue(
    corrected,
  );
  await page
    .getByRole("button", { name: "Save these words", exact: true })
    .click();
  await expect
    .poll(async () => (await stored(page, sid)).turns[0].transcript?.rawText)
    .toBe(corrected);
});

test("paused audio is saved before its same-turn transcript becomes editable", async ({
  page,
}) => {
  const sid = await begin(page, false);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByLabel("Your words", { exact: true })).toBeDisabled();
  await page.route(
    "**/api/interviews/*/turns/*/audio",
    (route) => route.abort(),
    { times: 1 },
  );
  await page
    .getByRole("button", {
      name: "Save recording and paste transcript",
      exact: true,
    })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Your draft is still here",
  );
  await expect(page.getByLabel("Your words", { exact: true })).toBeDisabled();
  expect((await stored(page, sid)).turns[0].audio).toBeNull();
  await page
    .getByRole("button", {
      name: "Save recording and paste transcript",
      exact: true,
    })
    .click();
  await expect(page.getByLabel("Your words", { exact: true })).toBeFocused();
  const before = await stored(page, sid);
  expect(before.turns[0].audio.bytes).toBeGreaterThan(44);
  const text =
    "  The transcript belongs to this original recording.\nEvery word remains mine.  ";
  await paste(page, text);
  await page
    .getByRole("button", { name: "Save these words", exact: true })
    .click();
  await expect
    .poll(async () => (await stored(page, sid)).turns[0].transcript?.rawText)
    .toBe(text.trim());
  const after = await stored(page, sid);
  expect(after.turns).toHaveLength(1);
  expect(after.turns[0].audio).toEqual(before.turns[0].audio);
  expect(after.turns[0].transcript.recordingId).toBe(
    before.turns[0].audio.recordingId,
  );
  await page.reload();
  expect((await stored(page, sid)).turns[0].audio).toEqual(
    before.turns[0].audio,
  );
});

test("an existing saved recording accepts a transcript without another recording or turn", async ({
  page,
}) => {
  const sid = await begin(page, false);
  await page
    .getByRole("button", { name: "Save for later", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "A memory, kept." }),
  ).toBeVisible();
  const before = await stored(page, sid);
  await page
    .getByRole("button", { name: "Paste a transcript", exact: true })
    .click();
  await expect(page.getByLabel("Your words", { exact: true })).toBeFocused();
  await paste(page, "Words for the recording I saved earlier.");
  await page
    .getByRole("button", { name: "Save these words", exact: true })
    .click();
  await expect
    .poll(async () => (await stored(page, sid)).turns[0].transcript?.rawText)
    .toBe("Words for the recording I saved earlier.");
  const after = await stored(page, sid);
  expect(after.turns).toHaveLength(1);
  expect(after.turns[0].audio).toEqual(before.turns[0].audio);
});

test("an accepted transcript with a lost reply reconciles without replay or a stuck draft guard", async ({
  page,
}) => {
  const sid = await begin(page);
  const text = "  These are my complete words, saved exactly once.  ";
  await paste(page, text);
  await page.clock.install();
  let writes = 0;
  let accepted = false;
  let held: Route | undefined;
  await page.route("**/api/interviews/*/turns/*/text", async (route) => {
    writes++;
    held = route;
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    accepted = true;
  });
  await page
    .getByRole("button", { name: "Save these words", exact: true })
    .click();
  await expect.poll(() => accepted).toBe(true);
  await page.clock.fastForward(15001);
  await expect(page.getByRole("alert")).toContainText(
    "Saving your words is taking too long.",
  );
  await page.clock.fastForward(2001);
  await expect(
    page.getByRole("button", { name: "Add something", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("Your words", { exact: true })).toHaveCount(0);
  await page.clock.fastForward(10001);
  expect(writes).toBe(1);
  expect((await stored(page, sid)).turns[0].transcript.rawText).toBe(
    text.trim(),
  );
  await held?.abort().catch(() => undefined);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Add something", exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel("Your words", { exact: true })).toHaveCount(0);
  expect(writes).toBe(1);
});

test("newer words survive a late confirmation and reload without changing the saved transcript", async ({
  page,
}) => {
  const sid = await begin(page);
  const submitted = "  The earlier version reached my shelf.  ";
  const newer = "The newer version is still an unsaved draft on this device.";
  await paste(page, submitted);
  await page.clock.install();
  let accepted = false;
  let writes = 0;
  let held: Route | undefined;
  await page.route("**/api/interviews/*/turns/*/text", async (route) => {
    writes++;
    held = route;
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    accepted = true;
  });
  await page
    .getByRole("button", { name: "Save these words", exact: true })
    .click();
  await expect.poll(() => accepted).toBe(true);
  await page.clock.fastForward(15001);
  await expect(page.getByRole("alert")).toContainText(
    "Saving your words is taking too long.",
  );
  await page.getByLabel("Your words", { exact: true }).fill(newer);
  await expect(
    page.getByRole("status").filter({ hasText: "Draft saved on this device." }),
  ).toBeVisible();
  await page.clock.fastForward(2001);
  await expect(
    page.getByRole("status").filter({
      hasText:
        "Your earlier words were saved. Your newer edits are still only on this device.",
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Your words", { exact: true })).toHaveValue(
    newer,
  );
  await expect(
    page.getByRole("button", { name: "Add something", exact: true }),
  ).toBeDisabled();
  expect((await stored(page, sid)).turns[0].transcript.rawText).toBe(
    submitted.trim(),
  );
  await held?.abort().catch(() => undefined);
  await page.reload();
  await expect(page.getByLabel("Your words", { exact: true })).toHaveValue(
    newer,
  );
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "They have not replaced the saved transcript." }),
  ).toBeVisible();
  expect(writes).toBe(1);
  await page
    .getByRole("button", { name: "Discard these unsaved words", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Add something", exact: true }),
  ).toBeEnabled();
  expect((await stored(page, sid)).turns[0].transcript.rawText).toBe(
    submitted.trim(),
  );
});

test("Unicode text beyond the JSON byte limit stays intact and cannot send a misleading oversized request", async ({
  page,
}) => {
  const sid = await begin(page);
  const text = "家".repeat(40000);
  let writes = 0;
  await page.route("**/api/interviews/*/turns/*/text", (route) => {
    writes++;
    return route.continue();
  });
  await paste(page, text);
  await expect(page.getByRole("alert")).toContainText(
    "too large to save as one part",
  );
  await expect(
    page.getByRole("button", { name: "Save these words", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("status").filter({ hasText: "Draft saved on this device." }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Your words", { exact: true })).toHaveValue(
    text,
  );
  expect(writes).toBe(0);
  expect((await stored(page, sid)).turns[0].transcript).toBeNull();
});
