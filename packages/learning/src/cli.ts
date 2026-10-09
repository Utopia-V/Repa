#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { runCli } from "repa/cli";
import { startLearningServer } from "./product.js";

await runCli(process.argv.slice(2), {
  entry: fileURLToPath(import.meta.url),
  name: "repa-learning",
  startServer: startLearningServer,
});
