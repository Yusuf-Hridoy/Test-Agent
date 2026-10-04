/**
 * The demo's stand-in application — the same fixture shop the test suite uses,
 * served on a fixed port so a recording can break it on cue.
 *
 *   npx tsx launch/fixture-shop.ts        # http://127.0.0.1:8099
 *     r  rename "Add to cart" to "Add to basket"   (breaks a recorded flow)
 *     u  undo the rename
 *     q  quit
 *
 * Not part of the shipped package: it imports the test fixture, and `files` in
 * package.json ships only dist/ and templates/.
 */
import { startFakeApp } from "../src/harness/__tests__/fakeapp.js";

const PORT = Number(process.env.PORT ?? 8099);
const app = await startFakeApp(PORT);

console.log(`fixture shop on ${app.url}`);
console.log("  r = rename the add-to-cart button   u = undo   q = quit");

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (key: Buffer) => {
  const k = String(key);
  if (k === "r") {
    app.setAddLabel("Add to basket");
    console.log('renamed: "Add to cart" -> "Add to basket"');
  } else if (k === "u") {
    app.setAddLabel("Add to cart");
    console.log('restored: "Add to cart"');
  } else if (k === "q" || k === "\u0003") {
    void app.close().then(() => process.exit(0));
  }
});
