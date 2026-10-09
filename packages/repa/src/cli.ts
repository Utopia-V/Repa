#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { runCli } from "./cli-main.js";

await runCli(process.argv.slice(2), { entry: fileURLToPath(import.meta.url) });
