import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate } from "react-router";
import { ChevronDown, Clock, MessageSquarePlus, RefreshCw, Split } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { StatusNotice } from "@/components/ui/status-notice";
import { AskCard } from "@/components/domain/ask-card";
import { ConversationMessage } from "@/components/domain/conversation-message";
import { ErrorNotice } from "@/components/domain/error-notice";
import { MessageComposer } from "@/components/domain/message-composer";
import { ToolActivity } from "@/components/domain/tool-activity";
import { ConversationModelDialog } from "@/features/model-picker";
import { useAppStore } from "@/hooks/use-app-store";
import type { ConversationItem } from "@/lib/conversation";
import type { Ask } from "@/lib/store";
import { errorCode } from "@/lib/errors";
import { folderName } from "@/lib/paths";
import { cn } from "@/lib/utils";

export function ConversationPage() {
  const space = useAppStore((state) => state.space);
  if (!space) return <Navigate to="/learning-space" replace />;
  return <Conversation space={space} />;
}

function Conversation({ space }: { space: string }) {
  const conversation = useAppStore((state) => state.conversation);
  const connected = useAppStore((state) => state.connected);
  const loadConversation = useAppStore((state) => state.loadConversation);
  const newConversation = useAppStore((state) => state.newConversation);
  const sendMessage = useAppStore((state) => state.sendMessage);
  const stopRun = useAppStore((state) => state.stopRun);
  const forkSession = useAppStore((state) => state.forkSession);
  const asks = useAppStore((state) => state.asks);
  const submitAsk = useAppStore((state) => state.submitAsk);
  const cancelAsk = useAppStore((state) => state.cancelAsk);
  const defaultModel = useAppStore((state) => state.resources.defaultModel);
  const models = useAppStore((state) => state.resources.models);
  const providers = useAppStore((state) => state.resources.providers);
  const loadModelSettings = useAppStore((state) => state.loadModelSettings);
  const [draft, setDraft] = useState("");
  const [picking, setPicking] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [forking, setForking] = useState(false);
  // 分叉失败只在原会话里提示，切到别的会话后不再显示。
  const [forkError, setForkError] = useState<{ sessionId: string | undefined; error: unknown }>();
  const record = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // 用户往上翻看时不打断，停在底部附近时跟随新内容。
  const following = useRef(true);

  useEffect(() => {
    if (conversation.status === "idle") void loadConversation();
  }, [conversation.status, loadConversation]);

  // 用来显示当前模型和判断有没有可用模型；读取失败时不提示，发送时后端仍会报告。
  useEffect(() => {
    void loadModelSettings();
  }, [loadModelSettings]);

  const providerNames = useMemo(
    () => new Map((providers.data ?? []).map((provider) => [provider.id, provider.name])),
    [providers.data],
  );
  const available = useMemo(() => (models.data ?? []).filter((model) => model.available), [models.data]);

  useLayoutEffect(() => {
    const element = record.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [conversation.items, conversation.queued, asks]);

  function onScroll() {
    const element = record.current;
    if (!element) return;
    following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    setScrolled(element.scrollTop > 0);
  }

  async function send() {
    const text = draft;
    setDraft("");
    following.current = true;
    const sent = await sendMessage(text);
    // 没发出去时把内容还回输入框，除非用户已经开始写下一条。
    if (!sent) setDraft((current) => current === "" ? text : current);
  }

  async function fork(entryId: string) {
    const sessionId = conversation.sessionId;
    setForking(true);
    setForkError(undefined);
    try {
      await forkSession(entryId);
      following.current = true;
      // 原来的按钮随记录一起换掉，焦点交给输入框，接着在新会话里提问。
      input.current?.focus();
    } catch (error) {
      setForkError({ sessionId, error });
    } finally {
      setForking(false);
    }
  }

  async function stop() {
    const unsent = await stopRun();
    // 和 Pi 一样，取消时没送到的排队消息回到输入框，排在正在写的内容前面。
    if (unsent.length > 0) setDraft((current) => [...unsent, current].filter((text) => text.trim() !== "").join("\n\n"));
  }

  const { run, status, items } = conversation;
  const running = run !== "idle";
  // 询问显示在发起它的工具调用下面；找不到那次调用时（例如插件或子 Agent 发起的）放在记录末尾。
  const toolIds = new Set(items.flatMap((item) => item.kind === "tool" ? [item.id] : []));
  const asksAt = (id: string) => asks.filter((ask) => ask.request.origin.callId === id);
  const unplaced = asks.filter((ask) => ask.request.origin.callId === undefined || !toolIds.has(ask.request.origin.callId));
  const waiting = asks.some((ask) => ask.closed === undefined);
  const askCard = (ask: Ask) => <AskCard
    key={ask.request.id}
    ask={ask}
    onSubmit={(response) => { void submitAsk(ask.request.id, response); }}
    onCancel={() => { void cancelAsk(ask.request.id); }}
  />;
  // 已建立的会话用自己保存的模型，还没建立的用选中的或默认模型。
  const model = conversation.model ?? defaultModel.data ?? undefined;
  const modelInfo = model && models.data?.find((item) => item.provider === model.provider && item.id === model.id);
  const modelProvider = model && providers.data?.find((provider) => provider.id === model.provider);
  const modelName = modelInfo?.name ?? model?.id;
  const needsModel = (conversation.model === undefined && defaultModel.status === "ready" && defaultModel.data === null)
    || errorCode(conversation.sendError) === "model_required";

  // 页面占满一屏，只让对话记录滚动，输入框始终留在底部。
  return <div className="flex h-dvh flex-col">
    {/* 顶栏只显示空间名，完整路径悬停查看；对话记录滚动后才出现分隔线。移动端左侧让出浮动的导航按钮。 */}
    <header className={cn(
      "flex min-h-14 shrink-0 items-center justify-between gap-3 border-b py-2 pr-4 pl-16 transition-colors md:px-6",
      scrolled ? "border-border" : "border-transparent",
    )}>
      <h2 className="min-w-0 truncate text-base font-semibold" title={space}>{folderName(space)}</h2>
      <Button variant="ghost" disabled={running || status !== "ready" || items.length === 0} onClick={newConversation}>
        <MessageSquarePlus aria-hidden="true" />新会话
      </Button>
    </header>

    <section
      ref={record}
      aria-label="对话记录"
      aria-busy={running}
      tabIndex={0}
      onScroll={onScroll}
      // 两侧预留同样的滚动条位置，内容与下方输入框始终对齐。
      className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <div className="mx-auto w-full max-w-3xl px-4 pb-4 md:px-8">
        {status === "loading" && <p role="status" className="text-sm text-muted-foreground">正在读取会话…</p>}
        {status === "error" && <div className="grid gap-3">
          <ErrorNotice title="无法读取会话" error={conversation.error} />
          <div>
            <Button variant="outline" onClick={() => { void loadConversation(); }}>
              <RefreshCw aria-hidden="true" />重试
            </Button>
          </div>
        </div>}
        {status === "ready" && items.length === 0 && !running && <p className="text-sm text-muted-foreground">
          这是一个新会话。说说你想学什么，或者直接提问。
        </p>}
        {items.map((item) => <Fragment key={item.id}>
          <Item
            item={item}
            streaming={item.id === conversation.streaming}
            onFork={item.kind === "assistant" && item.forkable ? () => { void fork(item.id); } : undefined}
            forkDisabled={running || forking || !connected}
          />
          {item.kind === "tool" && asksAt(item.id).map(askCard)}
        </Fragment>)}
        {unplaced.map(askCard)}
        {/* 等待作答时卡片本身就是状态，不再显示“正在处理”。 */}
        {running && !waiting && conversation.streaming === undefined && <p role="status" className="mb-4 text-sm text-muted-foreground">
          {run === "stopping" ? "正在停止…" : "Agent 正在处理…"}
        </p>}
        {/* 排队的消息留在记录末尾，送达后换成记录里的用户消息，位置基本不动。 */}
        {conversation.queued.map((message) => <div key={message.id} className="mb-4 grid justify-items-end gap-1">
          <ConversationMessage sender="user" className="mb-0">{message.text}</ConversationMessage>
          <p className="flex items-center gap-1 text-sm text-muted-foreground">
            <Clock aria-hidden="true" className="size-4 shrink-0" />排队中，Agent 做完当前这一步后会看到
          </p>
        </div>)}
      </div>
    </section>

    <div className="mx-auto grid w-full max-w-3xl gap-3 px-4 pt-2 pb-4 md:px-8">
      {needsModel && <div className="grid gap-3">
        <StatusNotice status="error" title="还没有可用的模型"><p>连接一个模型提供方后才能对话。</p></StatusNotice>
        <div>
          <Button asChild variant="outline"><Link to="/settings">去设置模型</Link></Button>
        </div>
      </div>}
      {conversation.sendError !== undefined && errorCode(conversation.sendError) !== "model_required"
        && <ErrorNotice title="消息没有完成" error={conversation.sendError} />}
      {forkError && forkError.sessionId === conversation.sessionId && <ErrorNotice title="没能分叉会话" error={forkError.error} />}
      <MessageComposer
        inputRef={input}
        value={draft}
        onChange={setDraft}
        onSend={() => { void send(); }}
        onStop={() => { void stop(); }}
        running={running}
        stopping={run === "stopping"}
        answering={waiting}
        // 运行开始前还没有可以排队的运行，停止中再发的消息会被一起取消。
        disabled={!connected || status !== "ready" || run === "sending" || run === "stopping"}
      />
      {model && <div className="flex min-w-0 flex-wrap items-center gap-x-2">
        <Button
          variant="ghost"
          aria-label={`更换模型，当前是 ${modelName ?? ""}`}
          title="更换这个会话的模型"
          disabled={running || status !== "ready" || available.length === 0}
          onClick={() => setPicking(true)}
        >
          <span className="min-w-0 break-all">{modelName}</span>
          <ChevronDown aria-hidden="true" />
        </Button>
        {modelProvider && !modelProvider.configured && <span className="text-sm text-muted-foreground">
          {modelProvider.name} 还没有连接，发送会失败
        </span>}
      </div>}
    </div>
    <ConversationModelDialog
      open={picking}
      onOpenChange={setPicking}
      models={available}
      providerNames={providerNames}
      current={model}
      started={conversation.sessionId !== undefined}
    />
  </div>;
}

function Item({ item, streaming, onFork, forkDisabled }: {
  item: ConversationItem;
  streaming: boolean;
  /** 只有能作为分叉点的消息才有。 */
  onFork?: (() => void) | undefined;
  forkDisabled: boolean;
}) {
  switch (item.kind) {
    case "user":
      return <ConversationMessage sender="user">{item.text}</ConversationMessage>;
    case "assistant": {
      // 分叉保留这条回答和它之前的全部内容，在新会话里换个方向接着问；原会话不变。
      const actions = onFork && <Button
        variant="ghost"
        size="icon"
        aria-label="从这里分叉"
        title="从这里分叉：保留到这条回答，在新会话里继续"
        disabled={forkDisabled}
        onClick={onFork}
      >
        <Split aria-hidden="true" />
      </Button>;
      return <ConversationMessage sender="assistant" actions={actions}>
        <Markdown text={item.text} streaming={streaming} />
      </ConversationMessage>;
    }
    case "tool":
      return <ToolActivity tool={item.tool} status={item.status} />;
    case "error":
      return <div className="mb-4"><StatusNotice status="error" title="运行出错"><p>{item.text}</p></StatusNotice></div>;
    case "stopped":
      return <p className="mb-4 text-sm text-muted-foreground">已停止</p>;
    case "compaction":
      return <p className="mb-4 text-sm text-muted-foreground">已压缩上下文，较早的对话已整理成摘要</p>;
  }
}
