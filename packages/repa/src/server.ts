// 本机后端：Node 自带的 http，只监听 127.0.0.1。请求和回应是 JSON，对话的事件用 SSE 推给界面；其余路径是界面的静态文件。
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";

import { diffLines } from "diff";

import { backlinks, brokenLinks, cardCount, changeOf, createFolder, mocMembers, readOptional, RepaFault, resolveIn, resolvePage, revert, saveCard, setCardMeta, type Page } from "./kb.js";
import { calendarDays, childFolders, listModes, loadState, readModeText, readSettings, updateSettings, writeMode, type State } from "./map.js";
import { dateOf, dayOf } from "./review.js";
import { wikiTargets } from "./links.js";
import type { PendingReply } from "./protocol.js";
import type { Sessions } from "./pi/sessions.js";

/** 启动后端所需的东西。webRoot 是界面构建后的目录，不给就只提供接口。 */
export interface ServerOptions {
  root: string;
  port: number;
  sessions: Sessions;
  webRoot?: string;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".woff2": "font/woff2", ".woff": "font/woff", ".pdf": "application/pdf",
};
const STATUS: Record<RepaFault["code"], number> = { not_found: 404, conflict: 409, bad_request: 400 };

type Handler = (request: IncomingMessage, url: URL, body: Record<string, unknown>, params: string[]) => Promise<unknown>;

/** 启动后端，返回 http 服务器；关掉它就停止。 */
export async function startServer(options: ServerOptions): Promise<Server> {
  const { root } = options;
  const { sessions } = options;
  const query = (url: URL, name: string) => url.searchParams.get(name) ?? "";

  // 每张卡片的列表项都带上画记号要用的复习状态：记忆估计、是否到期、逾期几天、下次到期和上次练习的日子。
  const summary = (state: State, page: Page) => {
    const review = state.review.get(page.path);
    const last = review?.practicedDays.at(-1);
    return {
      path: page.path, title: page.title, folder: page.folder, summary: page.summary, moc: page.moc, keep: state.kept.has(page.path),
      ...(page.error ? { error: page.error } : {}), ...(page.review ? { review: page.review } : {}),
      ...(review?.memory === undefined ? {} : { memory: review.memory }),
      due: Boolean(review && !review.practicedToday && (review.due || review.manualDue)),
      overdueDays: review?.overdueDays ?? 0,
      ...(review?.nextDue === undefined ? {} : { nextDue: dateOf(review.nextDue) }),
      ...(last === undefined ? {} : { lastPracticed: dateOf(last) }),
      ...(page.created === undefined ? {} : { created: page.created }),
    };
  };
  const folderInfo = (state: State, folder: string) => ({ path: folder, name: folder.slice(folder.lastIndexOf("/") + 1), count: cardCount(state.kb, folder) });
  const pageAt = (state: State, rel: string) => {
    const page = state.kb.byPath.get(rel);
    if (!page) throw new RepaFault("not_found", `${rel} 不在知识库里。`);
    return page;
  };

  const routes: Array<[string, RegExp, Handler]> = [
    ["GET", /^\/api\/health$/u, async () => ({ name: path.basename(root) })],
    ["GET", /^\/api\/tree$/u, async () => {
      const state = await loadState(root);
      return {
        folders: state.kb.folders.map((folder) => folderInfo(state, folder)),
        pages: state.kb.pages.map((page) => ({ path: page.path, title: page.title, folder: page.folder, moc: page.moc, ...(page.error ? { error: page.error } : {}) })),
        materials: state.kb.materials,
      };
    }],
    ["GET", /^\/api\/cards$/u, async () => {
      const state = await loadState(root);
      const linked = (page: Page, targets: string[]) => targets.map((target) => ({ target, path: resolvePage(state.kb, page.folder, target)?.path ?? null }));
      return {
        cards: state.kb.pages.map((page) => {
          return { ...summary(state, page), requires: linked(page, page.requires), links: linked(page, [...new Set(wikiTargets(page.body))]) };
        }),
      };
    }],
    ["GET", /^\/api\/folder$/u, async (_request, url) => {
      const state = await loadState(root);
      const folder = query(url, "path");
      if (!state.kb.folders.includes(folder)) throw new RepaFault("not_found", `知识库里没有 ${folder} 这个文件夹。`);
      // AGENTS.md 带上修改时间，文件夹页编辑它时经 PUT /api/card 保存，被别处改过就拒绝。
      const agentsFile = path.join(resolveIn(root, folder), "AGENTS.md");
      const agentsText = await readOptional(agentsFile);
      const agents = agentsText === undefined ? null : { text: agentsText, mtime: (await stat(agentsFile)).mtimeMs };
      const own = state.kb.pages.filter((page) => page.folder === folder);
      return {
        path: folder,
        agents,
        mocs: own.filter((page) => page.moc).map((page) => summary(state, page)),
        cards: own.filter((page) => !page.moc).map((page) => summary(state, page)),
        folders: childFolders(state.kb, folder).map((child) => folderInfo(state, child)),
        materials: state.kb.materials.filter((item) => path.posix.dirname(item.path) === (folder || ".")),
      };
    }],
    ["GET", /^\/api\/card$/u, async (_request, url) => {
      const state = await loadState(root);
      const page = pageAt(state, query(url, "path"));
      const practices = state.practices.filter((practice) => page.id !== undefined && practice.card === page.id).reverse();
      return {
        ...summary(state, page),
        text: page.text, body: page.body, mtime: page.mtime, folder: page.folder,
        requires: page.requires.map((target) => ({ target, path: resolvePage(state.kb, page.folder, target)?.path ?? null })),
        members: page.moc ? mocMembers(state.kb, page).members.map((member) => ({ path: member.path, title: member.title })) : [],
        broken: [...brokenLinks(state.kb, page), ...(page.moc ? mocMembers(state.kb, page).broken : [])],
        backlinks: backlinks(state.kb, page).map((other) => ({ path: other.path, title: other.title })),
        practices: practices.map((practice) => ({
          id: practice.id, t: practice.t, questions: practice.quiz?.questions ?? [], answers: practice.quiz?.answers ?? null,
          ...(practice.grade ? { result: practice.grade.result, note: practice.grade.note, ...(practice.grade.external ? { external: practice.grade.external } : {}) } : {}),
        })),
      };
    }],
    ["PUT", /^\/api\/card$/u, async (_request, _url, body) => ({
      mtime: await saveCard(root, String(body.path), String(body.text), typeof body.mtime === "number" ? body.mtime : undefined),
    })],
    ["POST", /^\/api\/card\/meta$/u, async (_request, _url, body) => ({
      mtime: await setCardMeta(root, String(body.path), {
        ...(body.keep === null || typeof body.keep === "boolean" ? { keep: body.keep } : {}),
        ...(body.review === null || typeof body.review === "string" ? { review: body.review } : {}),
      }),
    })],
    ["POST", /^\/api\/folder$/u, async (_request, _url, body) => {
      await createFolder(root, String(body.path));
      return {};
    }],
    // extra 是“再来几张”累计要的张数，加在每天的张数上；做完当天的张数时 done 为真。
    ["GET", /^\/api\/today$/u, async (_request, url) => {
      const { dailyLimit } = await readSettings(root);
      const limit = dailyLimit === null ? null : dailyLimit + Number(query(url, "extra") || 0);
      const state = await loadState(root, new Date(), limit);
      const item = (rel: string) => ({ ...summary(state, pageAt(state, rel)), manual: state.review.get(rel)?.manualDue ?? false });
      const { suggestions } = state;
      return {
        practiced: suggestions.practiced, limit, done: limit !== null && suggestions.practiced >= limit,
        due: suggestions.due.map(item), dueTotal: suggestions.dueTotal,
        fresh: suggestions.fresh.map(item), freshTotal: suggestions.freshTotal,
        recent: await sessions.recentFolders(),
      };
    }],
    // month=YYYY-MM 给出每天到期几张、练了几张；date=YYYY-MM-DD 给出那一天的卡片。
    ["GET", /^\/api\/calendar$/u, async (_request, url) => {
      const state = await loadState(root);
      const date = query(url, "date");
      if (date) {
        const day = calendarDays(state, dayOf(date), dayOf(date)).get(dayOf(date));
        return { date, due: (day?.due ?? []).map((rel) => summary(state, pageAt(state, rel))), practiced: (day?.practiced ?? []).map((rel) => summary(state, pageAt(state, rel))) };
      }
      const month = query(url, "month") || dateOf(state.today).slice(0, 7);
      const first = dayOf(`${month}-01`);
      // 第一天往后 31 天一定落在下个月，取下个月的 1 号再退一天，就是这个月的最后一天。
      const last = dayOf(`${dateOf(first + 31).slice(0, 8)}01`) - 1;
      const days = calendarDays(state, first, last);
      return { month, today: dateOf(state.today), days: [...days].map(([day, item]) => ({ date: dateOf(day), due: item.due.length, practiced: item.practiced.length })) };
    }],
    // 不给 folder 是全部文件夹；reviews=1 包含复习对话；sort 是 recent、oldest 或 folder。
    ["GET", /^\/api\/sessions$/u, async (_request, url) => ({
      sessions: await sessions.list({
        ...(url.searchParams.has("folder") ? { folder: query(url, "folder") } : {}),
        q: query(url, "q"),
        reviews: query(url, "reviews") === "1",
        sort: (["recent", "oldest", "folder"] as const).find((item) => item === query(url, "sort")) ?? "recent",
      }),
    })],
    ["POST", /^\/api\/sessions$/u, async (_request, _url, body) => {
      if (typeof body.review === "string") return sessions.review(pageAt(await loadState(root), body.review));
      return sessions.open({
        folder: String(body.folder ?? ""),
        ...(typeof body.id === "string" ? { id: body.id } : {}),
        ...(body.fresh === true ? { fresh: true } : {}),
      });
    }],
    ["POST", /^\/api\/sessions\/([^/]+)\/prompt$/u, async (_request, _url, body, [id = ""]) => {
      const text = (name: string) => (typeof body[name] === "string" && body[name] ? String(body[name]) : undefined);
      await sessions.prompt(id, String(body.text), text("viewing"), text("quote"));
      return {};
    }],
    ["POST", /^\/api\/sessions\/([^/]+)\/abort$/u, async (_request, _url, _body, [id = ""]) => sessions.abort(id).then(() => ({}))],
    ["POST", /^\/api\/sessions\/([^/]+)\/compact$/u, async (_request, _url, _body, [id = ""]) => sessions.compact(id)],
    ["POST", /^\/api\/sessions\/([^/]+)\/model$/u, async (_request, _url, body, [id = ""]) => sessions.setModel(id, String(body.provider), String(body.id)).then(() => ({}))],
    ["POST", /^\/api\/sessions\/([^/]+)\/thinking$/u, async (_request, _url, body, [id = ""]) => sessions.setThinking(id, String(body.level)).then(() => ({}))],
    ["POST", /^\/api\/sessions\/([^/]+)\/mode$/u, async (_request, _url, body, [id = ""]) => {
      sessions.setMode(id, String(body.mode));
      return {};
    }],
    ["GET", /^\/api\/sessions\/([^/]+)\/context$/u, async (_request, _url, _body, [id = ""]) => sessions.context(id)],
    ["POST", /^\/api\/pending\/([^/]+)$/u, async (_request, _url, body, [id = ""]) => {
      sessions.answer(decodeURIComponent(id), body as PendingReply);
      return {};
    }],
    ["GET", /^\/api\/change$/u, async (_request, url) => {
      const change = await changeOf(root, query(url, "path"), query(url, "tool"));
      return { version: change.version, created: change.before === undefined, deleted: change.after === undefined, diff: diffLines(change.before ?? "", change.after ?? "") };
    }],
    ["POST", /^\/api\/revert$/u, async (_request, _url, body) => ({ saved: await revert(root, String(body.path), String(body.version)) })],
    ["GET", /^\/api\/models$/u, async () => ({ models: await sessions.models() })],
    ["GET", /^\/api\/modes$/u, async () => ({ modes: await listModes(root) })],
    ["GET", /^\/api\/modes\/([^/]+)$/u, async (_request, _url, _body, [name = ""]) => ({ name: decodeURIComponent(name), text: await readModeText(root, decodeURIComponent(name)) })],
    ["PUT", /^\/api\/modes\/([^/]+)$/u, async (_request, _url, body, [name = ""]) => {
      await writeMode(root, decodeURIComponent(name), String(body.text));
      return {};
    }],
    // 设置里带上知识库的位置，只读，供设置页显示；这是接口里唯一出现本机路径的地方。
    ["GET", /^\/api\/settings$/u, async () => ({ ...(await readSettings(root)), root })],
    ["PUT", /^\/api\/settings$/u, async (_request, _url, body) => ({ root, ...await updateSettings(root, {
      ...(typeof body.confirmEdits === "boolean" ? { confirmEdits: body.confirmEdits } : {}),
      ...(typeof body.confirmCommands === "boolean" ? { confirmCommands: body.confirmCommands } : {}),
      ...(body.dailyLimit === null || (typeof body.dailyLimit === "number" && body.dailyLimit >= 0) ? { dailyLimit: body.dailyLimit } : {}),
      ...(body.appearance === "system" || body.appearance === "light" || body.appearance === "dark" ? { appearance: body.appearance } : {}),
      ...(body.keys !== null && typeof body.keys === "object" && !Array.isArray(body.keys) ? { keys: body.keys as Record<string, unknown> } : {}),
      // 设置页直接改新对话默认的模型与 thinking 级别；在对话里换的也写进这两项
      ...(typeof body.model === "string" ? { model: body.model } : {}),
      ...(typeof body.thinking === "string" ? { thinking: body.thinking } : {}),
    }) })],
  ];

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => fail(response, error));
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = request.headers.host ?? "";
    // Agent 能运行命令，所以只接受来自自己页面的请求：Host 是本机地址加端口挡住 DNS 重绑定，Origin 挡住别的网页，
    // 写入类请求必须是 JSON，表单和简单请求因此发不过来。
    const port = String((server.address() as { port: number }).port);
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(response, 403, { error: "只接受本机的请求。" });
    if (request.headers.origin !== undefined && request.headers.origin !== `http://${host}`) return send(response, 403, { error: "只接受 Repa 自己页面的请求。" });
    const url = new URL(request.url ?? "/", `http://${host}`);
    const method = request.method ?? "GET";
    if (method !== "GET" && !String(request.headers["content-type"]).startsWith("application/json")) return send(response, 415, { error: "请求要用 JSON。" });

    const events = /^\/api\/sessions\/([^/]+)\/events$/u.exec(url.pathname);
    if (events && method === "GET") return stream(request, response, (listener) => sessions.subscribe(decodeURIComponent(events[1] ?? ""), listener));
    if (url.pathname === "/api/events" && method === "GET") return stream(request, response, (listener) => sessions.watch(listener));
    if (url.pathname === "/api/file" && method === "GET") return sendFile(response, resolveIn(root, query(url, "path")), true);
    for (const [routeMethod, pattern, handler] of routes) {
      const match = pattern.exec(url.pathname);
      if (!match || routeMethod !== method) continue;
      const body = method === "GET" ? {} : await readJson(request);
      return send(response, 200, (await handler(request, url, body, match.slice(1))) ?? {});
    }
    if (url.pathname.startsWith("/api/")) return send(response, 404, { error: "没有这个接口。" });
    if (!options.webRoot) return send(response, 404, { error: "界面没有构建。" });
    const file = path.resolve(options.webRoot, `.${decodeURIComponent(url.pathname)}`);
    const isFile = file.startsWith(options.webRoot) && (await stat(file).catch(() => undefined))?.isFile();
    return sendFile(response, isFile ? file : path.join(options.webRoot, "index.html"), false);
  }

  // subscribe 会同步发出当前的状态，所以先缓存，写过响应头再发；对话没有打开时它抛出的错误照常回成 404。
  function stream(request: IncomingMessage, response: ServerResponse, subscribe: (listener: (event: unknown) => void) => () => void): void {
    const write = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`);
    const events: unknown[] = [];
    const unsubscribe = subscribe((event) => (response.headersSent ? write(event) : events.push(event)));
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    // 还没有事件可发时也先把响应头送出去，浏览器的 EventSource 据此才算连上
    response.flushHeaders();
    for (const event of events) write(event);
    request.on("close", unsubscribe);
  }

  await new Promise<void>((resolve) => server.listen(options.port, "127.0.0.1", resolve));
  return server;
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

function fail(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  if (error instanceof RepaFault) return send(response, STATUS[error.code], { error: error.message, code: error.code, details: error.details });
  console.error(error);
  send(response, 500, { error: error instanceof Error ? error.message : String(error) });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  const value: unknown = text ? JSON.parse(text) : {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new RepaFault("bad_request", "请求体要是一个 JSON 对象。");
  return value as Record<string, unknown>;
}

async function sendFile(response: ServerResponse, file: string, missingIs404: boolean): Promise<void> {
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) return missingIs404 ? send(response, 404, { error: "没有这个文件。" }) : send(response, 404, { error: "界面没有构建。" });
  response.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", "Content-Length": info.size });
  createReadStream(file).pipe(response);
}
