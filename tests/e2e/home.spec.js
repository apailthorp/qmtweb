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
    // Viewport tall enough that the collapsed page fits (not scrollable → shown),
    // but short enough that expanding the manage panel overflows it (scrollable).
    await page.setViewportSize({ width: 1280, height: 1100 });
    const stamp = page.locator("#app-version");
    await expect(stamp).not.toHaveClass(/\bis-hidden\b/); // collapsed: shown

    // Expanding the panel grows the document with no scroll/resize event — only a
    // ResizeObserver recompute hides the now-floating tag (we're still at top).
    await page.locator("#manage-toggle").click();
    await expect(stamp).toHaveClass(/\bis-hidden\b/); // expanded + at top: hidden
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

  test("Submit buttons bind to `taf` with 0/1 values", async ({ page }) => {
    const metarOnly = page.locator("button[name='taf'][value='0']");
    const metarTaf = page.locator("button[name='taf'][value='1']");
    await expect(metarOnly).toHaveText("METAR");
    await expect(metarTaf).toHaveText("METAR/TAF");
  });

  test("Decode + Hours persist across reload (Tabular stays off)", async ({ page }) => {
    await page.locator("#decoded-toggle").check();
    await page.locator("#hours-select").selectOption("6");

    await page.reload();

    await expect(page.locator("#decoded-toggle")).toBeChecked();
    await expect(page.locator("#tabular-toggle")).not.toBeChecked();
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

  test("Tabular disables the METAR/TAF button (Tabular excludes TAF)", async ({ page }) => {
    const metarTaf = page.locator("button[name='taf'][value='1']");
    const metarOnly = page.locator("button[name='taf'][value='0']");
    await expect(metarTaf).toBeEnabled();

    await page.locator("#tabular-toggle").check();
    await expect(metarTaf).toBeDisabled();
    await expect(metarOnly).toBeEnabled(); // plain METAR still allowed

    // Turning Tabular off (here via Decode, which excludes Tabular) re-enables it.
    await page.locator("#decoded-toggle").check();
    await expect(page.locator("#tabular-toggle")).not.toBeChecked();
    await expect(metarTaf).toBeEnabled();
  });

  test("METAR/TAF disabled state persists across reload", async ({ page }) => {
    await page.locator("#tabular-toggle").check();
    await page.reload();
    await expect(page.locator("#tabular-toggle")).toBeChecked();
    await expect(page.locator("button[name='taf'][value='1']")).toBeDisabled();
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

    await page.locator("button[name='taf'][value='0']").click();
    await expect(page.locator("#form-error")).toBeVisible();
    await expect(page.locator("#form-error")).toContainText(/add at least one/i);
    expect(navigated).toBe(false);
  });

  test("typing in the query clears a prior error", async ({ page }) => {
    await page.locator("#manage-toggle").click();
    await page.locator("button[data-action='select-none']").click();
    await page.locator("button[name='taf'][value='0']").click();
    await expect(page.locator("#form-error")).toBeVisible();

    await page.locator("#icao-query").fill("K");
    await expect(page.locator("#form-error")).toBeHidden();
  });
});
