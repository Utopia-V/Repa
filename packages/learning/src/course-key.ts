/**
 * 课在空间里的身份：登记里的一个键，创建时定下，此后不变。文件夹只是课的位置，清单里的 id 只是作者的声明，
 * 两者都会变（改名、搬走、模型换版时改了 id），键不变。学习状态（学生模型、补救、失败、已学的节、首次见题）按“课的键加编号”存，
 * 两门课的 topic 与题目编号可以相同。
 */
import { Type } from "typebox";

/** 课的键：小写字母、数字与连字符。 */
export const CourseKeySchema = Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" });

/** 随包的课的键，由它的包内标识（课程目录名）定。 */
export function bundledKey(name: string): string {
  return `bundled-${name}`;
}

/** 学习状态里的键：课的键加 topic 或题目的编号。 */
export function scoped(key: string, id: string): string {
  return `${key}:${id}`;
}

/** 学习状态的键属于这门课时，去掉课的键得到编号；不属于时为 undefined。 */
export function unscoped(key: string, id: string): string | undefined {
  return id.startsWith(`${key}:`) ? id.slice(key.length + 1) : undefined;
}
