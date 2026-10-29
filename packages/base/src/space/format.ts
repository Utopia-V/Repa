import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { RepaFault } from "../schema.js";

// 标记读取允许新增可选字段；写标记时只生成当前版本约定的字段。
const FormatSchema = Type.Object({ version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) });

/**
 * 只读检查格式，返回盘上的版本。调用方负责读懂所有旧版本；需要改写时先备份，
 * 数据改写成功后才更新标记。新数据由所属模块显式初始化，不给未知数据补标记。
 */
export async function checkFormat(file: string, version: number): Promise<number> {
  if (!Number.isSafeInteger(version) || version < 1) throw new RepaFault("invalid_data_version", "数据版本必须是正整数");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    throw new RepaFault("unknown_data_format", "数据缺少格式标记，无法识别；请使用原应用或专用导入工具处理", { file });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RepaFault("invalid_data_version", "数据版本标记损坏", { file });
  }
  if (!Check(FormatSchema, value)) throw new RepaFault("invalid_data_version", "数据版本标记损坏", { file });
  if (value.version > version) {
    throw new RepaFault("incompatible_data_version", "数据由更新版本写入，请升级 Repa 或插件后再打开", { file, actual: value.version, required: version });
  }
  return value.version;
}
