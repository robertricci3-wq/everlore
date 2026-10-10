import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

async function syntheticEdition(page: Page, freeze = true) {
  const headers = { "X-Evermore-Client": "1" };
  const account = await page.request.post("/api/register", {
    headers,
    data: {
      name: `feedback ${randomUUID().slice(0, 10)}`,
      password: "A private fixture password",
      adult: true,
    },
  });
  expect(account.status()).toBe(201);
  const example = await page.request.post("/api/demo", { headers, data: {} });
  expect(example.status()).toBe(201);
  const { id } = await example.json();
  await page.request.post(`/api/projects/${id}/confirm`, {
    headers,
    data: { confirmed: true },
  });
  await expect
    .poll(async () =>
      Boolean(
        (await (await page.request.get(`/api/projects/${id}`)).json()).book,
      ),
    )
    .toBe(true);
  const project = await (await page.request.get(`/api/projects/${id}`)).json();
  if (!freeze) return { id: id as string, edition: null, book: project.book };
  const editionResponse = await page.request.post(
    `/api/projects/${id}/editions`,
    {
      headers,
      data: {
        baseRevision: project.book.revision,
        contentHash: project.book.contentHash,
      },
    },
  );
  expect(editionResponse.status()).toBe(201);
  const edition = await editionResponse.json();
  return { id: id as string, edition, book: project.book };
}

test("optional private book feedback survives a lost response, can be changed, and never changes the edition", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { id, edition, book } = await syntheticEdition(page);
  const originalEdition = await (
    await page.request.get(`/api/projects/${id}/editions/${edition.id}`)
  ).text();
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST")
      writes.push(new URL(request.url()).pathname);
  });
  await page.goto(`/#/story/${id}/edition/${edition.id}`);
  const disclosure = page.locator(".book-feedback");
  await expect(disclosure).toBeVisible();
  await expect(disclosure).not.toHaveAttribute("open");
  await page.getByRole("button", { name: "Next spread" }).click();
  await expect(page.getByText("Spread 1 of 12", { exact: true })).toBeVisible();
  expect(writes).toEqual([]);

  await disclosure.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(
    disclosure.getByText(/optional and shared privately/),
  ).toBeVisible();
  await disclosure.getByRole("radio", { name: "A good start" }).check();
  await disclosure
    .getByRole("textbox", { name: /Anything you loved or would change/ })
    .fill("The fox feels familiar. I would love a quieter ending.");
  let lost = false;
  await page.route(`**/api/projects/${id}/feedback`, async (route) => {
    if (route.request().method() !== "POST" || lost) return route.continue();
    lost = true;
    await route.fetch();
    await route.abort("failed");
  });
  await disclosure.getByRole("button", { name: "Share feedback" }).click();
  await expect(disclosure.getByRole("alert")).toBeVisible();
  await disclosure.getByRole("button", { name: "Share feedback" }).click();
  await expect(disclosure.getByRole("status")).toHaveText(
    "Thank you. Your feedback is saved.",
  );
  await page.unroute(`**/api/projects/${id}/feedback`);
  const query = new URLSearchParams({
    revision: String(book.revision),
    contentHash: book.contentHash,
    editionId: edition.id,
  });
  const first = await (
    await page.request.get(`/api/projects/${id}/feedback?${query}`)
  ).json();
  expect(first.feedback.version).toBe(1);
  expect(first.feedback.editionId).toBe(edition.id);

  await page.reload();
  await disclosure.locator("summary").click();
  await expect(
    disclosure.getByRole("radio", { name: "A good start" }),
  ).toBeChecked();
  await disclosure.getByRole("radio", { name: "I loved it" }).check();
  await disclosure
    .getByRole("textbox", { name: /Anything you loved or would change/ })
    .fill("After reading it again, I loved the small details.");
  await disclosure.getByRole("button", { name: "Update feedback" }).click();
  await expect(disclosure.getByRole("status")).toHaveText(
    "Thank you. Your feedback is saved.",
  );
  const second = await (
    await page.request.get(`/api/projects/${id}/feedback?${query}`)
  ).json();
  expect(second.feedback.id).toBe(first.feedback.id);
  expect(second.feedback.version).toBe(2);
  expect(second.feedback.overall).toBe("loved_it");
  expect(
    await (
      await page.request.get(`/api/projects/${id}/editions/${edition.id}`)
    ).text(),
  ).toBe(originalEdition);
  expect((await page.request.get("/api/operator/feedback")).status()).toBe(403);
  expect(writes).toEqual(Array(3).fill(`/api/projects/${id}/feedback`));
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await disclosure.screenshot({ path: "work/evidence/feedback-phone.png" });
  await page.setViewportSize({ width: 1440, height: 1040 });
  await disclosure.screenshot({ path: "work/evidence/feedback-desktop.png" });
});

test("an unfinished response survives closing the section and saving the book PDF", async ({
  page,
}) => {
  const { id, book } = await syntheticEdition(page, false);
  await page.goto(`/#/story/${id}`);
  const disclosure = page.locator(".book-feedback");
  let loads = 0;
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      request.url().includes(`/projects/${id}/feedback?`)
    )
      loads++;
  });
  await disclosure.locator("summary").click();
  await disclosure.getByRole("radio", { name: "A good start" }).check();
  const note = "I am still thinking about the ending.";
  const field = disclosure.getByRole("textbox", {
    name: /Anything you loved or would change/,
  });
  await field.fill(note);
  await disclosure.locator("summary").click();
  await disclosure.locator("summary").click();
  await expect(field).toHaveValue(note);
  await expect(
    disclosure.getByRole("radio", { name: "A good start" }),
  ).toBeChecked();
  await page.getByText("Book options", { exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download review PDF" }).click();
  await download;
  await expect(
    page.getByRole("link", { name: "Download review PDF" }),
  ).toBeVisible();
  await expect(field).toHaveValue(note);
  await expect(
    disclosure.getByRole("radio", { name: "A good start" }),
  ).toBeChecked();
  expect(loads).toBe(1);
  await disclosure.getByRole("button", { name: "Share feedback" }).click();
  await expect(disclosure.getByRole("status")).toHaveText(
    "Thank you. Your feedback is saved.",
  );
  const project = await (await page.request.get(`/api/projects/${id}`)).json();
  const query = new URLSearchParams({
    revision: String(book.revision),
    contentHash: book.contentHash,
  });
  const { feedback } = await (
    await page.request.get(`/api/projects/${id}/feedback?${query}`)
  ).json();
  expect(feedback.editionId).toBe(project.editions[0].id);
  expect(feedback.text).toBe(note);
});

test("operator feedback presentation handles empty results, review and denied access", async ({
  page,
}) => {
  // Presentation fixtures are separate from real API ownership tests.
  let response = {
    note: "Optional adult feedback; not observed child engagement.",
    total: 0,
    limit: 25,
    offset: 0,
    counts: [] as { overall: string; count: number }[],
    responses: [] as {
      id: string;
      revision: number;
      overall: string;
      text: string;
      updatedAt: string;
    }[],
  };
  await page.route("**/api/operator/feedback?*", (route) =>
    route.fulfill({ json: response }),
  );
  await page.goto("/#/operator/feedback");
  await expect(
    page.getByRole("heading", { name: "What families are saying." }),
  ).toBeVisible();
  await expect(
    page.getByText("0 saved responses across book versions."),
  ).toBeVisible();
  response = {
    ...response,
    total: 1,
    counts: [{ overall: "good_start", count: 1 }],
    responses: [
      {
        id: "fixture",
        revision: 1,
        overall: "good_start",
        text: "The animal family feels like ours.",
        updatedAt: "2026-10-10T12:00:00Z",
      },
    ],
  };
  await page.getByRole("button", { name: "Refresh feedback" }).click();
  await expect(
    page.getByText("The animal family feels like ours."),
  ).toBeVisible();
  await expect(page.getByText(/not observed child engagement/)).toBeVisible();
  await page.unroute("**/api/operator/feedback?*");
  await page.getByRole("button", { name: "Refresh feedback" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByText("The animal family feels like ours."),
  ).toHaveCount(0);
});
