import type { TestContext } from "node:test";

/** CI 要求环境完整；本机缺环境时仍按原原因跳过。 */
export function skipUnavailableEnvironment(t: TestContext, reason: string): void {
  if (process.env.REPA_TEST_REQUIRE_ENV === "1") {
    throw new Error(reason);
  }
  t.skip(reason);
}
