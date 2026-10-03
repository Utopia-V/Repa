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
  SettingsDefinitionSchema,
  SettingsGetParamsSchema,
  SettingsResetParamsSchema,
  SettingsSetParamsSchema,
  type PromptSettings,
  type SettingScope,
  type SettingsEntry,
  type SettingsDefinition,
  type SettingsResetParams,
  type SettingsSetParams,
  type SettingsView,
} from "./schema.js";
import { PROMPT_SETTINGS_DEFINITION, type SettingsNamespaceDefinition } from "./definitions.js";

type StoredEntry = { revision: string; value?: unknown };
type Overrides = Record<string, StoredEntry>;
type StoredScope = { namespaces?: Record<string, Overrides> };
type SettingsFile = StoredScope & {
  format: "repa.settings";
  version: 2;
  sessions?: Record<string, StoredScope>;
};
type LegacyScope = { prompts?: Overrides };
type LegacyFile = LegacyScope & {
  format: "repa.settings";
  version: 1;
  sessions?: Record<string, LegacyScope>;
};
type Files = { application: SettingsFile; space?: SettingsFile };
type Locations = { application: string; space?: string };

const storedOverrides = Type.Record(Type.String({ minLength: 1 }), object({
  revision: RevisionSchema,
  value: Type.Optional(Type.Unknown()),
}));
const storedScope = object({
  namespaces: Type.Optional(Type.Record(Type.String({ minLength: 1 }), storedOverrides)),
});
const legacyScope = object({ prompts: Type.Optional(storedOverrides) });
const fileSchema = (session: boolean) => Type.Union([
  object({
    format: Type.Literal("repa.settings"),
    version: Type.Literal(2),
    ...storedScope.properties,
    ...(session ? { sessions: Type.Optional(Type.Record(IdSchema, storedScope)) } : {}),
  }),
  object({
    format: Type.Literal("repa.settings"),
    version: Type.Literal(1),
    ...legacyScope.properties,
    ...(session ? { sessions: Type.Optional(Type.Record(IdSchema, legacyScope)) } : {}),
  }),
]);
const applicationFileSchema = fileSchema(false);
const spaceFileSchema = fileSchema(true);
const emptyFile = (): SettingsFile => ({ format: "repa.settings", version: 2 });

function storedScopeFor(file: SettingsFile, scope: SettingScope): StoredScope {
  if (scope.kind !== "session") return file;
  return file.sessions && Object.hasOwn(file.sessions, scope.sessionId)
    ? file.sessions[scope.sessionId] ?? {}
    : {};
}

function overrides(file: SettingsFile, scope: SettingScope, namespace: string): Overrides {
  const namespaces = storedScopeFor(file, scope).namespaces;
  return namespaces && Object.hasOwn(namespaces, namespace) ? namespaces[namespace] ?? {} : {};
}

function currentEntry(files: Files, scope: SettingScope, namespace: string, key: string): StoredEntry | undefined {
  const items = overrides(scope.kind === "application" ? files.application : files.space!, scope, namespace);
  return Object.hasOwn(items, key) ? items[key] : undefined;
}

function hasValue(entry: StoredEntry | undefined): entry is StoredEntry & { value: unknown } {
  return entry !== undefined && Object.hasOwn(entry, "value");
}

function revision(entry: StoredEntry | undefined): string {
  return entry?.revision ?? "unset";
}

function checkInput(schema: TSchema, value: unknown): void {
  if (!Check(schema, value))
    throw new RepaFault("configuration", "设置请求的作用域、字段或修改基准无效。");
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
  const parsed = saved as SettingsFile | LegacyFile;
  if (parsed.version === 2) return parsed;
  const migrateScope = (scope: LegacyScope): StoredScope =>
    scope.prompts ? { namespaces: { prompts: scope.prompts } } : {};
  return {
    format: "repa.settings",
    version: 2,
    ...migrateScope(parsed),
    ...(parsed.sessions ? {
      sessions: Object.fromEntries(Object.entries(parsed.sessions).map(([id, scope]) => [id, migrateScope(scope)])),
    } : {}),
  };
}

/** 持有按项覆盖与修订；读取不创建配置，修改在配置文件锁内重新检查当前项。 */
export class ConfigStore {
  readonly #appDirectory: string;
  readonly #resolveSpace: (spaceId: string) => string;
  readonly #queue = new SerialQueue();
  readonly #definitions = new Map<string, SettingsDefinition[]>();

  constructor(options: {
    appDirectory: string;
    resolveSpace: (spaceId: string) => string;
    definitions?: SettingsNamespaceDefinition[];
  }) {
    this.#appDirectory = path.resolve(options.appDirectory);
    this.#resolveSpace = options.resolveSpace;
    const supplied = options.definitions ?? [];
    for (const definition of [...(supplied.some(item => item.namespace === "prompts") ? [] : [PROMPT_SETTINGS_DEFINITION]), ...supplied]) {
      if (this.#definitions.has(definition.namespace)) throw new RepaFault("configuration", `设置命名空间重复登记：${definition.namespace}。`);
      this.register(definition);
    }
  }

  register(definition: SettingsNamespaceDefinition): void {
    if (!definition.namespace) throw new RepaFault("configuration", "设置命名空间不能为空。");
    const entries = Object.entries(definition.settings).map(([key, item]) => ({
      key, ...item, schema: Object.fromEntries(Object.entries(item.schema)),
    }));
    for (const entry of entries) {
      if (!Check(SettingsDefinitionSchema, entry) || !Check(entry.schema, entry.default))
        throw new RepaFault("configuration", `设置 ${definition.namespace}.${entry.key} 的定义或默认值无效。`);
    }
    const existing = this.#definitions.get(definition.namespace);
    if (existing && !isDeepStrictEqual(existing, entries))
      throw new RepaFault("configuration", `设置命名空间存在不同定义：${definition.namespace}。`);
    this.#definitions.set(definition.namespace, structuredClone(entries));
  }

  async get(scope: SettingScope, namespace: string): Promise<SettingsView> {
    const views = await this.getMany(scope, [namespace]);
    return views[0]!;
  }

  /** 一次受理从同一组文件快照取得各命名空间，来源与有效值一起返回。 */
  async getMany(scope: SettingScope, namespaces: readonly string[]): Promise<SettingsView[]> {
    for (const namespace of namespaces) {
      checkInput(SettingsGetParamsSchema, { scope, namespace });
      this.#namespace(namespace);
    }
    scope = structuredClone(scope);
    const files = await this.#read(this.#locations(scope));
    return namespaces.map(namespace => this.#view(scope, namespace, files));
  }

  async set(params: SettingsSetParams): Promise<SettingsView> {
    checkInput(SettingsSetParamsSchema, params);
    const definition = this.#setting(params.namespace, params.key, params.scope);
    if (!Check(definition.schema, params.value))
      throw new RepaFault("configuration", `设置 ${params.namespace}.${params.key} 的值类型或允许范围无效。`, {
        namespace: params.namespace, key: params.key,
      });
    return this.#change(structuredClone(params), { value: structuredClone(params.value) });
  }

  async reset(params: SettingsResetParams): Promise<SettingsView> {
    checkInput(SettingsResetParamsSchema, params);
    this.#setting(params.namespace, params.key, params.scope);
    return this.#change(structuredClone(params), {});
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
    this.#validateStored(application, "application");
    if (space) {
      this.#validateStored(space, "space");
      for (const scope of Object.values(space.sessions ?? {})) this.#validateStored(scope, "session");
    }
    return { application, ...(space ? { space } : {}) };
  }

  #namespace(namespace: string): SettingsDefinition[] {
    const definition = this.#definitions.get(namespace);
    if (!definition)
      throw new RepaFault("unsupported_settings_namespace", `尚未定义设置命名空间：${namespace}。`);
    return definition;
  }

  #setting(namespace: string, key: string, scope: SettingScope): SettingsDefinition {
    const definition = this.#namespace(namespace).find((item) => item.key === key);
    if (!definition) throw new RepaFault("configuration", `未知设置项：${namespace}.${key}。`);
    if (!definition.scopes.includes(scope.kind))
      throw new RepaFault("configuration", `设置 ${namespace}.${key} 不允许在 ${scope.kind} 作用域修改。`);
    return definition;
  }

  #validateStored(scope: StoredScope, kind: SettingScope["kind"]): void {
    for (const [namespace, values] of Object.entries(scope.namespaces ?? {})) {
      const definitions = this.#definitions.get(namespace);
      if (!definitions) continue;
      for (const [key, entry] of Object.entries(values)) {
        const definition = definitions.find((item) => item.key === key);
        if (!definition || !definition.scopes.includes(kind) || (hasValue(entry) && !Check(definition.schema, entry.value)))
          throw new RepaFault("configuration", `持久设置 ${namespace}.${key} 的作用域或值无效。`, { namespace, key, scope: kind });
      }
    }
  }

  #view(scope: SettingScope, namespace: string, files: Files): SettingsView {
    const layers: { scope: SettingScope; file: SettingsFile }[] = [
      { scope: { kind: "application" }, file: files.application },
    ];
    if (scope.kind !== "application")
      layers.push({ scope: { kind: "space", spaceId: scope.spaceId }, file: files.space! });
    if (scope.kind === "session") layers.push({ scope, file: files.space! });
    const definitions = this.#namespace(namespace);
    const entries = definitions.map((definition): SettingsEntry => {
      const { key } = definition;
      let effective: unknown = definition.default;
      let source: SettingsEntry["source"] = "default";
      for (const layer of layers) {
        const items = overrides(layer.file, layer.scope, namespace);
        const entry = Object.hasOwn(items, key) ? items[key] : undefined;
        if (hasValue(entry)) {
          effective = entry.value;
          source = layer.scope;
        }
      }
      const current = currentEntry(files, scope, namespace, key);
      return {
        key,
        ...(hasValue(current) ? { override: current.value } : {}),
        effective,
        source,
        revision: revision(current),
      };
    });
    return structuredClone({ namespace, scope, entries, definitions });
  }

  #change(
    params: SettingsResetParams,
    next: { value?: unknown },
  ): Promise<SettingsView> {
    const { scope, namespace, key } = params;
    const locations = this.#locations(scope);
    const same = (files: Files): boolean => {
      const current = currentEntry(files, scope, namespace, key);
      return Object.hasOwn(next, "value")
        ? hasValue(current) && isDeepStrictEqual(current.value, next.value)
        : !hasValue(current);
    };
    return this.#queue.run(async () => {
      const observed = await this.#read(locations);
      if (same(observed)) return this.#view(scope, namespace, observed);
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
          if (same(current)) return this.#view(scope, namespace, current);
          const actual = revision(currentEntry(current, scope, namespace, key));
          if (params.base !== actual)
            throw new RepaFault("settings_conflict", "该项设置已改变，请读取当前值后重新修改。", {
              scope, namespace: params.namespace, key, base: params.base, revision: actual,
            });
          const saved = scope.kind === "application" ? current.application : current.space!;
          const targetScope = storedScopeFor(saved, scope);
          const namespaces = {
            ...targetScope.namespaces,
            [namespace]: { ...overrides(saved, scope, namespace), [key]: { revision: randomUUID(), ...next } },
          };
          if (scope.kind === "session")
            saved.sessions = { ...saved.sessions, [scope.sessionId]: { namespaces } };
          else saved.namespaces = namespaces;
          if (compromised) throw compromised;
          await writeJson(file, saved);
          if (compromised) throw compromised;
          return this.#view(scope, namespace, current);
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
