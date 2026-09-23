import { describe, expect, it } from "vitest";
import { normalizePageKey, pathOfKey } from "../pagekey.js";

const cases: [string, string][] = [
  // the brief's own two examples
  ["https://shop.test/item/4711?x=1", "shop.test/item/:id"],
  ["https://www.saucedemo.com/inventory.html", "www.saucedemo.com/inventory.html"],
  // scheme, case and fragment are identity-free
  ["HTTP://Shop.Test/Cart", "shop.test/cart"],
  ["https://shop.test/cart#items", "shop.test/cart"],
  ["https://shop.test/cart?a=1&b=2", "shop.test/cart"],
  // root stays "/", other trailing slashes are stripped
  ["https://shop.test", "shop.test/"],
  ["https://shop.test/", "shop.test/"],
  ["https://shop.test/orders/", "shop.test/orders"],
  // the port is part of the application's identity
  ["http://127.0.0.1:8080/inventory", "127.0.0.1:8080/inventory"],
  // parameterization: numeric, UUID, long hex, opaque base64url key
  ["https://shop.test/user/42/orders/7", "shop.test/user/:id/orders/:id"],
  ["https://shop.test/o/3f2504e0-4f89-11d3-9a0c-0305e82c3301", "shop.test/o/:id"],
  ["https://shop.test/doc/507f1f77bcf86cd799439011", "shop.test/doc/:id"],
  ["https://shop.test/c/cus_Jk3MnBvCx9QwEr", "shop.test/c/:id"],
  // …but readable long slugs are NOT ids, or the map loses the pages that matter
  ["https://shop.test/blog/add-cheapest-item-to-cart", "shop.test/blog/add-cheapest-item-to-cart"],
  ["https://shop.test/blog/2026-09-18-release-notes", "shop.test/blog/2026-09-18-release-notes"],
  // non-http pages still get a stable key (S3: dead servers park here)
  ["chrome-error://chromewebdata/", "chrome-error://chromewebdata/"],
  ["about:blank", "about:blank"],
];

describe("normalizePageKey", () => {
  for (const [input, expected] of cases) {
    it(`${input} → ${expected}`, () => {
      expect(normalizePageKey(input)).toBe(expected);
    });
  }

  it("is stable: normalizing a key again changes nothing for app URLs", () => {
    for (const [input] of cases.slice(0, 14)) {
      const once = normalizePageKey(input);
      expect(normalizePageKey(`https://${once}`)).toBe(once);
    }
  });

  it("survives junk instead of throwing", () => {
    expect(normalizePageKey("")).toBe("");
    expect(normalizePageKey("not a url")).toBe("not a url");
    expect(normalizePageKey("https://shop.test/%E0%A4%A")).toBe("shop.test/%e0%a4%a");
  });

  it("pathOfKey renders the path half for CLI tables", () => {
    expect(pathOfKey("shop.test/item/:id")).toBe("/item/:id");
    expect(pathOfKey("shop.test/")).toBe("/");
  });
});
