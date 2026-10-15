import { test, expect, type Page, type Route } from "@playwright/test";

async function pausedMemory(page: Page) {
  await page.goto("/#/join");
  await page
    .getByLabel("Shelf name")
    .fill(`recording recovery ${crypto.randomUUID()}`);
  await page
    .getByLabel("Password", { exact: true })
    .fill("Synthetic recovery password");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create your private shelf" }).click();
  await page
    .getByRole("button", { name: "Save a memory", exact: true })
    .click();
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Save a memory", exact: true })
    .click();
  await expect(page.locator(".timer")).toHaveText("00:02", { timeout: 6000 });
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    page.getByText("Paused. Take your time.", { exact: true }),
  ).toBeVisible();
  return page.url().split("/tell/")[1];
}

async function savedOnly(page: Page, sid: string) {
  const session = await (
    await page.request.get(`/api/interviews/${sid}`)
  ).json();
  const journey = await (await page.request.get(`/api/journey/${sid}`)).json();
  expect(session.session.turns).toHaveLength(1);
  expect(session.session.turns[0].audio.bytes).toBeGreaterThan(44);
  expect(session.transcriptionJobs).toHaveLength(0);
  expect(journey.requestId).toBeNull();
  expect(journey.projectId).toBeNull();
  return session.session.turns[0].audio;
}

test("paused recording survives a failed refresh, reconnects, and preserves separate action errors", async ({
  page,
}) => {
  const sid = await pausedMemory(page);
  const pausedTime = await page.locator(".timer").innerText();
  let failed = false,
    successfulReads = 0;
  await page.route(`**/api/journey/${sid}`, async (route) => {
    if (!failed) {
      failed = true;
      await route.abort("failed");
    } else {
      successfulReads++;
      await route.continue();
    }
  });
  const connection = page
    .getByRole("status")
    .filter({ hasText: "Connection interrupted." });
  await expect(connection).toBeVisible();
  await expect(connection).toHaveCount(0, { timeout: 6000 });
  await expect(page.locator(".timer")).toHaveText(pausedTime);
  await expect(
    page.getByText("Paused. Take your time.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Save for later", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "A memory, kept." }),
  ).toBeVisible();
  const audio = await savedOnly(page, sid);

  await page.route(`**/api/journey/${sid}/turns`, (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "Synthetic additional-part rejection." }),
    }),
  );
  await page
    .getByRole("button", { name: "Add something", exact: true })
    .click();
  const action = page
    .getByRole("alert")
    .filter({ hasText: "Synthetic additional-part rejection." });
  await expect(action).toBeVisible();
  const before = successfulReads;
  await expect.poll(() => successfulReads).toBeGreaterThan(before + 1);
  await expect(action).toBeVisible();
  await expect(connection).toHaveCount(0);
  expect(await savedOnly(page, sid)).toEqual(audio);
});

test("a hung recording upload times out without retrying or deleting its recoverable draft", async ({
  page,
}) => {
  const sid = await pausedMemory(page);
  await page.clock.install();
  let uploads = 0;
  let held: Route | undefined;
  const audioRoute = "**/api/interviews/*/turns/*/audio";
  await page.route(audioRoute, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    uploads++;
    held = route;
    // Deliberately withhold the response. The browser request must time out.
  });
  await page
    .getByRole("button", { name: "Save for later", exact: true })
    .click();
  await expect.poll(() => uploads).toBe(1);
  await page.clock.fastForward(90001);
  await expect(page.getByRole("alert")).toContainText(
    "Saving is taking too long.",
  );
  await expect(page.getByRole("alert")).toContainText(
    "Your draft is still here.",
  );
  await expect(
    page.getByRole("button", { name: "Save for later", exact: true }),
  ).toBeEnabled();
  expect(uploads).toBe(1);
  const before = await (
    await page.request.get(`/api/interviews/${sid}`)
  ).json();
  expect(before.session.turns[0].audio).toBeNull();
  expect(before.transcriptionJobs).toHaveLength(0);
  expect(
    (await (await page.request.get(`/api/journey/${sid}`)).json()).requestId,
  ).toBeNull();

  await held?.abort().catch(() => undefined);
  await page.unroute(audioRoute);
  await page.reload();
  await expect(
    page.getByText("Your unsaved recording is still here on this device."),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Save for later", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "A memory, kept." }),
  ).toBeVisible();
  const audio = await savedOnly(page, sid);
  await page.reload();
  expect(await savedOnly(page, sid)).toEqual(audio);
});

test("an accepted creation with a hung reply is found by reads without repeating the request", async ({
  page,
}) => {
  const sid = await pausedMemory(page);
  await page
    .getByRole("button", { name: "Save for later", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "A memory, kept." }),
  ).toBeVisible();
  // Only the family availability display is simulated. The synthetic server's
  // workers and provider transport stay disabled throughout this test.
  await page.route(`**/api/journey/${sid}`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), canCreate: true },
    });
  });
  await expect(
    page.getByRole("button", { name: "Make my book", exact: true }),
  ).toBeVisible();
  await page.clock.install();
  let creates = 0;
  let acceptedId: string | undefined;
  let held: Route | undefined;
  await page.route(`**/api/journey/${sid}/create`, async (route) => {
    creates++;
    held = route;
    const response = await route.fetch();
    expect(response.status()).toBe(202);
    acceptedId = (await response.json()).requestId;
    // Acceptance is durable but the browser never receives this response.
  });
  await page.getByRole("button", { name: "Make my book", exact: true }).click();
  await expect.poll(() => acceptedId).toBeTruthy();
  await page.clock.fastForward(15001);
  await expect(page.getByRole("alert")).toContainText(
    "We couldn’t confirm your book request yet.",
  );
  await page.clock.fastForward(2001);
  await expect(
    page.getByRole("heading", { name: "Your memory is waiting safely." }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.clock.fastForward(20001);
  expect(creates).toBe(1);
  expect(
    (await (await page.request.get(`/api/journey/${sid}`)).json()).requestId,
  ).toBe(acceptedId);
  const session = await (
    await page.request.get(`/api/interviews/${sid}`)
  ).json();
  expect(session.session.turns).toHaveLength(1);
  expect(session.transcriptionJobs).toHaveLength(0);
  await held?.abort().catch(() => undefined);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your memory is waiting safely." }),
  ).toBeVisible();
  expect(creates).toBe(1);
});

test("an uncertain additional-part save reuses its key and resumes read reconciliation", async ({
  page,
}) => {
  const sid = await pausedMemory(page);
  await page
    .getByRole("button", { name: "Save for later", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "A memory, kept." }),
  ).toBeVisible();
  const audio = await savedOnly(page, sid);
  await page.clock.install();
  const keys: string[] = [];
  let held: Route | undefined;
  await page.route(`**/api/journey/${sid}/turns`, async (route) => {
    keys.push(route.request().postDataJSON().key);
    if (keys.length === 1) {
      held = route;
      return;
    }
    await route.continue();
  });
  await page
    .getByRole("button", { name: "Add something", exact: true })
    .click();
  await expect.poll(() => keys.length).toBe(1);
  await page.clock.fastForward(15001);
  await expect(page.getByRole("alert")).toContainText(
    "We couldn’t confirm the additional part yet.",
  );
  await page.clock.fastForward(2001);
  await page
    .getByRole("button", { name: "Add something", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Start telling", exact: true }),
  ).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  const session = await (
    await page.request.get(`/api/interviews/${sid}`)
  ).json();
  expect(session.session.turns).toHaveLength(2);
  expect(session.session.turns[0].audio).toEqual(audio);
  expect(session.transcriptionJobs).toHaveLength(0);
  expect(
    (await (await page.request.get(`/api/journey/${sid}`)).json()).requestId,
  ).toBeNull();
  await held?.abort().catch(() => undefined);
});
