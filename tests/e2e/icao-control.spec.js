import { test, expect } from "@playwright/test";

const SEED_12 = [
  "KPAE", "KBFI", "KRNT", "KPWT", "KOLM", "KHQM",
  "KSEA", "KTIW", "KBLI", "KAWO", "KORS", "KFHR",
];
const DEFAULT_SELECTED_6 = SEED_12.slice(0, 6);

async function openPanel(page) {
  await page.locator("#manage-toggle").click();
  await expect(page.locator("#manage-toggle")).toHaveAttribute("aria-expanded", "true");
}

test.describe("ICAO list — toggle + checkbox grid", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("manage panel starts hidden and toggles open via the button", async ({ page }) => {
    await expect(page.locator("#manage-panel")).toBeHidden();
    await expect(page.locator("#manage-toggle")).toHaveAttribute("aria-expanded", "false");
    await openPanel(page);
    await expect(page.locator("#manage-panel")).toBeVisible();
    await expect(page.locator("#icao-presets .icao-row")).toHaveCount(12);
  });

  test("Escape closes the panel and returns focus to the toggle", async ({ page }) => {
    await openPanel(page);
    await page.keyboard.press("Escape");
    await expect(page.locator("#manage-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#manage-panel")).toBeHidden();
    await expect(page.locator("#manage-toggle")).toBeFocused();
  });

  test("count badge on the toggle reflects (selected/list)", async ({ page }) => {
    await expect(page.locator("#icao-count")).toContainText("(6/12)");
    await openPanel(page);
    await page.locator("button[data-action='select-all']").click();
    await expect(page.locator("#icao-count")).toContainText("(12/12)");
    await page.locator("button[data-action='select-none']").click();
    await expect(page.locator("#icao-count")).toContainText("(0/12)");
  });

  test("the first 6 are checked by default", async ({ page }) => {
    await openPanel(page);
    for (const icao of DEFAULT_SELECTED_6) {
      await expect(page.locator(`#icao-presets input[value='${icao}']`)).toBeChecked();
    }
    await expect(page.locator("#icao-presets input[value='KSEA']")).not.toBeChecked();
  });

  test("toggling a checkbox updates the text input", async ({ page }) => {
    await openPanel(page);
    await page.locator("#icao-presets input[value='KSEA']").check();
    const ids = (await page.locator("#ids").inputValue()).split(",");
    expect(ids).toContain("KSEA");
  });

  test("editing the text input updates the checkboxes", async ({ page }) => {
    await openPanel(page);
    await page.locator("#ids").fill("KPAE,KSEA");
    await expect(page.locator("#icao-presets input[value='KPAE']")).toBeChecked();
    await expect(page.locator("#icao-presets input[value='KSEA']")).toBeChecked();
    await expect(page.locator("#icao-presets input[value='KBFI']")).not.toBeChecked();
  });

  test("typing an off-seed ICAO appends a new row", async ({ page }) => {
    await openPanel(page);
    await page.locator("#ids").fill("KPAE,KSFO");
    await expect(page.locator("#icao-presets .icao-row")).toHaveCount(13);
    await expect(page.locator("#icao-presets input[value='KSFO']")).toBeChecked();
  });

  test("Restore defaults reverts list AND selection to seed", async ({ page }) => {
    await openPanel(page);
    await page.locator("#ids").fill("KSEA,KSFO");
    await expect(page.locator("#icao-presets .icao-row")).toHaveCount(13);

    await page.locator("button[data-action='select-defaults']").click();
    const ids = (await page.locator("#ids").inputValue()).split(",");
    expect(ids).toEqual(DEFAULT_SELECTED_6);
    await expect(page.locator("#icao-presets .icao-row")).toHaveCount(12);
  });
});

test.describe("ICAO list — per-row reorder via arrows", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await openPanel(page);
  });

  test("first row has ↑ disabled; last row has ↓ disabled", async ({ page }) => {
    const firstUp = page.locator(`#icao-presets .icao-row[data-icao='KPAE'] button.icao-up`);
    const lastDown = page.locator(`#icao-presets .icao-row[data-icao='KFHR'] button.icao-down`);
    await expect(firstUp).toBeDisabled();
    await expect(lastDown).toBeDisabled();
  });

  test("clicking ↓ on row 0 swaps it with row 1", async ({ page }) => {
    await page.locator(`#icao-presets .icao-row[data-icao='KPAE'] button.icao-down`).click();

    const rowIcaos = await page.locator("#icao-presets .icao-row").evaluateAll(
      (rows) => rows.map((r) => r.getAttribute("data-icao")),
    );
    expect(rowIcaos.slice(0, 3)).toEqual(["KBFI", "KPAE", "KRNT"]);
  });

  test("reorder also reorders the selected codes in the text input", async ({ page }) => {
    await page.locator(`#icao-presets .icao-row[data-icao='KBFI'] button.icao-up`).click();
    const ids = (await page.locator("#ids").inputValue()).split(",");
    // KBFI was index 1 of selected, now index 0; KPAE pushed to index 1.
    expect(ids.slice(0, 2)).toEqual(["KBFI", "KPAE"]);
  });

  test("reorder persists across reload", async ({ page }) => {
    await page.locator(`#icao-presets .icao-row[data-icao='KPAE'] button.icao-down`).click();
    await page.reload();
    await openPanel(page);
    const rowIcaos = await page.locator("#icao-presets .icao-row").evaluateAll(
      (rows) => rows.map((r) => r.getAttribute("data-icao")),
    );
    expect(rowIcaos[0]).toBe("KBFI");
    expect(rowIcaos[1]).toBe("KPAE");
  });
});

test.describe("ICAO list — drag and drop reorder", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await openPanel(page);
  });

  async function rowIcaos(page) {
    return page.locator("#icao-presets .icao-row").evaluateAll(
      (rows) => rows.map((r) => r.getAttribute("data-icao")),
    );
  }

  test("dropping in the lower half of a later row inserts after it", async ({ page }) => {
    const src = page.locator(`#icao-presets .icao-row[data-icao='KPAE']`);
    const dst = page.locator(`#icao-presets .icao-row[data-icao='KRNT']`);
    const box = await dst.boundingBox();
    await src.dragTo(dst, { targetPosition: { x: box.width / 2, y: box.height - 4 } });

    const order = await rowIcaos(page);
    expect(order.indexOf("KPAE")).toBeGreaterThan(order.indexOf("KRNT"));
  });

  test("dropping in the upper half of an earlier row inserts before it", async ({ page }) => {
    const src = page.locator(`#icao-presets .icao-row[data-icao='KORS']`);
    const dst = page.locator(`#icao-presets .icao-row[data-icao='KBFI']`);
    const box = await dst.boundingBox();
    await src.dragTo(dst, { targetPosition: { x: box.width / 2, y: 2 } });

    const order = await rowIcaos(page);
    expect(order.indexOf("KORS")).toBeLessThan(order.indexOf("KBFI"));
  });
});

test.describe("ICAO list — minus button (list editing)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await openPanel(page);
  });

  test("clicking − removes the row from the list and the input", async ({ page }) => {
    await page.locator("#icao-presets .icao-remove[data-remove-icao='KPAE']").click();
    await expect(page.locator("#icao-presets .icao-row")).toHaveCount(11);
    const ids = (await page.locator("#ids").inputValue()).split(",");
    expect(ids).not.toContain("KPAE");
  });

  test("− removal persists across reload", async ({ page }) => {
    await page.locator("#icao-presets .icao-remove[data-remove-icao='KPAE']").click();
    await page.reload();
    await openPanel(page);
    await expect(page.locator("#icao-presets .icao-row")).toHaveCount(11);
    await expect(page.locator("#icao-presets input[value='KPAE']")).toHaveCount(0);
  });

  test("− is disabled once only one entry remains", async ({ page }) => {
    for (const icao of SEED_12.slice(0, 11)) {
      await page.locator(`#icao-presets .icao-remove[data-remove-icao='${icao}']`).click();
    }
    await expect(page.locator("#icao-presets .icao-row")).toHaveCount(1);
    await expect(page.locator("#icao-presets .icao-remove")).toBeDisabled();
  });
});

test.describe("ICAO list — search box", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await openPanel(page);
  });

  test("external search button is rendered but disabled (PHP proxy pending)", async ({ page }) => {
    const btn = page.locator("#icao-search-external");
    await expect(btn).toBeVisible();
    await expect(btn).toBeDisabled();
    await expect(btn).toHaveAttribute("title", /Online search not yet wired/i);
  });

  test("typing 2+ chars shows results", async ({ page }) => {
    await page.locator("#icao-search").fill("Heath");
    await expect(page.locator("#icao-search-results button[data-add-icao]").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#icao-search-results")).toContainText(/Heathrow/i);
  });

  test("clicking a result adds and selects it", async ({ page }) => {
    await page.locator("#icao-search").fill("KSFO");
    await page.locator("#icao-search-results button[data-add-icao='KSFO']").click();

    await expect(page.locator("#icao-presets input[value='KSFO']")).toBeVisible();
    await expect(page.locator("#icao-presets input[value='KSFO']")).toBeChecked();
    const ids = (await page.locator("#ids").inputValue()).split(",");
    expect(ids).toContain("KSFO");
  });

  test("an already-listed airport shows 'in list' and is disabled", async ({ page }) => {
    await page.locator("#icao-search").fill("KPAE");
    const btn = page.locator("#icao-search-results button[data-add-icao='KPAE']");
    await expect(btn).toBeDisabled();
    await expect(btn).toContainText(/in list/i);
  });

  test("at LIST_MAX (20) further additions are blocked", async ({ page }) => {
    const extras = ["KSFO", "KLAX", "KJFK", "KORD", "KDFW", "KATL", "KDEN", "KPHX"];
    await page.locator("#ids").fill([...SEED_12, ...extras].join(","));
    await expect(page.locator("#icao-presets .icao-row")).toHaveCount(20);

    await page.locator("#icao-search").fill("KMIA");
    const btn = page.locator("#icao-search-results button[data-add-icao='KMIA']");
    await expect(btn).toBeDisabled();
    await expect(page.locator("#icao-search-status")).toContainText(/maximum/i);
  });

  test("nonsense queries surface a 'no matches' message", async ({ page }) => {
    await page.locator("#icao-search").fill("zzzqxqx");
    await expect(page.locator("#icao-search-status")).toContainText(/no matches/i, { timeout: 10_000 });
  });
});
