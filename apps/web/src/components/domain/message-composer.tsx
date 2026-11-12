import type { KeyboardEvent, Ref } from "react";
import { ArrowUp, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupTextarea } from "@/components/ui/input-group";
import { t } from "@/lib/strings";

/**
 * 消息输入框。Enter 发送、Shift+Enter 换行；输入法确认候选词的 Enter 不发送。
 * 运行中发送按钮旁多出停止，发出的消息由调用方排队交给 Agent；有询问等待作答时，发出的话代替作答。位置和用途在对话页里不言自明，
 * 按规范的例外不显示标签，名称只提供给辅助技术。
 */
export function MessageComposer({ inputRef, value, onChange, onSend, onStop, running, stopping, answering = false, disabled }: {
  /** 页面在需要时把焦点移回输入框。 */
  inputRef?: Ref<HTMLTextAreaElement> | undefined;
  value: string;
  onChange(value: string): void;
  onSend(): void;
  onStop(): void;
  running: boolean;
  stopping: boolean;
  /** 有询问卡片等待作答，发出的话交回 Agent 代替作答。 */
  answering?: boolean;
  /** 暂时不能发送，例如未连接、会话还在读取或运行正在开始、停止。 */
  disabled: boolean;
}) {
  const canSend = !disabled && value.trim() !== "";

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    if (canSend) onSend();
  }

  // 文本框按内容定尺寸，最小宽度需要归零，长行才会在框内折行而不是撑宽页面。
  return <form
    className="min-w-0"
    onSubmit={(event) => {
      event.preventDefault();
      if (canSend) onSend();
    }}
  >
    <InputGroup>
      <InputGroupTextarea
        ref={inputRef}
        aria-label={t("conversation.composer.label")}
        className="max-h-[min(15rem,35dvh)]"
        value={value}
        placeholder={answering ? t("conversation.composer.replyInstead.placeholder") : t("conversation.composer.placeholder")}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <InputGroupAddon className="self-end">
        {running && <Button variant="tertiary" size="icon" aria-label={stopping ? t("conversation.composer.stopping.status") : t("conversation.composer.stop.action")} title={stopping ? t("conversation.composer.stopping.status") : t("conversation.composer.stop.action")} disabled={stopping} onClick={onStop}>
          <Square aria-hidden="true" />
        </Button>}
        <Button size="icon" type="submit" aria-label={t("conversation.composer.send.label")} title={answering ? t("conversation.composer.sendInstead.hint") : running ? t("conversation.composer.sendQueued.hint") : t("conversation.composer.send.label")} disabled={!canSend}>
          <ArrowUp aria-hidden="true" />
        </Button>
      </InputGroupAddon>
    </InputGroup>
  </form>;
}
