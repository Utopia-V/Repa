import { useState } from "react";
import type { ModelRef, Result } from "@repa/base/protocol";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SearchInput } from "@/components/ui/search-input";
import { SelectionButton } from "@/components/ui/selection-button";
import { ErrorNotice } from "@/components/domain/error-notice";
import { useAppStore } from "@/hooks/use-app-store";

type Model = Result<"model.list">[number];

type ModelDialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** 只包含可用的模型。 */
  models: Model[];
  providerNames: Map<string, string>;
  current: ModelRef | null | undefined;
};

/** 从已连接提供方的模型里选默认模型。 */
export function DefaultModelDialog(props: ModelDialogProps) {
  const setDefaultModel = useAppStore((state) => state.setDefaultModel);
  return <ModelDialog {...props} title="选择默认模型" description="新会话使用这个模型。" onChoose={setDefaultModel} />;
}

/** 给当前会话换模型；不改默认模型。 */
export function ConversationModelDialog(props: ModelDialogProps & { started: boolean }) {
  const { started, ...rest } = props;
  const setConversationModel = useAppStore((state) => state.setConversationModel);
  return <ModelDialog
    {...rest}
    title="选择这个会话的模型"
    description={started ? "之后的消息用这个模型回答，不改默认模型。" : "这个新会话用它开始，不改默认模型。"}
    onChoose={setConversationModel}
  />;
}

/** 一个提供方可能有几百个模型，所以用搜索加列表。 */
function ModelDialog({ open, onOpenChange, models, providerNames, current, title, description, onChoose }: ModelDialogProps & {
  title: string;
  description: string;
  onChoose(model: ModelRef): Promise<void>;
}) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      {/* 列表随对话框打开挂载，每次打开时搜索从空开始。 */}
      <ModelList models={models} providerNames={providerNames} current={current} onChoose={onChoose} onChosen={() => onOpenChange(false)} />
    </DialogContent>
  </Dialog>;
}

function ModelList({ models, providerNames, current, onChoose, onChosen }: {
  models: Model[];
  providerNames: Map<string, string>;
  current: ModelRef | null | undefined;
  onChoose(model: ModelRef): Promise<void>;
  onChosen(): void;
}) {
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState<string>();
  const [error, setError] = useState<unknown>();
  const keyword = query.trim().toLowerCase();
  const matched = models.filter((model) => !keyword
    || model.name.toLowerCase().includes(keyword)
    || model.id.toLowerCase().includes(keyword)
    || (providerNames.get(model.provider) ?? model.provider).toLowerCase().includes(keyword));

  async function choose(model: Model) {
    const key = `${model.provider}/${model.id}`;
    setSaving(key);
    setError(undefined);
    try {
      await onChoose({ provider: model.provider, id: model.id });
      onChosen();
    } catch (failure) {
      setError(failure);
    } finally {
      setSaving(undefined);
    }
  }

  return <div className="grid min-w-0 gap-3">
    <SearchInput label="搜索模型" value={query} onChange={(event) => setQuery(event.target.value)} onClear={() => setQuery("")} />
    {error !== undefined && <ErrorNotice title="没有设置成功" error={error} />}
    {matched.length === 0
      ? <p className="text-sm text-muted-foreground">没有找到匹配的模型。</p>
      : <ul aria-label="可用模型" className="m-0 grid max-h-80 list-none gap-1 overflow-y-auto p-0">
        {matched.map((model) => {
          const key = `${model.provider}/${model.id}`;
          return <li key={key}>
            <SelectionButton
              className="w-full"
              selected={current?.provider === model.provider && current.id === model.id}
              disabled={saving !== undefined}
              aria-busy={saving === key}
              onClick={() => { void choose(model); }}
            >
              <span className="grid min-w-0 text-left">
                <span className="break-all">{model.name}</span>
                <span className="text-xs font-normal break-all text-muted-foreground">
                  {saving === key ? "正在保存…" : providerNames.get(model.provider) ?? model.provider}
                </span>
              </span>
            </SelectionButton>
          </li>;
        })}
      </ul>}
  </div>;
}
