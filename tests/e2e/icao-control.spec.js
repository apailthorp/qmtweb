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
    // v1.4.0 keep-results-visible UX: the query + dropdown stay up so the
    // user can add more from the same search. The clicked row goes
    // disabled + "active" so it can't be added twice; the rest stay clickable.
    await expect(page.locator("#icao-query")).toHaveValue("KSFO");
    await expect(result).toBeDisabled();
    await expect(result).toContainText(/active/i);
    expect(await idsCodes(page)).toEqual([...DEFAULT_6, "KSFO"]);
  });

  test("an already-active airport shows 'active' and is disabled", async ({ page }) => {
    await page.locator("#icao-query").fill("KPAE");
    const btn = page.locator("#icao-search-results button[data-add-icao='KPAE']");
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await expect(btn).toBeDisabled();
    await expect(btn).toContainText(/active/i);
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

    // v1.4.0: picking a result no longer auto-collapses. Panel stays
    // expanded; the dropdown stays visible; the picked row goes disabled.
    const result = page.locator("#icao-search-results button[data-add-icao='KGEG']");
    await result.click();
    await expect(page.locator("#manage-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(result).toBeDisabled();
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
    // v1.4.0: query + dropdown stay; selected row disabled.
    await expect(page.locator("#icao-query")).toHaveValue("Spokane");
    await expect(result).toBeDisabled();

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
