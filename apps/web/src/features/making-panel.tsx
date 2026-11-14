import { useEffect, useLayoutEffect, useRef } from "react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import { StatusNotice } from "@/components/ui/status-notice";
import { ErrorNotice } from "@/components/domain/error-notice";
import { MessageComposer } from "@/components/domain/message-composer";
import { ConversationTranscript } from "@/features/conversation-transcript";
import { useDraftSend } from "@/hooks/use-draft-send";
import { useAppStore } from "@/hooks/use-app-store";
import { errorCode } from "@/lib/errors";
import { t } from "@/lib/strings";

/**
 * 让当前会话是做课的那一段：不是时接上它，运行中不换，等这一轮结束。由学习页调用，不随抽屉开关：
 * 窄屏时抽屉关着，Agent 的提问也要落在这段会话上，抽屉打开时不能因为换会话把提问清掉。
 */
export function useMakingSession(sessionId: string | undefined): void {
  const bound = useAppStore((state) => state.conversation.sessionId === sessionId);
  const run = useAppStore((state) => state.conversation.run);
  const sessions = useAppStore((state) => state.resources.sessions);
  const loadSessions = useAppStore((state) => state.loadSessions);
  const openSession = useAppStore((state) => state.openSession);
  // 列表里找不到这段会话时只重读一次列表，避免读完仍找不到时反复读取。
  const reloadedFor = useRef<string>(undefined);

  useEffect(() => {
    if (sessionId === undefined || bound || run !== "idle") return;
    const session = sessions.data?.find((item) => item.id === sessionId);
    if (session) void openSession(session);
    // 刚建的会话可能还不在读过的列表里，重新读一次。
    else if (sessions.status !== "loading" && reloadedFor.current !== sessionId) {
      reloadedFor.current = sessionId;
      void loadSessions();
    }
  }, [bound, run, sessionId, sessions.data, sessions.status, openSession, loadSessions]);
}

/**
 * 做课的对话：学习插件记下的那一段通用 Agent 会话（building.get 的 sessionId）。学习者在这里看 Agent 在做什么、
 * 回答它的提问、随时提要求。与对话页共用会话记录的显示；接上这段会话由 useMakingSession 负责。
 */
export function MakingPanel({ sessionId }: { sessionId: string }) {
  const conversation = useAppStore((state) => state.conversation);
  const connected = useAppStore((state) => state.connected);
  const asks = useAppStore((state) => state.asks);
  const sendMessage = useAppStore((state) => state.sendMessage);
  const stopRun = useAppStore((state) => state.stopRun);
  const defaultModel = useAppStore((state) => state.resources.defaultModel);
  const loadModelSettings = useAppStore((state) => state.loadModelSettings);
  const { draft, setDraft, send: sendDraft } = useDraftSend(sendMessage);
  const record = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const bound = conversation.sessionId === sessionId;
  const { run, status, items } = conversation;
  const running = run !== "idle";
  const waiting = asks.some((ask) => ask.closed === undefined);

  useEffect(() => {
    void loadModelSettings();
  }, [loadModelSettings]);

  useLayoutEffect(() => {
    const element = record.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [conversation.items, conversation.queued, asks]);

  async function send() {
    following.current = true;
    await sendDraft();
  }

  async function stop() {
    const unsent = await stopRun();
    if (unsent.length > 0) setDraft((current) => [...unsent, current].filter((text) => text.trim() !== "").join("\n\n"));
  }

  const needsModel = (defaultModel.status === "ready" && defaultModel.data === null) || errorCode(conversation.sendError) === "model_required";

  return <section aria-label={t("making.panel.label")} className="flex min-h-0 flex-1 flex-col">
    <div
      ref={record}
      tabIndex={0}
      aria-label={t("making.transcript.label")}
      aria-busy={running}
      onScroll={() => {
        const element = record.current;
        if (element) following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
      }}
      className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      {bound && status === "loading" && <p role="status" className="text-body text-muted-foreground">{t("common.loading.status")}</p>}
      {bound && status === "error" && <ErrorNotice title={t("making.load.error")} error={conversation.error} />}
      {bound && <ConversationTranscript workingText={t("making.working.status")} />}
    </div>
    <div className="grid gap-3 px-4 pt-2 pb-4">
      {needsModel && <div className="grid gap-3">
        <StatusNotice status="error" title={t("common.noModel.title")}><p>{t("making.noModel.description")}</p></StatusNotice>
        <div><Button asChild variant="tertiary"><Link to="/settings">{t("common.setupModel.action")}</Link></Button></div>
      </div>}
      {bound && conversation.sendError !== undefined && errorCode(conversation.sendError) !== "model_required"
        && <ErrorNotice title={t("common.messageIncomplete.title")} error={conversation.sendError} />}
      <MessageComposer
        value={draft}
        onChange={setDraft}
        onSend={() => { void send(); }}
        onStop={() => { void stop(); }}
        running={running}
        stopping={run === "stopping"}
        answering={waiting}
        disabled={!bound || !connected || status !== "ready" || run === "sending" || run === "stopping"}
      />
    </div>
  </section>;
}
