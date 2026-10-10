import { test, expect, type Page } from "@playwright/test";
const headers = { "X-Evermore-Client": "1" };
async function family(page: Page) {
  await page.goto("/#/join");
  await page.getByLabel("Shelf name").fill(`voice journey ${Date.now()}`);
  await page.getByLabel("Password", {exact:true}).fill("Synthetic recording test password");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", {name:"Create your private shelf"}).click();
  await expect(page.getByRole("button", {name:"Save a memory", exact:true})).toBeVisible();
}
test("voice to book: consent once, interrupted save recovery, extra recording and no unrequested generation", async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await family(page);
  await page.getByRole("button", {name:"Save a memory",exact:true}).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", {name:"Save a memory",exact:true}).click();
  await expect(page.locator(".timer")).toHaveText("00:02", {timeout:6000});
  const sid = page.url().split("/tell/")[1];
  await page.route("**/api/interviews/*/turns/*/audio", route => route.request().method() === "PUT" ? route.abort() : route.continue());
  await page.getByRole("button", {name:"Save for later",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("Your draft is still here");
  await page.unroute("**/api/interviews/*/turns/*/audio");
  await page.reload();
  await expect(page.getByText("Your unsaved recording is still here on this device.")).toBeVisible();
  await page.getByRole("button", {name:"Save for later",exact:true}).click();
  await expect(page.getByRole("heading", {name:"A memory, kept."})).toBeVisible();
  expect((await (await page.request.get(`/api/journey/${sid}`)).json()).requestId).toBeNull();
  const before = await (await page.request.get(`/api/interviews/${sid}`)).json();
  expect(before.session.turns[0].audio.bytes).toBeGreaterThan(44);
  await page.getByRole("button", {name:"Add something",exact:true}).click();
  await page.getByRole("button", {name:"Start telling",exact:true}).click();
  await expect(page.locator(".timer")).toHaveText("00:02", {timeout:6000});
  await page.getByRole("button", {name:"Pause",exact:true}).click();
  await page.getByRole("button", {name:"Resume",exact:true}).click();
  await page.getByRole("button", {name:"Save for later",exact:true}).click();
  await expect(page.getByRole("heading", {name:"A memory, kept."})).toBeVisible();
  const after = await (await page.request.get(`/api/interviews/${sid}`)).json();
  expect(after.session.turns).toHaveLength(2);
  expect(after.session.turns[0].audio).toEqual(before.session.turns[0].audio);
  expect(after.transcriptionJobs).toHaveLength(0);
  await page.getByRole("link", {name:"Back to your stories",exact:true}).click();
  await expect(page.getByRole("button", {name:"Save a memory",exact:true})).toBeVisible();
  await page.screenshot({path:"work/evidence/voice-book-shelf-phone.png",fullPage:true,animations:"disabled"});
  await page.getByRole("button", {name:"Save a memory",exact:true}).click();
  await expect(page.locator(".timer")).toBeVisible(); // no repeat consent or recorder-start step
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await page.getByRole("button", {name:"Save for later",exact:true}).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("voice to book: two deliberate actions request one book and preserve a lost response", async ({page}) => {
  await family(page);
  // Explicit synthetic test consent; availability is simulated, providers remain disabled.
  await page.request.post("/api/journey/start", {headers, data:{key:crypto.randomUUID(),consent:true,processWithOpenAI:true,consentVersion:"family-memory-v1"}});
  await page.route("**/api/journey/setup", async route => {
    const response = await route.fetch(); await route.fulfill({response,json:{...await response.json(),canCreate:true}});
  });
  await page.route(/\/api\/journey\/[^/]+$/, async route => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch(); await route.fulfill({response,json:{...await response.json(),canCreate:true}});
  });
  await page.reload();
  await page.getByRole("button", {name:"Record a memory",exact:true}).click(); // action 1
  await expect(page.locator(".timer")).toHaveText("00:02", {timeout:6000});
  const sid = page.url().split("/tell/")[1];
  await page.route("**/api/journey/*/create", async route => { await route.fetch(); await route.abort(); }, {times:1});
  await page.getByRole("button", {name:"Make my book",exact:true}).click(); // action 2
  await expect(page.getByRole("heading", {name:"Your memory is waiting safely."})).toBeVisible({timeout:10000});
  const first = await (await page.request.get(`/api/journey/${sid}`)).json();
  expect(first.requestId).toBeTruthy();
  const retry = await page.request.post(`/api/journey/${sid}/create`, {headers, data:{key:crypto.randomUUID(),consentVersion:"family-memory-v1",processWithOpenAI:true,imaginativeAdaptation:true}});
  expect((await retry.json()).requestId).toBe(first.requestId);
  await page.reload();
  await expect(page.getByRole("heading", {name:"Your memory is waiting safely."})).toBeVisible();
  const session = await (await page.request.get(`/api/interviews/${sid}`)).json();
  expect(session.session.turns).toHaveLength(1);
  expect(session.transcriptionJobs).toHaveLength(0);
});

test("record-first design: desktop, keyboard, reduced motion and no hidden service controls", async ({page}) => {
  await page.setViewportSize({width:1440,height:1000});
  await page.emulateMedia({reducedMotion:"reduce"});
  await family(page);
  const button = page.getByRole("button", {name:"Save a memory",exact:true});
  await expect(button).toBeInViewport();
  await page.getByRole("button", {name:"Help me begin",exact:true}).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".record-idea")).toBeVisible();
  await page.getByRole("button", {name:"Another idea",exact:true}).click();
  await expect(page.locator(".record-art img")).toBeVisible();
  await expect.poll(() => page.locator(".record-art img").evaluate(e => (e as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await page.screenshot({path:"work/evidence/voice-book-shelf-desktop.png",fullPage:true});
  expect(await page.locator("main").innerText()).not.toMatch(/API key|allowance|engine version|craft library|research/i);
});
