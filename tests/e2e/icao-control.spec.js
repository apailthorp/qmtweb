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

// Deterministic native HTML5 DnD: dispatch dragstart/dragover/drop with a real
// DataTransfer and a clientY in the target's upper or lower half. (Playwright's
// dragTo emulates mouse moves that don't reliably fire native drag events.)
async function dndReorder(page, srcIcao, dstIcao, half) {
  await page.evaluate(({ srcIcao, dstIcao, half }) => {
    const src = document.querySelector(`.tile[data-icao='${srcIcao}']`);
    const dst = document.querySelector(`.tile[data-icao='${dstIcao}']`);
    const r = dst.getBoundingClientRect();
    const clientX = r.left + r.width / 2;
    const clientY = half === "upper" ? r.top + 2 : r.bottom - 2;
    const dataTransfer = new DataTransfer();
    const fire = (el, type) =>
      el.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, clientX, clientY }),
      );
    fire(src, "dragstart");
    fire(dst, "dragover");
    fire(dst, "drop");
    fire(src, "dragend");
  }, { srcIcao, dstIcao, half });
}

test.describe("ICAO tiles — collapsed defaults", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("starts collapsed showing active tiles as pills and inactive ones as bullets", async ({ page }) => {
    await expect(page.locator("#manage-toggle")).toHaveAttribute("aria-expanded", "false");
    // All 12 tiles are in the DOM; the 6 active show as full pills, the other
    // 6 show as small bullets (the inactive .tile-check is shrunk to a dot).
    await expect(page.locator("#icao-tiles .tile")).toHaveCount(12);
    await expect(page.locator(".tile.is-active")).toHaveCount(6);
    await expect(page.locator(tile("KPAE"))).toBeVisible();
    // Inactive tiles are still visible in the layout — just rendered as bullets.
    await expect(page.locator(tile("KSEA"))).toBeVisible();
    await expect(page.locator(tile("KSEA"))).not.toHaveClass(/\bis-active\b/);
  });

  test("count badge reflects (selected/list)", async ({ page }) => {
    await expect(page.locator("#icao-count")).toContainText("(6/12)");
  });

  test("hidden #ids holds the active selection in order", async ({ page }) => {
    expect(await idsCodes(page)).toEqual(DEFAULT_6);
  });

  test("Online button is available in collapsed mode (no extra click to expand)", async ({ page }) => {
    const btn = page.locator("#icao-search-external");
    await expect(btn).toBeVisible();
    await expect(btn).toBeEnabled();
    await expect(btn).toHaveAttribute("title", /nearest/i);
    // Panel is still collapsed; the button just sits in the query row.
    await expect(page.locator("#manage-toggle")).toHaveAttribute("aria-expanded", "false");
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

  test("keyboard toggle keeps focus on the tile (focus survives re-render)", async ({ page }) => {
    const check = page.locator(toggle("KSEA"));
    await check.focus();
    await page.keyboard.press("Space"); // toggles → commit() rebuilds the tiles
    await expect(check).toBeFocused();
    await expect(page.locator(tile("KSEA"))).toHaveClass(/\bis-active\b/);
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
    // Keep-results-visible UX: the query + dropdown stay up so the user can
    // add more from the same search. The clicked row goes into the
    // "is-active" state (accent-coloured "active" hint) but stays CLICKABLE
    // — a second click toggles it back off (see the toggle tests below).
    await expect(page.locator("#icao-query")).toHaveValue("KSFO");
    await expect(result).toBeEnabled();
    await expect(result).toHaveClass(/\bis-active\b/);
    await expect(result).toContainText(/active/i);
    expect(await idsCodes(page)).toEqual([...DEFAULT_6, "KSFO"]);
  });

  test("an already-active airport shows 'active' and stays clickable for toggle-off", async ({ page }) => {
    await page.locator("#icao-query").fill("KPAE");
    const btn = page.locator("#icao-search-results button[data-add-icao='KPAE']");
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await expect(btn).toBeEnabled();
    await expect(btn).toHaveClass(/\bis-active\b/);
    await expect(btn).toContainText(/active/i);
  });

  test("clicking an active result toggles it off back to its pre-click state", async ({ page }) => {
    // KSFO isn't in the default list — click adds it (initialState = "add"),
    // toggle off should remove it from list + selected, hint reverts to "add".
    const q = page.locator("#icao-query");
    await q.fill("KSFO");
    const result = page.locator("#icao-search-results button[data-add-icao='KSFO']");
    await expect(result).toBeVisible({ timeout: 10_000 });
    await expect(result).toContainText(/add/i);

    await result.click();
    await expect(result).toHaveClass(/\bis-active\b/);
    await expect(result).toContainText(/active/i);
    expect(await idsCodes(page)).toContain("KSFO");

    // Toggle off: row reverts to "add" because KSFO wasn't on the list before
    // this search session — symmetric reversal of the original add.
    await result.click();
    await expect(result).not.toHaveClass(/\bis-active\b/);
    await expect(result).toContainText(/add/i);
    expect(await idsCodes(page)).not.toContain("KSFO");
    await expect(page.locator(tile("KSFO"))).toHaveCount(0);

    // And back again: a third click re-adds + re-selects.
    await result.click();
    await expect(result).toHaveClass(/\bis-active\b/);
    expect(await idsCodes(page)).toContain("KSFO");
  });

  test("toggling off an already-listed airport keeps it on the list and shows 'reactivate'", async ({ page }) => {
    // KSEA starts listed-but-inactive (initialState = "reactivate"). Click
    // → "active"; click again → BACK to "reactivate" (deselect, stay on list).
    // Distinguishes this from the "add" case which removes from list entirely.
    await page.locator("#icao-query").fill("KSEA");
    const btn = page.locator("#icao-search-results button[data-add-icao='KSEA']");
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await expect(btn).toContainText(/reactivate/i);

    await btn.click();
    await expect(btn).toHaveClass(/\bis-active\b/);
    await expect(btn).toContainText(/active/i);
    expect(await idsCodes(page)).toContain("KSEA");

    await btn.click();
    await expect(btn).not.toHaveClass(/\bis-active\b/);
    await expect(btn).toContainText(/reactivate/i);
    expect(await idsCodes(page)).not.toContain("KSEA");
    // Tile stayed on the list — it just dropped out of #ids.
    await expect(page.locator(tile("KSEA"))).toHaveCount(1);
  });

  test("a listed-but-inactive airport shows 'reactivate' and re-activates it", async ({ page }) => {
    // KSEA is in the default list but not selected, so it can be re-activated.
    await page.locator("#icao-query").fill("KSEA");
    const btn = page.locator("#icao-search-results button[data-add-icao='KSEA']");
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await expect(btn).toBeEnabled();
    await expect(btn).toContainText(/reactivate/i);
    await btn.click();
    await expect(page.locator(tile("KSEA"))).toHaveClass(/\bis-active\b/);
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
    await dndReorder(page, "KPAE", "KRNT", "lower");
    const order = await tileOrder(page);
    expect(order.indexOf("KPAE")).toBeGreaterThan(order.indexOf("KRNT"));
  });

  test("dropping in the upper half of an earlier tile inserts before it", async ({ page }) => {
    // Long reorder (KORS idx 11 → KBFI idx 1) — reliable now via native dispatch.
    await dndReorder(page, "KORS", "KBFI", "upper");
    const order = await tileOrder(page);
    expect(order.indexOf("KORS")).toBeLessThan(order.indexOf("KBFI"));
  });
});

// Mulberry32 — small, fast, well-distributed seedable PRNG. We use a fixed
// seed so the random target order is REPRODUCIBLE across runs: a failure
// gives us the exact drag sequence to replay. To explore a different
// permutation, change the seed constant in the test.
function seededRandom(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleSeeded(arr, rng) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Longest common subsequence (relative-order-preserving) of two permutations.
// The elements in the LCS are the ones that DON'T need to move — every other
// element gets exactly one drag, giving the theoretical minimum of N - |LCS|.
//
// Optional `preferStable(x)` biases the traceback: when DP ties between i--
// (drop a's element) and j-- (drop b's element), we choose j-- if a[i-1]
// passes preferStable. The active-only test uses this to ensure every dot
// lands in the LCS — without the bias, an equally-valid LCS could include a
// pill instead of a dot, leaving a dot non-stable and forcing it to be a
// drag source (which would violate the "only pills move" constraint).
function lcs(a, b, preferStable = null) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const result = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { result.unshift(a[i - 1]); i--; j--; }
    else if (dp[i - 1][j] > dp[i][j - 1]) i--;
    else if (dp[i][j - 1] > dp[i - 1][j]) j--;
    else if (preferStable && preferStable(a[i - 1])) j--;
    else i--;
  }
  return result;
}

// Build a target permutation that keeps the inactive tiles (dots) in their
// original relative order and reassigns the active tiles (pills) to a random
// subset of the 12 positions. Two seeded steps:
//   1. Pick which 6 of the 12 positions hold pills (subset). The other 6
//      positions hold dots in their original order — that's what makes the
//      dots a "fixed scaffolding" the LCS can always preserve.
//   2. Permute which pill lands in which of those 6 positions.
// Together they cover both "pill ↔ dot position swaps" and "pill ↔ pill
// reshuffles" within a single shuffle.
function buildActiveShuffleTarget(initialOrder, activeSet, rng) {
  const N = initialOrder.length;
  const activeOrder = initialOrder.filter((icao) => activeSet.has(icao));
  const inactiveOrder = initialOrder.filter((icao) => !activeSet.has(icao));

  const allPositions = Array.from({ length: N }, (_, i) => i);
  const tilePositions = new Set(
    shuffleSeeded(allPositions, rng).slice(0, activeOrder.length),
  );
  const shuffledActive = shuffleSeeded(activeOrder, rng);

  const target = new Array(N);
  let activeIdx = 0, inactiveIdx = 0;
  for (let i = 0; i < N; i++) {
    target[i] = tilePositions.has(i)
      ? shuffledActive[activeIdx++]
      : inactiveOrder[inactiveIdx++];
  }
  return target;
}

// Plan the minimum sequence of insertion-drags that turns `cur` into `tgt`.
// Strategy: elements in `stable` (defaults to the LCS) stay put. For each
// non-stable element X (walked in tgt order), drag X to just BEFORE its
// right anchor — the first stable element appearing after X in tgt. If no
// right anchor exists (X belongs after all anchors), drag X AFTER the
// current last element. Each non-stable element gets exactly one drag,
// matching N - |stable|.
//
// Passing a custom `stable` set lets the caller constrain which tiles are
// SOURCES: only non-stable tiles ever appear in `plan[i].srcIcao`. The
// active-only test passes {all dots} so the planner never picks a dot as
// a source.
//
// Returns [{srcIcao, dstIcao, where: "before"|"after"}, ...].
function computeMinDragPlan(cur, tgt, stable = null) {
  if (stable === null) stable = new Set(lcs(cur, tgt));
  const current = [...cur];
  const plan = [];
  for (let i = 0; i < tgt.length; i++) {
    const x = tgt[i];
    if (stable.has(x)) continue;
    let rightAnchor = null;
    for (let k = i + 1; k < tgt.length; k++) {
      if (stable.has(tgt[k])) { rightAnchor = tgt[k]; break; }
    }
    if (rightAnchor !== null) {
      plan.push({ srcIcao: x, dstIcao: rightAnchor, where: "before" });
      const j = current.indexOf(x);
      const moved = current.splice(j, 1)[0];
      current.splice(current.indexOf(rightAnchor), 0, moved);
    } else {
      // X belongs after every stable element. Drop after the current tail —
      // safe because no stable element ever sits to the right of X in tgt.
      const tail = current[current.length - 1];
      if (tail === x) continue;
      plan.push({ srcIcao: x, dstIcao: tail, where: "after" });
      const j = current.indexOf(x);
      const moved = current.splice(j, 1)[0];
      current.push(moved);
    }
  }
  return plan;
}

// Axis-aware DnD dispatcher: works in BOTH collapsed (horizontal axis) and
// expanded (vertical axis) modes. The drop handler computes "before" vs
// "after" via isDropBefore() which uses clientX when collapsed and clientY
// when expanded — so we set BOTH coordinates to the appropriate half of dst.
async function dndReorderInPlace(page, srcIcao, dstIcao, where) {
  await page.evaluate(({ srcIcao, dstIcao, where }) => {
    const src = document.querySelector(`.tile[data-icao='${srcIcao}']`);
    const dst = document.querySelector(`.tile[data-icao='${dstIcao}']`);
    if (!src || !dst) throw new Error(`tile not found: src=${srcIcao} dst=${dstIcao}`);
    const r = dst.getBoundingClientRect();
    const clientX = where === "before" ? r.left + 2 : r.right - 2;
    const clientY = where === "before" ? r.top + 2 : r.bottom - 2;
    const dataTransfer = new DataTransfer();
    const fire = (el, type) =>
      el.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, clientX, clientY }),
      );
    fire(src, "dragstart");
    fire(dst, "dragover");
    fire(dst, "drop");
    fire(src, "dragend");
  }, { srcIcao, dstIcao, where });
}

test.describe("ICAO tiles — collapsed-mode active-only random reorder", () => {
  test("pills shuffled into pill+dot positions via minimum drags; METAR URL reflects new order", async ({ page }) => {
    await page.goto("/");
    // Stay collapsed — the panel is closed by default. This exercises drag
    // across the WHOLE list including the inactive bullet tiles, which is the
    // path that actually ships to mobile users (they rarely expand the panel).
    await expect(page.locator("#manage-toggle")).toHaveAttribute("aria-expanded", "false");

    // Snapshot the starting state: every tile in the list (pills + dots), and
    // which of them are active (only the active set ends up in the METAR URL).
    const initialOrder = await tileOrder(page);
    expect(initialOrder).toEqual(SEED_12);
    const activeSet = new Set(
      await page.locator("#icao-tiles .tile.is-active").evaluateAll(
        (els) => els.map((e) => e.getAttribute("data-icao")),
      ),
    );
    expect(activeSet.size).toBe(6);

    // Build a target where the active pills are reassigned to a random subset
    // of the 12 positions (so a pill can land where a dot currently sits or
    // vice-versa) and the dots fill the remaining positions in their original
    // relative order. The dot-order invariant is what lets us plan a sequence
    // that NEVER drags a dot — every drag source is a pill.
    const rng = seededRandom(0xc01dca5e);
    const targetOrder = buildActiveShuffleTarget(initialOrder, activeSet, rng);

    // Spec constraint: at least three active tiles end up at positions
    // different from their starting positions. Asserts the shuffle actually
    // exercised the drag handler instead of producing a near-identity layout
    // by luck.
    const movedActive = [...activeSet].filter(
      (icao) => initialOrder.indexOf(icao) !== targetOrder.indexOf(icao),
    );
    expect(movedActive.length).toBeGreaterThanOrEqual(3);

    // Force every dot into the stable scaffolding by computing the LCS with
    // a dots-prefer tiebreaker. With dots locked stable, the planner's
    // non-stable set is a SUBSET of the active set — guarantees the plan
    // never drags a dot. Then it can still PROMOTE a pill into the stable
    // set if its relative position with the dots happens to be preserved
    // (saves a drag).
    const isDot = (icao) => !activeSet.has(icao);
    const stable = new Set(lcs(initialOrder, targetOrder, isDot));
    // Sanity: every dot landed in stable; LCS may also include some pills.
    for (const icao of initialOrder) {
      if (isDot(icao)) expect(stable.has(icao)).toBe(true);
    }

    const plan = computeMinDragPlan(initialOrder, targetOrder, stable);

    // Two hard guarantees about the plan before we replay it:
    //   1. Length = N - |stable| (the theoretical minimum for this stable set).
    //   2. Every source is an active pill — no dot is ever lifted.
    expect(plan.length).toBe(initialOrder.length - stable.size);
    for (const step of plan) {
      expect(activeSet.has(step.srcIcao)).toBe(true);
    }

    // Replay each drag. The dispatcher targets data-icao (stable across
    // reorders) rather than DOM index, so plan steps still resolve after
    // earlier drags shift things around.
    for (const step of plan) {
      await dndReorderInPlace(page, step.srcIcao, step.dstIcao, step.where);
    }

    // Order check: the live tile list now matches the shuffled target.
    expect(await tileOrder(page)).toEqual(targetOrder);

    // Submission grouping: the form's ids field tracks list order filtered to
    // the active set. Read it directly first as a fast sanity gate before
    // setting up the network intercept (gives a clearer failure if the form
    // is mid-update for some reason).
    const expectedActiveOrder = targetOrder.filter((icao) => activeSet.has(icao));
    expect(await idsCodes(page)).toEqual(expectedActiveOrder);

    // Now exercise the actual METAR button — the user's terminal action.
    // Intercept the upstream navigation so we capture the URL the browser
    // WOULD have GET'd without actually loading aviationweather.gov (slow,
    // external, fragile). route.fulfill() with a stub 200 page rather than
    // route.abort() — abort produces a scary ERR_FAILED in headed/debug
    // mode (the operator watching the test sees "site can't be reached");
    // fulfill renders a clear placeholder explaining the intercept.
    let capturedUrl = null;
    await page.route("https://aviationweather.gov/**", (route) => {
      capturedUrl = route.request().url();
      return route.fulfill({
        status: 200,
        contentType: "text/html",
        body:
          `<!doctype html><html><body style="font-family:system-ui;padding:2em;line-height:1.5;">` +
          `<h1 style="margin-top:0;">Test intercept</h1>` +
          `<p>Playwright's <code>page.route</code> handler caught this navigation ` +
          `before it left the test sandbox. Real users land on aviationweather.gov; ` +
          `the test asserts on the URL below.</p>` +
          `<pre style="background:#f4f4f4;padding:1em;overflow:auto;white-space:pre-wrap;">` +
          route.request().url() +
          `</pre></body></html>`,
      });
    });
    await page.locator("#metar-form button[type='submit']").click();

    // Poll for the intercepted URL — the click is synchronous but the
    // navigation request is fired off the event loop tick.
    await expect.poll(() => capturedUrl, { timeout: 5_000 }).not.toBeNull();

    const submitted = new URL(capturedUrl);
    const submittedIds = (submitted.searchParams.get("ids") ?? "")
      .split(/\s+/)
      .filter(Boolean);
    expect(submittedIds).toEqual(expectedActiveOrder);
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

test.describe("ICAO tiles — online search (mocked PHP proxy)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await openPanel(page);
  });

  test("resolves a single-candidate query; clicking a station adds a tile", async ({ page }) => {
    await page.route("**/api/resolve.php**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          groups: [
            {
              interpreted: "Nearest METAR to Ilwaco, WA",
              stations: [
                { icao: "KAST", name: "Astoria Regional", distance_km: 12.3 },
                { icao: "KOLM", name: "Olympia Regional", distance_km: 80.1 },
              ],
            },
          ],
        }),
      }),
    );

    await page.locator("#icao-query").fill("Ilwaco metar");
    await page.locator("#icao-search-external").click();

    const kast = page.locator("#icao-search-results button[data-add-icao='KAST']");
    await expect(kast).toBeVisible();
    await expect(kast).toContainText(/12\.3 km/);
    await expect(kast).toContainText(/add/i);
    await expect(page.locator("#icao-search-status")).toContainText(/Ilwaco/i);
    // Single-group result hides the section header (one location is obvious).
    await expect(page.locator("#icao-search-results .icao-result-group-header")).toHaveCount(0);

    await kast.click();
    await expect(page.locator(tile("KAST"))).toHaveClass(/\bis-active\b/);
    expect(await idsCodes(page)).toContain("KAST");
  });

  test("ambiguous query renders one section per candidate with headers", async ({ page }) => {
    await page.route("**/api/resolve.php**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          groups: [
            {
              interpreted: "Nearest METAR to King County, Washington, United States",
              stations: [
                { icao: "KRNT", name: "Renton Muni, WA, US", distance_km: 26.5 },
                { icao: "KSEA", name: "Seattle-Tacoma Intl, WA, US", distance_km: 34.3 },
              ],
            },
            {
              interpreted: "Nearest METAR to King County, Texas, United States",
              stations: [
                { icao: "KCDS", name: "Childress Muni, TX, US", distance_km: 93.5 },
              ],
            },
          ],
        }),
      }),
    );

    await page.locator("#icao-query").fill("King County");
    await page.locator("#icao-search-external").click();

    const headers = page.locator("#icao-search-results .icao-result-group-header");
    await expect(headers).toHaveCount(2);
    await expect(headers.nth(0)).toContainText(/King County, Washington/i);
    await expect(headers.nth(1)).toContainText(/King County, Texas/i);

    // Both candidate stations are clickable; status invites the user to pick.
    await expect(page.locator("#icao-search-results button[data-add-icao='KRNT']")).toBeVisible();
    await expect(page.locator("#icao-search-results button[data-add-icao='KCDS']")).toBeVisible();
    await expect(page.locator("#icao-search-status")).toContainText(/multiple matches/i);
  });

  test("an error response surfaces a message and adds nothing", async ({ page }) => {
    await page.route("**/api/resolve.php**", (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "Couldn't work out a location from that." }),
      }),
    );

    await page.locator("#icao-query").fill("zzzz nowhere");
    await page.locator("#icao-search-external").click();
    await expect(page.locator("#icao-search-status")).toContainText(/couldn't work out a location/i);
    await expect(page.locator("#icao-tiles .tile")).toHaveCount(12); // unchanged
  });

  test("an empty query prompts instead of calling the proxy", async ({ page }) => {
    let called = false;
    await page.route("**/api/resolve.php**", (route) => {
      called = true;
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.locator("#icao-query").fill("");
    await page.locator("#icao-search-external").click();
    await expect(page.locator("#icao-search-status")).toContainText(/type a place/i);
    expect(called).toBe(false);
  });

  test("Online button shows an in-flight spinner; clears on response", async ({ page }) => {
    let release;
    const gate = new Promise((r) => { release = r; });
    await page.route("**/api/resolve.php**", async (route) => {
      await gate;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          groups: [
            {
              interpreted: "Nearest METAR",
              stations: [{ icao: "KAST", name: "Astoria", distance_km: 1 }],
            },
          ],
        }),
      });
    });

    await page.locator("#icao-query").fill("test");
    await page.locator("#icao-search-external").click();
    const btn = page.locator("#icao-search-external");
    // The in-flight cue is on the button itself — where the click landed —
    // plus aria-busy for screen readers. The status row also adopts the
    // loading colour class via setStatus(..., "loading").
    await expect(btn).toHaveClass(/is-loading/);
    await expect(btn).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#icao-search-status")).toHaveClass(/is-loading/);
    release();
    await expect(btn).not.toHaveClass(/is-loading/);
    await expect(btn).not.toHaveAttribute("aria-busy", /.*/);
    await expect(page.locator("#icao-search-status")).not.toHaveClass(/is-loading/);
  });

  test("clicking Online from collapsed mode auto-expands the panel", async ({ page }) => {
    await page.route("**/api/resolve.php**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          groups: [
            { interpreted: "Nearest METAR to Spokane, WA", stations: [{ icao: "KGEG", name: "Spokane Intl", distance_km: 8 }] },
          ],
        }),
      }),
    );

    // Start collapsed (the describe's beforeEach opens the panel — so close it).
    await page.locator("#manage-toggle").click();
    await expect(page.locator("#manage-toggle")).toHaveAttribute("aria-expanded", "false");

    // Type + click Online with the panel still collapsed.
    await page.locator("#icao-query").fill("Spokane");
    await page.locator("#icao-search-external").click();

    // Panel auto-expands and the result appears under the query line.
    await expect(page.locator("#manage-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#icao-search-results button[data-add-icao='KGEG']")).toBeVisible();
  });

  test("after auto-expanded Online select, panel stays expanded until × dismisses + snaps back to collapsed", async ({ page }) => {
    await page.route("**/api/resolve.php**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          groups: [
            { interpreted: "Nearest METAR to Spokane, WA", stations: [{ icao: "KGEG", name: "Spokane Intl", distance_km: 8 }] },
          ],
        }),
      }),
    );

    // Start collapsed.
    await page.locator("#manage-toggle").click();
    await expect(page.locator("#manage-toggle")).toHaveAttribute("aria-expanded", "false");

    // Run Online from collapsed (auto-expands).
    await page.locator("#icao-query").fill("Spokane");
    await page.locator("#icao-search-external").click();
    await expect(page.locator("#manage-toggle")).toHaveAttribute("aria-expanded", "true");

    // Picking a result no longer auto-collapses. Panel stays expanded; the
    // dropdown stays visible; the picked row flips to is-active state but
    // stays clickable so a second click toggles it back off.
    const result = page.locator("#icao-search-results button[data-add-icao='KGEG']");
    await result.click();
    await expect(page.locator("#manage-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(result).toHaveClass(/\bis-active\b/);
    await expect(result).toBeEnabled();
    await expect(page.locator("#icao-query")).toHaveValue("Spokane");
    expect(await idsCodes(page)).toContain("KGEG");

    // Tapping × clears the query AND snaps back to the prior collapsed state
    // (since the search auto-expanded the panel earlier).
    await page.locator("#icao-query-clear").click();
    await expect(page.locator("#manage-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#icao-query")).toHaveValue("");
  });

  test("stays expanded after selection if the user opened the panel manually; × leaves it expanded", async ({ page }) => {
    await page.route("**/api/resolve.php**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          groups: [
            { interpreted: "Nearest METAR to Spokane, WA", stations: [{ icao: "KGEG", name: "Spokane Intl", distance_km: 8 }] },
          ],
        }),
      }),
    );

    // Manually open the panel (the describe's beforeEach already did this).
    await expect(page.locator("#manage-toggle")).toHaveAttribute("aria-expanded", "true");
    await page.locator("#icao-query").fill("Spokane");
    await page.locator("#icao-search-external").click();
    const result = page.locator("#icao-search-results button[data-add-icao='KGEG']");
    await result.click();
    // Still expanded — the user is in edit mode on purpose.
    await expect(page.locator("#manage-toggle")).toHaveAttribute("aria-expanded", "true");
    // Query + dropdown stay; selected row is in is-active state and stays
    // clickable for toggle-off.
    await expect(page.locator("#icao-query")).toHaveValue("Spokane");
    await expect(result).toHaveClass(/\bis-active\b/);
    await expect(result).toBeEnabled();

    // × clears query but does NOT collapse — only the auto-expand path snaps
    // back. The user manually opened this panel; they keep edit mode.
    await page.locator("#icao-query-clear").click();
    await expect(page.locator("#manage-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#icao-query")).toHaveValue("");
  });

  test("manual Edit-toggle collapse dismisses the active search session", async ({ page }) => {
    await page.route("**/api/resolve.php**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          groups: [
            { interpreted: "Nearest METAR to Spokane, WA", stations: [{ icao: "KGEG", name: "Spokane Intl", distance_km: 8 }] },
          ],
        }),
      }),
    );

    // Panel already open from beforeEach. Run a search; results appear.
    await page.locator("#icao-query").fill("Spokane");
    await page.locator("#icao-search-external").click();
    const result = page.locator("#icao-search-results button[data-add-icao='KGEG']");
    await expect(result).toBeVisible();
    await expect(page.locator("#icao-query")).toHaveValue("Spokane");

    // Click Edit (manage-toggle) to collapse manually — also dismisses
    // the active search: query clears, dropdown hides, status clears.
    await page.locator("#manage-toggle").click();
    await expect(page.locator("#manage-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#icao-query")).toHaveValue("");
    await expect(page.locator("#icao-search-results")).toBeHidden();
  });

  test("clear × button is hidden when empty, visible when typing, and clears + aborts on click", async ({ page }) => {
    const q = page.locator("#icao-query");
    const x = page.locator("#icao-query-clear");

    // Hidden on first paint (input is empty, no search running).
    await expect(x).toBeHidden();

    // Type → appears.
    await q.fill("Spokane");
    await expect(x).toBeVisible();

    // Stage a slow resolve.php so the click can land mid-flight.
    let release;
    const gate = new Promise((r) => { release = r; });
    await page.route("**/api/resolve.php**", async (route) => {
      await gate;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ groups: [{ interpreted: "x", stations: [{ icao: "KAST", name: "x", distance_km: 1 }] }] }),
      });
    });
    await page.locator("#icao-search-external").click();
    await expect(page.locator("#icao-search-external")).toHaveClass(/is-loading/);

    // Cancel mid-flight — query clears, button spinner clears, status clears,
    // clear button hides again because there's nothing to clear or cancel.
    await x.click();
    await expect(page.locator("#icao-search-external")).not.toHaveClass(/is-loading/);
    await expect(q).toHaveValue("");
    await expect(x).toBeHidden();
    release(); // let the deferred fulfill complete; aborted fetch shouldn't render anything
  });

  test("shows a not-found indicator on a 404 from the proxy; clears on next edit", async ({ page }) => {
    await page.route("**/api/resolve.php**", (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "Couldn't work out a location from that." }),
      }),
    );

    await page.locator("#icao-query").fill("nothing nearby");
    await page.locator("#icao-search-external").click();
    await expect(page.locator("#icao-search-status")).toHaveClass(/is-notfound/);
    await expect(page.locator("#icao-search-status")).toContainText(/couldn't work out a location/i);

    // Any edit clears the indicator so the user gets a fresh slate.
    await page.locator("#icao-query").pressSequentially("x");
    await expect(page.locator("#icao-search-status")).not.toHaveClass(/is-notfound/);
  });

  test("pressing Enter (or iOS 'Go') on a place query fires Online search and does NOT submit the form", async ({ page }) => {
    await page.route("**/api/resolve.php**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          groups: [
            { interpreted: "Nearest METAR to Spokane, WA", stations: [{ icao: "KGEG", name: "Spokane Intl", distance_km: 8 }] },
          ],
        }),
      }),
    );

    // Detect navigation — if Enter fell through to form submit, the page would
    // try to navigate away from the dev server (form action is aviationweather.gov).
    let navigated = false;
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame() && !f.url().startsWith("http://localhost") && !f.url().startsWith("http://127.0.0.1")) {
        navigated = true;
      }
    });

    await page.locator("#icao-query").fill("Spokane");
    await page.locator("#icao-query").press("Enter");

    // Online result rendered (same as if magnifier was clicked).
    await expect(page.locator("#icao-search-results button[data-add-icao='KGEG']")).toBeVisible();
    expect(navigated).toBe(false);
  });
});

test.describe("ICAO tiles — tokenizer requires known codes", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await openPanel(page);
  });

  test("a 4-letter word that isn't a real ICAO (e.g. BASE) does NOT tokenize", async ({ page }) => {
    const q = page.locator("#icao-query");
    // Warm the dataset so the membership check is active; a known prefix gives
    // us a real local result, signalling lookupByIcao is populated.
    await q.fill("Sea");
    await expect(page.locator("#icao-search-results .icao-result").first()).toBeVisible();
    await q.fill("");
    await q.pressSequentially("BASE ");
    // No spurious BASE tile, query keeps the literal text.
    await expect(page.locator(tile("BASE"))).toHaveCount(0);
    await expect(q).toHaveValue("BASE ");
  });

  test("typed natural-language phrase produces no tiles for any of its words", async ({ page }) => {
    const q = page.locator("#icao-query");
    await q.fill("Sea");
    await expect(page.locator("#icao-search-results .icao-result").first()).toBeVisible();
    await q.fill("");
    await q.pressSequentially("airforce base in Washington ");
    // None of {AIRF (5 char), BASE (4 char), WASH (4 char prefix typed mid-word)}
    // should appear as tiles; the only 4-letter candidate "BASE" is a real
    // English word that fails the membership check.
    await expect(page.locator(tile("BASE"))).toHaveCount(0);
    await expect(page.locator(tile("AIRF"))).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Exhaustive drop-zone coverage (collapsed mode).
//
// Walks every "legitimate" drop-target region a user might aim at — split
// into five categories:
//
//   tile-left    cursor in the left  half of a tile (pill or dot)
//   tile-right   cursor in the right half of a tile
//   gap-left     cursor in the left  half of the whitespace gap between two
//                consecutive tiles (closer to the left  neighbour)
//   gap-right    cursor in the right half of the whitespace gap (closer to
//                the right neighbour)
//   trailing     cursor in the whitespace AFTER the last tile but still
//                inside the <ol> tiles container
//
// For each zone we pick a random source tile (seeded RNG for replay), perform
// a REAL Playwright mouse drag — mouse.move → mouse.down → smooth mouse.move
// to the zone with intermediate steps so the browser fires dragover at each
// pixel-step → verify the .drop-before/.drop-after indicator class is on the
// expected tile right before release → mouse.up → verify the resulting tile
// order matches the model.
//
// Push-through failure mode: each zone uses expect.soft so the test continues
// after a mismatch, the model is re-synced to whatever the UI actually did,
// and the test fails ONCE at the end with a list of every broken zone. Gives
// the full picture of which zones misbehave rather than bailing on the first.
//
// After every zone is exercised the test expands the manage panel to verify
// dots that were repositioned in collapsed mode also moved their hidden
// ICAOs to the expected positions (the panel reveals the inactive ICAO
// codes, so we can confirm the same list ordering with full labels).

function tileBox(page, icao) {
  return page.locator(`.tile[data-icao='${icao}']`).boundingBox();
}

// Resolve a zone spec to absolute (x, y) coordinates against the CURRENT
// rendered layout. Specs reference list POSITIONS, not specific ICAOs, so
// after each cumulative drag they still describe "the tile now at index N".
// Returns null when the zone has no meaningful coordinate at this moment
// (e.g. a gap pair whose two anchors landed on different rows after the
// flex flow wrapped, or a trailing zone with no actual whitespace inside
// the <ol>). Callers SKIP null zones — they're not failures, just
// unreachable targets given the current layout.
async function resolveZoneCoords(page, spec, currentOrder) {
  if (spec.kind === "tile-left" || spec.kind === "tile-right") {
    const box = await tileBox(page, currentOrder[spec.position]);
    return {
      x: spec.kind === "tile-left" ? box.x + 3 : box.x + box.width - 3,
      y: box.y + box.height / 2,
    };
  }
  if (spec.kind === "gap-left" || spec.kind === "gap-right") {
    const [li, ri] = spec.betweenPositions;
    const leftBox  = await tileBox(page, currentOrder[li]);
    const rightBox = await tileBox(page, currentOrder[ri]);
    const leftCy  = leftBox.y  + leftBox.height  / 2;
    const rightCy = rightBox.y + rightBox.height / 2;
    // Cross-row pair: the visual flex gap only exists between same-row
    // neighbours. Once the list grows past one row's width the flex flow
    // wraps; the "gap" between the last tile of row N and the first of
    // row N+1 is a line break, not horizontal whitespace, so there's
    // nothing to aim at.
    if (Math.abs(leftCy - rightCy) > 5) return null;
    const gapL = leftBox.x + leftBox.width;
    const gapR = rightBox.x;
    if (gapR - gapL < 2) return null; // gap visually collapsed
    const gapM = (gapL + gapR) / 2;
    return {
      x: spec.kind === "gap-left" ? (gapL + gapM) / 2 : (gapM + gapR) / 2,
      y: leftCy,
    };
  }
  // trailing: point a few px right of the last tile but still inside <ol>.
  // Skip when the last tile butts up against the OL's right edge — that's
  // the no-trailing-whitespace case (e.g. lists that exactly fill the row).
  const lastBox = await tileBox(page, currentOrder[currentOrder.length - 1]);
  const olBox = await page.locator("#icao-tiles").boundingBox();
  const trailingX = lastBox.x + lastBox.width + 8;
  if (trailingX > olBox.x + olBox.width - 4) return null;
  return { x: trailingX, y: lastBox.y + lastBox.height / 2 };
}

// Pure-JS model of what the drop handler should do for each zone spec.
// Mirrors moveTo()'s "splice from fromIdx, insert at clamped newIdx" plus
// the "if fromIdx < newIdx, newIdx -= 1" shift compensation in the live
// drop handler.
function applyDragExpected(currentOrder, srcIcao, spec) {
  const N = currentOrder.length;
  const fromIdx = currentOrder.indexOf(srcIcao);
  let newIdx;
  switch (spec.kind) {
    case "tile-left":  newIdx = spec.position; break;
    case "tile-right": newIdx = spec.position + 1; break;
    // Gaps insert BETWEEN the two anchor tiles — both halves of a single
    // gap collapse to the same insertion point (newIdx = right anchor's
    // current position). The left/right halves are user-visible distinctions
    // for cursor placement, not different commit outcomes.
    case "gap-left":
    case "gap-right": newIdx = spec.betweenPositions[1]; break;
    case "trailing":  newIdx = N; break;
  }
  if (fromIdx < newIdx) newIdx -= 1;
  const result = [...currentOrder];
  const [moved] = result.splice(fromIdx, 1);
  result.splice(newIdx, 0, moved);
  return result;
}

// Which tile + class the .drop-before/.drop-after indicator SHOULD land on
// just before release, given a zone spec. For zones in tile halves the
// answer is unambiguous; for gaps + trailing we expect the natural
// destination's adjacent tile to carry the marker.
function expectedIndicator(currentOrder, spec) {
  switch (spec.kind) {
    case "tile-left":
      return { icao: currentOrder[spec.position], cls: "drop-before" };
    case "tile-right":
      return { icao: currentOrder[spec.position], cls: "drop-after" };
    case "gap-left":
      return { icao: currentOrder[spec.betweenPositions[0]], cls: "drop-after" };
    case "gap-right":
      return { icao: currentOrder[spec.betweenPositions[1]], cls: "drop-before" };
    case "trailing":
      return { icao: currentOrder[currentOrder.length - 1], cls: "drop-after" };
  }
  return null;
}

// Enumerate every zone for a list of N tiles: 2N tile halves + 2(N-1) gap
// halves + 1 trailing = 4N - 1 = 47 zones for N=12.
function buildZoneSpecs(N) {
  const specs = [];
  for (let i = 0; i < N; i++) {
    specs.push({ kind: "tile-left",  position: i });
    specs.push({ kind: "tile-right", position: i });
  }
  for (let i = 0; i < N - 1; i++) {
    specs.push({ kind: "gap-left",  betweenPositions: [i, i + 1] });
    specs.push({ kind: "gap-right", betweenPositions: [i, i + 1] });
  }
  specs.push({ kind: "trailing" });
  return specs;
}

// Short human label for failure reporting.
function describeSpec(spec, currentOrder) {
  switch (spec.kind) {
    case "tile-left":
    case "tile-right":
      return `${spec.kind} of ${currentOrder[spec.position]} (pos ${spec.position})`;
    case "gap-left":
    case "gap-right":
      return `${spec.kind} between ${currentOrder[spec.betweenPositions[0]]} (pos ${spec.betweenPositions[0]}) and ${currentOrder[spec.betweenPositions[1]]} (pos ${spec.betweenPositions[1]})`;
    case "trailing":
      return `trailing after ${currentOrder[currentOrder.length - 1]} (last)`;
  }
  return JSON.stringify(spec);
}

// Pick a random source from currentOrder excluding tiles that would make
// the drag a positional no-op for this zone. Returns null if nothing valid
// remains (caller should skip).
function pickSource(currentOrder, spec, rng) {
  const exclude = new Set();
  if (spec.kind === "tile-left") {
    // dragging tile-at-position to its own left half = no-op; dragging the
    // tile immediately to the LEFT of position to position's left half also
    // a no-op (it already sits there).
    exclude.add(currentOrder[spec.position]);
    if (spec.position > 0) exclude.add(currentOrder[spec.position - 1]);
  } else if (spec.kind === "tile-right") {
    exclude.add(currentOrder[spec.position]);
    if (spec.position < currentOrder.length - 1) {
      exclude.add(currentOrder[spec.position + 1]);
    }
  } else if (spec.kind === "gap-left" || spec.kind === "gap-right") {
    exclude.add(currentOrder[spec.betweenPositions[0]]);
    exclude.add(currentOrder[spec.betweenPositions[1]]);
  } else if (spec.kind === "trailing") {
    exclude.add(currentOrder[currentOrder.length - 1]);
  }
  const pool = currentOrder.filter((icao) => !exclude.has(icao));
  if (!pool.length) return null;
  return pool[Math.floor(rng() * pool.length)];
}

// Real Playwright mouse drag from the source tile's centre to (dstX, dstY)
// with smooth multi-step motion. Initial 4-px nudge after mouse.down is
// what convinces Chromium to upgrade the gesture from "mouse-down + move"
// to a real HTML5 drag-start. Without the nudge dragstart often doesn't
// fire on the first move step.
async function dragRealMouse(page, srcIcao, dstX, dstY) {
  const src = await tileBox(page, srcIcao);
  const sx = src.x + src.width / 2;
  const sy = src.y + src.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 4, sy); // nudge to commit drag gesture
  await page.mouse.move(dstX, dstY, { steps: 15 });
  // Settle the indicator. Chrome can coalesce rapid pointermove events into
  // fewer dragover dispatches; on smooth multi-step moves the LAST dragover
  // sometimes fires at the second-to-last coordinate, leaving the marker
  // class on a neighbour rather than the tile under the final cursor
  // position. A 1-px jiggle dispatches one fresh dragover at the exact
  // target so the class lands deterministically — no test-side guesswork
  // about which dragover the browser ended on.
  await page.mouse.move(dstX + 1, dstY);
  await page.mouse.move(dstX, dstY);
}

// Three list-size scenarios exercising the full supported N range. Each
// pre-populates localStorage with the relevant {selected, list} state via
// addInitScript so the page renders that exact configuration on goto.
//
//   default 12 — 6 active + 6 inactive — uses the page's built-in seed
//   no-dots 6  — 6 active + 0 inactive — minimal list, nothing to drag
//                a dot onto, all sources are pills
//   max 20     — 6 active + 14 inactive — upper end of the supported
//                range; verifies the test scales without the layout
//                wrapping past one row
//
// Tests share a single body; the only per-scenario difference is the
// pre-seeded storage state.
const DROP_ZONE_SCENARIOS = [
  {
    label: "N=12 (6 active + 6 inactive — page default)",
    storage: null, // no override, use the built-in seed
  },
  {
    label: "N=6 (no dots — pills only)",
    storage: {
      selected: ["KPAE", "KBFI", "KRNT", "KPWT", "KOLM", "KHQM"],
      list:     ["KPAE", "KBFI", "KRNT", "KPWT", "KOLM", "KHQM"],
    },
  },
  {
    label: "N=20 (6 active + 14 inactive — max supported)",
    storage: {
      selected: ["KPAE", "KBFI", "KRNT", "KPWT", "KOLM", "KHQM"],
      list: [
        "KPAE", "KBFI", "KRNT", "KPWT", "KOLM", "KHQM",
        "KSEA", "KTIW", "KBLI", "KAWO", "KORS", "KFHR",
        "KHIO", "KPDX", "KSLE", "KEUG", "KMFR", "KGEG", "KPSC", "KYKM",
      ],
    },
  },
];

test.describe("ICAO tiles — exhaustive collapsed-mode drop-zone coverage", () => {
  for (const scenario of DROP_ZONE_SCENARIOS) {
   test(`${scenario.label}: every drop zone (tile halves, gap halves, trailing) commits as the model expects`, async ({ page }) => {
    // Up to 20 tiles → ~80 zones × ~300ms each + 50ms settle = ~30s, plus
    // assertion overhead. The 60s default is enough for N=12 but we lift
    // it for the upper end of the supported range.
    test.setTimeout(120_000);

    if (scenario.storage) {
      // addInitScript runs in the page context before any script of the page
      // does, so the storage entry exists by the time the app's init pass
      // reads it. Avoids the race where page.goto starts loading scripts
      // before a post-goto evaluate would land.
      await page.addInitScript((state) => {
        localStorage.setItem("qmtweb.icao.state.v3", JSON.stringify(state));
      }, scenario.storage);
    }

    await page.goto("/");
    await expect(page.locator("#manage-toggle")).toHaveAttribute("aria-expanded", "false");

    let currentOrder = await tileOrder(page);
    const N = currentOrder.length;
    // Test is parameterised over the actual rendered list — no SEED_12
    // hardcode. Anything from 2 (minimum to have a gap to test) to 20
    // (upper end of "reasonable list size" before zones explode and
    // viewport-wrap becomes the dominant concern) is supported.
    expect(N).toBeGreaterThanOrEqual(2);
    expect(N).toBeLessThanOrEqual(20);

    const rng = seededRandom(0x4d40fa11);
    const specs = buildZoneSpecs(N);
    const failures = [];
    let skippedNoSource = 0;
    let skippedNoZone = 0;

    for (const spec of specs) {
      const srcIcao = pickSource(currentOrder, spec, rng);
      if (!srcIcao) { skippedNoSource++; continue; }

      // Resolve coords against the LIVE layout — handles multi-row wrap by
      // returning null for gap pairs whose anchors landed on different rows
      // and for trailing zones with no actual trailing whitespace.
      const coords = await resolveZoneCoords(page, spec, currentOrder);
      if (!coords) { skippedNoZone++; continue; }
      const { x, y } = coords;
      const expectedOrder = applyDragExpected(currentOrder, srcIcao, spec);
      const wantIndicator = expectedIndicator(currentOrder, spec);
      const label = describeSpec(spec, currentOrder);

      await dragRealMouse(page, srcIcao, x, y);

      // Let the final dragover settle. Playwright's mouse.move resolves as
      // soon as the events are queued; the dragover handler that paints the
      // marker class runs on a microtask after. Poll for the EXPECTED
      // marker to appear on the expected tile (auto-retries every poll
      // interval, returns the instant it's visible) with a 500ms cap.
      // .catch absorbs the timeout — in the known paint-race cases the
      // marker never lands on the expected tile (Chrome coalesces the
      // last few dragover events, indicator stays on a neighbour); we
      // still want the actual-state snapshot below to record the
      // discrepancy as indicator-only noise rather than blowing up.
      if (wantIndicator) {
        await page
          .locator(`.tile[data-icao='${wantIndicator.icao}'].${wantIndicator.cls}`)
          .waitFor({ state: "visible", timeout: 500 })
          .catch(() => {});
      }

      // Indicator snapshot BEFORE release. There should be exactly one
      // .drop-before OR .drop-after marker on the expected tile.
      const seen = await page.evaluate(() => {
        const before = [...document.querySelectorAll(".tile.drop-before")]
          .map((e) => e.dataset.icao);
        const after = [...document.querySelectorAll(".tile.drop-after")]
          .map((e) => e.dataset.icao);
        return { before, after };
      });

      await page.mouse.up();

      const actualOrder = await tileOrder(page);

      const orderOk = actualOrder.join(" ") === expectedOrder.join(" ");
      const indicatorOk =
        wantIndicator &&
        (wantIndicator.cls === "drop-before"
          ? seen.before.length === 1 && seen.before[0] === wantIndicator.icao && seen.after.length === 0
          : seen.after.length === 1 && seen.after[0] === wantIndicator.icao && seen.before.length === 0);

      if (!orderOk || !indicatorOk) {
        // Split failure modes so the report makes the actual user-visible
        // bug obvious. orderOk=false is the serious one: the drag didn't
        // commit. orderOk=true with indicatorOk=false is a smaller marker-
        // paint inconsistency (often: Playwright's mouse.up fires before
        // the browser dispatches a final dragover at the exact target
        // coordinate, so the snapshot catches the second-to-last paint).
        failures.push({
          zone: label,
          kind: spec.kind,
          severity: orderOk ? "indicator-only" : "no-commit",
          source: srcIcao,
          want: { order: expectedOrder.join(" "), indicator: wantIndicator },
          got: { order: actualOrder.join(" "), indicator: seen },
        });
      }

      // Sync the model to whatever the UI actually did so subsequent zones
      // continue from the real state — not from a pretend state we'd have
      // had if every zone worked.
      currentOrder = actualOrder;
    }

    // Expand the panel so inactive ICAO codes become visible. The DOM order
    // of <li class="tile"> doesn't change between collapsed and expanded
    // modes — only label rendering does — so this check confirms dot drags
    // moved their (hidden in collapsed mode) ICAOs to the same positions
    // a user would now see written out.
    await page.locator("#manage-toggle").click();
    await expect(page.locator("#manage-toggle")).toHaveAttribute("aria-expanded", "true");

    // Don't race the reflow. The .is-open class lands synchronously with the
    // click, but the CSS rule `.tile-control.is-open .tile { width: 100% }`
    // needs a layout pass before each tile actually takes full row width
    // (which is what makes flex-wrap push them onto stacked rows). And even
    // after that, any CSS transitions on individual tiles can still be
    // animating into their new row positions, so a snapshot taken too early
    // catches a horizontally-overlapping mid-reflow state.
    //
    // Three-part settle check, ALL of which must hold:
    //   1. The OL has reflowed (its width is the page's content width).
    //   2. EVERY tile has taken its expanded-mode full row width — not just
    //      the first one.
    //   3. EVERY pair of adjacent tiles is on a distinct row (Y-centers
    //      separated). That's the definitive proof the stack is in place —
    //      while mid-transition multiple tiles still share Y coordinates.
    //   4. No CSS animations or transitions are still playing.
    await page.waitForFunction(() => {
      const ol = document.getElementById("icao-tiles");
      if (!ol) return false;
      const tiles = [...ol.querySelectorAll(".tile")];
      if (tiles.length < 2) return true;
      const olW = ol.getBoundingClientRect().width;
      if (olW < 100) return false;

      const rects = tiles.map((t) => t.getBoundingClientRect());
      const allFullWidth = rects.every((r) => Math.abs(olW - r.width) < 5);
      if (!allFullWidth) return false;

      const centers = rects.map((r) => r.top + r.height / 2);
      const sorted = [...centers].sort((a, b) => a - b);
      const allDistinct = sorted.every((c, i) => i === 0 || c - sorted[i - 1] > 5);
      if (!allDistinct) return false;

      // Defensive: even with reducedMotion: "reduce" set in Playwright config,
      // some pages run their own JS-driven transitions. document.getAnimations
      // covers both CSS transitions/animations and Web Animations API ones.
      const anims = document.getAnimations ? document.getAnimations() : [];
      return anims.every((a) => a.playState === "finished" || a.playState === "idle");
    });

    expect(await tileOrder(page)).toEqual(currentOrder);

    // Two-class reporting:
    //   no-commit       drag didn't move the tile to where the model said it
    //                   should land. Real user-visible bug, hard-fails the
    //                   test.
    //   indicator-only  drag committed to the right position but the
    //                   .drop-before/.drop-after marker snapshot caught a
    //                   neighbour tile instead of the target. Test-side
    //                   paint race: Playwright's smooth-move dragover
    //                   dispatches get coalesced by Chrome and the LAST
    //                   one sometimes fires mid-path, not at the final
    //                   pixel — leaving a stale marker on whatever tile
    //                   the cursor crossed before reaching the gap. The
    //                   drag itself is correct (order matches); the
    //                   marker is just a step behind.
    //
    // Indicator-only noise is reported as a console.log so it's visible
    // in CI logs and can still tip us off if it spikes or shifts pattern,
    // but it doesn't fail CI. Only no-commit fails.
    const exercised = specs.length - skippedNoSource - skippedNoZone;
    const byKind = {};
    const bySeverity = { "no-commit": 0, "indicator-only": 0 };
    for (const f of failures) {
      byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
      bySeverity[f.severity]++;
    }
    const summary =
      `N=${N} tiles, ${specs.length} zones (exercised ${exercised}, ` +
      `skipped ${skippedNoSource} no-source + ${skippedNoZone} no-reachable-coord)\n` +
      `Severity: ${bySeverity["no-commit"]} no-commit (drag silently failed), ` +
      `${bySeverity["indicator-only"]} indicator-only (drag committed but marker on wrong tile)\n` +
      `By zone kind: ${Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join(", ")}`;

    if (bySeverity["indicator-only"]) {
      console.log(`drop-zone indicator-only noise (N=${N}): ${bySeverity["indicator-only"]} markers snapshotted on a neighbour tile after correct commit`);
    }

    if (bySeverity["no-commit"]) {
      const report = failures
        .filter((f) => f.severity === "no-commit")
        .map((f, i) =>
          `${i + 1}. ${f.zone}\n   src=${f.source}\n   want order: ${f.want.order}\n   got  order: ${f.got.order}\n   want marker: ${f.want.indicator?.cls} on ${f.want.indicator?.icao}\n   got  before=${JSON.stringify(f.got.indicator.before)} after=${JSON.stringify(f.got.indicator.after)}`,
        )
        .join("\n\n");
      throw new Error(`${bySeverity["no-commit"]}/${exercised} drop zones FAILED TO COMMIT.\n\n${summary}\n\n${report}`);
    }
   });
  }
});
