import { test, expect } from "@playwright/test";

const EXPECTED_AIRPORTS = ["KPAE", "KBFI", "KRNT", "KPWT", "KOLM", "KHQM"];

test.describe("pailthorp.net home page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("renders the heading and tagline", async ({ page }) => {
    await expect(page).toHaveTitle(/pailthorp\.net/);
    await expect(page.getByRole("heading", { name: "pailthorp.net", level: 1 })).toBeVisible();
    await expect(page.locator(".tagline")).toContainText(/METAR/i);
  });

  test("KING 5 radar links point at tegna-media CDN", async ({ page }) => {
    const radarLinks = page.locator("[data-testid='radar-distance'] a, [data-testid='radar-regional'] a");
    await expect(radarLinks).toHaveCount(6);
    const hrefs = await radarLinks.evaluateAll((els) => els.map((a) => a.href));
    for (const href of hrefs) {
      expect(href).toMatch(/^https:\/\/cdn\.tegna-media\.com\/king\/weather\//);
    }
  });

  test("NOAA forecast links point at current (non-retired) endpoints", async ({ page }) => {
    const links = page.locator(".forecast-list a");
    await expect(links).toHaveCount(2);
    const hrefs = await links.evaluateAll((els) => els.map((a) => a.href));
    expect(hrefs).toEqual([
      "https://aviationweather.gov/gfa/",
      expect.stringMatching(/^https:\/\/forecast\.weather\.gov\/product\.php\?.*product=AFD/),
    ]);
  });

  test("METAR form is prepopulated with the expected airports", async ({ page }) => {
    const ids = page.locator("#ids");
    const value = await ids.inputValue();
    const codes = value.split(",").map((s) => s.trim());
    expect(codes).toEqual(EXPECTED_AIRPORTS);
  });

  test("METAR form posts to the aviationweather.gov SPA form route", async ({ page }) => {
    const action = await page.locator("#metar-form").getAttribute("action");
    expect(action).toBe("https://aviationweather.gov/data/metar/");
  });

  test("Format radio binds to `decoded` param with 0/1 values", async ({ page }) => {
    const raw = page.locator("input[name='decoded'][value='0']");
    const translated = page.locator("input[name='decoded'][value='1']");
    await expect(raw).toBeChecked();
    await expect(translated).not.toBeChecked();
  });

  test("Submit buttons bind to `taf` with 0/1 values", async ({ page }) => {
    const metarOnly = page.locator("button[name='taf'][value='0']");
    const metarTaf = page.locator("button[name='taf'][value='1']");
    await expect(metarOnly).toHaveText("METAR");
    await expect(metarTaf).toHaveText(/METAR \+ TAF/);
  });

  test("invalid ICAOs surface an inline error and block submission", async ({ page }) => {
    await page.locator("#ids").fill("BAD,KBFI");

    // Capture navigation attempts; if validation blocks, no nav happens.
    let navigated = false;
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame() && !f.url().endsWith("/")) navigated = true;
    });

    await page.locator("button[name='taf'][value='0']").click();
    await expect(page.locator("#form-error")).toBeVisible();
    await expect(page.locator("#form-error")).toContainText(/BAD/);
    expect(navigated).toBe(false);
  });

  test("editing the ICAO field clears a prior error", async ({ page }) => {
    await page.locator("#ids").fill("BAD");
    await page.locator("button[name='taf'][value='0']").click();
    await expect(page.locator("#form-error")).toBeVisible();

    await page.locator("#ids").fill("KPAE");
    await expect(page.locator("#form-error")).toBeHidden();
  });
});
