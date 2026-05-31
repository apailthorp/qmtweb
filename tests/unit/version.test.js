import { describe, it, expect } from "vitest";
import {
  resolveVersion,
  shouldHide,
  recordVersion,
  commitUrl,
  VERSION_STORE_KEY,
} from "../../site/js/version.js";
import { applyVersionToken, applyShaToken, buildVersion, shortSha } from "../../scripts/stamp-version.mjs";

function memStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    _data: data,
  };
}

describe("resolveVersion", () => {
  it("returns the stamped version verbatim", () => {
    expect(resolveVersion("v1.2.3 · abc1234")).toBe("v1.2.3 · abc1234");
  });

  it("falls back to 'dev' for the unstamped token", () => {
    expect(resolveVersion("__APP_VERSION__")).toBe("dev");
  });

  it("falls back to 'dev' for empty / undefined / null", () => {
    expect(resolveVersion("")).toBe("dev");
    expect(resolveVersion(undefined)).toBe("dev");
    expect(resolveVersion(null)).toBe("dev");
  });
});

describe("shouldHide", () => {
  it("never hides on a short, non-scrollable page (nothing to collide with)", () => {
    expect(shouldHide({ scrollHeight: 600, viewportHeight: 800, scrollY: 0 })).toBe(false);
  });

  it("treats a page only marginally taller than the viewport as non-scrollable", () => {
    // within the default threshold (8px)
    expect(shouldHide({ scrollHeight: 805, viewportHeight: 800, scrollY: 0 })).toBe(false);
  });

  it("hides while scrolled up from the bottom (tag floats over content)", () => {
    expect(shouldHide({ scrollHeight: 1600, viewportHeight: 800, scrollY: 0 })).toBe(true);
    expect(shouldHide({ scrollHeight: 1600, viewportHeight: 800, scrollY: 400 })).toBe(true);
  });

  it("shows once scrolled to (or within threshold of) the bottom — its home", () => {
    // max scroll = 1600 - 800 = 800
    expect(shouldHide({ scrollHeight: 1600, viewportHeight: 800, scrollY: 800 })).toBe(false);
    expect(shouldHide({ scrollHeight: 1600, viewportHeight: 800, scrollY: 793 })).toBe(false); // within 8px
    expect(shouldHide({ scrollHeight: 1600, viewportHeight: 800, scrollY: 790 })).toBe(true); // 10px shy → still hidden
  });

  it("honours a custom threshold", () => {
    expect(shouldHide({ scrollHeight: 1600, viewportHeight: 800, scrollY: 760, threshold: 50 })).toBe(false);
  });
});

describe("recordVersion", () => {
  it("uses the versioned localStorage key", () => {
    expect(VERSION_STORE_KEY).toBe("qmtweb.appVersion");
  });

  it("returns false on a first-ever visit and stores the version", () => {
    const s = memStorage();
    expect(recordVersion("v1.0.0 · aaa", s)).toBe(false);
    expect(s.getItem(VERSION_STORE_KEY)).toBe("v1.0.0 · aaa");
  });

  it("returns false when the version is unchanged", () => {
    const s = memStorage({ [VERSION_STORE_KEY]: "v1.0.0 · aaa" });
    expect(recordVersion("v1.0.0 · aaa", s)).toBe(false);
  });

  it("returns true when the version changed since a prior session", () => {
    const s = memStorage({ [VERSION_STORE_KEY]: "v1.0.0 · aaa" });
    expect(recordVersion("v1.1.0 · bbb", s)).toBe(true);
    expect(s.getItem(VERSION_STORE_KEY)).toBe("v1.1.0 · bbb");
  });

  it("is safe (returns false) when storage is null", () => {
    expect(recordVersion("v1", null)).toBe(false);
  });

  it("is safe when storage throws", () => {
    const throwing = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    };
    expect(recordVersion("v1", throwing)).toBe(false);
  });
});

describe("commitUrl", () => {
  it("builds a GitHub commit URL for a 7-char hex SHA", () => {
    expect(commitUrl("abc1234")).toBe("https://github.com/apailthorp/qmtweb/commit/abc1234");
  });

  it("accepts a full 40-char hex SHA", () => {
    const long = "abcdef1234567890abcdef1234567890abcdef12";
    expect(commitUrl(long)).toBe(`https://github.com/apailthorp/qmtweb/commit/${long}`);
  });

  it("returns null for the unstamped placeholder (local dev)", () => {
    expect(commitUrl("__APP_VERSION_SHA__")).toBeNull();
  });

  it("returns null for the 'local' fallback from shortSha()", () => {
    expect(commitUrl("local")).toBeNull();
  });

  it("returns null for empty / undefined / null", () => {
    expect(commitUrl("")).toBeNull();
    expect(commitUrl(undefined)).toBeNull();
    expect(commitUrl(null)).toBeNull();
  });

  it("rejects non-hex / shape-mismatched values to avoid broken links", () => {
    expect(commitUrl("not-a-sha")).toBeNull();
    expect(commitUrl("abc12")).toBeNull(); // too short
    expect(commitUrl("xyz1234")).toBeNull(); // non-hex
  });
});

describe("stamp-version helpers", () => {
  it("buildVersion composes semver + sha with a middot", () => {
    expect(buildVersion("1.0.0", "abc1234")).toBe("v1.0.0 · abc1234");
  });

  it("applyVersionToken replaces every token occurrence", () => {
    const html = `<html data-version="__APP_VERSION__"><div>__APP_VERSION__</div>`;
    expect(applyVersionToken(html, "v1.0.0 · abc1234")).toBe(
      `<html data-version="v1.0.0 · abc1234"><div>v1.0.0 · abc1234</div>`,
    );
  });

  it("applyVersionToken is a no-op when the token is absent", () => {
    const html = `<html data-version="v1.0.0 · abc1234"></html>`;
    expect(applyVersionToken(html, "v9.9.9 · zzz")).toBe(html);
  });

  it("applyShaToken replaces every SHA token occurrence", () => {
    const html = `<div data-sha="__APP_VERSION_SHA__">__APP_VERSION_SHA__</div>`;
    expect(applyShaToken(html, "abc1234")).toBe(
      `<div data-sha="abc1234">abc1234</div>`,
    );
  });

  it("applyShaToken leaves __APP_VERSION__ alone (no prefix collision)", () => {
    // The two tokens share a 13-char prefix; the SHA replacer must not chew
    // the version token, and vice-versa. Belt-and-suspenders coverage.
    const html = `<html data-version="__APP_VERSION__" data-sha="__APP_VERSION_SHA__"></html>`;
    expect(applyShaToken(html, "abc1234")).toBe(
      `<html data-version="__APP_VERSION__" data-sha="abc1234"></html>`,
    );
    expect(applyVersionToken(html, "v1.0.0 · abc1234")).toBe(
      `<html data-version="v1.0.0 · abc1234" data-sha="__APP_VERSION_SHA__"></html>`,
    );
  });

  it("shortSha prefers GITHUB_SHA (truncated to 7 chars)", () => {
    expect(shortSha({ GITHUB_SHA: "abcdef1234567890" })).toBe("abcdef1");
  });
});
