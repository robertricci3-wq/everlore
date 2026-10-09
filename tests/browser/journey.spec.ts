import { test, expect, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  PUBLIC_ART_SHOWCASE,
  PUBLIC_HERO_ARTWORK,
} from "../../src/shared/publicArt.js";
async function example(page: Page) {
  await account(page);
  // The public illustration showcase never creates family work. These
  // separate reader tests explicitly opt into the deterministic test fixture.
  const response = await page.request.post("/api/demo", {
    headers: { "X-Evermore-Client": "1" },
    data: {},
  });
  expect(response.status()).toBe(201);
  const { id } = await response.json();
  await page.goto(`/#/story/${id}`);
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
  const heroImage = page.getByRole("img", {
    name: PUBLIC_HERO_ARTWORK.alt,
    exact: true,
  });
  await expect(heroImage).toHaveAttribute("src", PUBLIC_HERO_ARTWORK.src);
  await expect
    .poll(() =>
      heroImage.evaluate(
        (element) => (element as HTMLImageElement).naturalWidth,
      ),
    )
    .toBe(1024);
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
  await expect(
    page.getByRole("heading", { name: "Your orders", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Your hardcover orders will appear here."),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
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

function persistentCounts() {
  const db = new DatabaseSync(
    join(process.cwd(), "work/e2e-data/evermore.sqlite"),
    { readOnly: true },
  );
  try {
    return Object.fromEntries(
      [
        "users",
        "sessions",
        "projects",
        "recordings",
        "jobs",
        "studio_jobs",
        "studio_calls",
        "editions",
      ].map((table) => [
        table,
        db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count,
      ]),
    );
  } finally {
    db.close();
  }
}

async function inspectShowcase(page: Page) {
  await expect(page).toHaveURL(/#\/example$/);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: PUBLIC_ART_SHOWCASE.heading,
      exact: true,
    }),
  ).toBeVisible();
  const next = page.getByRole("button", {
    name: "Next illustration",
    exact: true,
  });
  const previous = page.getByRole("button", {
    name: "Previous illustration",
    exact: true,
  });
  await expect(previous).toBeDisabled();
  for (const [index, artwork] of PUBLIC_ART_SHOWCASE.artworks.entries()) {
    await expect(
      page.getByText(`Illustration ${index + 1} of 3`, { exact: true }),
    ).toBeVisible();
    const image = page.getByRole("img", { name: artwork.alt, exact: true });
    await expect(image).toBeVisible();
    await expect
      .poll(() =>
        image.evaluate((element) => {
          const img = element as HTMLImageElement;
          return (
            img.complete &&
            img.naturalWidth === 1024 &&
            img.naturalHeight === 1024
          );
        }),
      )
      .toBe(true);
    await expect(
      page.getByRole("heading", { name: artwork.title, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: `Show ${artwork.title}`, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    if (index < 2) {
      await next.focus();
      await page.keyboard.press("Enter");
    }
  }
  await expect(next).toBeDisabled();
  await previous.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("Illustration 2 of 3", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: `Show ${PUBLIC_ART_SHOWCASE.artworks[0].title}`,
      exact: true,
    })
    .focus();
  await page.keyboard.press("Space");
  await expect(
    page.getByText("Illustration 1 of 3", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: /Save this edition|Make the example book|Make my legacy story|Change something|Buy/,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: /Download.*PDF|Purchase|Buy/ }),
  ).toHaveCount(0);
}

test("desktop: public animal art is keyboard accessible and creates no account or family records", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1040 });
  await page.goto("/");
  const before = persistentCounts();
  const mutations: string[] = [];
  const legacyRequests: string[] = [];
  page.on("request", (request) => {
    if (
      /^\/api\/(?:example|demo)(?:\/|$)/.test(new URL(request.url()).pathname)
    )
      legacyRequests.push(new URL(request.url()).pathname);
    if (
      new URL(request.url()).pathname.startsWith("/api/") &&
      !["GET", "HEAD"].includes(request.method())
    )
      mutations.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  await page
    .getByRole("link", { name: "Explore the illustrations", exact: true })
    .first()
    .focus();
  await page.keyboard.press("Enter");
  await inspectShowcase(page);
  expect(
    (await (await page.request.get("/api/session")).json()).user,
  ).toBeNull();
  expect(mutations).toEqual([]);
  expect(legacyRequests).toEqual([]);
  expect(persistentCounts()).toEqual(before);
  await page.screenshot({
    path: "work/evidence/showcase-desktop.png",
    fullPage: true,
  });
});

test("phone: signed-in families see the same public art without creating a demo project", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await account(page);
  const projectsBefore = await (await page.request.get("/api/projects")).json();
  const countsBefore = persistentCounts();
  const mutations: string[] = [];
  const legacyRequests: string[] = [];
  page.on("request", (request) => {
    if (
      /^\/api\/(?:example|demo)(?:\/|$)/.test(new URL(request.url()).pathname)
    )
      legacyRequests.push(new URL(request.url()).pathname);
    if (
      new URL(request.url()).pathname.startsWith("/api/") &&
      !["GET", "HEAD"].includes(request.method())
    )
      mutations.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the illustrations", exact: true })
    .first()
    .click();
  await inspectShowcase(page);
  await page.goto("/#/shelf");
  await page
    .getByRole("button", { name: "Explore the illustrations", exact: true })
    .click();
  await expect(page).toHaveURL(/#\/example$/);
  expect(await (await page.request.get("/api/projects")).json()).toEqual(
    projectsBefore,
  );
  expect(persistentCounts()).toEqual(countsBefore);
  expect(mutations).toEqual([]);
  expect(legacyRequests).toEqual([]);
  await page.screenshot({
    path: "work/evidence/showcase-phone.png",
    fullPage: true,
  });
});
