/** 有说明的常量，供导出检查夹具使用。 */
export const documented = 1;
export const missing = 2;
/** */
export interface Empty {}
/** @param value 只有参数说明，不是声明说明。 */
export function tagsOnly(value: number): number { return value; }
/** 有说明的接口，用于验证接口声明。 */
export interface Documented {}
export class MissingClass {}
export type MissingType = string;
export { local as renamed };
const local = 3;
export { foreign } from "../../external.js";
export * from "../../external.js";
export { inside } from "./original.js";
