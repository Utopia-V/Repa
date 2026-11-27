import type { Issue, Repository } from "./context.js";
import { generateHostApi } from "./gen-host-api.js";
import { generatePackages } from "./gen-packages.js";
import { generateProtocol } from "./gen-protocol.js";
import { checkGenerated } from "./generation.js";

export async function catalogs(repo: Repository): Promise<Issue[]> {
  if (!repo.files.includes("scripts/docs/config.json")) return [];
  const { generateTools } = await import("./gen-tools.js");
  const outputs = [
    await generatePackages(repo.root),
    await generateProtocol(repo.root),
    await generateTools(),
    await generateHostApi(repo.root),
  ];
  return checkGenerated(repo.root, outputs);
}
