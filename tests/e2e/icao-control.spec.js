import { test, expect } from "@playwright/test";

const SEED_12 = [
  "KPAE", "KBFI", "KRNT", "KPWT", "KOLM", "KHQM",
  "KSEA", "KTIW", "KBLI", "KAWO", "KORS", "KFHR",
];
const DEFAULT_6 = SEED_12.slice(0, 6);

async function openPanel(page) {
  await page.locator("#manage-toggle").click();
  await expect(page.locator("#manage-toggle")).toHaveAttribute("aria-expanded", "true");
}

async function idsCodes(page) {
  return (await page.locator("#ids").inputValue()).split(/\s+/).filter(Boolean);
}

async function tileOrder(page) {
  return page.locator("#icao-tiles .tile").evaluateAll(
    (els) => els.map((e) => e.getAttribute("data-icao")),
  );
}

const tile = (icao) => `.tile[data-icao='${icao}']`;
const toggle = (icao) => `[data-toggle-icao='${icao}']`;

test.describe("ICAO tiles — collapsed defaults", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("starts collapsed showing only the active tiles", async ({ page }) => {
    await expect(page.locator("#manage-toggle")).toHaveAttribute("aria-expanded", "false");
    // 12 tiles exist; the 6 active are visible, the rest hidden.
    await expect(page.locator("#icao-tiles .tile")).toHaveCount(12);
    await expect(page.locator(".tile.is-active")).toHaveCount(6);
    await expect(page.locator(tile("KPAE"))).toBeVisible();
    await expect(page.locator(tile("KSEA"))).toBeHidden();
  });

  test("count badge reflects (selected/list)", async ({ page }) => {
    await expect(page.locator("#icao-count")).toContainText("(6/12)");
  });

  test("hidden #ids holds the active selection in order", async ({ page }) => {
    expect(await idsCodes(page)).toEqual(DEFAULT_6);
  });

  test("Online button is hidden until expanded, then visible + disabled", async ({ page }) => {
    await expect(page.locator("#icao-search-external")).toBeHidden();
    await openPanel(page);
    const btn = page.locator("#icao-search-external");
    await expect(btn).toBeVisible();
    await expect(btn).toBeDisabled();
    await expect(btn).toHaveAttribute("title", /Online search not yet wired/i);
  });
});

test.describe("ICAO tiles — expand / collapse", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("manage toggle expands to show all tiles + actions", async ({ page }) => {
    await openPanel(page);
    await expect(page.locator("#tile-control")).toHaveClass(/\bis-open\b/);
    await expect(page.locator(tile("KSEA"))).toBeVisible(); // inactive now shown
    await expect(page.locator("#icao-actions")).toBeVisible();
  });

  test("Escape closes the panel and refocuses the toggle", async ({ page }) => {
    await openPanel(page);
    await page.keyboard.press("Escape");
    await expect(page.locator("#manage-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#manage-toggle")).toBeFocused();
  });
});

test.describe("ICAO tiles — activate / hide + actions", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await openPanel(page);
  });

  test("the first 6 tiles are active by default", async ({ page }) => {
    for (const icao of DEFAULT_6) {
      await expect(page.locator(tile(icao))).toHaveClass(/\bis-active\b/);
    }
    await expect(page.locator(tile("KSEA"))).not.toHaveClass(/\bis-active\b/);
  });

  test("clicking a tile toggles it active and updates #ids + count", async ({ page }) => {
    await page.locator(toggle("KSEA")).click();
    await expect(page.locator(tile("KSEA"))).toHaveClass(/\bis-active\b/);
    await expect(page.locator("#icao-count")).toContainText("(7/12)");
    expect(await idsCodes(page)).toContain("KSEA");

    await page.locator(toggle("KSEA")).click();
    await expect(page.locator(tile("KSEA"))).not.toHaveClass(/\bis-active\b/);
    expect(await idsCodes(page)).not.toContain("KSEA");
  });

  test("All / None / Restore defaults", async ({ page }) => {
    await page.locator("button[data-action='select-all']").click();
    await expect(page.locator("#icao-count")).toContainText("(12/12)");

    await page.locator("button[data-action='select-none']").click();
    await expect(page.locator("#icao-count")).toContainText("(0/12)");

    await page.locator("button[data-action='select-defaults']").click();
    await expect(page.locator("#icao-count")).toContainText("(6/12)");
    expect(await idsCodes(page)).toEqual(DEFAULT_6);
  });
});

test.describe("ICAO tiles — query tokenization", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("a valid ICAO + space becomes a tile inserted after the last active", async ({ page }) => {
    const q = page.locator("#icao-query");
    await q.fill("KSFO");
    await q.press("Space");

    await expect(page.locator(tile("KSFO"))).toHaveClass(/\bis-active\b/);
    expect(await idsCodes(page)).toEqual([...DEFAULT_6, "KSFO"]);
    const order = await tileOrder(page);
    expect(order.indexOf("KSFO")).toBe(order.indexOf("KHQM") + 1);
    await expect(q).toHaveValue(""); // consumed into a tile
  });

  test("a non-ICAO word stays as query text and adds no tile (no transient prefix)", async ({ page }) => {
    const q = page.locator("#icao-query");
    await q.fill("Ilwaco");
    await q.press("Space");

    // No tile created — crucially not the 4-char prefix "ILWA".
    await expect(page.locator("#icao-tiles .tile")).toHaveCount(12);
    await expect(page.locator(tile("ILWA"))).toHaveCount(0);
    await expect(page.locator("#icao-count")).toContainText("(6/12)");
    await expect(q).toHaveValue(/Ilwaco/);
  });

  test("Backspace on an empty query removes the last active tile", async ({ page }) => {
    const q = page.locator("#icao-query");
    await q.focus();
    await q.press("Backspace");

    await expect(page.locator(tile("KHQM"))).not.toHaveClass(/\bis-active\b/);
    await expect(page.locator("#icao-count")).toContainText("(5/12)");
    expect(await idsCodes(page)).not.toContain("KHQM");
  });
});

test.describe("ICAO tiles — reorder via arrows", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await openPanel(page);
  });

  test("first tile ↑ disabled; last tile ↓ disabled", async ({ page }) => {
    await expect(page.locator("[data-move-icao='KPAE'][data-direction='up']")).toBeDisabled();
    await expect(page.locator("[data-move-icao='KFHR'][data-direction='down']")).toBeDisabled();
  });

  test("clicking ↓ on the first tile swaps it with the second", async ({ page }) => {
    await page.locator("[data-move-icao='KPAE'][data-direction='down']").click();
    expect((await tileOrder(page)).slice(0, 3)).toEqual(["KBFI", "KPAE", "KRNT"]);
  });

  test("reorder is reflected in #ids order", async ({ page }) => {
    await page.locator("[data-move-icao='KBFI'][data-direction='up']").click();
    expect((await idsCodes(page)).slice(0, 2)).toEqual(["KBFI", "KPAE"]);
  });

  test("reorder persists across reload", async ({ page }) => {
    await page.locator("[data-move-icao='KPAE'][data-direction='down']").click();
    await page.reload();
    await openPanel(page);
    expect((await tileOrder(page)).slice(0, 2)).toEqual(["KBFI", "KPAE"]);
  });
});

test.describe("ICAO tiles — remove (−)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await openPanel(page);
  });

  test("clicking − removes the tile from the list and #ids", async ({ page }) => {
    await page.locator(".tile-remove[data-remove-icao='KPAE']").click();
    await expect(page.locator("#icao-tiles .tile")).toHaveCount(11);
    expect(await idsCodes(page)).not.toContain("KPAE");
  });

  test("removal persists across reload", async ({ page }) => {
    await page.locator(".tile-remove[data-remove-icao='KPAE']").click();
    await page.reload();
    await openPanel(page);
    await expect(page.locator("#icao-tiles .tile")).toHaveCount(11);
    await expect(page.locator(tile("KPAE"))).toHaveCount(0);
  });

  test("− is disabled once a single entry remains", async ({ page }) => {
    for (const icao of SEED_12.slice(0, 11)) {
      await page.locator(`.tile-remove[data-remove-icao='${icao}']`).click();
    }
    await expect(page.locator("#icao-tiles .tile")).toHaveCount(1);
    await expect(page.locator(".tile-remove")).toBeDisabled();
  });
});

test.describe("ICAO tiles — local autocomplete search", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("typing 2+ chars shows local results", async ({ page }) => {
    await page.locator("#icao-query").fill("Heath");
    await expect(page.locator("#icao-search-results button[data-add-icao]").first())
      .toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#icao-search-results")).toContainText(/Heathrow/i);
  });

  test("clicking a result adds + selects it after the last active", async ({ page }) => {
    await page.locator("#icao-query").fill("KSFO");
    const result = page.locator("#icao-search-results button[data-add-icao='KSFO']");
    await expect(result).toBeVisible({ timeout: 10_000 });
    await result.click();

    await expect(page.locator(tile("KSFO"))).toHaveClass(/\bis-active\b/);
    await expect(page.locator("#icao-query")).toHaveValue("");
    expect(await idsCodes(page)).toEqual([...DEFAULT_6, "KSFO"]);
  });

  test("an already-active airport shows 'active' and is disabled", async ({ page }) => {
    await page.locator("#icao-query").fill("KPAE");
    const btn = page.locator("#icao-search-results button[data-add-icao='KPAE']");
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await expect(btn).toBeDisabled();
    await expect(btn).toContainText(/active/i);
  });

  test("at LIST_MAX (20) the result is disabled with a 'list full' hint", async ({ page }) => {
    const q = page.locator("#icao-query");
    const extras = ["KSFO", "KLAX", "KJFK", "KORD", "KDFW", "KATL", "KDEN", "KPHX"];
    for (const code of extras) {
      await q.fill(code);
      await q.press("Space");
    }
    await expect(page.locator("#icao-tiles .tile")).toHaveCount(20);

    await q.fill("KMIA");
    const btn = page.locator("#icao-search-results button[data-add-icao='KMIA']");
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await expect(btn).toBeDisabled();
    await expect(btn).toContainText(/list full/i);
  });

  test("nonsense queries surface a 'no local match' message", async ({ page }) => {
    await page.locator("#icao-query").fill("zzzqxqx");
    await expect(page.locator("#icao-search-status"))
      .toContainText(/no local match/i, { timeout: 10_000 });
  });
});

test.describe("ICAO tiles — drag and drop reorder", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await openPanel(page);
  });

  test("dropping in the lower half of a later tile inserts after it", async ({ page }) => {
    const src = page.locator(tile("KPAE"));
    const dst = page.locator(tile("KRNT"));
    const box = await dst.boundingBox();
    await src.dragTo(dst, { targetPosition: { x: box.width / 2, y: box.height - 4 } });

    const order = await tileOrder(page);
    expect(order.indexOf("KPAE")).toBeGreaterThan(order.indexOf("KRNT"));
  });

  test("dropping in the upper half of an earlier tile inserts before it", async ({ page }) => {
    // Short, near-the-top drag (KPWT idx 3 → KBFI idx 1) — long synthetic
    // native-DnD drags don't register reliably.
    const src = page.locator(tile("KPWT"));
    const dst = page.locator(tile("KBFI"));
    const box = await dst.boundingBox();
    await src.dragTo(dst, { targetPosition: { x: box.width / 2, y: 4 } });

    const order = await tileOrder(page);
    expect(order.indexOf("KPWT")).toBeLessThan(order.indexOf("KBFI"));
  });
});

test.describe("ICAO tiles — persistence", () => {
  test("activation persists across reload", async ({ page }) => {
    await page.goto("/");
    await openPanel(page);
    await page.locator(toggle("KSEA")).click();
    await expect(page.locator("#icao-count")).toContainText("(7/12)");

    await page.reload();
    await expect(page.locator("#icao-count")).toContainText("(7/12)");
    expect(await idsCodes(page)).toContain("KSEA");
  });
});
