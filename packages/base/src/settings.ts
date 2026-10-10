import { readFile } from "node:fs/promises";
import path from "node:path";
import type { TSchema, Static } from "typebox";
import {
  parse, PromptOverridesSchema, RepaFault, SettingsSchema,
  type PromptOverride, type PromptOverrides, type Settings,
} from "./schema.js";
import { SerialQueue, writeJson } from "./storage.js";

async function readJson<S extends TSchema>(file: string, schema: S, fallback: Static<S>): Promise<Static<S>> {
  try {
    return parse(schema, JSON.parse(await readFile(file, "utf8")) as unknown);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

export class SettingsStore {
  #queue = new SerialQueue();
  #value: Settings;

  private constructor(readonly home: string, settings: Settings) {
    this.#value = settings;
  }

  static async open(home: string): Promise<SettingsStore> {
    const settings = await readJson(path.join(home, "settings.json"), SettingsSchema, {
      commandPolicy: "ask", recentSpaces: [], prompts: {},
    });
    return new SettingsStore(home, settings);
  }

  get(): Settings {
    return structuredClone(this.#value);
  }

  set(update: Partial<Pick<Settings, "commandPolicy">>): Promise<Settings> {
    return this.#queue.run(async () => {
      const next = parse(SettingsSchema, { ...this.#value, ...update });
      await this.#save(next);
      return this.get();
    });
  }

  remember(root: string): Promise<void> {
    return this.#queue.run(async () => {
      const recentSpaces = [root, ...this.#value.recentSpaces.filter((item) => item !== root)].slice(0, 20);
      await this.#save({ ...this.#value, recentSpaces });
    });
  }

  async overrides(root?: string): Promise<{ app: PromptOverrides; space: PromptOverrides }> {
    return {
      app: this.get().prompts,
      space: root ? await readJson(path.join(root, ".repa", "prompts.json"), PromptOverridesSchema, {}) : {},
    };
  }

  setPrompt(scope: "app" | "space", id: string, override: PromptOverride | undefined, root?: string): Promise<void> {
    return this.#queue.run(async () => {
      if (scope === "space" && !root) throw new RepaFault("space_not_open", "空间尚未打开");
      const overrides = await this.overrides(root);
      const next = { ...overrides[scope] };
      if (override === undefined) delete next[id];
      else Object.defineProperty(next, id, { value: override, enumerable: true, writable: true, configurable: true });
      parse(PromptOverridesSchema, next);
      if (scope === "app") await this.#save({ ...this.#value, prompts: next });
      else await writeJson(path.join(root ?? "", ".repa", "prompts.json"), next);
    });
  }

  async #save(next: Settings): Promise<void> {
    await writeJson(path.join(this.home, "settings.json"), next);
    this.#value = next;
  }
}
