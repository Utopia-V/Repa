// 只返回判断，不把真实回复写入证据；分开定位状态读取和提示覆盖的失败。
export function checkProbeReply(text: string | undefined, version: number, suffix: string) {
  const reply = text?.trim();
  const parsed = reply?.match(/^CHECK_(\d+)\|([AB])$/u);
  return {
    replyMatches: reply === `CHECK_${version}|${suffix}`,
    replyFormatMatches: Boolean(parsed),
    versionMatches: parsed ? Number(parsed[1]) === version : null,
    suffixMatches: parsed ? parsed[2] === suffix : null,
  };
}
