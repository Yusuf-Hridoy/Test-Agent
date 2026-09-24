import type { Locator, Page } from "playwright";
import type { ElementRef, Snapshot } from "../types.js";

export const MAGPIE_ATTR = "data-magpie-id";
const MAX_ELEMENTS = 120;
const MAX_PAGE_TEXT = 2000;
const MAX_NAME = 60;

const INTERACTIVE_SELECTOR = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "[role=button]",
  "[role=link]",
  "[role=tab]",
  "[role=checkbox]",
  "[role=menuitem]",
  "[onclick]",
].join(",");

export interface SnapshotResult {
  snap: Snapshot;
  /** Valid only until the next action — the harness re-snapshots after each one. */
  locators: Map<string, Locator>;
}

/**
 * Tag every interactive element with a stable id and describe the page for the
 * model. Runs in the page so one round-trip covers layout, names and values.
 */
export async function takeSnapshot(page: Page): Promise<SnapshotResult> {
  const data = await page.evaluate(
    ({ selector, attr, maxElements, maxPageText, maxName }) => {
      for (const stale of Array.from(document.querySelectorAll(`[${attr}]`))) {
        stale.removeAttribute(attr);
      }

      const roleOf = (el: Element): string => {
        const explicit = el.getAttribute("role");
        if (explicit) return explicit;
        const tag = el.tagName.toLowerCase();
        if (tag === "a") return "link";
        if (tag === "button") return "button";
        if (tag === "select") return "combobox";
        if (tag === "textarea") return "textbox";
        if (tag === "input") {
          const type = (el.getAttribute("type") ?? "text").toLowerCase();
          if (["button", "submit", "reset", "image"].includes(type)) return "button";
          if (type === "checkbox") return "checkbox";
          if (type === "radio") return "radio";
          return "textbox";
        }
        return "generic";
      };

      const nameOf = (el: Element): string => {
        const aria = el.getAttribute("aria-label");
        if (aria?.trim()) return aria.trim();
        const labelledBy = el.getAttribute("aria-labelledby");
        if (labelledBy) {
          const text = labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" ")
            .trim();
          if (text) return text;
        }
        const id = el.getAttribute("id");
        if (id) {
          const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (label?.textContent?.trim()) return label.textContent.trim();
        }
        const wrapping = el.closest("label");
        if (wrapping?.textContent?.trim()) return wrapping.textContent.trim();
        const text = (el as HTMLElement).innerText?.trim();
        if (text) return text;
        const placeholder = el.getAttribute("placeholder");
        if (placeholder?.trim()) return placeholder.trim();
        const value = el.getAttribute("value");
        if (value?.trim() && el.tagName.toLowerCase() === "input") return value.trim();
        const nameAttr = el.getAttribute("name");
        if (nameAttr?.trim()) return nameAttr.trim();
        const title = el.getAttribute("title");
        return title?.trim() ?? "";
      };

      const els = Array.from(document.querySelectorAll(selector));
      const described = els.map((el, index) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity ?? "1") > 0.05;
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute("type") ?? "").toLowerCase();
        // Hard Rule 2: a password field's value never leaves the browser.
        const rawValue =
          tag === "input" || tag === "textarea" || tag === "select"
            ? (el as HTMLInputElement).value
            : undefined;
        const value =
          type === "password" ? undefined : rawValue ? rawValue.slice(0, maxName) : undefined;
        // `href` on an anchor is already absolute in the DOM, and only anchors
        // tell memory about pages nobody has visited yet.
        const href =
          tag === "a" && (el as HTMLAnchorElement).href
            ? (el as HTMLAnchorElement).href
            : undefined;
        return {
          index,
          el,
          visible,
          top: rect.top,
          desc: {
            role: roleOf(el),
            name: nameOf(el).replace(/\s+/g, " ").slice(0, maxName),
            tag: type ? `${tag}[${type}]` : tag,
            ...(value ? { value } : {}),
            ...((el as HTMLInputElement).disabled ? { disabled: true } : {}),
            ...(href ? { href } : {}),
          },
        };
      });

      described.sort((a, b) => {
        if (a.visible !== b.visible) return a.visible ? -1 : 1;
        if (a.visible && b.visible) return Math.abs(a.top) - Math.abs(b.top);
        return a.index - b.index;
      });

      const kept = described.slice(0, maxElements);
      const elements = kept.map((entry, i) => {
        const id = `e${i + 1}`;
        entry.el.setAttribute(attr, id);
        return { id, ...entry.desc };
      });

      return {
        url: location.href,
        title: document.title,
        elements,
        pageText: (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").slice(0, maxPageText),
        truncated: described.length > maxElements ? described.length - maxElements : 0,
      };
    },
    {
      selector: INTERACTIVE_SELECTOR,
      attr: MAGPIE_ATTR,
      maxElements: MAX_ELEMENTS,
      maxPageText: MAX_PAGE_TEXT,
      maxName: MAX_NAME,
    },
  );

  const locators = new Map<string, Locator>();
  for (const el of data.elements) {
    locators.set(el.id, page.locator(`[${MAGPIE_ATTR}="${el.id}"]`));
  }

  const snap: Snapshot = {
    url: data.url,
    title: data.title,
    elements: data.elements as ElementRef[],
    pageText:
      data.truncated > 0
        ? `${data.pageText}\n[${data.truncated} more interactive elements not listed]`
        : data.pageText,
  };
  return { snap, locators };
}

/** Compact snapshot rendering for the model prompt. */
export function renderSnapshot(snap: Snapshot): string {
  const lines = snap.elements.map((e) => {
    const bits = [`${e.id}`, `${e.role}`, `"${e.name}"`, e.tag];
    if (e.value) bits.push(`value="${e.value}"`);
    if (e.disabled) bits.push("disabled");
    return `  ${bits.join(" ")}`;
  });
  return [
    `URL: ${snap.url}`,
    `TITLE: ${snap.title}`,
    `ELEMENTS (${snap.elements.length}):`,
    ...lines,
    `PAGE TEXT:`,
    snap.pageText,
  ].join("\n");
}
