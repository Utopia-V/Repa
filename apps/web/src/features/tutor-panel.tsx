import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import type { RenderLink } from "@/components/ui/markdown";
import { StatusNotice } from "@/components/ui/status-notice";
import { ConversationItemView } from "@/components/domain/conversation-item";
import { ErrorNotice } from "@/components/domain/error-notice";
import { MessageComposer } from "@/components/domain/message-composer";
import { useAppStore } from "@/hooks/use-app-store";
import { errorCode } from "@/lib/errors";
import { TUTOR_AGENT } from "@/lib/learning";

/**
 * 辅导对话，绑定当前任务：每个任务一个 learning-tutor 会话，换任务就换会话，旧会话仍在会话列表里。
 * 辅导看到的当前任务来自后端的 view，前端不往消息里拼题目。复习和测验期间不能辅导，输入框收起。
 */
export function TutorPanel({ space, taskId, allowed, renderLink }: {
  space: string;
  taskId: string;
  allowed: boolean;
  renderLink: RenderLink;
}) {
  const conversation = useAppStore((state) => state.conversation);
  const connected = useAppStore((state) => state.connected);
  const sessionId = useAppStore((state) => state.tutorSessions[`${space}\n${taskId}`]);
  const sessions = useAppStore((state) => state.resources.sessions);
  const loadSessions = useAppStore((state) => state.loadSessions);
  const openSession = useAppStore((state) => state.openSession);
  const newConversation = useAppStore((state) => state.newConversation);
  const sendMessage = useAppStore((state) => state.sendMessage);
  const stopRun = useAppStore((state) => state.stopRun);
  const defaultModel = useAppStore((state) => state.resources.defaultModel);
  const loadModelSettings = useAppStore((state) => state.loadModelSettings);
  const [draft, setDraft] = useState("");
  const record = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const bound = sessionId !== undefined ? conversation.sessionId === sessionId : conversation.learningTask === taskId;

  useEffect(() => {
    void loadModelSettings();
  }, [loadModelSettings]);

  useEffect(() => {
    if (sessions.status === "idle") void loadSessions();
  }, [sessions.status, loadSessions]);

  // 把对话换成这个任务的会话；运行中不换，等这一轮结束。会话列表还没读到时先等它。
  useEffect(() => {
    if (bound || conversation.run !== "idle") return;
    if (sessionId === undefined) {
      newConversation({ agent: TUTOR_AGENT, learningTask: taskId });
      return;
    }
    const session = sessions.data?.find((candidate) => candidate.id === sessionId);
    if (session) void openSession(session);
    // 记下的会话已经不在了（例如空间换到另一台设备后被删掉），为这个任务重新开一个。
    else if (sessions.status === "ready") newConversation({ agent: TUTOR_AGENT, learningTask: taskId });
  }, [bound, conversation.run, sessionId, sessions.data, sessions.status, taskId, newConversation, openSession]);

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

  const { run, status, items } = conversation;
  const running = run !== "idle";
  const needsModel = (defaultModel.status === "ready" && defaultModel.data === null) || errorCode(conversation.sendError) === "model_required";

  return <section aria-label="辅导" className="flex min-h-0 flex-1 flex-col">
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
      {allowed && conversation.sendError !== undefined && errorCode(conversation.sendError) !== "model_required"
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
