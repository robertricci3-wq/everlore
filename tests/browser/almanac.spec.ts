import { test, expect, type Page } from "@playwright/test";
import { ALMANAC_CHAPTERS, ALMANAC_PAGES } from "../../src/shared/almanac.js";

async function family(page: Page) {
  await page.goto("/#/join");
  await page.getByLabel("Shelf name").fill(`almanac ${Date.now()}`);
  await page
    .getByLabel("Password", { exact: true })
    .fill("A synthetic private password");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create your private shelf" }).click();
  await expect(
    page.getByRole("heading", { name: "Your family, in stories." }),
  ).toBeVisible();
}
async function begin(page: Page) {
  await page.goto("/#/memory/people-how-we-met");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Let’s begin", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Start telling", exact: true }),
  ).toBeEnabled();
}
test("almanac: 32 invitations, recoverable text, finished telling, hidden pages and immutable source", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await family(page);
  await expect(
    page.getByRole("link", { name: "Tell this memory" }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "The day we met", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".almanac-overview")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Arrange your topics" }),
  ).not.toBeVisible();
  await expect(page.getByRole("link", { name: "Studio tools" })).toHaveCount(0);
  await page.screenshot({
    path: "work/evidence/simple-family-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Try another idea" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Something from our kitchen",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "work/evidence/simple-family-phone.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByText("Find a different memory", { exact: true }).click();
  await expect(page.locator(".almanac-overview>section")).toHaveCount(8);
  await expect(page.locator(".almanac-overview a")).toHaveCount(32);
  for (const chapter of ALMANAC_CHAPTERS)
    await expect(
      page
        .locator(".almanac-overview")
        .getByRole("heading", { name: chapter.title }),
    ).toBeVisible();
  await page.screenshot({
    path: "work/evidence/almanac-desktop.png",
    fullPage: true,
  });
  await begin(page);
  await page
    .getByText("Prefer to add the words yourself?", { exact: true })
    .click();
  const source =
    "One day I met my cousin at the pond. We floated a blue tin with paper sails. It mattered to me because we made something together.";
  await page.getByLabel("Your words", { exact: true }).fill(source);
  await expect(
    page.getByRole("button", { name: "Skip this question" }),
  ).toBeDisabled();
  await page.reload();
  await expect(page.getByLabel("Your words", { exact: true })).toHaveValue(
    source,
  );
  await page
    .getByRole("button", { name: "Save these words", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Make my story", exact: true }),
  ).toBeVisible();
  const sessionId = page.url().split("/interview/")[1];
  const before = await (
    await page.request.get(`/api/interviews/${sessionId}`)
  ).json();
  expect(before.session.turns[0].transcript.rawText).toBe(source);
  await page.request.post(`/api/interviews/${sessionId}/finish`, {
    headers: { "X-Evermore-Client": "1" },
    data: {},
  });
  await page.goto("/#/shelf");
  await expect(
    page.getByRole("heading", { name: "Continue your story." }),
  ).toBeVisible();
  await page.locator(".almanac-drafts a").first().click();
  await expect(
    page.getByText("This telling is saved.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("checkbox").last().check();
  await page
    .getByRole("button", { name: "Make my story", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Your memory is saved");
  await page
    .getByRole("button", { name: "Make my story", exact: true })
    .click();
  const after = await (
    await page.request.get(`/api/interviews/${sessionId}`)
  ).json();
  expect(after.sourceRevisions).toHaveLength(1);
  expect(after.session.turns[0].transcript.rawText).toBe(source);
  await page.goto("/#/shelf");
  await page.getByText("Personalize your collection", { exact: true }).click();
  await page.getByRole("button", { name: "Arrange your topics" }).click();
  const topic = ALMANAC_PAGES[0].title;
  await page
    .getByRole("button", { name: `Hide ${topic}`, exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: `Restore ${topic}`, exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: `Restore ${topic}`, exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: `Hide ${topic}`, exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  expect(await page.locator("main").innerText()).not.toMatch(
    /API key|Save connection|spending allowance/,
  );
});

test("voice almanac: interrupted upload resumes same answer and never loses an earlier turn", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await family(page);
  await begin(page);
  await page
    .getByRole("button", { name: "Start telling", exact: true })
    .click();
  await expect(page.locator(".timer")).toHaveText("00:02", { timeout: 6000 });
  await expect(
    page.getByRole("button", { name: "Skip this question" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.getByRole("button", { name: "Finish this part" }).click();
  await page.route("**/api/interviews/*/turns/*/audio", (route) =>
    route.request().method() === "PUT"
      ? route.abort("failed")
      : route.continue(),
  );
  await page
    .getByRole("button", { name: "Save this part", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Your draft is still here",
  );
  await page.unroute("**/api/interviews/*/turns/*/audio");
  await page.reload();
  await expect(
    page.getByText("Your unsaved recording is still here on this device."),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Save this part", exact: true })
    .click();
  await expect(page.getByLabel("Your saved answer")).toBeVisible();
  const sid = page.url().split("/interview/")[1];
  const session = await (
    await page.request.get(`/api/interviews/${sid}`)
  ).json();
  expect(session.session.turns).toHaveLength(1);
  expect(session.session.turns[0].audio.bytes).toBeGreaterThan(44);
  expect(session.transcriptionJobs).toHaveLength(0); // disabled production provider, no fake transcription
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "work/evidence/almanac-voice-mobile.png",
    fullPage: true,
  });
  await page.goto("/#/reading");
  await expect(
    page.getByRole("heading", { name: "A little world to return to." }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Your stories will live here." }),
  ).toBeVisible();
});

test("a spoken-page naming session is recoverable and has a typed fallback", async ({
  page,
}) => {
  await family(page);
  await page.getByText("Personalize your collection", { exact: true }).click();
  await page
    .getByRole("button", { name: "A page of my own", exact: true })
    .click();
  await page.getByRole("button", { name: "Name it by voice" }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Let’s begin", exact: true }).click();
  await expect(page).toHaveURL(/#\/interview\/[^/]+$/);
  await expect(
    page.getByRole("button", { name: "Start telling", exact: true }),
  ).toBeVisible();
  const sessionUrl = page.url();
  await page.goto("/#/shelf");
  await page
    .getByRole("link", {
      name: /Name your page Return to your saved page name/,
    })
    .click();
  await expect(page).toHaveURL(sessionUrl);
  await page
    .getByText("Prefer to add the words yourself?", { exact: true })
    .click();
  await page
    .getByLabel("Your words", { exact: true })
    .fill("The boat we made together");
  await page
    .getByRole("button", { name: "Save these words", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Save page name", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "The boat we made together",
      exact: true,
    }),
  ).toBeVisible();
  await page.goto(sessionUrl);
  await expect(
    page.getByText("Your page name is saved.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Make my story", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Add something to this memory",
      exact: true,
    }),
  ).toHaveCount(0);
  const view = await (await page.request.get("/api/almanac")).json();
  expect(view.titleDrafts).toHaveLength(0);
  expect(view.books).toHaveLength(0);
});

test("starting a memory prepares the recorder once, even when the opening-turn reply is lost", async ({
  page,
}) => {
  await family(page);
  await page.getByRole("link", { name: "Tell this memory" }).click();
  await page.getByRole("checkbox").check();
  let loseReply = true;
  await page.route("**/api/interviews/*/turns", async (route) => {
    if (route.request().method() === "POST" && loseReply) {
      loseReply = false;
      await route.fetch();
      await route.fulfill({
        status: 503,
        json: { error: "Temporary interruption" },
      });
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Let’s begin", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Temporary interruption");
  await page.getByRole("button", { name: "Let’s begin", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Start telling", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Answer in your own time", exact: true }),
  ).toHaveCount(0);
  const sid = page.url().split("/interview/")[1];
  const view = await (await page.request.get(`/api/interviews/${sid}`)).json();
  expect(view.session.turns).toHaveLength(1);
  expect(view.session.turns[0].status).toBe("awaiting_audio");
  expect(view.transcriptionJobs).toHaveLength(0);
});
