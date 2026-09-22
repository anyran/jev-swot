import { describe, expect, it } from "vitest";
import { isSelectionShortcut } from "./shortcut";

describe("selection shortcut fallback", () => {
  it("accepts Ctrl/Command+Shift+Y", () => {
    expect(isSelectionShortcut({ key: "y", code: "KeyY", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, isComposing: false })).toBe(true);
    expect(isSelectionShortcut({ key: "Y", code: "KeyY", ctrlKey: false, metaKey: true, shiftKey: true, altKey: false, isComposing: false })).toBe(true);
    expect(isSelectionShortcut({ key: "z", code: "KeyY", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, isComposing: false })).toBe(true);
    expect(isSelectionShortcut({ key: "y", code: "KeyY", ctrlKey: false, metaKey: false, shiftKey: true, altKey: true, isComposing: false })).toBe(true);
    expect(isSelectionShortcut({ key: "u", code: "KeyU", ctrlKey: false, metaKey: true, shiftKey: true, altKey: false, isComposing: false })).toBe(true);
  });
  it("does not intercept editable or modified shortcuts", () => {
    expect(isSelectionShortcut({ key: "y", code: "KeyY", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, isComposing: false })).toBe(false);
    expect(isSelectionShortcut({ key: "u", code: "KeyU", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, isComposing: false })).toBe(false);
    expect(isSelectionShortcut({ key: "u", code: "KeyU", ctrlKey: true, metaKey: false, shiftKey: true, altKey: true, isComposing: false })).toBe(false);
    expect(isSelectionShortcut({ key: "y", code: "KeyY", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, isComposing: true })).toBe(false);
  });
});
