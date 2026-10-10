import { test, expect } from "@playwright/test";

const shelfName = "synthetic-family-shelf";
const password = "Synthetic test password only";
const invitationError = "This invitation is invalid or expired.";
const loginError = "The shelf name or password does not match.";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/session", (route) =>
    route.fulfill({ json: { user: null, inviteRequired: true } }),
  );
});

test("switching from join to sign-in clears invitation errors and preserves credentials", async ({
  page,
}) => {
  const loginRequests: unknown[] = [];
  await page.route("**/api/register", (route) =>
    route.fulfill({ status: 403, json: { error: invitationError } }),
  );
  await page.route("**/api/login", (route) => {
    loginRequests.push(route.request().postDataJSON());
    return route.fulfill({ status: 401, json: { error: loginError } });
  });
  await page.goto("/#/join");
  await expect(
    page.getByRole("link", { name: "Sign in to your existing shelf" }),
  ).toBeVisible();
  await expect(
    page.getByText("New shelves are invitation-only during the pilot.", {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByLabel("Shelf name").fill(shelfName);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Invitation code").fill("synthetic-invalid-code");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create your private shelf" }).click();
  await expect(page.getByRole("alert")).toHaveText(invitationError);

  await page
    .getByRole("button", { name: "Already have a shelf? Sign in" })
    .click();
  await expect(page).toHaveURL(/#\/login$/);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("Invitation code")).toHaveCount(0);
  await expect(page.getByLabel("Shelf name")).toHaveValue(shelfName);
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue(
    password,
  );
  await page.getByRole("button", { name: "Open your shelf" }).click();
  await expect(page.getByRole("alert")).toHaveText(loginError);
  expect(loginRequests).toEqual([{ name: shelfName, password }]);

  await page.getByRole("button", { name: "New here? Create a shelf" }).click();
  await expect(page).toHaveURL(/#\/join$/);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("Shelf name")).toHaveValue(shelfName);
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue(
    password,
  );
});

test("a delayed invitation rejection never appears in the sign-in form", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let release!: () => void;
  let received = false;
  const responseReady = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/register", async (route) => {
    received = true;
    await responseReady;
    await route.fulfill({ status: 403, json: { error: invitationError } });
  });
  await page.route("**/api/login", (route) =>
    route.fulfill({ status: 401, json: { error: loginError } }),
  );
  try {
    await page.goto("/#/join");
    await page.getByLabel("Shelf name").fill(shelfName);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByLabel("Invitation code").fill("synthetic-invalid-code");
    await page.getByRole("checkbox").check();
    await page
      .getByRole("button", { name: "Create your private shelf" })
      .click();
    await expect.poll(() => received).toBe(true);
    await page
      .getByRole("link", { name: "Sign in to your existing shelf" })
      .click();
    await expect(page).toHaveURL(/#\/login$/);
    release();
    await expect(
      page.getByRole("button", { name: "Open your shelf" }),
    ).toBeEnabled();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByLabel("Shelf name")).toHaveValue(shelfName);
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue(
      password,
    );
  } finally {
    release();
  }
});
