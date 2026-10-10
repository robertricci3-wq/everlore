import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

async function readyBook(page: Page) {
  const registration = await page.request.post("/api/register", {
    headers: { "X-Evermore-Client": "1" },
    data: {
      name: `purchase ${randomUUID().slice(0, 12)}`,
      password: "A private fixture password",
      adult: true,
    },
  });
  expect(registration.status()).toBe(201);
  const created = await page.request.post("/api/demo", {
    headers: { "X-Evermore-Client": "1" },
    data: {},
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  await page.request.post(`/api/projects/${id}/confirm`, {
    headers: { "X-Evermore-Client": "1" },
    data: { confirmed: true },
  });
  await expect
    .poll(async () =>
      Boolean(
        (await (await page.request.get(`/api/projects/${id}`)).json()).book,
      ),
    )
    .toBe(true);
  return id;
}
function orderView(projectId: string, editionId: string) {
  return {
    id: "retained-test-order",
    projectId,
    editionId,
    status: "needs_attention",
    amountCents: 14900,
    checkoutUrl: null,
    error: "Your order is saved while we check its payment status.",
    taxCents: null,
    totalCents: null,
    refundedCents: 0,
    receiptUrl: null,
    canRenew: false,
    tracking: [],
  };
}
const available = {
  reasons: [],
  priceCents: 14900,
  format: "210 mm square hardcover · 32 interior pages",
  editionId: null,
  bundle: null,
  order: null,
};

test("reader keeps the book focal and unavailable ordering performs no preparation", async ({
  page,
}) => {
  const id = await readyBook(page);
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") writes.push(request.url());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#/story/${id}`);
  await expect(page.locator(".reader-heading")).toContainText(
    "The little things we learn",
  );
  await expect(
    page.getByText("Hardcover ordering isn’t available yet.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Send me this book/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: /Prepare this edition|Save this edition/,
    }),
  ).toHaveCount(0);
  expect(await page.locator(".reader-options").getAttribute("open")).toBeNull();
  expect(
    await page
      .locator(".art-page img")
      .evaluate((image) => getComputedStyle(image).objectFit),
  ).toBe("contain");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(writes).toEqual([]);
  const current = await (await page.request.get(`/api/projects/${id}`)).json();
  expect(current.editions).toHaveLength(0);
  await page.screenshot({
    path: "work/evidence/simple-reader-phone.png",
    fullPage: true,
  });
});

test("one priced action freezes the displayed book and the order reopens that exact edition", async ({
  page,
}) => {
  const id = await readyBook(page);
  let editionId = "",
    saves = 0,
    checkouts = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith(`/projects/${id}/editions`)
    )
      saves++;
  });
  await page.route(`**/api/projects/${id}/purchase?*`, (route) =>
    route.fulfill({ json: available }),
  );
  await page.route(
    `**/api/projects/${id}/editions/*/checkout`,
    async (route) => {
      editionId = route.request().url().split("/editions/")[1].split("/")[0];
      checkouts++;
      await route.fulfill({ json: orderView(id, editionId) });
    },
  );
  await page.route("**/api/orders/retained-test-order", (route) =>
    route.fulfill({ json: orderView(id, editionId) }),
  );
  await page.goto(`/#/story/${id}`);
  await page
    .getByRole("button", { name: "Send me this book · $149.00" })
    .click();
  await expect(
    page.getByRole("heading", { name: /Your order needs attention/ }),
  ).toBeVisible();
  expect(saves).toBe(1);
  expect(checkouts).toBe(1);
  const current = await (await page.request.get(`/api/projects/${id}`)).json();
  expect(current.editions).toHaveLength(1);
  expect(current.editions[0].id).toBe(editionId);
  await page.request.post(`/api/projects/${id}/rename`, {
    headers: { "X-Evermore-Client": "1" },
    data: {
      baseRevision: 1,
      personId: "nell",
      newName: "Nora",
      key: randomUUID(),
    },
  });
  await expect(
    page.getByRole("link", { name: "Read your ordered edition" }),
  ).toHaveAttribute("href", `#/story/${id}/edition/${editionId}`);
  await page.getByRole("link", { name: "Read your ordered edition" }).click();
  await expect(page.locator(".reader-heading")).toContainText("Nell");
  await page.reload();
  await expect(page.locator(".reader-heading")).toContainText("Nell");
  await page.getByRole("link", { name: "Return to current book" }).click();
  await expect(page.locator(".reader-heading")).toContainText("Nora");
});

test("a lost checkout reply recovers the existing order instead of offering another purchase", async ({
  page,
}) => {
  const id = await readyBook(page);
  let editionId = "",
    checkouts = 0;
  await page.route(`**/api/projects/${id}/purchase?*`, (route) =>
    route.fulfill({
      json: {
        ...available,
        editionId: editionId || null,
        order: editionId ? orderView(id, editionId) : null,
      },
    }),
  );
  await page.route(`**/api/projects/${id}/editions/*/purchase`, (route) =>
    route.fulfill({
      json: { ...available, editionId, order: orderView(id, editionId) },
    }),
  );
  await page.route(
    `**/api/projects/${id}/editions/*/checkout`,
    async (route) => {
      editionId = route.request().url().split("/editions/")[1].split("/")[0];
      checkouts++;
      await route.abort("failed");
    },
  );
  await page.goto(`/#/story/${id}`);
  await page
    .getByRole("button", { name: "Send me this book · $149.00" })
    .click();
  await expect(
    page.getByRole("link", { name: "View your order" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Send me this book/ }),
  ).toHaveCount(0);
  expect(checkouts).toBe(1);
  expect(
    (await (await page.request.get(`/api/projects/${id}`)).json()).editions,
  ).toHaveLength(1);
});

test("failed availability and an unavailable saved edition never offer the current book for purchase", async ({
  page,
}) => {
  const id = await readyBook(page);
  await page.route(`**/api/projects/${id}/purchase?*`, (route) =>
    route.fulfill({
      status: 500,
      json: { error: "PRIVATE_CONFIGURATION_DIAGNOSTIC" },
    }),
  );
  await page.goto(`/#/story/${id}`);
  await expect(page.getByRole("alert")).toContainText(
    "Hardcover availability could not be loaded.",
  );
  await expect(page.getByText("PRIVATE_CONFIGURATION_DIAGNOSTIC")).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: /Send me this book/ }),
  ).toHaveCount(0);
  await page.goto(`/#/story/${id}/edition/unavailable-edition`);
  await expect(page.getByRole("alert")).toContainText(
    "This saved edition could not be opened.",
  );
  await expect(
    page.getByRole("button", { name: /Send me this book/ }),
  ).toHaveCount(0);
  await expect(page.locator(".reader-heading")).toHaveCount(0);
});
