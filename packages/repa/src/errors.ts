/** 可通过程序接口处理的产品错误；细节仍受调用入口的访问范围约束。 */
export class RepaFault extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
