import { test, expect } from "@playwright/test";

const shelfName = "synthetic-family-shelf";
const password = "Synthetic test password only";
const invitationError = "This invitation is invalid or expired.";
const loginError = "The shelf name or password does not match.";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/session", (route) =>
    route.fulfill({ json: { user: null, inviteRequired: true } }),
  );
  await page.route("**/api/engine", (route) =>
    route.fulfill({ json: { ready: false } }),
  );
});

test("an invitation link carries its code into a free private shelf without checkout", async ({ page }) => {
  let registered = false;
  const registrations: Record<string, unknown>[] = [];
  const paidRequests: string[] = [];
  page.on("request", (request) => {
    if (/checkout|api\.openai\.com|\/journey\/[^/]+\/create/.test(request.url()))
      paidRequests.push(request.url());
  });
  await page.route("**/api/engine", (route) => route.fulfill({ json: { ready: true } }));
  await page.route("**/api/session", async (route) => {
    if (registered) return route.fulfill({ response: await route.fetch() });
    return route.fulfill({ json: { user: null, inviteRequired: true } });
  });
  await page.route("**/api/register", async (route) => {
    registrations.push(route.request().postDataJSON());
    registered = true;
    await route.continue();
  });
  await page.goto("/#/join?invite=synthetic-link-token");
  await expect(page.getByText("Your invitation is included in this link.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Invitation code")).toHaveCount(0);
  await expect(page.getByText("Your invited digital book is free", { exact: false })).toBeVisible();
  await expect(page.getByText("No card required.", { exact: false })).toBeVisible();
  await expect(page.getByText("a printed copy is an optional purchase", { exact: false })).toBeVisible();
  await page.getByLabel("Shelf name").fill(`invited ${Date.now()}`);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create your private shelf" }).click();
  await expect(page.getByRole("heading", { name: "Your family, in stories." })).toBeVisible();
  expect(registrations).toHaveLength(1);
  expect(registrations[0].inviteCode).toBe("synthetic-link-token");
  expect(paidRequests).toEqual([]);
});

test("expired invitation links offer a manual alternative and a new link replaces the old token", async ({ page }) => {
  const registrations: Record<string, unknown>[] = [];
  let releaseOldLink!: () => void;
  const delayedRejection = new Promise<void>((resolve) => { releaseOldLink = resolve; });
  await page.route("**/api/register", async (route) => {
    registrations.push(route.request().postDataJSON());
    if (registrations.length === 2) await delayedRejection;
    return route.fulfill({ status: 403, json: { error: invitationError } });
  });
  await page.goto("/#/join?invite=synthetic-expired-token");
  await expect(page.getByText("Book creation is not available yet.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Invitation code")).toHaveCount(0);
  await page.getByLabel("Shelf name").fill(shelfName);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create your private shelf" }).click();
  await expect(page.getByRole("alert")).toHaveText(invitationError);
  await page.getByLabel("Invitation code").fill("synthetic-manual-token");
  await page.getByRole("button", { name: "Create your private shelf" }).click();
  await expect.poll(() => registrations.length).toBe(2);
  await page.evaluate(() => { location.hash = "/join?invite=synthetic-new-link-token"; });
  await expect(page.getByLabel("Invitation code")).toHaveCount(0);
  releaseOldLink();
  await expect(page.getByRole("button", { name: "Create your private shelf" })).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("Shelf name")).toHaveValue(shelfName);
  await page.getByRole("button", { name: "Create your private shelf" }).click();
  await expect.poll(() => registrations.length).toBe(3);
  expect(registrations.map((value) => value.inviteCode)).toEqual([
    "synthetic-expired-token", "synthetic-manual-token", "synthetic-new-link-token",
  ]);
  await page.getByRole("link", { name: "Sign in to your existing shelf" }).click();
  await expect(page.getByLabel("Invitation code")).toHaveCount(0);
  await expect(page.getByText("No card required.", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("operator copies a private invitation and sees a fallback when clipboard access is unavailable", async ({ page }) => {
  await page.route("**/api/session", (route) => route.fulfill({ json: {
    user: { id: "synthetic-operator", name: "operator", kind: "private", operator: true },
    inviteRequired: true,
  } }));
  await page.route("**/api/operator/access", (route) => route.fulfill({ json: {
    cycleReserveCents: 500, availableCents: 500, invitations: [],
  } }));
  const requests: Record<string, unknown>[] = [];
  await page.route("**/api/operator/invitations", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { code: "synthetic-share-token" } });
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (value: string) => sessionStorage.setItem("synthetic-copied-link", value),
    } });
  });
  await page.goto("/#/operator/access");
  await expect(page.getByText("Book creation is currently unavailable.", { exact: false })).toBeVisible();
  await page.getByLabel("Family or invitation name").fill("Synthetic family");
  await page.getByRole("button", { name: "Create invitation", exact: true }).click();
  const link = page.getByLabel("Invitation link", { exact: true });
  await expect(link).toHaveValue("http://127.0.0.1:4318/#/join?invite=synthetic-share-token");
  await page.getByRole("button", { name: "Copy invitation link", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Invitation link copied. Send it to the family you’re inviting.");
  expect(await page.evaluate(() => sessionStorage.getItem("synthetic-copied-link"))).toBe(await link.inputValue());
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { value: undefined }); });
  await page.getByRole("button", { name: "Copy invitation link", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("The link is selected. Copy it, then send it to the family you’re inviting.");
  await expect(link).toBeFocused();
  expect(await link.evaluate((input: HTMLInputElement) => input.selectionEnd! - input.selectionStart!)).toBe((await link.inputValue()).length);
  expect(requests).toEqual([{ label: "Synthetic family", bookCount: 1, expiresDays: 7, creditCents: 500 }]);
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
