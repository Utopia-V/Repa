import { readdir } from "node:fs/promises";
import path from "node:path";

export async function findSessionPath(directory: string, id: string): Promise<string | undefined> {
  const file = (await readdir(directory)).find(name => name.endsWith(`_${id}.jsonl`));
  return file === undefined ? undefined : path.join(directory, file);
}
