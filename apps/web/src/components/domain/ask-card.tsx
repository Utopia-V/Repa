import { useId, useState } from "react";
import { CircleAlert, CircleCheck, CircleHelp, CircleX, MessageCircle } from "lucide-react";
import type { ItemResponse } from "@repa/base/protocol";

import { Button } from "@/components/ui/button";
import { ErrorNotice } from "@/components/domain/error-notice";
import { buildResponse, emptyDraft, ItemSlots, SlotProblems } from "@/components/domain/item-form";
import { Content, type Draft } from "@/components/domain/item-parts";
import { answerText, slotName } from "@/lib/ask";
import type { Ask } from "@/lib/store";

const endedText = {
  cancelled: "你关闭了这次提问",
  aborted: "提问已结束：运行停止了",
  closed: "提问已结束：空间关闭了",
  disconnected: "提问已结束：连接中断了",
  unsupported: "这次提问没能在界面上显示",
  answered: "提问已结束",
} as const;

/**
 * 对话里的一次询问。等待作答时是一张可以提交、关闭的卡片；交了以后收起成问题和回答，
 * 后端接受时附了说明就显示在下面；在输入框里回了一句话时显示这句话；其他方式结束时只留一行说明。
 */
export function AskCard({ ask, onSubmit, onCancel }: {
  ask: Ask;
  onSubmit(response: ItemResponse): void;
  onCancel(): void;
}) {
  const { item } = ask.request;
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(item));
  const base = useId();
  const titleId = `${base}-title`;

  if (ask.closed !== undefined) {
    if (ask.declined !== undefined) {
      return <section aria-labelledby={titleId} className="mb-4 grid gap-2 rounded-md border border-border bg-card p-5 text-card-foreground">
        <h3 id={titleId} className="m-0 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          <MessageCircle aria-hidden="true" className="size-4 shrink-0" />你没有按卡片作答，回了一句话
        </h3>
        <p className="m-0 text-sm break-words whitespace-pre-wrap">{ask.declined}</p>
      </section>;
    }
    if (ask.response) {
      return <section aria-labelledby={titleId} className="mb-4 grid gap-3 rounded-md border border-border bg-card p-5 text-card-foreground">
        <h3 id={titleId} className="m-0 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          <CircleCheck aria-hidden="true" className="size-4 shrink-0" />你回答了 Agent 的提问
        </h3>
        <dl className="m-0 grid gap-2 text-sm">
          {item.slots.map((slot, index) => <div key={slot.id} className="grid gap-0.5">
            {/* 回看时题面比短标签清楚。 */}
            <dt className="text-muted-foreground">{slot.prompt && slot.prompt.length > 0 ? <Content blocks={slot.prompt} /> : slotName(slot, index)}</dt>
            <dd className="m-0 break-words whitespace-pre-wrap">{answerText(slot, ask.response?.answers[slot.id])}</dd>
          </div>)}
        </dl>
        <Content blocks={ask.message} className="text-sm" />
      </section>;
    }
    const Icon = ask.closed === "cancelled" ? CircleX : CircleAlert;
    return <p className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
      <Icon aria-hidden="true" className="size-4 shrink-0" />{endedText[ask.closed]}
    </p>;
  }

  const general = ask.problems.filter((problem) => problem.slot === undefined || !item.slots.some((slot) => slot.id === problem.slot));

  return <section aria-labelledby={titleId} className="mb-4 grid gap-5 rounded-md border border-border-selected bg-card p-5 text-card-foreground">
    <div className="flex items-center justify-between gap-3">
      <h3 id={titleId} className="m-0 flex items-center gap-2 text-base font-semibold">
        <CircleHelp aria-hidden="true" className="size-5 shrink-0 text-primary" />{item.title ?? "Agent 想问你"}
      </h3>
      <Button variant="ghost" size="icon" aria-label="关闭提问" title="关闭提问，不作答" onClick={onCancel}>
        <CircleX aria-hidden="true" />
      </Button>
    </div>
    <Content blocks={item.body} />
    <ItemSlots item={item} draft={draft} onChange={setDraft} problems={ask.problems} disabled={ask.submitting} />
    <SlotProblems id={`${base}-problems`} problems={general} />
    {ask.error !== undefined && <ErrorNotice title="没能送出" error={ask.error} />}
    <p className="m-0 text-sm text-muted-foreground">不想按卡片答，也可以在下面的输入框里直接回一句。</p>
    <div className="flex flex-wrap items-center justify-end gap-3">
      <Button disabled={ask.submitting} onClick={() => onSubmit(buildResponse(item, draft))}>
        {ask.submitting ? "正在提交…" : "提交"}
      </Button>
    </div>
  </section>;
}
