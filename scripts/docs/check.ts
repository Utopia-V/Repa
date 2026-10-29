import path from "node:path";

import { applyExceptions, runChecks } from "./checks.js";
import { Repository, readSettings } from "./context.js";

async function main(): Promise<void> {
  const root = path.resolve(import.meta.dirname, "../..");
  const repo = Repository.tracked(root);
  const settings = await readSettings(repo);
  const issues = applyExceptions(await runChecks(repo, settings), settings, repo.files);
  for (const issue of issues) {
    console.error(`${issue.file}:${issue.line} ${issue.check} ${issue.message}`);
  }
  if (issues.length) process.exitCode = 1;
  else console.log("文档检查全部通过");
}

main().catch((error: unknown) => {
  console.error(`scripts/docs/check.ts:1 文档检查 ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
