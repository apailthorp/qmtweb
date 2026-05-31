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
  { label: "NOAA NWS",            url: "https://www.weather.gov/",           marker: /national weather service/i },
  { label: "KING 5",              url: "https://www.king5.com/radar",        marker: /radar/i },
  // Tier-2 LLM providers in the multi-provider chain. Each is credited even
  // when the local deploy doesn't have its API key — the site supports them
  // as a capability list. Markers match each provider's homepage content.
  { label: "Google Gemini",       url: "https://ai.google.dev/",             marker: /gemini|google ai/i },
  { label: "OpenRouter",          url: "https://openrouter.ai/",             marker: /openrouter|model|api/i },
  { label: "Cerebras",            url: "https://www.cerebras.ai/",           marker: /cerebras/i },
  { label: "Groq",                url: "https://groq.com/",                  marker: /groq/i },
];

const stripSlash = (u) => u.replace(/\/+$/, "");

test.describe("footer data-source links are live", () => {
  // Network calls can flake; give them a couple of retries even locally.
  test.describe.configure({ retries: 2 });

  test("footer hrefs match the link-health list (keeps this spec honest)", async ({ page }) => {
    // Block /api/health.php so the runtime configured-providers prune doesn't
    // fire. This spec is a registry check — every link in the markup must be
    // in FOOTER_LINKS — independent of which providers happen to have keys in
    // the dev / CI environment. The endpoint exists to prune the live footer
    // to actually-configured providers in production; tested in isolation.
    await page.route("**/api/health.php", (route) => route.abort());
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

      // Positive signal: a known marker present in the title or body. Poll
      // for it (up to 10s) instead of a fixed delay — SPA-rendered pages
      // (aviationweather.gov, Cerebras) hydrate at variable speeds, so a
      // content-based wait passes as soon as the marker appears and avoids
      // a wasted 2s on pages that render synchronously.
      const matched = await page.waitForFunction(
        ({ src, flags }) => {
          const re = new RegExp(src, flags);
          const t = document.title || "";
          const b = document.body ? document.body.innerText : "";
          return re.test(`${t}\n${b}`);
        },
        { src: link.marker.source, flags: link.marker.flags },
        { timeout: 10_000 },
      ).then(() => true, () => false);

      // Final assertion with the detailed error message — runs even if the
      // poll timed out, so we get a useful "marker X not found on URL"
      // failure rather than a generic Playwright timeout.
      const title = await page.title();
      const body = await page.locator("body").innerText().catch(() => "");
      expect(
        link.marker.test(`${title}\n${body}`),
        `marker ${link.marker} not found on ${link.url} (title: ${JSON.stringify(title)}, polled: ${matched})`,
      ).toBe(true);
    });
  }
});
