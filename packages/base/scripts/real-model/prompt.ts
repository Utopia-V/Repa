export const PROBE_PROMPT = "读取最新 view 的核实版本，按当前插件说明仅回复版本码和后缀，用竖线连接。不要调用工具。";
export const CHANGE_NOTICE = "变更说明：plugin:notes 的核实回复后缀已从 A 改为 B；后续回复使用 B，之前回复中的 A 已过时。";

// 说明只附在覆盖后的第一轮，后续轮次仍发送原问题，观察模型是否持续采用新规则。
export function probePrompt(changeNotice = false): string {
  return changeNotice ? `${PROBE_PROMPT}\n${CHANGE_NOTICE}` : PROBE_PROMPT;
}
