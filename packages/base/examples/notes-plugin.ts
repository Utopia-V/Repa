import { readFile } from "node:fs/promises";
import path from "node:path";

import { Type, type TSchema } from "typebox";

import type { Host, Plugin, PluginInstance } from "../src/plugin.js";
import { directory, failure, parse, scopedFile, writeJson } from "./files.js";

const object = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

const NoteSchema = object({ name: Type.String({ pattern: "^[a-zA-Z0-9-]+$" }), text: Type.String() });
const EmptySchema = object({});
const DraftSchema = object({ text: Type.String() });
const RewriteSchema = object({ text: Type.String(), style: Type.String() });
const SummarySchema = object({ title: Type.String(), summary: Type.String() });

// 子插件只认识 notes/ 内的文件；父插件承担命名空间转换与生命周期。
const notebook: Plugin = {
  id: "notebook",
  async open(host): Promise<PluginInstance> {
    let cursor: string | undefined;
    let closed = false;
    return {
      instructions: () => "使用 save_note 保存用户明确要求保留的文字，保留原文。",
      tools: () => [{
        name: "save_note",
        description: "把一段文字保存为命名笔记。",
        parameters: NoteSchema,
        async execute(input, context) {
          context.signal.throwIfAborted();
          const note = parse(NoteSchema, input);
          await host.files.write(`${note.name}.md`, note.text);
          return { text: `已保存 ${note.name}.md` };
        },
      }],
      async view() {
        return "笔记保存在 notes/ 中。详细内容通过工具读取；本插件只保存用户明确要求保留的文字。";
      },
      async onChange(revision) {
        const feed = await host.history.changes(cursor);
        const files = feed.revisions.flatMap((item) => item.changes.map((change) => change.path));
        cursor = feed.revision;
        if (files.length > 0) host.emit({ type: "notesChanged", revision, files });
      },
      methods: {
        save: {
          parameters: NoteSchema,
          async invoke(input) {
            const note = parse(NoteSchema, input);
            if (closed) throw failure("plugin_closed", "笔记插件已经关闭");
            await host.history.record({ kind: "plugin", pluginId: "notebook" }, async () => {
              await host.files.write(`${note.name}.md`, note.text);
            });
            return { name: note.name };
          },
        },
      },
      async close() { closed = true; },
    };
  },
};

async function childHost(host: Host): Promise<Host> {
  const childRoot = path.join(host.space.root, "notes");
  const scopedPath = async (file: string): Promise<string> =>
    path.join("notes", await scopedFile(childRoot, file));
  return {
    ...host,
    space: { root: childRoot, dataDir: path.join(host.space.dataDir, "notebook") },
    files: {
      read: async (file) => host.files.read(await scopedPath(file)),
      write: async (file, text) => host.files.write(await scopedPath(file), text),
      async list(directory = ".") {
        return (await host.files.list(await scopedPath(directory))).map((file) => path.relative("notes", file));
      },
    },
    history: {
      ...host.history,
      record(source, action) {
        if (source.kind !== "plugin" || source.pluginId !== "notebook") throw failure("invalid_history_source", "子插件只能记录自己的修改");
        return host.history.record({ kind: "plugin", pluginId: "notes" }, action);
      },
      async changes(since) {
        const feed = await host.history.changes(since);
        return {
          ...feed,
          revisions: feed.revisions.map((revision) => ({
            ...revision,
            changes: revision.changes.filter((change) => change.path.startsWith("notes/")
              || (change.kind === "renamed" && change.previousPath.startsWith("notes/"))),
          })),
        };
      },
    },
    emit: (event) => { host.emit({ child: "notebook", event }); },
  };
}

export const notesPlugin: Plugin = {
  id: "notes",
  async open(host) {
    await directory(path.join(host.space.root, "notes"));
    const child = await childHost(host);
    await directory(child.space.dataDir);
    const instance = await notebook.open(child);
    const stateFile = path.join(host.space.dataDir, "preferences.json");
    let style = "清楚、简洁";
    try {
      const value: unknown = JSON.parse(await readFile(stateFile, "utf8"));
      style = parse(object({ style: Type.String() }), value).style;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    const work = new Map<string, { result: Promise<void>; cancel(): Promise<void> }>();
    return {
      instructions: () => `笔记插件用于保存文字和整理笔记。${instance.instructions?.() ?? ""}`,
      tools: () => instance.tools?.() ?? [],
      view: () => instance.view?.() ?? Promise.resolve(undefined),
      onChange: (revision) => instance.onChange?.(revision) ?? Promise.resolve(),
      methods: {
        ...instance.methods,
        setStyle: {
          parameters: object({ style: Type.String() }),
          async invoke(input) {
            style = parse(object({ style: Type.String() }), input).style;
            await writeJson(stateFile, { style });
            host.emit({ type: "styleChanged", style });
            return { style };
          },
        },
        rewrite: {
          parameters: RewriteSchema,
          async invoke(input) {
            const request = parse(RewriteSchema, input);
            return host.models.complete({ prompt: `用${request.style || style}风格改写下面的文字：\n${request.text}` });
          },
        },
        summarize: {
          parameters: DraftSchema,
          async invoke(input) {
            const request = parse(DraftSchema, input);
            return host.models.completeStructured({ prompt: `概括下面的文字，输出 title 和 summary：\n${request.text}` }, SummarySchema);
          },
        },
        organize: {
          parameters: EmptySchema,
          async invoke() {
            const task = await host.models.runAgent({ text: "阅读 notes/ 中的笔记，给出整理建议；只在用户明确同意后修改文件。" });
            const result = task.result.then(() => {
              host.emit({ type: "organizeFinished", id: task.id });
            }, (error: unknown) => {
              host.emit({ type: "organizeFailed", id: task.id, message: String(error) });
            }).finally(() => { work.delete(task.id); });
            work.set(task.id, { result, cancel: () => task.cancel() });
            return { id: task.id };
          },
        },
      },
      async close() {
        await Promise.all([...work.values()].map(async (task) => {
          await task.cancel();
          await task.result;
        }));
        await instance.close?.();
      },
    };
  },
};

export default notesPlugin;
