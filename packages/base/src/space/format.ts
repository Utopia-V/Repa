import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { object, RepaFault } from "../schema.js";
import { writeJson } from "../storage.js";

const FormatSchema = object({ version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) });

/** 空间持有独占锁后使用；无标记的重做期数据补当前版本，已有标记绝不覆盖。 */
export async function checkFormat(file: string, version: number): Promise<void> {
  if (!Number.isSafeInteger(version) || version < 1) throw new RepaFault("invalid_data_version", "数据版本必须是正整数");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    await writeJson(file, { version });
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RepaFault("invalid_data_version", "数据版本标记损坏", { file });
  }
  if (!Check(FormatSchema, value)) throw new RepaFault("invalid_data_version", "数据版本标记损坏", { file });
  if (value.version !== version) {
    throw new RepaFault("incompatible_data_version", "数据格式与当前代码不兼容，请使用兼容版本打开", { file, actual: value.version, required: version });
  }
}
