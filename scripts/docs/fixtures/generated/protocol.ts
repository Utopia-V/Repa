export const methods = {
  "z.get": { params: { type: "object", properties: {} }, result: { type: "null" } },
  "a.set": {
    params: { type: "object", properties: { title: { type: "string", description: "标题" }, note: { type: "string" } }, required: ["title"] },
    result: { type: "object", properties: { saved: { type: "boolean", description: "是否保存" } }, required: ["saved"] },
  },
};
export const notifications = { "b.changed": { type: "object", properties: { id: { type: "string" } }, required: ["id"] } };
