import { test, expect } from "@playwright/test";

// Live link-health checks for the footer "Data:" credits. These hit the
// real internet to catch the case where a destination starts returning a
// 404 / soft-error page (which has burned this site's links before).
//
// Inherently network-dependent: if one fails, confirm the site is actually
// down or changed before treating it as a regression. Retries are bumped
// to absorb transient blips.

const FOOTER_LINKS = [
  { label: "aviationweather.gov", url: "https://aviationweather.gov/",       marker: /aviation weather/i },
  { label: "NOAA NWS",           url: "https://www.weather.gov/",            marker: /national weather service/i },
  { label: "KING 5",             url: "https://www.king5.com/radar",         marker: /radar/i },
];

const stripSlash = (u) => u.replace(/\/+$/, "");

test.describe("footer data-source links are live", () => {
  // Network calls can flake; give them a couple of retries even locally.
  test.describe.configure({ retries: 2 });

  test("footer hrefs match the link-health list (keeps this spec honest)", async ({ page }) => {
    await page.goto("/");
    const hrefs = await page.locator("footer a").evaluateAll((els) => els.map((a) => a.href));
    expect(hrefs.map(stripSlash).sort()).toEqual(
      FOOTER_LINKS.map((l) => stripSlash(l.url)).sort(),
    );
  });

  for (const link of FOOTER_LINKS) {
    test(`${link.label} resolves to a real page, not an error page`, async ({ page }) => {
      const resp = await page.goto(link.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      expect(resp, `no response from ${link.url}`).not.toBeNull();
      expect(resp.status(), `unexpected HTTP ${resp.status()} from ${link.url}`).toBeLessThan(400);

      // Positive signal: a known marker present in the title or body. Give
      // SPA-rendered pages (aviationweather.gov) a moment to populate.
      await page.waitForTimeout(2000);
      const title = await page.title();
      const body = await page.locator("body").innerText().catch(() => "");
      const haystack = `${title}\n${body}`;
      expect(
        link.marker.test(haystack),
        `marker ${link.marker} not found on ${link.url} (title: ${JSON.stringify(title)})`,
      ).toBe(true);
    });
  }
});
