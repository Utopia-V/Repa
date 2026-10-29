// 120 个方法各带一段长说明，生成的协议目录超过 40 KB。
const text = { type: "string", description: "这一段说明很长，".repeat(10) };
export const methods = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [
  `demo.method${index}`,
  { params: { type: "object", properties: { text }, required: ["text"] }, result: { type: "null" } },
]));
export const notifications = {};
