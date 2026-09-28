import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import lockfile from "proper-lockfile";
import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { RepaFault } from "../errors.js";
import { IdSchema, object, RevisionSchema } from "../schema.js";
import { SerialQueue, writeJson } from "../storage/atomic.js";
import {
  DEFAULT_BASE_PROMPT,
  PromptSettingsSchema,
  SettingsGetParamsSchema,
  SettingsResetParamsSchema,
  SettingsSetParamsSchema,
  type PromptSettings,
  type SettingScope,
  type SettingsEntry,
  type SettingsResetParams,
  type SettingsSetParams,
  type SettingsView,
} from "./schema.js";

export { DEFAULT_BASE_PROMPT } from "./schema.js";

type PromptKey = keyof PromptSettings;
type PromptValue = PromptSettings[PromptKey];
type StoredEntry = { revision: string; value?: PromptValue };
type Overrides = Partial<Record<PromptKey, StoredEntry>>;
type StoredScope = { prompts?: Overrides };
type SettingsFile = StoredScope & {
  format: "repa.settings";
  version: 1;
  sessions?: Record<string, StoredScope>;
};
type Files = { application: SettingsFile; space?: SettingsFile };
type Locations = { application: string; space?: string };

const defaults: PromptSettings = {
  base: DEFAULT_BASE_PROMPT,
  append: [],
  projectInstructions: false,
  skillCatalog: true,
  environment: true,
  learningContext: true,
  fileChanges: "on-demand",
};
const keys = Object.keys(PromptSettingsSchema.properties) as PromptKey[];
const storedOverrides = object(Object.fromEntries(
  Object.entries(PromptSettingsSchema.properties).map(([key, value]) => [
    key,
    Type.Optional(object({ revision: RevisionSchema, value: Type.Optional(value) })),
  ]),
));
const storedScope = { prompts: Type.Optional(storedOverrides) };
const storedFile = {
  format: Type.Literal("repa.settings"),
  version: Type.Literal(1),
  ...storedScope,
};
const applicationFileSchema = object(storedFile);
const spaceFileSchema = object({
  ...storedFile,
  sessions: Type.Optional(Type.Record(IdSchema, object(storedScope))),
});
const emptyFile = (): SettingsFile => ({ format: "repa.settings", version: 1 });

function overrides(file: SettingsFile, scope: SettingScope): Overrides {
  if (scope.kind !== "session") return file.prompts ?? {};
  return file.sessions && Object.hasOwn(file.sessions, scope.sessionId)
    ? file.sessions[scope.sessionId]!.prompts ?? {}
    : {};
}

function currentEntry(files: Files, scope: SettingScope, key: PromptKey): StoredEntry | undefined {
  return overrides(scope.kind === "application" ? files.application : files.space!, scope)[key];
}

function hasValue(entry: StoredEntry | undefined): entry is StoredEntry & { value: PromptValue } {
  return entry !== undefined && Object.hasOwn(entry, "value");
}

function revision(entry: StoredEntry | undefined): string {
  return entry?.revision ?? "unset";
}

function checkInput(schema: TSchema, value: unknown): void {
  if (!Check(schema, value))
    throw new RepaFault("configuration", "设置请求的作用域、字段或修改基准无效。");
}

function checkNamespace(namespace: string): void {
  if (namespace !== "prompts")
    throw new RepaFault("unsupported_settings_namespace", `尚未定义设置命名空间：${namespace}。`);
}

function promptKey(key: string): PromptKey {
  if (!Object.hasOwn(PromptSettingsSchema.properties, key))
    throw new RepaFault("configuration", `未知提示设置：${key}。`);
  return key as PromptKey;
}

async function readSettings(file: string, schema: TSchema): Promise<SettingsFile> {
  let bytes: string;
  try {
    bytes = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFile();
    throw new RepaFault("configuration", `无法读取设置文件：${file}。`, { file });
  }
  let saved: unknown;
  try { saved = JSON.parse(bytes); } catch {
    throw new RepaFault("configuration", `设置文件不是有效的 JSON：${file}。`, { file });
  }
  if (!Check(schema, saved))
    throw new RepaFault("configuration", `设置文件的格式或设置值无效：${file}。`, { file });
  return saved as SettingsFile;
}

/** 持有按项覆盖与修订；读取不创建配置，修改在配置文件锁内重新检查当前项。 */
export class ConfigStore {
  readonly #appDirectory: string;
  readonly #resolveSpace: (spaceId: string) => string;
  readonly #queue = new SerialQueue();

  constructor(options: { appDirectory: string; resolveSpace: (spaceId: string) => string }) {
    this.#appDirectory = path.resolve(options.appDirectory);
    this.#resolveSpace = options.resolveSpace;
  }

  async get(scope: SettingScope, namespace: string): Promise<SettingsView> {
    checkInput(SettingsGetParamsSchema, { scope, namespace });
    checkNamespace(namespace);
    scope = structuredClone(scope);
    return this.#view(scope, await this.#read(this.#locations(scope)));
  }

  async set(params: SettingsSetParams): Promise<SettingsView> {
    checkInput(SettingsSetParamsSchema, params);
    checkNamespace(params.namespace);
    const key = promptKey(params.key);
    if (!Check(PromptSettingsSchema.properties[key], params.value))
      throw new RepaFault("configuration", `提示设置 ${key} 的值类型或允许范围无效。`, {
        namespace: params.namespace, key,
      });
    return this.#change(structuredClone(params), key, { value: structuredClone(params.value) as PromptValue });
  }

  async reset(params: SettingsResetParams): Promise<SettingsView> {
    checkInput(SettingsResetParamsSchema, params);
    checkNamespace(params.namespace);
    return this.#change(structuredClone(params), promptKey(params.key), {});
  }

  async prompts(scope: SettingScope): Promise<PromptSettings> {
    const view = await this.get(scope, "prompts");
    return Object.fromEntries(view.entries.map((entry) => [entry.key, entry.effective])) as PromptSettings;
  }

  #locations(scope: SettingScope): Locations {
    return {
      application: path.join(this.#appDirectory, "repa-settings.json"),
      ...(scope.kind === "application" ? {} : {
        space: path.resolve(this.#resolveSpace(scope.spaceId), ".repa", "settings.json"),
      }),
    };
  }

  async #read(locations: Locations): Promise<Files> {
    const [application, space] = await Promise.all([
      readSettings(locations.application, applicationFileSchema),
      locations.space ? readSettings(locations.space, spaceFileSchema) : undefined,
    ]);
    return { application, ...(space ? { space } : {}) };
  }

  #view(scope: SettingScope, files: Files): SettingsView {
    const layers: { scope: SettingScope; file: SettingsFile }[] = [
      { scope: { kind: "application" }, file: files.application },
    ];
    if (scope.kind !== "application")
      layers.push({ scope: { kind: "space", spaceId: scope.spaceId }, file: files.space! });
    if (scope.kind === "session") layers.push({ scope, file: files.space! });
    const entries = keys.map((key): SettingsEntry => {
      let effective: PromptValue = defaults[key];
      let source: SettingsEntry["source"] = "default";
      for (const layer of layers) {
        const entry = overrides(layer.file, layer.scope)[key];
        if (hasValue(entry)) {
          effective = entry.value;
          source = layer.scope;
        }
      }
      const current = currentEntry(files, scope, key);
      return {
        key,
        ...(hasValue(current) ? { override: current.value } : {}),
        effective,
        source,
        revision: revision(current),
      };
    });
    return structuredClone({ namespace: "prompts", scope, entries });
  }

  #change(
    params: SettingsResetParams,
    key: PromptKey,
    next: { value?: PromptValue },
  ): Promise<SettingsView> {
    const { scope } = params;
    const locations = this.#locations(scope);
    const same = (files: Files): boolean => {
      const current = currentEntry(files, scope, key);
      return Object.hasOwn(next, "value")
        ? hasValue(current) && isDeepStrictEqual(current.value, next.value)
        : !hasValue(current);
    };
    return this.#queue.run(async () => {
      const observed = await this.#read(locations);
      if (same(observed)) return this.#view(scope, observed);
      const target = scope.kind === "application" ? locations.application : locations.space!;
      try {
        await mkdir(path.dirname(target), { recursive: true });
        // 解析父目录即可锁住尚不存在的文件，并让目录符号链接共用同一把锁。
        const file = path.join(await realpath(path.dirname(target)), path.basename(target));
        let compromised: Error | undefined;
        const release = await lockfile.lock(file, {
          realpath: false,
          retries: { retries: 30, minTimeout: 10, maxTimeout: 100 },
          onCompromised: (error) => { compromised = error; },
        });
        try {
          const current = await this.#read(locations);
          if (same(current)) return this.#view(scope, current);
          const actual = revision(currentEntry(current, scope, key));
          if (params.base !== actual)
            throw new RepaFault("settings_conflict", "该项设置已改变，请读取当前值后重新修改。", {
              scope, namespace: params.namespace, key, base: params.base, revision: actual,
            });
          const saved = scope.kind === "application" ? current.application : current.space!;
          const prompts = { ...overrides(saved, scope), [key]: { revision: randomUUID(), ...next } };
          if (scope.kind === "session")
            saved.sessions = { ...saved.sessions, [scope.sessionId]: { prompts } };
          else saved.prompts = prompts;
          if (compromised) throw compromised;
          await writeJson(file, saved);
          if (compromised) throw compromised;
          return this.#view(scope, current);
        } finally {
          await release();
        }
      } catch (error) {
        if (error instanceof RepaFault) throw error;
        throw new RepaFault("configuration", `无法保存设置文件：${target}。`, {
          file: target, reason: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }
}
