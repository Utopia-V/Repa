import type { TSchema } from "typebox";

import { document, loadModule, ROOT, runGenerator } from "./generation.js";
import { schemaTable } from "./schema-table.js";

export async function generateProtocol(root = ROOT) {
  const module = await loadModule(root, "packages/base/src/protocol.ts");
  const methods = module.methods as Record<string, { params: TSchema; result: TSchema }>;
  const notifications = module.notifications as Record<string, TSchema>;
  const entries = [
    ...Object.entries(methods).map(([name, method]) => ({
      name,
      text: `## 方法：${name}\n\n### 参数\n\n${schemaTable(method.params)}\n\n### 结果\n\n${schemaTable(method.result)}`,
    })),
    ...Object.entries(notifications).map(([name, schema]) => ({
      name,
      text: `## 通知：${name}\n\n${schemaTable(schema)}`,
    })),
  ].sort((a, b) => a.name.localeCompare(b.name, "en"));
  return document("protocol", "docs/generated/protocol.md", "前后端协议", entries.map((entry) => entry.text).join("\n\n"), entries.length);
}
runGenerator(import.meta.url, () => generateProtocol());
