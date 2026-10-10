import { test, expect } from "@playwright/test";
import { Store } from "../../src/server/store.js";
import { setLabOwner } from "../../src/server/lab/service.js";
test("Creative Lab: offline comparison, optional feedback and no approval or release bypass", async ({
  page,
  request,
}) => {
  const name = `lab-browser-${Date.now()}`,
    password = "Synthetic browser test password";
  const created = await request.post("/api/register", {
    headers: { "X-Evermore-Client": "1" },
    data: { name, password, adult: true },
  });
  expect(created.ok()).toBeTruthy();
  const store = new Store("work/e2e-data");
  const owner = store.one<{ id: string }>(
    "SELECT id FROM users WHERE name=?",
    name,
  )!;
  setLabOwner(store, owner.id);
  store.close();
  await page.goto("/#/login");
  await page.getByLabel("Shelf name").fill(name);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Open your shelf" }).click();
  // Login completes asynchronously. Navigating before the shelf opens can
  // cancel the request and leave the browser outside the private Lab.
  await expect(page).toHaveURL(/#\/shelf$/);
  const labAccess = await page.request.get("/api/lab");
  expect(labAccess.status()).toBe(200);
  expect((await labAccess.json()).allowed).toBe(true);
  await page.goto("/#/lab");
  await expect(
    page.getByRole("heading", {
      name: "Find the extraordinary in the ordinary.",
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Experiments", exact: true }).click();
  await page.getByLabel("Evaluation purpose").selectOption("release");
  await expect(
    page.getByText("Matched development comparison of this candidate", {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByLabel("Evaluation purpose").selectOption("development");
  await page.getByRole("button", { name: "Freeze this experiment" }).click();
  await page
    .getByRole("button", { name: "Run comparison", exact: true })
    .click();
  await expect(
    page.getByText("36/36 artifacts retained", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Offline fixtures verify behavior only; no creative promotion.",
      { exact: true },
    ),
  ).toBeVisible();
  await page
    .getByText("Optional observations · never a required step", { exact: true })
    .click();
  await page
    .getByLabel("Evidence", { exact: true })
    .fill(
      "Browser test: these are explicitly labeled placeholders, not creative results.",
    );
  await page.getByRole("button", { name: "Save optional observation" }).click();
  await expect(
    page.getByText(
      "tie: Browser test: these are explicitly labeled placeholders, not creative results.",
    ),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Engine versions", exact: true })
    .click();
  await expect(
    page.getByText(
      "No candidate has been promoted. Offline examples cannot activate an engine release.",
    ),
  ).toBeVisible();
});

test("memory comparison retains a checkpoint, citations and complete reproducible evidence", async ({
  page,
  request,
}) => {
  const name = `memory-lab-browser-${Date.now()}`,
    password = "Synthetic browser test password";
  expect(
    (
      await request.post("/api/register", {
        headers: { "X-Evermore-Client": "1" },
        data: { name, password, adult: true },
      })
    ).ok(),
  ).toBeTruthy();
  const store = new Store("work/e2e-data");
  const owner = store.one<{ id: string }>(
    "SELECT id FROM users WHERE name=?",
    name,
  )!;
  setLabOwner(store, owner.id);
  store.close();
  await page.goto("/#/login");
  await page.getByLabel("Shelf name").fill(name);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Open your shelf" }).click();
  await expect(page).toHaveURL(/#\/shelf$/);
  await page.goto("/#/lab");
  const memory = page.getByRole("region", {
    name: "Guided memory experiments",
  });
  await memory
    .getByRole("button", { name: "Freeze memory comparison" })
    .click();
  await memory
    .getByRole("button", { name: "Run one pair and checkpoint" })
    .click();
  await expect(
    memory.getByRole("heading", { name: "Saved checkpoint" }),
  ).toBeVisible();
  await expect(
    memory.getByText("2/72 decisions retained", { exact: false }),
  ).toBeVisible();
  await page.reload();
  await memory
    .getByRole("button", { name: "Resume memory comparison" })
    .click();
  await expect(
    memory.getByText("72/72 decisions retained", { exact: false }),
  ).toBeVisible();
  await expect(
    memory.getByText("12 pairs with fewer prompts", { exact: false }),
  ).toBeVisible();
  await expect(
    memory.getByText("0 failed runs", { exact: false }),
  ).toBeVisible();
  const citations = memory
    .locator(".lab-artifact")
    .filter({ has: page.getByRole("heading", { name: "Candidate guide" }) });
  await expect(
    citations.getByText("Source citations", { exact: true }),
  ).toBeVisible();
  expect(await citations.locator("blockquote").count()).toBeGreaterThan(0);
  await page.screenshot({
    path: "work/evidence/quality-memory-comparison.png",
    fullPage: true,
  });
  const response = await page.request.get("/api/lab/memory");
  const data = await response.json();
  expect(data.experiments[0].summary.providerCalls).toBe(0);
  expect(data.experiments[0].summary.promotionEligible).toBe(false);
});
