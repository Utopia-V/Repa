import { expect, test } from "vitest";

import { comboOf, keyOf } from "../src/ui";

const press = (key: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) =>
  comboOf({ key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

test("按键写成键位表里的字：修饰键在前，只按修饰键不算，Shift 打出的符号不再写 Shift", () => {
  expect(press("Enter", { shiftKey: true })).toBe("Shift+Enter");
  expect(press("k", { ctrlKey: true })).toBe("Ctrl+K");
  expect(press("?", { shiftKey: true })).toBe("?");
  expect(press("Control", { ctrlKey: true })).toBe("");
  expect(keyOf({ send: "Ctrl+Enter" }, "send")).toBe("Ctrl+Enter");
  expect(keyOf({}, "side")).toBe("Ctrl+\\");
});
