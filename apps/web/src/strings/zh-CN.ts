/**
 * 界面上给人看的文字。要改一句话，直接改这里，不用动组件。
 * 文字由人书写：Agent 新增键时值写成“〔待写〕”，不写内容。
 * 键名是“区域.对象.用途”，`{name}` 由调用处传入。
 */
export const strings = {
  // 下拉选择
  "select.placeholder": "选择",

  // 抽屉
  "sheet.close.label": "关闭导航",

  // 对话框
  "dialog.close.label": "关闭对话框",
} as const satisfies Record<string, string>;
