import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { renderSnapshot, takeSnapshot } from "../snapshot.js";

const FIXTURE = `
<html><head><title>Fixture Shop</title></head><body>
  <h1>Fixture Shop</h1>
  <label for="user">Username</label><input id="user" name="user-name" type="text" placeholder="Username">
  <input id="pw" type="password" aria-label="Password" value="hunter2">
  <button id="go">Login</button>
  <a href="/cart.html">Cart</a>
  <select id="qty" aria-label="Quantity"><option value="1">1</option><option value="2">2</option></select>
  <button style="display:none">Hidden Button</button>
  <button disabled aria-label="Checkout">Checkout</button>
  <p>Some page copy for the model to read.</p>
</body></html>`;

describe("takeSnapshot", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.setContent(FIXTURE);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("returns stable ids for the interactive elements", async () => {
    const { snap, locators } = await takeSnapshot(page);
    expect(snap.title).toBe("Fixture Shop");
    expect(snap.elements.map((e) => e.id)).toEqual(
      snap.elements.map((_, i) => `e${i + 1}`),
    );
    expect(locators.size).toBe(snap.elements.length);
    const again = await takeSnapshot(page);
    expect(again.snap.elements).toEqual(snap.elements);
  });

  it("names elements by aria-label, label, text and placeholder", async () => {
    const { snap } = await takeSnapshot(page);
    const byName = (name: string) => snap.elements.find((e) => e.name === name);
    expect(byName("Username")).toMatchObject({ role: "textbox", tag: "input[text]" });
    expect(byName("Password")).toMatchObject({ role: "textbox", tag: "input[password]" });
    expect(byName("Login")).toMatchObject({ role: "button", tag: "button" });
    expect(byName("Cart")).toMatchObject({ role: "link", tag: "a" });
    expect(byName("Quantity")).toMatchObject({ role: "combobox", tag: "select" });
    expect(byName("Checkout")).toMatchObject({ disabled: true });
  });

  it("never exposes a password field's value (Hard Rule 2)", async () => {
    const { snap } = await takeSnapshot(page);
    expect(JSON.stringify(snap)).not.toContain("hunter2");
    expect(snap.elements.find((e) => e.name === "Password")?.value).toBeUndefined();
  });

  it("sorts visible elements before hidden ones", async () => {
    const { snap } = await takeSnapshot(page);
    const hidden = snap.elements.findIndex((e) => e.name === "Hidden Button");
    const visible = snap.elements.findIndex((e) => e.name === "Login");
    expect(visible).toBeLessThan(hidden);
  });

  it("caps pageText at 2000 chars", async () => {
    await page.setContent(`<html><body><p>${"x".repeat(5000)}</p></body></html>`);
    const { snap } = await takeSnapshot(page);
    expect(snap.pageText.length).toBeLessThanOrEqual(2000);
    await page.setContent(FIXTURE);
  });

  it("renders a compact prompt view", async () => {
    const { snap } = await takeSnapshot(page);
    const text = renderSnapshot(snap);
    expect(text).toContain("URL:");
    expect(text).toContain('e1 textbox "Username" input[text]');
  });
});
