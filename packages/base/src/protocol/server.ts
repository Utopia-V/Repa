import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { Check } from "typebox/value";
import { WebSocket, WebSocketServer } from "ws";
import { createAgentRuntime, withFileMutationQueue, type AgentRuntime, type AgentSpace, type UnsavedSession } from "../agent.js";
import type { AskRoute } from "../ask.js";
import { restoreInPlace, restoreToNew } from "../backup/restore.js";
import { SpaceBackups } from "../backup/schedule.js";
import { deleteBackup, groupStatus, listBackups } from "../backup/store.js";
import { resolveAppHome } from "../home.js";
import { createFeedbackBundle } from "../feedback/bundle.js";
import { RecentErrors } from "../feedback/errors.js";
import {
  canRender,
  checkResponse,
  AskSubmitResultSchema,
  type AskSubmitResult,
  type ItemResponse,
} from "../interaction.js";
import type { AskOutcome, Plugin, Services } from "../plugin.js";
import { openPluginHost, type PluginHost } from "../plugins.js";
import { listPlugins } from "../plugins/plugin-list.js";
import { pluginsDirectory } from "../plugins/snapshots.js";
import { spacePlugins, type SpacePlugin, type UnavailablePlugin } from "../plugins/space-plugins.js";
import {
  methods,
  notifications,
  PROTOCOL_VERSION,
  type ClientCapabilities,
  type Method,
  type Notification,
  type NotificationParams,
  type Params,
  type PluginInfo,
} from "../protocol.js";
import { errorText, RepaFault, type Confirmation, type Confirm } from "../schema.js";
import { SettingsStore } from "../settings.js";
import { createSpace, openSpace, type Space } from "../space.js";
import { browseDirectory, listRoots } from "../space/browse.js";
import { createPluginRequests, listText, type Execution } from "./plugin-requests.js";
import { ReverseRequests } from "./reverse.js";
import { errorResponse, parseRequest, RpcFault, type RpcId } from "./json-rpc.js";

// 重组在模块加载时的空上下文里进行：它由最后结束的那项工作触发，但不属于那次运行，也不属于发起它的连接；
// 否则新插件 open 里的写入会记在那次运行名下，撤销运行时一并删掉。
const detached = AsyncLocalStorage.snapshot();

/** 协议后端的装配选项，用于指定应用配置、插件和 Agent 运行时。 */
export interface ServerOptions {
  home?: string;
  port?: number;
  token?: string;
  plugins?: Plugin[];
  runtime?: AgentRuntime;
  /** 是否提供通用 Agent；学习者版本关掉它。默认提供。 */
  generalAgent?: boolean;
  /** 用户能直接对话的 Agent；省略时按各定义的 direct，通用 Agent 默认可以。 */
  directAgents?: string[];
  /** 空间历史用的 Git 程序的绝对路径，打开空间和恢复到新文件夹时使用；省略时用 PATH 里的 git。 */
  gitPath?: string;
}

/** 运行中的协议后端；嵌入宿主用它交付连接并等待保存、收尾完成。 */
export interface RepaServer {
  connection: { url: string; token: string };
  closed: Promise<void>;
  close(): Promise<void>;
  /**
   * 重组当前空间：等到空闲，关闭插件宿主与 Agent 运行时，再打开它们；空间、锁、历史与备份不动。
   * 运行的自写插件按这一刻盘上的启用记录重新得出；plugins 替换随包插件，省略时用当前的随包插件。
   * 装卸请求（plugin.load、plugin.unload 与通用 Agent 的 plugin 工具）经同一条路径；这个入口供测试与宿主内部调用。
   */
  reassemble(plugins?: Plugin[]): Promise<Reassembly>;
}

/** 一次重组的结局。cancelled：等待期间空间已经关闭或换成别的空间，没有重组。 */
export type Reassembly =
  | { status: "applied"; assembly: number; plugins: PluginInfo[]; closeFailures: { pluginId: string; message: string }[] }
  | { status: "cancelled" };

interface Peer {
  socket: WebSocket;
  authenticated: boolean;
  subscribed: boolean;
  alive: boolean;
  /** initialize 里的声明；没有声明时为空对象。 */
  capabilities: ClientCapabilities;
  /** 初始化的先后，同一服务有多个提供方时交给最近初始化的连接。 */
  serial: number;
  logins: Set<AbortController>;
  /** 正在生成的反馈包；断线或关闭后端时取消，自述的模型调用不会一直挂着。 */
  feedbacks: Set<AbortController>;
}

type PendingData =
  | { kind: "confirm"; request: Confirmation }
  | {
    kind: "ask";
    request: NotificationParams<"ask.request">;
    onSubmit?: (response: ItemResponse) => Promise<AskSubmitResult>;
    /** 上一次提交处理完之前，不接受下一次提交。 */
    busy: boolean;
  }
  | { kind: "service"; service: string };

/** 一项请求的响应；baseline 为 true 的是初始化响应，要在闸门抬起时生成。 */
interface Reply {
  baseline: boolean;
  build(): unknown;
}

interface ActiveSpace {
  space: Space;
  plugins: PluginHost;
  agent: AgentSpace;
  backups: SpaceBackups;
  /** 这一次打开空间时的装配序号；plugin.call 带的序号比它小，说明调用属于此前打开的空间。 */
  opened: number;
  /** 当前装配的序号。 */
  assembly: number;
  /** 当前装配时启用了却没有交给插件宿主的自写插件：待批准或失败。每次重组按启用记录重新得出。 */
  unavailable: UnavailablePlugin[];
  /** 当前装配交给宿主的自写插件与各自的版本。 */
  selfWritten: SpacePlugin[];
  /** 当前的随包插件；重组时可以替换。 */
  bundled: Plugin[];
  /**
   * 插件列表（不含请求状态）。在装配结束时、plugin.list 与 plugin 工具的 list 读取时重新核对，基线与通知同步取用这一份：
   * 初始化的基线在同一段同步代码里生成，不能等文件读取。
   */
  list: PluginInfo[];
}

/** runEnd 事件里的运行结局。 */
function runStatus(data: unknown): "completed" | "failed" | "aborted" {
  const status = data !== null && typeof data === "object" && "status" in data ? data.status : undefined;
  return status === "completed" || status === "aborted" ? status : "failed";
}

// 经过重组闸门的方法：它们用到 Agent 空间或插件宿主，重组期间要等新的装配。
// space.*、确认与询问的回复、服务回复、登录、设置、备份与历史不等：批准、登录和备份不应等重组，空间对象也不随重组关闭。
const GATED = new Set<Method>([
  "agent.list",
  "session.list", "session.create", "session.history", "session.send", "session.steer", "session.followUp",
  "session.abort", "session.setModel", "session.compact", "session.fork",
  "plugin.list", "plugin.call", "plugin.load", "plugin.unload", "plugin.cancel",
  "prompt.list", "prompt.preview",
  "feedback.create",
]);
// 在闸门前等待时，同一会话的 session.abort 到达即作废这些请求：停止要拿到它之前发出的消息。
const VOIDABLE = new Set<Method>(["session.send", "session.steer", "session.followUp", "session.compact"]);
// 使用者在会话里的介入：到达时登记，此前提出的插件装卸不再在结果交回时自动续跑。
const INTERVENING = new Set<Method>(["session.send", "session.steer", "session.followUp", "session.abort", "session.compact", "session.fork"]);

/** 启动本机 HTTP 与 WebSocket 后端，返回连接凭据及可等待的关闭入口。 */
export async function startServer(options: ServerOptions = {}): Promise<RepaServer> {
  const token = options.token ?? randomBytes(32).toString("hex");
  if (token.length < 32) throw new RepaFault("invalid_token", "连接令牌至少需要 32 个字符");
  // 启动时就拒绝，不等到打开空间才失败；为什么必须是绝对路径见 space-history 的 createGit。
  const gitPath = options.gitPath;
  if (gitPath !== undefined) {
    if (!path.isAbsolute(gitPath)) throw new RepaFault("invalid_git_path", "Git 程序的路径必须是绝对路径");
    // Windows 上 X_OK 只检查存在；文件缺失或不能执行时，否则要等打开空间才报出意义不明的 ENOENT、EACCES。
    await access(gitPath, constants.X_OK).catch(() => {
      throw new RepaFault("invalid_git_path", `找不到 Git 程序或不能执行：${gitPath}`);
    });
  }
  const git = gitPath === undefined ? {} : { gitPath };
  const home = resolveAppHome({ home: options.home });
  const settings = await SettingsStore.open(home);
  const runtime: AgentRuntime = options.runtime ?? await createAgentRuntime({ agentDir: path.join(home, "agent") });
  const serverId = randomUUID();
  const peers = new Set<Peer>();
  const reverse = new ReverseRequests<Peer, PendingData>();
  let initialized = 0;
  const owner = new AsyncLocalStorage<Peer>();
  const operations = new Set<Promise<unknown>>();
  let active: ActiveSpace | undefined;
  let stopping = false;
  let closePromise: Promise<void> | undefined;
  let lifecycle = Promise.resolve();
  let finishClosed: () => void;
  const closed = new Promise<void>((resolve) => {
    finishClosed = resolve;
  });
  const http = createServer((_request, response) => response.writeHead(404).end());
  const websocket = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024 * 1024,
    perMessageDeflate: false,
  });

  // 发给前端的错误事件同时记一份，反馈包从这里取；后端没有日志文件。
  const recordError = (method: Notification, params: unknown) => {
    if (method === "session.event" && Check(notifications["session.event"], params) && params.type === "error") {
      const data = params.data;
      const code = data !== null && typeof data === "object" && "code" in data && typeof data.code === "string" ? data.code : undefined;
      errors.add({ source: `session:${params.sessionId}`, message: params.text ?? "", ...(code === undefined ? {} : { code }) });
    }
  };
  const send = (peer: Peer, value: unknown) => {
    if (!peer.alive || peer.socket.readyState !== WebSocket.OPEN) return;
    if (peer.socket.bufferedAmount > 8 * 1024 * 1024) {
      peer.socket.close(1013, "resynchronize");
      return;
    }
    peer.socket.send(JSON.stringify(value));
  };
  const errors = new RecentErrors(() => runtime.now());
  const emit = <N extends Notification>(method: N, params: NotificationParams<N>) => {
    if (!Check(notifications[method], params)) throw new RepaFault("invalid_event", "模块发出了无效事件");
    recordError(method, params);
    for (const peer of peers) {
      if (peer.subscribed) send(peer, { jsonrpc: "2.0", method, params });
    }
  };
  const cancelPeer = (peer: Peer) => {
    peer.alive = false;
    for (const controller of peer.logins) controller.abort();
    for (const controller of peer.feedbacks) controller.abort();
    reverse.endPeer(peer);
    peers.delete(peer);
  };
  const confirmFor = (peer: Peer | undefined): Confirm => (request, signal) => {
    if (!peer?.alive || !peer.authenticated || stopping || signal?.aborted) {
      return Promise.reject(new RepaFault("confirmation_cancelled", "当前没有可以接收确认的连接"));
    }
    if (!Check(notifications["confirm.request"].properties.request, request)) {
      return Promise.reject(new RepaFault("invalid_confirmation", "确认请求不符合接口要求"));
    }
    const pending = reverse.create<string | boolean | null>(peer, { kind: "confirm", request }, {
      signal,
      aborted: () => new RepaFault("confirmation_cancelled", "确认已取消"),
      disconnected: () => new RepaFault("confirmation_cancelled", "确认连接已断开"),
      closed: () => new RepaFault("confirmation_cancelled", "空间正在关闭"),
    });
    send(peer, { jsonrpc: "2.0", method: "confirm.request", params: { id: pending.id, request } });
    return pending.result;
  };
  /**
   * 对话里的询问只发给发起这次运行的连接：断线、运行中止和关空间都结束询问。
   * 连接没有声明 Item 需要的能力时不发送，直接得到 unsupported。
   */
  const askFor = (peer: Peer | undefined): AskRoute => (input, options) => {
    const signal = options.signal;
    if (!peer?.alive || !peer.authenticated || stopping) {
      return Promise.reject(new RepaFault("ask_unavailable", "当前运行没有可以作答的连接"));
    }
    if (signal?.aborted) return Promise.reject(new RepaFault("ask_cancelled", "询问已取消：运行已中止", { reason: "aborted" }));
    if (!canRender(peer.capabilities.interaction, input.item)) return Promise.resolve({ action: "unsupported" });
    // 编号由待答表生成；校验时用合法占位值，避免无效请求进入表。
    if (!Check(notifications["ask.request"], { id: "pending", ...input })) return Promise.reject(new RepaFault("invalid_ask", "询问不符合交互词汇"));
    const data: Extract<PendingData, { kind: "ask" }> = { kind: "ask", request: { id: "pending", ...input }, onSubmit: options.onSubmit, busy: false };
    const pending = reverse.create<AskOutcome>(peer, data, {
      signal,
      aborted: () => new RepaFault("ask_cancelled", "询问已取消：运行已中止", { reason: "aborted" }),
      disconnected: () => new RepaFault("ask_cancelled", "用户没有作答：连接已断开", { reason: "disconnected" }),
      closed: () => new RepaFault("ask_cancelled", "询问已取消：空间正在关闭", { reason: "closed" }),
      notifyClosed: (id, reason) => send(peer, { jsonrpc: "2.0", method: "ask.closed", params: { id, reason } }),
    });
    data.request.id = pending.id;
    send(peer, { jsonrpc: "2.0", method: "ask.request", params: data.request });
    return pending.result;
  };

  const replyAsk = async (peer: Peer, input: Params<"ask.reply">): Promise<AskSubmitResult | null> => {
    const pending = reverse.get(input.id);
    if (!pending || pending.peer !== peer || pending.data.kind !== "ask") throw new RepaFault("ask_not_found", "询问不存在、已经结束或不属于当前连接");
    const data = pending.data;
    const response = input.response;
    if ((response !== undefined) !== (input.action === "submit") || (input.message !== undefined && input.action !== "decline")) {
      throw new RepaFault("invalid_ask_reply", "response 只随 submit，message 只随 decline");
    }
    if (input.action === "decline") {
      pending.end({ value: { action: "decline", ...(input.message === undefined ? {} : { message: input.message }) } }, "answered");
      return null;
    }
    if (input.action === "cancel" || input.action === "unsupported") {
      pending.end({ value: { action: input.action } }, "cancelled");
      return null;
    }
    // 前面已确认 submit 带了作答；这里再查一次，类型上也就收窄了。
    if (response === undefined) throw new RepaFault("invalid_ask_reply", "提交需要带上作答");
    if (data.busy) throw new RepaFault("ask_busy", "上一次提交还在处理，请稍后再交");
    const checked = checkResponse(data.request.item, response);
    if (!checked.ok) return { status: "invalid", problems: checked.problems };
    let result: AskSubmitResult = { status: "accepted" };
    if (data.onSubmit !== undefined) {
      data.busy = true;
      try {
        result = await data.onSubmit(response);
      } catch {
        // 调用方处理失败时询问保持打开，用户可以再交或不按卡片作答；不把插件内部错误交给前端。
        throw new RepaFault("ask_submit_failed", "这次作答没能处理，请再交一次或换一种方式回答");
      } finally {
        data.busy = false;
      }
      if (!Check(AskSubmitResultSchema, result)) throw new RepaFault("ask_submit_failed", "调用方对这次作答的处理结果不符合交互词汇");
    }
    // 处理期间询问可能已经因为中止、断线或关空间结束；结果不再交回。
    if (reverse.get(input.id) !== pending) throw new RepaFault("ask_not_found", "询问已经结束");
    if (result.status === "invalid") return result;
    pending.end({ value: { action: "submit", response } }, "answered");
    return result;
  };
  /**
   * 前端服务的路由：优先交给发起当前操作的连接，它没有声明时交给最近初始化、声明了这项服务的连接。
   * 中止、断线和关空间都结束请求，失败不自动换连接重试。
   */
  const serviceFor = (initiator: Peer | undefined): Services["call"] => (service, input, options = {}) => {
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(new RepaFault("service_cancelled", "服务请求已取消", { service, reason: "aborted" }));
    const provides = (peer: Peer) => peer.alive && peer.authenticated && (peer.capabilities.services ?? []).includes(service);
    const target = initiator !== undefined && provides(initiator)
      ? initiator
      : [...peers].filter(provides).sort((left, right) => right.serial - left.serial)[0];
    if (stopping || target === undefined) return Promise.reject(new RepaFault("service_unavailable", "没有连接提供这项服务", { service }));
    // 只转交 JSON 数据；先序列化一次，既拦下不能传输的值，也让之后对原对象的修改不影响请求。
    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(input);
    } catch {
      encoded = undefined;
    }
    if (encoded === undefined) return Promise.reject(new RepaFault("invalid_service_input", "服务输入必须是 JSON 数据", { service }));
    const pending = reverse.create<unknown>(target, { kind: "service", service }, {
      signal,
      aborted: () => new RepaFault("service_cancelled", "服务请求已取消", { service, reason: "aborted" }),
      disconnected: () => new RepaFault("service_cancelled", "提供服务的连接已断开", { service, reason: "disconnected" }),
      closed: () => new RepaFault("service_cancelled", "服务请求已取消：空间正在关闭", { service, reason: "closed" }),
      notifyClosed: (id, reason) => send(target, { jsonrpc: "2.0", method: "service.closed", params: { id, reason } }),
    });
    send(target, { jsonrpc: "2.0", method: "service.request", params: { id: pending.id, service, input: JSON.parse(encoded) as unknown } });
    return pending.result;
  };

  const requireActive = (): ActiveSpace => {
    if (!active) throw new RepaFault("space_not_open", "请先打开空间");
    return active;
  };
  /** 插件列表加上各插件当前的或最近一次的装卸请求。 */
  const pluginsOf = (current: ActiveSpace): PluginInfo[] => requests.merge(current.space.root, current.list);
  /** 重新核对插件列表（源文件夹的状态、启用记录）；有变化时通知前端。宿主必须仍然打开。 */
  const refreshList = async (current: ActiveSpace): Promise<PluginInfo[]> => {
    const list = await listPlugins({
      home,
      root: current.space.root,
      dataDir: current.space.dataDir,
      assembled: { host: current.plugins, bundled: current.bundled.map((plugin) => plugin.id), selfWritten: current.selfWritten, unavailable: current.unavailable },
    });
    const changed = JSON.stringify(list) !== JSON.stringify(current.list);
    current.list = list;
    if (changed && active === current) emit("plugin.updated", { plugins: pluginsOf(current) });
    return pluginsOf(current);
  };
  const requests = createPluginRequests<Peer>({
    home,
    now: () => runtime.now(),
    current: () => active === undefined ? undefined : { root: active.space.root, dataDir: active.space.dataDir, opened: active.opened, bundled: active.bundled.map((plugin) => plugin.id) },
    confirm: (peer, request, signal) => confirmFor(peer)(request, signal),
    alive: (peer) => peer.alive,
    fullAccess: () => settings.get().commandPolicy === "fullAccess",
    execute: async (execution, signal) => (await reassembleWith(undefined, execution, signal)).status,
    runAs: (peer, action) => owner.run(peer, action),
    updated: () => {
      if (active !== undefined) emit("plugin.updated", { plugins: pluginsOf(active) });
    },
    error: (error) => {
      errors.add({ source: "plugin-requests", message: errorText(error), ...(error instanceof RepaFault ? { code: error.code } : {}) });
    },
  });
  // 装配序号：每次打开空间和每次重组前分配，单调递增；新宿主的 emit 闭包捕获它，旧宿主迟到的事件带旧序号。
  let serial = 0;
  // 重组闸门：落下时为一个 Promise，抬起时兑现。经过闸门的请求在 dispatch 之前等它。
  let reassembling: Promise<void> | undefined;
  // 在闸门前等待、尚未取得准入的请求；session.abort 到达时据此作废同一会话的发送、插话、追问和压缩。
  const gateWaiters = new Set<{ method: Method; sessionId: string | undefined; cancel(): void }>();
  // 正在装配、尚未发布到 active 的插件宿主与 Agent 空间；服务关闭时与 active 一起通知它们停止。
  let building: { plugins?: PluginHost; agent?: AgentSpace } | undefined;
  // 正在执行、经过闸门的请求数；session.send 等整次运行结束才返回，运行因此也算在内。
  let inFlight = 0;
  // 等待空闲的重组；任一工作结束时逐个重新判断，不轮询。
  const idleWaiters = new Set<() => void>();
  const checkIdle = () => {
    for (const check of [...idleWaiters]) check();
  };

  /** 结束空间里的命令确认、询问和服务请求；登录确认不属于空间。 */
  const endSpaceRequests = () => {
    reverse.endWhere((data) => data.kind !== "confirm" || data.request.kind === "command");
  };
  /**
   * 同一段同步代码里让 Agent 空间和插件宿主都开始关闭：两者各自立即拒绝新工作、发出取消，然后才一起等收尾。
   * 先等完一方再通知另一方会成环：插件持有空间写锁等模型请求时，Agent 的运行在等这把锁，而模型请求要等宿主关闭才取消。
   */
  const stopAssembly = (current: { agent: AgentSpace; plugins: PluginHost }) => {
    endSpaceRequests();
    return Promise.allSettled([current.agent.close(), current.plugins.close()]);
  };
  /** 让正在装配的部分开始关闭；还没建好的部分在建好时由装配自己核对 stopping 后关闭。 */
  const stopBuilding = () => {
    const owners = building;
    if (owners?.plugins === undefined) return;
    if (owners.agent !== undefined) void stopAssembly({ agent: owners.agent, plugins: owners.plugins });
    else void owners.plugins.close().catch(() => undefined);
  };
  const closeActive = async () => {
    const current = active;
    active = undefined;
    if (!current) return;
    // 等待空闲的重组随之取消，这个空间的装卸请求一并撤回。
    checkIdle();
    requests.closeSpace();
    const failures: unknown[] = [];
    for (const result of await stopAssembly(current)) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    // 写入者都停下以后备份最后一次，再让空间落盘并释放锁；每个 owner 都取得收尾机会。
    // 关闭时的备份在释放空间锁之前完成，上一次使用的改动不必等到下次打开才进入备份。
    for (const close of [() => current.backups.close(), () => current.space.close()]) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, "关闭空间失败");
  };
  const serializeLifecycle = <T>(action: () => Promise<T>): Promise<T> => {
    const result = lifecycle.then(action);
    lifecycle = result.then(() => undefined, () => undefined);
    return result;
  };

  /**
   * 打开空间和重组共用的装配：选出插件 → 插件 open → Agent 运行时 → 追赶，次序与打开空间时相同。
   * 运行的插件每次都从这一刻盘上的启用记录得出：bundled 是随包插件，自写插件由 spacePlugins 按记录加入。
   * clean 为 false 时不清理暂存与快照：旧实例没有正常关闭，可能还在用它们。
   * 插件 open 期间 Agent 空间尚未接上，runAgent 以 space_not_ready 拒绝；装配期间服务请求立即以 service_unavailable 拒绝，
   * 新连接因此不可能是装配所等的服务提供方。失败时关闭已经打开的部分，空间留给调用方处理。
   */
  const assemble = async (space: Space, bundled: Plugin[], how: { first: boolean; clean?: boolean; unsaved?: UnsavedSession[] }) => {
    const assembly = ++serial;
    let host: PluginHost | undefined;
    let agent: AgentSpace | undefined;
    let ready = false;
    // 建好的部分登记在这里，服务关闭时不必等装配结束就能通知它们停止；每建好一部分都核对一次服务是否正在关闭。
    const owners: NonNullable<typeof building> = {};
    building = owners;
    const checkStopping = () => {
      if (stopping) throw new RepaFault("closed", "服务正在关闭");
    };
    try {
      // 随包插件加上启用记录里的自写插件；没有交给宿主的自写插件与宿主停用的插件在插件列表里带着待批准或失败的状态。
      // 暂存副本只在打开空间时清：重组时下一批装卸可能正拿着暂存副本等批准。
      const selected = await spacePlugins({ home, space, bundled, clean: how.clean ?? true, staging: how.first });
      for (const problem of selected.problems) {
        errors.add({ source: "plugin-host", message: errorText(problem), code: problem instanceof RepaFault ? problem.code : "plugin_failed" });
      }
      checkStopping();
      host = await openPluginHost({
        space,
        plugins: selected.plugins,
        now: () => runtime.now(),
        ask: (request, askOptions) => askFor(owner.getStore())(request, askOptions),
        services: {
          call: (service, input, callOptions) => {
            if (!ready) return Promise.reject(new RepaFault("service_unavailable", "空间正在装配插件，暂不能调用前端服务", { service }));
            return serviceFor(owner.getStore())(service, input, callOptions);
          },
        },
        // 插件导出数据与反馈包用同一套脱敏：保存的凭据由运行时读出，读不到时导出失败。
        exports: { home, credentials: () => runtime.credentials() },
        models: (pluginId) => ({
          complete: (request) => runtime.complete(request, { pluginId, root: space.root, sessionsDir: space.sessionsDir }),
          completeStructured: (request, schema) => runtime.completeStructured(request, schema, { pluginId, root: space.root, sessionsDir: space.sessionsDir }),
          runAgent: (task) => {
            if (!agent) return Promise.reject(new RepaFault("space_not_ready", "空间尚未完成打开"));
            return agent.runAgent(task);
          },
          defaultModel: () => runtime.defaultModel(),
        }),
        async abortAgent(id) {
          if (!agent) {
            throw new RepaFault("space_not_ready", "空间尚未完成打开");
          }
          await agent.abortAgent(id);
        },
        emit: (pluginId, event) => emit("plugin.event", { pluginId, assembly, event }),
        onError: (error) => {
          errors.add({ source: "plugin-host", message: errorText(error), code: "plugin_failed", ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}) });
          emit("plugin.event", { pluginId: "host", assembly, event: { type: "error", code: "plugin_failed" } });
        },
        onIdle: checkIdle,
      });
      owners.plugins = host;
      checkStopping();
      const opened = host;
      // 停用或卸载的插件不提供 Agent，装配点名的直接对话 Agent 可能因此不在：这时去掉不在的，空间照常打开，停用原因在插件列表里。
      // 只有第一次装配、且没有插件停用、也没有未能运行的自写插件时原样交给运行时核对，写错的 id 仍报 unknown_agent。
      let directAgents = options.directAgents;
      if (directAgents !== undefined && (!how.first || opened.disabled().length > 0 || selected.unavailable.length > 0)) {
        const available = new Set([...(options.generalAgent === false ? [] : ["general"]), ...opened.agents().map((definition) => definition.id)]);
        directAgents = directAgents.filter((id) => available.has(id));
      }
      agent = await runtime.openSpace({
        root: space.root,
        sessionsDir: space.sessionsDir,
        instructions: () => opened.instructions(),
        tools: () => opened.tools(),
        views: () => opened.views(),
        agents: () => opened.agents(),
        generalAgent: options.generalAgent,
        directAgents,
        overrides: () => settings.overrides(space.root),
        commandPolicy: () => settings.get().commandPolicy,
        record: async (runId, action) => (await space.record({ kind: "agent", runId }, action)).value,
        writes: space.writes,
        controlDirs: [pluginsDirectory(home)],
        onEvent: (event) => {
          emit("session.event", event);
          // 一次运行结束时，它提出的装卸请求封口排队。会话里开始新的运行算作介入：
          // 请求提出之前就排进来的消息在提出请求的运行之后才运行，续跑不再接在它后面。
          if (event.type === "runStart") requests.intervene(event.sessionId);
          if (event.type === "runEnd" && event.runId !== undefined) requests.runEnded(event.runId, runStatus(event.data));
        },
        plugins: {
          list: async () => {
            // 只读这个装配自己的列表；装配还没发布或已被换下时，列表为空。
            const current = active;
            if (current === undefined || current.agent !== agent) return listText([]);
            return listText(await refreshList(current));
          },
          request: (input, origin) => requests.request(input, origin, owner.getStore()),
        },
        confirm: (request, signal) => confirmFor(owner.getStore())(request, signal),
        ask: (request, askOptions) => askFor(owner.getStore())(request, askOptions),
        onIdle: checkIdle,
        ...(how.unsaved === undefined ? {} : { unsavedSessions: how.unsaved }),
      });
      owners.agent = agent;
      checkStopping();
      await opened.start();
      checkStopping();
      ready = true;
      const list = await listPlugins({
        home,
        root: space.root,
        dataDir: space.dataDir,
        assembled: { host: opened, bundled: bundled.map((plugin) => plugin.id), selfWritten: selected.selfWritten, unavailable: selected.unavailable },
      });
      checkStopping();
      return { plugins: opened, agent, assembly, unavailable: selected.unavailable, selfWritten: selected.selfWritten, list };
    } catch (error) {
      if (agent !== undefined && host !== undefined) await stopAssembly({ agent, plugins: host });
      else await host?.close().catch(() => undefined);
      throw error;
    } finally {
      if (building === owners) building = undefined;
    }
  };
  const loadSpace = (root: string, create: boolean) => serializeLifecycle(async () => {
    if (stopping) throw new RepaFault("closed", "服务正在关闭");
    const resolved = path.resolve(root);
    if (active?.space.root === resolved && !create) return { root: resolved, assembly: active.assembly, plugins: pluginsOf(active) };
    await closeActive();
    // 插件写入与 Agent 的写入工具共用同一文件的写入队列。
    const space = await (create ? createSpace : openSpace)(resolved, { fileQueue: withFileMutationQueue, ...git });
    let assembled: Awaited<ReturnType<typeof assemble>> | undefined;
    try {
      assembled = await assemble(space, options.plugins ?? [], { first: true });
      await settings.remember(space.root);
      const backups = new SpaceBackups({
        home,
        space,
        now: () => runtime.now(),
        settings: () => settings.get().backup,
        onUpdate: (status) => emit("backup.updated", status),
        onError: (error) => {
          errors.add({
            source: "backup",
            message: error instanceof Error ? error.message : String(error),
            ...(error instanceof Error && "code" in error && typeof error.code === "string" ? { code: error.code } : {}),
          });
        },
      });
      const { plugins, agent, assembly, unavailable, selfWritten, list } = assembled;
      active = { space, plugins, agent, backups, opened: assembly, assembly, unavailable, selfWritten, bundled: options.plugins ?? [], list };
      backups.start();
      return { root: space.root, assembly, plugins: pluginsOf(active) };
    } catch (error) {
      if (assembled !== undefined) await stopAssembly(assembled);
      await space.close().catch(() => undefined);
      throw error;
    }
  });

  /** 当前空间的插件宿主与 Agent 空间是否都没有工作，也没有经过闸门、正在执行的请求。 */
  const idle = (current: ActiveSpace) => inFlight === 0 && !current.agent.busy() && !current.plugins.busy();

  /**
   * batch 是一批装卸在重组里要做的事：闸门落下时 begin，旧装配关闭以后 write，新装配建立以后 finish。
   * signal 中止时，还在等待空闲的重组以 cancelled 结束；闸门落下以后不再理会它。
   */
  const reassembleWith = (bundled?: Plugin[], batch?: Execution, signal?: AbortSignal): Promise<Reassembly> => {
    const target = active;
    if (stopping) return Promise.reject(new RepaFault("closed", "服务正在关闭"));
    if (target === undefined) return Promise.reject(new RepaFault("space_not_open", "请先打开空间"));
    const plugins = bundled ?? target.bundled;
    // 等待空闲时不挡住任何工作。空闲成立的那一刻，在同一段同步代码里落下闸门并让旧的装配开始关闭，
    // 计数为零与闸门落下之间没有 await，请求漏不进去；闸门落下以后插件新发起的工作被拒绝或取消，不等闸门。
    // 空间的身份是这一次打开：前一次重组换掉了 active 对象，但空间没有变，排在后面的重组照常进行。
    const opened = target.opened;
    return new Promise<Reassembly>((resolve, reject) => {
      const check = () => {
        const current = active;
        if (stopping || current?.opened !== opened || signal?.aborted === true) {
          idleWaiters.delete(check);
          signal?.removeEventListener("abort", check);
          resolve({ status: "cancelled" });
          return;
        }
        if (reassembling !== undefined || !idle(current)) return;
        idleWaiters.delete(check);
        signal?.removeEventListener("abort", check);
        detached(() => {
          let lift: () => void = () => undefined;
          reassembling = new Promise<void>((done) => { lift = done; });
          batch?.begin();
          const stopped = stopAssembly(current);
          serializeLifecycle(() => rebuild(current, plugins, stopped, batch)).then(resolve, reject).finally(() => {
            reassembling = undefined;
            lift();
            checkIdle();
          });
        });
      };
      idleWaiters.add(check);
      signal?.addEventListener("abort", check);
      check();
    });
  };

  const reassemble = (plugins?: Plugin[]): Promise<Reassembly> => reassembleWith(plugins);

  /**
   * 闸门落下以后、轮到生命周期队列时执行：等旧装配收尾；有装卸批次时写启用记录并读回；总是按盘上的启用记录重新装配；
   * 交回装卸结果、登记续跑；最后发出 space.assembled。闸门在调用方的 finally 里抬起。
   */
  const rebuild = async (target: ActiveSpace, plugins: Plugin[], stopped: Promise<PromiseSettledResult<void>[]>, batch?: Execution): Promise<Reassembly> => {
    const results = await stopped;
    // 排在前面的 space.open、space.close 已经关闭或换掉了这个空间；服务正在关闭时也不再打开插件，空间由服务关闭时的 closeActive 收尾。
    if (stopping || active !== target) return { status: "cancelled" };
    // 某个插件的 close() 抛错不挡住重组：记进最近错误，结果里写明是哪个插件、什么原因。
    // 这时旧实例可能还在用暂存副本或快照，这一次装配不清理它们，留到下一次正常的装配。
    const closeFailures: { pluginId: string; message: string }[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") continue;
      const reasons: unknown[] = result.reason instanceof AggregateError ? result.reason.errors : [result.reason];
      for (const reason of reasons) {
        const original = reason instanceof Error && reason.cause instanceof Error ? reason.cause : reason;
        errors.add({
          source: "plugin-host",
          message: errorText(reason),
          code: "plugin_close_failed",
          ...(original instanceof Error && original.stack !== undefined ? { stack: original.stack } : {}),
        });
        if (reason instanceof RepaFault && reason.code === "plugin_close_failed" && reason.details !== null && typeof reason.details === "object" && "pluginId" in reason.details && typeof reason.details.pluginId === "string") {
          closeFailures.push({ pluginId: reason.details.pluginId, message: reason.message });
        }
      }
    }
    // 旧实例都已关闭，这时写启用记录：记录没写成时，装回的就是原来的集合。持久化没有确认时不清理快照。
    let clean = closeFailures.length === 0;
    if (batch !== undefined) {
      try {
        if (!(await batch.write()).clean) clean = false;
      } catch (error) {
        clean = false;
        errors.add({ source: "plugin-requests", message: errorText(error) });
      }
    }
    let next: Awaited<ReturnType<typeof assemble>>;
    try {
      next = await assemble(target.space, plugins, { first: false, clean, unsaved: target.agent.unsavedSessions() });
    } catch (error) {
      // 装配途中服务开始关闭：已经建好的部分已关闭，空间由排在后面的 closeActive 收尾。
      if (stopping) return { status: "cancelled" };
      // 整体失败来自空间或运行时一类的故障（单个插件失败只会停用它）：照关闭空间的次序收尾，前端按恢复失败处理。
      batch?.failed(error);
      active = undefined;
      requests.closeSpace();
      for (const close of [() => target.backups.close(), () => target.space.close()]) {
        await close().catch((closeError: unknown) => {
          errors.add({ source: "space", message: closeError instanceof Error ? closeError.message : String(closeError) });
        });
      }
      const fault = error instanceof RepaFault ? error : new RepaFault("reassembly_failed", error instanceof Error ? error.message : String(error));
      emit("space.assembled", { root: null, error: { code: fault.code, message: fault.message } });
      throw error;
    }
    const current: ActiveSpace = { ...target, plugins: next.plugins, agent: next.agent, assembly: next.assembly, unavailable: next.unavailable, selfWritten: next.selfWritten, bundled: plugins, list: next.list };
    active = current;
    // 结果在闸门抬起之前交回：这时请求方会话刚从文件打开，除了这次交回没有别的东西能碰到它。续跑只登记，不等运行。
    if (batch !== undefined) {
      try {
        await batch.finish({ agent: next.agent, host: next.plugins, selfWritten: next.selfWritten, unavailable: next.unavailable, closeFailures });
      } catch (error) {
        errors.add({ source: "plugin-requests", message: errorText(error) });
      }
    }
    const list = pluginsOf(current);
    emit("space.assembled", { root: target.space.root, assembly: next.assembly, plugins: list });
    return { status: "applied", assembly: next.assembly, plugins: list, closeFailures };
  };

  // 前端只能与可直接对话的 Agent 建会话和发消息；后台任务与子 Agent 不经过这里。
  const requireDirect = (agent: AgentSpace, id: string) => {
    const info = agent.agents().find((item) => item.id === id);
    if (!info) throw new RepaFault("agent_not_found", "Agent 不存在或未启用", { agent: id });
    if (!info.direct) throw new RepaFault("agent_not_direct", "这个 Agent 不能直接对话", { agent: id });
  };
  const directSession = async (sessionId: string) => {
    const { agent } = requireActive();
    const session = await agent.get(sessionId);
    requireDirect(agent, session.info().agent);
    return session;
  };

  const dispatch = async (peer: Peer, method: Method, params: unknown): Promise<unknown> => {
    const p = <M extends Method>() => params as Params<M>;
    switch (method) {
      case "initialize": {
        const input = p<"initialize">();
        const supplied = Buffer.from(input.token);
        const expected = Buffer.from(token);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new RpcFault(-32001, "连接授权失败");
        if (input.version !== PROTOCOL_VERSION) throw new RpcFault(-32002, "协议版本不兼容");
        peer.authenticated = true;
        peer.capabilities = input.capabilities ?? {};
        peer.serial = ++initialized;
        return { version: PROTOCOL_VERSION, serverId };
      }
      case "space.list":
        return settings.get().recentSpaces;
      case "space.open":
        return loadSpace(p<"space.open">().root, false);
      case "space.create":
        return loadSpace(p<"space.create">().root, true);
      case "space.close":
        await serializeLifecycle(closeActive);
        return null;
      case "space.roots":
        return listRoots();
      case "space.browse":
        return browseDirectory(p<"space.browse">().path);
      case "agent.list":
        return requireActive().agent.agents();
      case "session.list":
        return requireActive().agent.list();
      case "session.create": {
        const input = p<"session.create">();
        const { agent } = requireActive();
        const id = input.agent ?? "general";
        requireDirect(agent, id);
        return (await agent.create({ agent: id, model: input.model })).info();
      }
      case "session.history":
        return (await requireActive().agent.get(p<"session.history">().sessionId)).history();
      case "session.send": {
        const input = p<"session.send">();
        await (await directSession(input.sessionId)).send(input.text);
        return null;
      }
      case "session.steer": {
        const input = p<"session.steer">();
        await (await directSession(input.sessionId)).steer(input.text);
        return null;
      }
      case "session.followUp": {
        const input = p<"session.followUp">();
        await (await directSession(input.sessionId)).followUp(input.text);
        return null;
      }
      case "session.abort":
        await (await requireActive().agent.get(p<"session.abort">().sessionId)).abort();
        return null;
      case "session.setModel": {
        const input = p<"session.setModel">();
        await (await requireActive().agent.get(input.sessionId)).setModel(input.model);
        return null;
      }
      case "session.compact":
        await (await requireActive().agent.get(p<"session.compact">().sessionId)).compact();
        return null;
      case "session.fork": {
        const input = p<"session.fork">();
        return (await (await directSession(input.sessionId)).fork(input.entryId)).info();
      }
      case "confirm.reply": {
        const input = p<"confirm.reply">();
        const pending = reverse.get(input.id);
        if (!pending || pending.peer !== peer || pending.data.kind !== "confirm") throw new RepaFault("confirmation_not_found", "确认不存在或不属于当前连接");
        const kind = pending.data.request.kind;
        if (
          ((kind === "command" || kind === "plugin") && typeof input.value !== "boolean" && input.value !== null) ||
          ((kind === "input" || kind === "select") && typeof input.value !== "string" && input.value !== null) ||
          (kind === "select" && typeof input.value === "string" && !pending.data.request.options?.includes(input.value))
        ) {
          throw new RepaFault("invalid_confirmation_reply", "确认回答不符合请求要求");
        }
        pending.end({ value: input.value });
        return null;
      }
      case "ask.reply":
        return replyAsk(peer, p<"ask.reply">());
      case "service.reply": {
        const input = p<"service.reply">();
        const pending = reverse.get(input.id);
        if (!pending || pending.peer !== peer || pending.data.kind !== "service") throw new RepaFault("service_request_not_found", "服务请求不存在、已经结束或不属于当前连接");
        if ("error" in input) {
          pending.end({ error: new RepaFault("service_failed", input.error.message, { service: pending.data.service, code: input.error.code }) });
        } else {
          pending.end({ value: input.result });
        }
        return null;
      }
      case "history.list":
        return requireActive().space.history.list(p<"history.list">().limit);
      case "history.changes":
        return requireActive().space.history.changes(p<"history.changes">().since);
      case "history.undo":
        return requireActive().space.history.undo(p<"history.undo">().revision);
      case "history.undoRun":
        return requireActive().space.history.undoRun(p<"history.undoRun">().runId);
      case "plugin.list":
        return refreshList(requireActive());
      case "plugin.load": {
        const input = p<"plugin.load">();
        requireActive();
        return { requestId: requests.submit("load", input.ids, input.from ?? "folder", peer) };
      }
      case "plugin.unload":
        requireActive();
        return { requestId: requests.submit("unload", p<"plugin.unload">().ids, "folder", peer) };
      case "plugin.cancel":
        requests.cancel(p<"plugin.cancel">().requestId);
        return null;
      case "plugin.call": {
        const input = p<"plugin.call">();
        const current = requireActive();
        // 序号不属于这一次打开的空间：调用是在切换空间之前组成的，不能落到这里的同名插件上。
        // 属于这一次打开、但早于最近一次重组的，照常交给现在的实例，在闸门后等待的调用不因重组而失败。
        if (input.assembly < current.opened || input.assembly > current.assembly) {
          throw new RepaFault("space_changed", "空间已经切换，调用属于此前打开的空间", { assembly: input.assembly });
        }
        // 交给插件的是副本，插件改动它不会影响这个连接的路由。
        return current.plugins.call(input.pluginId, input.method, input.input, { capabilities: structuredClone(peer.capabilities) });
      }
      case "prompt.list":
        return (await requireActive().agent.preview(p<"prompt.list">().agent)).sections;
      case "prompt.preview":
        return requireActive().agent.preview(p<"prompt.preview">().agent);
      case "prompt.set": {
        const input = p<"prompt.set">();
        await settings.setPrompt(
          input.scope,
          input.id,
          input.override,
          input.scope === "space" ? requireActive().space.root : active?.space.root,
        );
        return null;
      }
      case "prompt.reset": {
        const input = p<"prompt.reset">();
        await settings.setPrompt(
          input.scope,
          input.id,
          undefined,
          input.scope === "space" ? requireActive().space.root : active?.space.root,
        );
        return null;
      }
      case "model.list":
        return runtime.listModels();
      case "model.providers":
        return runtime.listProviders();
      case "model.getDefault":
        return runtime.defaultModel() ?? null;
      case "model.setDefault":
        await runtime.setDefaultModel(p<"model.setDefault">().model);
        return null;
      case "auth.login": {
        const input = p<"auth.login">();
        const controller = new AbortController();
        peer.logins.add(controller);
        try {
          await runtime.login(input.provider, input.type, confirmFor(peer), controller.signal);
        } catch {
          throw new RepaFault(
            controller.signal.aborted ? "login_cancelled" : "login_failed",
            controller.signal.aborted ? "登录已取消" : "登录失败，请检查连接与输入",
          );
        } finally {
          controller.abort();
          peer.logins.delete(controller);
        }
        return null;
      }
      case "auth.setKey": {
        const input = p<"auth.setKey">();
        try {
          await runtime.setKey(input.provider, input.key);
        } catch (error) {
          // requires_interactive_login 告诉前端改走 auth.login，不能被合并成笼统的失败。
          if (error instanceof RepaFault) throw error;
          throw new RepaFault("auth_failed", "保存模型凭据失败");
        }
        return null;
      }
      case "auth.logout":
        try {
          await runtime.logout(p<"auth.logout">().provider);
        } catch {
          throw new RepaFault("auth_failed", "删除模型凭据失败");
        }
        return null;
      case "feedback.create": {
        const input = p<"feedback.create">();
        const current = requireActive();
        const controller = new AbortController();
        peer.feedbacks.add(controller);
        try {
          return await createFeedbackBundle({
            now: () => runtime.now(),
            home,
            root: current.space.root,
            agent: current.agent,
            history: current.space.history,
            complete: (request) => runtime.complete(request),
            credentials: () => runtime.credentials(),
            errors,
            commandPolicy: settings.get().commandPolicy,
            plugins: current.plugins.list(),
          }, input, controller.signal);
        } finally {
          peer.feedbacks.delete(controller);
        }
      }
      case "settings.get":
        return settings.get();
      case "settings.set": {
        const result = await settings.set(p<"settings.set">());
        active?.backups.reschedule();
        return result;
      }
      case "backup.status":
        return active === undefined ? null : active.backups.status();
      case "backup.create": {
        const { backups } = requireActive();
        try {
          return await backups.check();
        } catch (error) {
          // 原因已记进备份状态，设置页从那里显示；这里给调用方可以分支的错误码。
          if (error instanceof RepaFault) throw error;
          throw new RepaFault("backup_failed", `备份没有完成：${error instanceof Error ? error.message : String(error)}`, {
            ...(error instanceof Error && "code" in error && typeof error.code === "string" ? { code: error.code } : {}),
          });
        }
      }
      case "backup.list":
        return listBackups(home);
      case "backup.restore": {
        const input = p<"backup.restore">();
        if (active?.space.root === input.root) throw new RepaFault("space_locked", "空间正在使用，关闭空间以后再恢复", { root: input.root });
        const before = await restoreInPlace({ home, root: input.root, id: input.id, now: runtime.now() });
        emit("backup.updated", await groupStatus(home, input.root));
        return before;
      }
      case "backup.restoreTo": {
        const input = p<"backup.restoreTo">();
        return { root: await restoreToNew({ home, root: input.root, id: input.id, target: input.target, ...git }) };
      }
      case "backup.delete": {
        const input = p<"backup.delete">();
        await deleteBackup(home, input.root, input.id);
        emit("backup.updated", active?.space.root === input.root ? await active.backups.status() : await groupStatus(home, input.root));
        return null;
      }
    }
  };

  /**
   * 经过闸门的请求取得准入并执行。最后一次确认闸门抬起、核对服务、连接、到达时的空间和作废状态、计数、调用 dispatch，
   * 在同一段同步代码里完成，计数为零与闸门落下之间、核对与执行之间都不会有重组或关闭插进来；闸门落着时等它抬起，再从头核对。
   * session.abort 到达时同步作废同一会话仍在等待的发送、插话、追问和压缩，作废资格保留到准入完成：闸门抬起后 abort 的异步层次更少，
   * 会先于 send 执行，按到达顺序无法保证停止拿到它之前的消息。作废的请求按排队中的运行被取消答复。
   */
  const admit = async (peer: Peer, method: Method, params: unknown): Promise<unknown> => {
    const sessionId = method.startsWith("session.") && params !== null && typeof params === "object" && "sessionId" in params && typeof params.sessionId === "string"
      ? params.sessionId
      : undefined;
    // 介入在请求到达时登记，不依赖闸门之后的执行次序：闸门期间到达的停止同样使此前提出的装卸不再续跑。
    if (sessionId !== undefined && INTERVENING.has(method)) requests.intervene(sessionId);
    if (method === "session.abort") {
      for (const waiter of [...gateWaiters]) {
        if (waiter.sessionId === sessionId && VOIDABLE.has(waiter.method)) waiter.cancel();
      }
    }
    const arrived = active?.space;
    let voided = false;
    let wake: () => void = () => undefined;
    const waiter = { method, sessionId, cancel: () => { voided = true; wake(); } };
    try {
      for (;;) {
        if (voided) throw new RepaFault("cancelled", "排队中的会话运行已取消");
        const gate = reassembling;
        if (gate === undefined) break;
        gateWaiters.add(waiter);
        await new Promise<void>((resolve) => {
          wake = resolve;
          void gate.then(resolve);
        });
      }
      if (stopping || !peer.alive) throw new RepaFault("closed", "服务或连接已经关闭");
      if (active?.space !== arrived) throw new RepaFault("space_changed", "等待期间空间已经关闭或切换");
    } finally {
      gateWaiters.delete(waiter);
    }
    inFlight++;
    try {
      return await owner.run(peer, () => dispatch(peer, method, params));
    } finally {
      inFlight--;
      checkIdle();
    }
  };

  const toFault = (error: unknown): RpcFault => error instanceof RpcFault ? error : error instanceof RepaFault
    ? new RpcFault(-32000, error.message, { code: error.code, ...(error.details === undefined ? {} : { details: error.details }) })
    : new RpcFault(-32603, "Internal error");

  /**
   * 生成并发出一个连接的响应。带基线的初始化响应要在闸门抬起时生成，不读正在关闭的对象：
   * 最后一次等待之后，核对、订阅、内存投影与 socket.send 在同一段同步代码里完成，批量请求也一样；之后的广播只能排在响应后面。
   */
  const respond = async (peer: Peer, replies: Reply[], batch: boolean): Promise<void> => {
    while (reassembling !== undefined && replies.some((reply) => reply.baseline)) await reassembling;
    const values = replies.map((reply) => reply.build());
    if (values.length) send(peer, batch ? values : values[0]);
  };

  const handle = async (peer: Peer, value: unknown): Promise<Reply | undefined> => {
    let id: RpcId = null;
    let notification = false;
    try {
      const request = parseRequest(value);
      notification = !Object.hasOwn(request, "id");
      id = request.id ?? null;
      // Repa 的操作需要响应确认，客户端 notification 不触发副作用。
      if (notification) return undefined;
      if (stopping || !peer.alive) throw new RepaFault("closed", "服务或连接已经关闭");
      if (!peer.authenticated && request.method !== "initialize") throw new RpcFault(-32001, "请先授权连接");
      if (!Object.hasOwn(methods, request.method)) throw new RpcFault(-32601, "Method not found");
      const method = request.method as Method;
      const params = request.params === undefined ? {} : request.params;
      if (!Check(methods[method].params, params)) throw new RpcFault(-32602, "Invalid params");
      // 关闭、切换或新建空间在到达时登记为介入：排在重组后面的关闭也使装卸结果不再续跑。
      if (method === "space.close" || method === "space.create" || (method === "space.open" && path.resolve((params as Params<"space.open">).root) !== active?.space.root)) {
        requests.interveneSpace();
      }
      const result = GATED.has(method) ? await admit(peer, method, params) : await owner.run(peer, () => dispatch(peer, method, params));
      if (method !== "initialize") {
        return {
          baseline: false,
          build: () => Check(methods[method].result, result) ? { jsonrpc: "2.0", id, result } : errorResponse(id, new RpcFault(-32603, "Internal error")),
        };
      }
      // 初始化的基线读 Agent 空间和插件宿主，在 respond 里闸门抬起以后、发送之前同步生成。
      return {
        baseline: true,
        build: () => {
          if (stopping || !peer.alive) return errorResponse(id, toFault(new RepaFault("closed", "服务或连接已经关闭")));
          peer.subscribed = true;
          const output = {
            version: PROTOCOL_VERSION,
            serverId,
            baseline: {
              space: active === undefined ? null : { root: active.space.root, assembly: active.assembly },
              sessions: active?.agent.baseline() ?? [],
              plugins: active === undefined ? [] : pluginsOf(active),
            },
          };
          return Check(methods[method].result, output) ? { jsonrpc: "2.0", id, result: output } : errorResponse(id, new RpcFault(-32603, "Internal error"));
        },
      };
    } catch (error) {
      if (notification) return undefined;
      // 内部错误不把细节交给前端，记进最近错误，反馈包里能看到原因。
      if (!(error instanceof RpcFault) && !(error instanceof RepaFault)) {
        errors.add({ source: "rpc", message: error instanceof Error ? error.message : String(error), ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}) });
      }
      const fault = toFault(error);
      return { baseline: false, build: () => errorResponse(id, fault) };
    }
  };
  http.on("upgrade", (request, socket, head) => {
    if (stopping || request.url !== "/rpc") {
      socket.destroy();
      return;
    }
    websocket.handleUpgrade(request, socket, head, (socket) => websocket.emit("connection", socket));
  });
  websocket.on("connection", (socket) => {
    const peer: Peer = {
      socket,
      authenticated: false,
      subscribed: false,
      alive: true,
      capabilities: {},
      serial: 0,
      logins: new Set(),
      feedbacks: new Set(),
    };
    peers.add(peer);
    const timer = setTimeout(() => {
      if (!peer.authenticated) socket.close(4001, "authentication required");
    }, 5000);
    timer.unref();
    socket.on("close", () => {
      clearTimeout(timer);
      cancelPeer(peer);
    });
    socket.on("error", () => {
      cancelPeer(peer);
      socket.terminate();
    });
    socket.on("message", (data, binary) => {
      const operation = (async () => {
        if (binary) {
          send(peer, errorResponse(null, new RpcFault(-32600, "Invalid Request")));
          return;
        }
        let value: unknown;
        try {
          value = JSON.parse(data.toString());
        } catch {
          send(peer, errorResponse(null, new RpcFault(-32700, "Parse error")));
          return;
        }
        if (Array.isArray(value)) {
          if (!value.length) {
            send(peer, errorResponse(null, new RpcFault(-32600, "Invalid Request")));
            return;
          }
          const replies = (await Promise.all(value.map((item) => handle(peer, item)))).filter((item) => item !== undefined);
          await respond(peer, replies, true);
        } else {
          const reply = await handle(peer, value);
          if (reply !== undefined) await respond(peer, [reply], false);
        }
      })();
      operations.add(operation);
      operation.then(
        () => operations.delete(operation),
        () => {
          operations.delete(operation);
          socket.terminate();
        },
      );
    });
  });

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    stopping = true;
    // 等待空闲的重组随之取消，装卸请求一并撤回。
    checkIdle();
    requests.closeSpace();
    // 先让当前装配和正在建立的装配都开始关闭，再等运行时：运行时收尾要等 Agent 的运行结束，运行可能排在插件持有的空间写锁后面，
    // 而插件持锁等的模型请求只在插件宿主开始关闭时取消。active 与装配中的部分之外没有别的插件宿主。
    if (active !== undefined) void stopAssembly(active);
    stopBuilding();
    closePromise = (async () => {
      const failures: unknown[] = [];
      for (const peer of peers) {
        cancelPeer(peer);
        peer.socket.terminate();
      }
      const transport = Promise.all([
        new Promise<void>((resolve) => websocket.close(() => resolve())),
        new Promise<void>((resolve) => http.close(() => resolve())),
      ]);
      for (const stop of [() => runtime.close(), () => serializeLifecycle(closeActive)]) {
        try {
          await stop();
        } catch (error) {
          failures.push(error);
        }
      }
      await Promise.allSettled([...operations]);
      await transport;
      finishClosed();
      if (failures.length) throw new AggregateError(failures, "关闭服务失败");
    })();
    return closePromise;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(options.port ?? 0, "127.0.0.1", () => {
        http.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
  const address = http.address();
  if (!address || typeof address === "string") {
    await close();
    throw new RepaFault("listen_failed", "后端未取得本机端口");
  }
  return { connection: { url: `ws://127.0.0.1:${address.port}/rpc`, token }, closed, close, reassemble };
}
