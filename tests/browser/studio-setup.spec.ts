import { test, expect } from "@playwright/test";
import type { StudioSetupView } from "../../src/shared/studioSetup.js";

test("operator setup retains settings while family creation hides administration and requires sharing consent", async ({
  page,
}) => {
  // Isolated HTTP fixtures: no real key, allowance, family data or paid request.
  let saves = 0,
    starts = 0,
    failSave = false,
    operator = false,
    operatorReads = 0;
  let startBody: unknown;
  let state: StudioSetupView = {
    ready: false,
    canStart: false,
    canManage: true,
    hasKey: false,
    budgetUsd: 0,
    audioReserveUsd: 0,
    textReserveUsd: 0,
    imageReserveUsd: 0,
    usedReserveUsd: 0,
    cycleReserveUsd: 0,
    message: "Save your connection and allowance first.",
  };
  await page.route("**/api/session", (route) =>
    route.fulfill({
      json: {
        user: {
          id: "test",
          name: "Synthetic setup test",
          kind: "private",
          operator,
        },
      },
    }),
  );
  await page.route("**/api/families", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/projects/setup-fixture", (route) =>
    route.fulfill({
      json: {
        id: "setup-fixture",
        title: "Synthetic setup test",
        mode: "unavailable",
        status: "awaiting_transcription",
        revision: 0,
        createdAt: new Date().toISOString(),
        transcript: null,
        book: null,
        engine: null,
        recording: { id: "audio", mime: "audio/wav", bytes: 16044 },
        jobs: [],
        editions: [],
        corrections: [],
      },
    }),
  );
  await page.route("**/api/projects/setup-fixture/engine", (route) => {
    starts++;
    startBody = route.request().postDataJSON();
    return route.fulfill({
      status: 409,
      json: { error: "Synthetic generation intercepted; no provider called." },
    });
  });
  await page.route("**/api/studio-setup", (route) => {
    expect(route.request().method()).toBe("GET");
    return route.fulfill({
      json: {
        ...state,
        canManage: false,
        hasKey: false,
        budgetUsd: 0,
        audioReserveUsd: 0,
        textReserveUsd: 0,
        imageReserveUsd: 0,
        usedReserveUsd: 0,
        cycleReserveUsd: 0,
        message: state.canStart
          ? "Your story studio is ready."
          : "Story creation is not enabled right now.",
      },
    });
  });
  await page.route("**/api/operator/studio-setup", (route) => {
    if (!operator)
      return route.fulfill({
        status: 403,
        json: { error: "Only the configured operator can manage the service." },
      });
    if (route.request().method() === "GET") operatorReads++;
    if (route.request().method() === "POST") {
      saves++;
      if (failSave)
        return route.fulfill({
          status: 409,
          json: { error: "Synthetic save failure; try again." },
        });
      const body = route.request().postDataJSON();
      state = {
        ...state,
        ready: true,
        hasKey: true,
        canStart: body.budgetUsd >= 69.5,
        budgetUsd: body.budgetUsd,
        audioReserveUsd: 3,
        textReserveUsd: 0.5,
        imageReserveUsd: 0.75,
        cycleReserveUsd: 69.5,
        message:
          body.budgetUsd >= 69.5
            ? "Connection saved."
            : "Your connection is saved. The total allowance needs to be at least $69.50.",
      };
    }
    return route.fulfill({ json: state });
  });
  await page.goto("/#/story/setup-fixture");
  const make = page.getByRole("button", { name: "Make my legacy story" });
  await expect(page.locator(".story-studio .notice")).toContainText(
    "Story creation is not enabled",
  );
  await make.click();
  await expect(page.locator(".story-studio > [role=alert]")).toContainText(
    "Your memory is saved",
  );
  await expect(page.locator(".studio-setup")).toHaveCount(0);
  await expect(page.getByLabel("API key", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Total allowance in US dollars")).toHaveCount(0);
  expect(operatorReads).toBe(0);
  expect(starts).toBe(0);

  // A family visiting the operator URL sees the denial, never a setup form.
  // Server ownership is tested independently by the API integration suite.
  await page.goto("/#/operator/studio");
  await expect(page.getByRole("alert")).toContainText(
    "Only the configured operator",
  );
  await expect(page.locator(".studio-setup")).toHaveCount(0);
  operator = true;
  await page.reload();
  await page.getByText("Connect the story studio", { exact: true }).click();
  await expect(page.locator(".studio-setup")).toHaveAttribute("open", "");
  await page
    .getByLabel("API key", { exact: true })
    .fill("sk-synthetic-browser-test-no-provider");
  const save = page.getByRole("button", {
    name: "Save connection and allowance",
  });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.locator(".studio-setup [role=alert]")).toContainText(
    "total allowance",
  );
  expect(saves).toBe(0);
  await page.getByLabel("Total allowance in US dollars").fill("10");
  await save.click();
  await expect(page.locator(".studio-setup [role=alert]")).toContainText(
    "authorization box",
  );
  await page
    .getByRole("checkbox", { name: /I authorize this allowance/ })
    .check();
  failSave = true;
  await save.click();
  await expect(page.locator(".studio-setup [role=alert]")).toContainText(
    "Synthetic save failure",
  );
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue(
    "sk-synthetic-browser-test-no-provider",
  );
  failSave = false;
  await save.click();
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
  await expect(page.getByRole("status")).toContainText(
    "Service settings saved",
  );
  expect(starts).toBe(0);
  // Even an operator viewing a family story gets the simple availability flow.
  await page.goto("/#/story/setup-fixture");
  await expect(page.locator(".story-studio .notice")).toContainText(
    "Story creation is not enabled",
  );
  await make.click();
  await expect(page.locator(".story-studio > [role=alert]")).toContainText(
    "Your memory is saved",
  );
  await expect(page.locator(".studio-setup")).toHaveCount(0);
  await expect(page.getByText(/at least \$69\.50/)).toHaveCount(0);
  expect(starts).toBe(0);

  await page.goto("/#/operator/studio");
  await page
    .getByText("Connection and allowance settings", { exact: true })
    .click();
  await expect(page.getByLabel("Total allowance in US dollars")).toHaveValue(
    "10",
  );
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
  await page.getByLabel("Total allowance in US dollars").fill("69.5");
  await page
    .getByRole("checkbox", { name: /I authorize this allowance/ })
    .check();
  await save.click();
  await expect(page.getByRole("status")).toContainText(
    "Service settings saved",
  );
  expect(starts).toBe(0);
  await page.reload();
  await page
    .getByText("Connection and allowance settings", { exact: true })
    .click();
  await expect(page.getByLabel("Total allowance in US dollars")).toHaveValue(
    "69.5",
  );
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
  expect(saves).toBe(3); // One rejected save and two successful saves, no generation.
  expect(starts).toBe(0);
  operator = false;
  await page.goto("/#/story/setup-fixture");
  await page.reload();
  await expect(page.locator(".story-studio .notice")).toContainText(
    "Your story studio is ready",
  );
  await expect(page.locator(".studio-setup")).toHaveCount(0);
  await expect(page.getByLabel("API key", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Total allowance in US dollars")).toHaveCount(0);
  await expect(
    page.getByRole("checkbox", { name: /I authorize this allowance/ }),
  ).toHaveCount(0);
  await make.click();
  await expect(page.locator(".story-studio > [role=alert]")).toContainText(
    "recording-sharing box",
  );
  expect(starts).toBe(0);
  await page
    .getByRole("checkbox", { name: /I want an imaginative adaptation/ })
    .check();
  await make.click();
  await expect(page.locator(".story-studio > [role=alert]")).toContainText(
    "Your memory and completed work are saved",
  );
  await expect(
    page.getByText("Synthetic generation intercepted", { exact: false }),
  ).toHaveCount(0);
  expect(starts).toBe(1);
  expect(startBody).toMatchObject({
    processWithOpenAI: true,
    imaginativeAdaptation: true,
  });
});
