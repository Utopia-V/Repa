/** 文件大小，按 1024 进位，取一位小数，例如 2.4 MB。 */
export function fileSize(bytes: number): string {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return new Intl.NumberFormat("zh-CN", { style: "unit", unit: units[unit], unitDisplay: "short", maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value);
}

/**
 * 估算的花费（美元）。单价来自模型目录，用量按会话记录汇总，只是估算，所以只留两位有效数字：
 * 0.0834 写成 US$0.083，12.37 写成 US$12。
 */
export function estimatedUsd(amount: number): string {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "USD", maximumSignificantDigits: 2 }).format(amount);
}
