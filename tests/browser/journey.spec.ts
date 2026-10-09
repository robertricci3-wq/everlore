import { test, expect, type Page } from "@playwright/test";
async function example(page: Page) {
  await account(page);
  await page.goto("/");
  await page
    .getByRole("button", { name: "See an example", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "A coat. Three buttons. A little patience.",
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Make the example book" }).click();
  await expect(
    page
      .getByRole("heading", { name: "The little things we learn", exact: true })
      .first(),
  ).toBeVisible();
}
async function account(page: Page) {
  await page.goto("/#/join");
  await page.getByLabel("Shelf name").fill(`test ${Date.now()}`);
  await page
    .getByLabel("Password", { exact: true })
    .fill("A private test password");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create your private shelf" }).click();
  await expect(
    page.getByRole("heading", { name: "Take your time. We’re listening." }),
  ).toBeVisible();
}
test("desktop: whole book, source view, revision, saved edition and matching download", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1040 });
  await page.goto("/");
  await page.screenshot({
    path: "work/evidence/home-desktop.png",
    fullPage: true,
  });
  await example(page);
  await page.screenshot({
    path: "work/evidence/book-desktop.png",
    fullPage: true,
  });
  for (let i = 1; i <= 12; i++) {
    await page.getByRole("button", { name: "Next spread" }).click();
    await expect(
      page.getByText(`Spread ${i} of 12`, { exact: true }),
    ).toBeVisible();
  }
  await expect(
    page.getByRole("button", { name: "Next spread" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "All pictures" }).click();
  await expect(page.locator(".contact-grid img")).toHaveCount(12);
  await page.screenshot({
    path: "work/evidence/contact-sheet.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Read the words" }).click();
  await expect(page.locator(".manuscript>section")).toHaveCount(12);
  await page.locator(".manuscript summary").first().click();
  await expect(
    page.getByText("Source s1", { exact: true }).first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Save this edition", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Download review PDF" }),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download review PDF" }).click();
  await (await download).saveAs("work/evidence/Evermore-review-edition-1.pdf");
  await page
    .getByRole("button", { name: "Change something", exact: true })
    .click();
  await page.getByLabel("Whose name?").selectOption("nell");
  await page.getByLabel("The correct name").fill("Nora");
  await page.getByRole("button", { name: "Apply name correction" }).click();
  await expect(
    page.getByText("Name corrected throughout the book.", { exact: false }),
  ).toBeVisible();
  await expect(page.locator(".reader-heading")).toContainText("Nora");
  await page.getByRole("button", { name: /Edition 1/ }).click();
  await expect(page.locator(".reader-heading")).toContainText("Nell");
  await page.reload();
  await expect(page.locator(".reader-heading")).toContainText("Nora");
  expect(errors).toEqual([]);
});
test("phone: readable stacked spread, all navigation controls and no horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await example(page);
  await page.getByRole("button", { name: "Next spread" }).click();
  await expect(page.locator(".mobile-story")).toBeVisible();
  expect(
    await page
      .locator(".mobile-story")
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeGreaterThanOrEqual(22);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "work/evidence/book-phone.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Next spread" }).click();
  await expect(page.getByText("Spread 2 of 12", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Your orders", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your orders", exact: true })).toBeVisible();
  await expect(page.getByText("Your hardcover orders will appear here.")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
test("browser microphone: pause/resume, interrupted upload, draft recovery and durable audio", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await account(page);
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Start telling", exact: true })
    .click();
  await expect(
    page.getByText("Recording your memory", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".timer")).toHaveText("00:02", { timeout: 5000 });
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByText("Paused. Take a little breath.")).toBeVisible();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.getByRole("button", { name: "I’m finished" }).click();
  await expect(
    page.getByRole("button", { name: "Save recording", exact: true }),
  ).toBeEnabled();
  await page.route("**/api/projects/*/recording", (route) =>
    route.abort("failed"),
  );
  await page
    .getByRole("button", { name: "Save recording", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Your draft is still here",
  );
  await page.unroute("**/api/projects/*/recording");
  await page.reload();
  await expect(
    page.getByText("We found a recording draft on this device.", {
      exact: false,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: "work/evidence/capture-recovered-phone.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Save recording", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your voice. Kept with care." }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator(".story-studio")).toBeVisible();
  const audio = page.getByLabel("Your saved recording");
  await expect(audio).toBeVisible();
  await expect
    .poll(() => audio.evaluate((el) => (el as HTMLAudioElement).readyState))
    .toBeGreaterThan(0);
  await page.screenshot({
    path: "work/evidence/recording-saved-phone.png",
    fullPage: true,
  });
});
test("denied microphone gives a file fallback without claiming a saved recording", async ({
  page,
}) => {
  await account(page);
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(new DOMException("Denied", "NotAllowedError"));
  });
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Start telling", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "The microphone is not available",
  );
  await expect(
    page.getByRole("button", { name: "Or choose an audio file" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Save recording", exact: true }),
  ).toHaveCount(0);
});

test("public example is readable without a shelf, generation, editing or checkout", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "See an example", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "The little things we learn",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("Spread 1 of 12", { exact: true })).toBeVisible();
  for (let i = 2; i <= 12; i++) {
    await page
      .getByRole("button", { name: "Next spread", exact: true })
      .click();
    await expect(
      page.getByText(`Spread ${i} of 12`, { exact: true }),
    ).toBeVisible();
  }
  await expect(
    page.getByRole("button", { name: "Next spread", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", {
      name: /Save this edition|Make the example book|Change something|Buy/,
    }),
  ).toHaveCount(0);
  expect((await (await request.get("/api/session")).json()).user).toBeNull();
});
