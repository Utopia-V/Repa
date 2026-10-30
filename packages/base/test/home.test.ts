import assert from "node:assert/strict";
import test from "node:test";
import { resolveAppHome } from "../src/home.js";

test("默认应用配置位置遵循系统目录和显式覆盖优先级", () => {
  assert.equal(resolveAppHome({ platform: "linux", userHome: "/users/local", env: {} }), "/users/local/.config/repa");
  assert.equal(resolveAppHome({ platform: "linux", userHome: "/users/local", env: { XDG_CONFIG_HOME: "/config" } }), "/config/repa");
  assert.equal(resolveAppHome({ platform: "linux", userHome: "/users/local", env: { XDG_CONFIG_HOME: "relative" } }), "/users/local/.config/repa");
  assert.equal(resolveAppHome({ platform: "darwin", userHome: "/Users/local", env: {} }), "/Users/local/Library/Application Support/Repa");
  assert.equal(resolveAppHome({ platform: "win32", userHome: "C:\\Users\\local", env: { APPDATA: "D:\\Roaming" } }), "D:\\Roaming\\Repa");
  assert.equal(resolveAppHome({ platform: "win32", userHome: "C:\\Users\\local", env: {} }), "C:\\Users\\local\\AppData\\Roaming\\Repa");
  assert.equal(resolveAppHome({ platform: "linux", env: { REPA_HOME: "/override", XDG_CONFIG_HOME: "/config" } }), "/override");
  assert.equal(resolveAppHome({ platform: "linux", home: "/explicit", env: { REPA_HOME: "/override" } }), "/explicit");
});
