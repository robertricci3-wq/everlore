import { test, expect } from "@playwright/test";
import type { ProjectView } from "../../src/shared/contracts.js";
import type { StudioView } from "../../src/shared/studio.js";

test("a rare identity question shows same-name context, accepts keyboard answers and retains its retry key", async ({
  page,
}) => {
  // Private HTTP fixtures only. Availability remains false and every answer is
  // intercepted; this test creates no real project or provider request.
  const answers: { questionId: string; answerId: string; key: string }[] = [];
  let answered = false;
  const engine: StudioView = {
    id: "continuity-job",
    kind: "generation",
    status: "awaiting_continuity",
    stage: "world",
    error: null,
    transcript: null,
    heart: null,
    heartHash: null,
    concepts: null,
    selectedConceptId: null,
    world: null,
    references: [],
    preview: null,
    continuity: {
      status: "needs_identity",
      question: {
        id: "which-nell",
        kind: "identity",
        prompt: "Which Nell is in this memory?",
        options: [
          {
            id: "coat-nell",
            label: "Nell",
            detail: "From The blue coat · Your aunt",
          },
          {
            id: "river-nell",
            label: "Nell",
            detail: "From River picnic · Your cousin",
          },
        ],
        allowUnspecified: true,
      },
    },
  };
  const project: ProjectView = {
    id: "continuity-fixture",
    title: "A day by the river",
    mode: "manual",
    status: "creating_legacy",
    revision: 0,
    createdAt: "2026-10-10T12:00:00Z",
    book: null,
    transcript: null,
    recording: null,
    editions: [],
    corrections: [],
    jobs: [],
    engine,
  };
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/session", (route) =>
    route.fulfill({
      json: {
        user: {
          id: "fixture-owner",
          name: "Fixture family",
          kind: "private",
          operator: false,
        },
      },
    }),
  );
  await page.route("**/api/families", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/studio-setup", (route) =>
    route.fulfill({
      json: {
        ready: false,
        canStart: false,
        canManage: false,
        hasKey: false,
        budgetUsd: 0,
        audioReserveUsd: 0,
        textReserveUsd: 0,
        imageReserveUsd: 0,
        usedReserveUsd: 0,
        cycleReserveUsd: 0,
        message: "Creation is disabled in this fixture.",
      },
    }),
  );
  await page.route("**/api/projects/continuity-fixture", (route) =>
    route.fulfill({
      json: {
        ...project,
        engine: answered
          ? {
              ...engine,
              status: "queued",
              continuity: { status: "resolved", question: null },
            }
          : engine,
      },
    }),
  );
  await page.route(
    "**/api/projects/continuity-fixture/engine/continuity",
    async (route) => {
      expect(route.request().method()).toBe("POST");
      answers.push(route.request().postDataJSON());
      if (answers.length === 1) {
        await route.fulfill({
          status: 503,
          json: { error: "Synthetic interrupted answer" },
        });
        return;
      }
      answered = true;
      await route.fulfill({ json: { status: "queued" } });
    },
  );
  await page.goto("/#/story/continuity-fixture");
  await expect(
    page.getByRole("heading", { name: "Which Nell is in this memory?" }),
  ).toBeVisible();
  await expect(
    page.getByText("From The blue coat · Your aunt", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("From River picnic · Your cousin", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "I’m not sure", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(answers).toHaveLength(0);
  await page.screenshot({
    path: "work/evidence/continuity-question-phone.png",
    fullPage: true,
    animations: "disabled",
  });

  const choice = page.getByRole("button", {
    name: "Nell From River picnic · Your cousin",
    exact: true,
  });
  await choice.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toContainText(
    "Your memory and completed work are saved",
  );
  expect(answers).toHaveLength(1);
  expect(answers[0]).toMatchObject({
    questionId: "which-nell",
    answerId: "river-nell",
  });
  expect(answers[0].key).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  await expect(choice).toBeEnabled();
  await choice.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Creating your story", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Which Nell is in this memory?" }),
  ).toHaveCount(0);
  expect(answers).toHaveLength(2);
  expect(answers[1]).toEqual(answers[0]);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
