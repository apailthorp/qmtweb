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

  test("shows the version stamp (pinned bottom-left, 'dev' when unstamped)", async ({ page }) => {
    const stamp = page.locator("#app-version");
    // version.js replaces the unstamped __APP_VERSION__ token with "dev" locally.
    await expect(stamp).toHaveText("dev");
    // Both checks are viewport-independent. We deliberately don't assert
    // toBeVisible(): the badge auto-hides via opacity (not display/visibility),
    // so that depends on scroll position and wouldn't be meaningful here.
    const position = await stamp.evaluate((el) => getComputedStyle(el).position);
    expect(position).toBe("fixed");
  });

  test("version stamp hides when the manage panel expands the page past the viewport", async ({ page }) => {
    // Measure the collapsed content height at a short viewport (so scrollHeight
    // reflects content, not the viewport), then size the viewport just above it.
    // Deterministic across fonts/environments — no hard-coded pixel height.
    await page.setViewportSize({ width: 1280, height: 400 });
    const collapsedH = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: 1280, height: collapsedH + 60 });

    const stamp = page.locator("#app-version");
    await expect(stamp).not.toHaveClass(/\bis-hidden\b/); // collapsed fits → shown

    // Expanding grows the document with no scroll/resize event — only a
    // ResizeObserver recompute hides the now-floating tag (we're still at top).
    await page.locator("#manage-toggle").click();
    await expect(stamp).toHaveClass(/\bis-hidden\b/); // expanded overflows → hidden
  });

  test("KING 5 radar grid has all 16 links pointing at the tegna-media CDN", async ({ page }) => {
    const radarLinks = page.locator("[data-testid='radar-grid'] a");
    await expect(radarLinks).toHaveCount(16);
    const hrefs = await radarLinks.evaluateAll((els) => els.map((a) => a.href));
    for (const href of hrefs) {
      expect(href).toMatch(/^https:\/\/cdn\.tegna-media\.com\/king\/weather\/.+Anim-640x480\.gif$/);
    }
    // All 16 are distinct.
    expect(new Set(hrefs).size).toBe(16);
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
    const codes = value.split(/\s+/).filter(Boolean);
    expect(codes).toEqual(EXPECTED_AIRPORTS);
  });

  test("METAR form posts to the aviationweather.gov SPA form route", async ({ page }) => {
    const action = await page.locator("#metar-form").getAttribute("action");
    expect(action).toBe("https://aviationweather.gov/data/metar/");
  });

  test("Decode toggle defaults off and submits decoded=1 when on", async ({ page }) => {
    const toggle = page.locator("#decoded-toggle");
    await expect(toggle).toHaveAttribute("type", "checkbox");
    await expect(toggle).toHaveAttribute("role", "switch");
    await expect(toggle).toHaveAttribute("name", "decoded");
    await expect(toggle).toHaveAttribute("value", "1");
    await expect(toggle).not.toBeChecked();          // off by default

    await toggle.check();
    await expect(toggle).toBeChecked();              // user can flip it on
  });

  test("single submit button — TAF rides on its own toggle (name=taf, value=1)", async ({ page }) => {
    const submit = page.locator("form#metar-form button[type='submit']");
    await expect(submit).toHaveCount(1);
    await expect(submit).toHaveText("METAR");
    // TAF rides on the toggle — when checked, the form GETs taf=1; when not, no taf= param at all.
    const tafToggle = page.locator("#taf-toggle");
    await expect(tafToggle).toHaveAttribute("name", "taf");
    await expect(tafToggle).toHaveAttribute("value", "1");
    await expect(tafToggle).toHaveAttribute("role", "switch");
  });

  test("Decode + Hours persist across reload (Tabular and TAF stay off)", async ({ page }) => {
    await page.locator("#decoded-toggle").check();
    await page.locator("#hours-select").selectOption("6");

    await page.reload();

    await expect(page.locator("#decoded-toggle")).toBeChecked();
    await expect(page.locator("#tabular-toggle")).not.toBeChecked();
    await expect(page.locator("#taf-toggle")).not.toBeChecked();
    await expect(page.locator("#hours-select")).toHaveValue("6");
  });

  test("Tabular toggle is a switch bound to tabular=1, off by default", async ({ page }) => {
    const toggle = page.locator("#tabular-toggle");
    await expect(toggle).toHaveAttribute("role", "switch");
    await expect(toggle).toHaveAttribute("name", "tabular");
    await expect(toggle).toHaveAttribute("value", "1");
    await expect(toggle).not.toBeChecked();
  });

  test("Decode and Tabular are mutually exclusive", async ({ page }) => {
    const decode = page.locator("#decoded-toggle");
    const tabular = page.locator("#tabular-toggle");

    await decode.check();
    await expect(decode).toBeChecked();
    await expect(tabular).not.toBeChecked();

    // Turning Tabular on forces Decode off.
    await tabular.check();
    await expect(tabular).toBeChecked();
    await expect(decode).not.toBeChecked();

    // And back the other way.
    await decode.check();
    await expect(decode).toBeChecked();
    await expect(tabular).not.toBeChecked();

    // Both may be off.
    await decode.uncheck();
    await expect(decode).not.toBeChecked();
    await expect(tabular).not.toBeChecked();
  });

  test("mutual exclusion survives a reload", async ({ page }) => {
    await page.locator("#decoded-toggle").check();
    await page.locator("#tabular-toggle").check(); // flips decode off
    await page.reload();
    await expect(page.locator("#tabular-toggle")).toBeChecked();
    await expect(page.locator("#decoded-toggle")).not.toBeChecked();
  });

  test("Tabular and TAF are mutually exclusive", async ({ page }) => {
    const tabular = page.locator("#tabular-toggle");
    const taf = page.locator("#taf-toggle");

    // Turn TAF on, then Tabular — Tabular forces TAF off.
    await taf.check();
    await expect(taf).toBeChecked();
    await expect(tabular).not.toBeChecked();
    await tabular.check();
    await expect(tabular).toBeChecked();
    await expect(taf).not.toBeChecked();

    // And the reverse — turning TAF on forces Tabular off.
    await taf.check();
    await expect(taf).toBeChecked();
    await expect(tabular).not.toBeChecked();
  });

  test("Decode + TAF can co-exist (only Tabular conflicts with TAF)", async ({ page }) => {
    await page.locator("#decoded-toggle").check();
    await page.locator("#taf-toggle").check();
    await expect(page.locator("#decoded-toggle")).toBeChecked();
    await expect(page.locator("#taf-toggle")).toBeChecked();
    await expect(page.locator("#tabular-toggle")).not.toBeChecked();
  });

  test("TAF state persists across reload", async ({ page }) => {
    await page.locator("#taf-toggle").check();
    await page.reload();
    await expect(page.locator("#taf-toggle")).toBeChecked();
  });

  test("an empty selection blocks submission with an inline error", async ({ page }) => {
    // The tile control only ever puts valid ICAOs in the hidden #ids, so the
    // sole error path is submitting with nothing selected.
    await page.locator("#manage-toggle").click();
    await page.locator("button[data-action='select-none']").click();
    await expect(page.locator("#icao-count")).toContainText("(0/12)");

    // Capture navigation attempts; if validation blocks, no nav happens.
    let navigated = false;
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame() && !f.url().endsWith("/")) navigated = true;
    });

    await page.locator("form#metar-form button[type='submit']").click();
    await expect(page.locator("#form-error")).toBeVisible();
    await expect(page.locator("#form-error")).toContainText(/add at least one/i);
    expect(navigated).toBe(false);
  });

  test("typing in the query clears a prior error", async ({ page }) => {
    await page.locator("#manage-toggle").click();
    await page.locator("button[data-action='select-none']").click();
    await page.locator("form#metar-form button[type='submit']").click();
    await expect(page.locator("#form-error")).toBeVisible();

    await page.locator("#icao-query").fill("K");
    await expect(page.locator("#form-error")).toBeHidden();
  });
});
