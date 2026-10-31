import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { SquarePen } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { RenderLink } from "@/components/ui/markdown";
import { StatusNotice } from "@/components/ui/status-notice";
import { ConversationItemView } from "@/components/domain/conversation-item";
import { ErrorNotice } from "@/components/domain/error-notice";
import { MessageComposer } from "@/components/domain/message-composer";
import { useAppStore } from "@/hooks/use-app-store";
import { describeError, errorCode } from "@/lib/errors";
import { TUTOR_AGENT } from "@/lib/learning";

/** `message_rejected` 的拒收原因，例如受限任务期间的 restricted。 */
function rejectedReason(error: unknown): unknown {
  const { details } = describeError(error);
  return typeof details === "object" && details !== null && "reason" in details ? details.reason : undefined;
}

/**
 * 辅导对话：一个学习空间一段连续的 learning-tutor 会话，换任务不换会话，重开时接着最近的一段。
 * 辅导从后端的 view 得知当前任务，前端不往消息里拼题目。学习者可以开始新对话，旧的仍在会话列表里。
 * 复习和测验期间不能辅导，输入框收起。
 */
export function TutorPanel({ allowed, renderLink }: {
  allowed: boolean;
  renderLink: RenderLink;
}) {
  const conversation = useAppStore((state) => state.conversation);
  const connected = useAppStore((state) => state.connected);
  const sessions = useAppStore((state) => state.resources.sessions);
  const loadSessions = useAppStore((state) => state.loadSessions);
  const openSession = useAppStore((state) => state.openSession);
  const newConversation = useAppStore((state) => state.newConversation);
  const sendMessage = useAppStore((state) => state.sendMessage);
  const stopRun = useAppStore((state) => state.stopRun);
  const defaultModel = useAppStore((state) => state.resources.defaultModel);
  const loadModelSettings = useAppStore((state) => state.loadModelSettings);
  const refreshLearning = useAppStore((state) => state.refreshLearning);
  const [draft, setDraft] = useState("");
  const record = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const bound = conversation.agent === TUTOR_AGENT;
  const { run, status, items } = conversation;
  const running = run !== "idle";

  useEffect(() => {
    void loadModelSettings();
  }, [loadModelSettings]);

  useEffect(() => {
    if (sessions.status === "idle") void loadSessions();
  }, [sessions.status, loadSessions]);

  // 对话不是辅导会话时，接上最近的一段（列表按最后消息时间倒序），没有就开一段新的。运行中不换，等这一轮结束。
  useEffect(() => {
    if (bound || conversation.run !== "idle" || sessions.status !== "ready") return;
    const latest = sessions.data?.find((session) => session.agent === TUTOR_AGENT);
    if (latest) void openSession(latest);
    else newConversation({ agent: TUTOR_AGENT });
  }, [bound, conversation.run, sessions.data, sessions.status, newConversation, openSession]);

  // 发出时限制刚生效（例如复习刚开始），后端以 restricted 拒收；重新读取状态，输入框随之收起。
  const restricted = errorCode(conversation.sendError) === "message_rejected" && rejectedReason(conversation.sendError) === "restricted";
  useEffect(() => {
    if (restricted) void refreshLearning();
  }, [restricted, refreshLearning]);

  useLayoutEffect(() => {
    const element = record.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [conversation.items]);

  async function send() {
    const text = draft;
    setDraft("");
    following.current = true;
    const sent = await sendMessage(text);
    if (!sent) setDraft((current) => current === "" ? text : current);
  }

  async function stop() {
    const unsent = await stopRun();
    if (unsent.length > 0) setDraft((current) => [...unsent, current].filter((text) => text.trim() !== "").join("\n\n"));
  }

  const needsModel = (defaultModel.status === "ready" && defaultModel.data === null) || errorCode(conversation.sendError) === "model_required";

  return <section aria-label="辅导" className="flex min-h-0 flex-1 flex-col">
    <div className="flex justify-end px-4">
      <Button
        variant="ghost"
        // 已经是一段空的新对话时不必再开。
        disabled={!bound || running || conversation.sessionId === undefined}
        onClick={() => newConversation({ agent: TUTOR_AGENT })}
      >
        <SquarePen aria-hidden="true" />新对话
      </Button>
    </div>
    <div
      ref={record}
      tabIndex={0}
      aria-label="辅导对话记录"
      aria-busy={running}
      onScroll={() => {
        const element = record.current;
        if (element) following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
      }}
      className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      {bound && status === "loading" && <p role="status" className="text-sm text-muted-foreground">正在读取对话…</p>}
      {bound && status === "error" && <ErrorNotice title="无法读取对话" error={conversation.error} />}
      {bound && status === "ready" && items.length === 0 && !running && <p className="m-0 text-sm text-muted-foreground">
        哪里看不懂，就在这里问。
      </p>}
      {bound && items.map((item) => <ConversationItemView
        key={item.id}
        item={item}
        streaming={item.id === conversation.streaming}
        forkDisabled
        renderLink={renderLink}
      />)}
      {bound && running && conversation.streaming === undefined && <p role="status" className="mb-4 text-sm text-muted-foreground">
        {run === "stopping" ? "正在停止…" : "辅导正在思考…"}
      </p>}
    </div>
    <div className="grid gap-3 px-4 pt-2 pb-4">
      {!allowed && <p className="m-0 text-sm text-muted-foreground">复习和测验期间不能问辅导，结束后再问。</p>}
      {allowed && needsModel && <div className="grid gap-3">
        <StatusNotice status="error" title="还没有可用的模型"><p>连接一个模型提供方后才能问辅导。</p></StatusNotice>
        <div><Button asChild variant="outline"><Link to="/settings">去设置模型</Link></Button></div>
      </div>}
      {allowed && restricted && <p className="m-0 text-sm text-muted-foreground">现在不能问辅导，这条消息没有发出。</p>}
      {allowed && conversation.sendError !== undefined && errorCode(conversation.sendError) !== "model_required" && !restricted
        && <ErrorNotice title="消息没有完成" error={conversation.sendError} />}
      {allowed && <MessageComposer
        value={draft}
        onChange={setDraft}
        onSend={() => { void send(); }}
        onStop={() => { void stop(); }}
        running={running}
        stopping={run === "stopping"}
        answering={false}
        disabled={!bound || !connected || status !== "ready" || run === "sending" || run === "stopping"}
      />}
    </div>
  </section>;
}
