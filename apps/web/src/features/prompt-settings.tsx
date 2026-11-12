import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Eye, RefreshCw } from "lucide-react";
import type { PromptOverride, PromptSection, Result } from "@repa/base/protocol";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ErrorNotice } from "@/components/domain/error-notice";
import { useAppStore } from "@/hooks/use-app-store";
import { folderName } from "@/lib/paths";
import { promptLevels, promptSource } from "@/lib/prompts";
import type { PromptScope } from "@/lib/store";
import { t } from "@/lib/strings";

/**
 * 提示装配：按装配顺序列出各段，可以启停、编辑、恢复，并预览下一条消息会带上的内容。
 * 各段由打开的空间和其中的插件决定，没有打开空间时只给出入口。
 */
export function PromptSettingsSection() {
  const space = useAppStore((state) => state.space);
  const [previewing, setPreviewing] = useState(false);

  return <section aria-labelledby="prompts" className="grid gap-3">
    <div className="flex items-center justify-between gap-3">
      <h3 id="prompts" className="text-title weight-semibold">{t("promptSettings.section.title")}</h3>
      {space && <Button variant="tertiary" onClick={() => setPreviewing(true)} leadingIcon={Eye}>{t("promptSettings.preview.action")}
      </Button>}
    </div>
    {space
      ? <PromptList space={space} />
      : <Card className="flex-row items-center justify-between">
        <p className="text-body text-muted-foreground">{t("promptSettings.noSpace.description")}</p>
        <Button asChild variant="tertiary"><Link to="/learning-space">{t("promptSettings.chooseSpace.action")}</Link></Button>
      </Card>}
    {space && <PromptPreviewDialog open={previewing} onOpenChange={setPreviewing} />}
  </section>;
}

function PromptList({ space }: { space: string }) {
  const prompts = useAppStore((state) => state.resources.prompts);
  const loadPrompts = useAppStore((state) => state.loadPrompts);
  const savePrompt = useAppStore((state) => state.savePrompt);
  const [editing, setEditing] = useState<PromptSection>();
  const [toggling, setToggling] = useState<string>();
  const [toggleFailure, setToggleFailure] = useState<{ id: string; error: unknown }>();

  // 每次进入都重新读取：AGENTS.md 和 Skill 文件夹可能在 Repa 之外改过。
  useEffect(() => {
    void loadPrompts();
  }, [loadPrompts]);

  const data = prompts.data;

  /** 列表里的开关只写本空间这一级，保留这一级已有的文字覆盖。 */
  async function toggle(section: PromptSection, enabled: boolean) {
    const levels = promptLevels(section, data?.app[section.id]);
    const next: PromptOverride = { ...levels.space };
    if (enabled === levels.inherited.enabled) delete next.enabled;
    else next.enabled = enabled;
    setToggling(section.id);
    setToggleFailure(undefined);
    try {
      await savePrompt("space", section.id, next);
    } catch (error) {
      setToggleFailure({ id: section.id, error });
    } finally {
      setToggling(undefined);
    }
  }

  if (!data) {
    if (prompts.status === "error") return <div className="grid gap-3">
      <ErrorNotice title={t("promptSettings.list.error")} error={prompts.error} />
      <div>
        <Button variant="tertiary" onClick={() => { void loadPrompts(); }} leadingIcon={RefreshCw}>{t("common.retry.action")}
        </Button>
      </div>
    </div>;
    return <p role="status" className="text-body text-muted-foreground">{t("common.loading.status")}</p>;
  }

  return <>
    <p className="text-body text-muted-foreground">
      {t("promptSettings.list.description")}
    </p>
    {toggleFailure && <ErrorNotice
      title={t("promptSettings.toggle.error", { value: data.sections.find((section) => section.id === toggleFailure.id)?.enabled ? t("promptSettings.disable.label") : t("promptSettings.enable.label"), name: promptSource(toggleFailure.id, space).name })}
      error={toggleFailure.error}
    />}
    <ol aria-labelledby="prompts" className="m-0 grid list-none gap-2 p-0">
      {data.sections.map((section) => {
        const { name, source } = promptSource(section.id, space);
        return <li key={section.id}>
          <Card className="flex-row items-center gap-3">
            <div className="grid min-w-0 flex-1 gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className={section.enabled ? "weight-semibold break-all" : "weight-semibold break-all text-muted-foreground"}>{name}</span>
                {section.text !== section.defaultText && <Badge variant="solid" color="gray">{t("promptSettings.modified.status")}</Badge>}
                {!section.enabled && <Badge variant="dot" color="gray">{t("promptSettings.disabled.status")}</Badge>}
              </div>
              {source && <span className="text-body text-muted-foreground">{source}</span>}
            </div>
            <Switch
              label={t("promptSettings.enable.action", { name })}
              className="[&>span:last-child]:sr-only"
              checked={section.enabled}
              disabled={toggling !== undefined}
              onToggle={() => { void toggle(section, !section.enabled); }}
            />
            <Button variant="ghost" aria-label={t("promptSettings.edit.label", { name })} onClick={() => setEditing(section)}>{t("promptSettings.edit.action")}</Button>
          </Card>
        </li>;
      })}
    </ol>
    <Dialog open={editing !== undefined} onOpenChange={(open) => { if (!open) setEditing(undefined); }}>
      {editing && <PromptEditor
        key={editing.id}
        section={editing}
        app={data.app[editing.id]}
        space={space}
        onDone={() => setEditing(undefined)}
      />}
    </Dialog>
  </>;
}

function PromptEditor({ section, app, space, onDone }: {
  section: PromptSection;
  app: PromptOverride | undefined;
  space: string;
  onDone(): void;
}) {
  const savePrompt = useAppStore((state) => state.savePrompt);
  const { name, generatedNote } = promptSource(section.id, space);
  const levels = promptLevels(section, app);
  const [scope, setScope] = useState<PromptScope>("space");
  // 两级各自的草稿：切换保存位置时显示那一级当前的内容，不把一级的内容带到另一级。
  const [drafts, setDrafts] = useState({ space: section.text, app: levels.app.text ?? section.defaultText });
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<unknown>();

  // 本空间这一级的上一级是所有空间，所有空间的上一级是默认内容。
  const base = scope === "space" ? levels.inherited.text : section.defaultText;
  const current = levels[scope];
  const resetLabel = scope === "space" && levels.app.text !== undefined ? t("promptSettings.editor.revertAll.action") : t("promptSettings.editor.restore.action");

  async function save(text: string | undefined) {
    const override: PromptOverride = { ...current };
    if (text === undefined || text === base) delete override.text;
    else override.text = text;
    setSaving(true);
    setFailure(undefined);
    try {
      await savePrompt(scope, section.id, override);
      onDone();
    } catch (error) {
      setFailure(error);
    } finally {
      setSaving(false);
    }
  }

  return <DialogContent>
    <DialogHeader>
      <DialogTitle>{t("promptSettings.edit.label", { name })}</DialogTitle>
      <DialogDescription>{t("promptSettings.editor.description")}</DialogDescription>
    </DialogHeader>
    {generatedNote && <p className="text-body text-muted-foreground">{generatedNote}</p>}
    <div className="grid gap-2">
      <span id="prompt-scope" className="text-body weight-semibold">{t("promptSettings.editor.saveTo.label")}</span>
      <RadioGroup aria-labelledby="prompt-scope" value={scope} onValueChange={(value) => setScope(value as PromptScope)} disabled={saving}>
        <div className="flex items-center gap-3">
          <RadioGroupItem id="prompt-scope-space" value="space" />
          <label htmlFor="prompt-scope-space" className="text-body">{t("promptSettings.editor.thisSpace.label", { space: folderName(space) })}</label>
        </div>
        <div className="flex items-center gap-3">
          <RadioGroupItem id="prompt-scope-app" value="app" />
          <label htmlFor="prompt-scope-app" className="text-body">{t("promptSettings.editor.allSpaces.label")}</label>
        </div>
      </RadioGroup>
    </div>
    {scope === "app" && levels.space.text !== undefined && <p className="text-body text-muted-foreground">
      {t("promptSettings.editor.override.hint")}
    </p>}
    <div className="grid gap-2">
      <label htmlFor="prompt-text" className="text-body weight-semibold">{t("promptSettings.editor.content.label")}</label>
      <Textarea
        id="prompt-text"
        className="max-h-80 min-h-40 font-mono"
        value={drafts[scope]}
        disabled={saving}
        onChange={(event) => { const text = event.target.value; setDrafts((value) => ({ ...value, [scope]: text })); }}
      />
      <div>
        <Button variant="ghost" disabled={saving || current.text === undefined} onClick={() => { void save(undefined); }} leadingIcon={RefreshCw}>{resetLabel}
        </Button>
      </div>
    </div>
    {failure !== undefined && <ErrorNotice title={t("promptSettings.editor.save.error")} error={failure} />}
    <DialogFooter>
      <Button variant="tertiary" onClick={onDone}>{t("common.cancel.action")}</Button>
      <Button disabled={saving} aria-busy={saving} onClick={() => { void save(drafts[scope]); }}>{t("common.save.action")}</Button>
    </DialogFooter>
  </DialogContent>;
}

type Preview = Result<"prompt.preview">;

function PromptPreviewDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const previewPrompts = useAppStore((state) => state.previewPrompts);
  const space = useAppStore((state) => state.space);
  const [preview, setPreview] = useState<{ status: "loading" } | { status: "ready"; data: Preview } | { status: "error"; error: unknown }>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  // 每次打开都按当时的配置重新计算。
  useEffect(() => {
    if (!open) return;
    let active = true;
    setPreview({ status: "loading" });
    previewPrompts().then(
      (data) => { if (active) setPreview({ status: "ready", data }); },
      (error: unknown) => { if (active) setPreview({ status: "error", error }); },
    );
    return () => { active = false; };
  }, [open, attempt, previewPrompts]);

  let position = 0;
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{t("promptSettings.preview.title")}</DialogTitle>
        <DialogDescription>{t("promptSettings.preview.description")}</DialogDescription>
      </DialogHeader>
      {preview.status === "loading" && <p role="status" className="text-body text-muted-foreground">{t("promptSettings.preview.loading.status")}</p>}
      {preview.status === "error" && <div className="grid gap-3">
        <ErrorNotice title={t("promptSettings.preview.error")} error={preview.error} />
        <div>
          <Button variant="tertiary" onClick={() => setAttempt((value) => value + 1)} leadingIcon={RefreshCw}>{t("common.retry.action")}
          </Button>
        </div>
      </div>}
      {preview.status === "ready" && <>
        <section aria-labelledby="preview-system" className="grid gap-2">
          <h3 id="preview-system" className="text-title weight-semibold">{t("promptSettings.preview.system.title")}</h3>
          <ol className="m-0 grid list-none gap-2 p-0">
            {preview.data.sections.map((section) => {
              const name = promptSource(section.id, space ?? "").name;
              if (!section.enabled) return <li key={section.id} className="text-body text-muted-foreground">{t("promptSettings.preview.disabled.status", { name })}</li>;
              position += 1;
              return <li key={section.id} className="grid gap-1">
                <span className="text-body weight-semibold">{position} · {name}</span>
                {section.text
                  ? <PreviewText text={section.text} />
                  : <p className="text-body text-muted-foreground">{t("promptSettings.preview.empty")}</p>}
              </li>;
            })}
          </ol>
        </section>
        <section aria-labelledby="preview-views" className="grid gap-2">
          <div className="grid gap-1">
            <h3 id="preview-views" className="text-title weight-semibold">{t("promptSettings.preview.runtime.title")}</h3>
            <p className="text-body text-muted-foreground">{t("promptSettings.preview.runtime.description")}</p>
          </div>
          {preview.data.views.length === 0
            ? <p className="text-body text-muted-foreground">{t("promptSettings.preview.runtime.empty")}</p>
            : <ul className="m-0 grid list-none gap-2 p-0">
              {preview.data.views.map((view) => <li key={view.id} className="grid gap-1">
                <span className="text-body weight-semibold">{view.id}</span>
                <PreviewText text={view.text} />
              </li>)}
            </ul>}
        </section>
      </>}
    </DialogContent>
  </Dialog>;
}

function PreviewText({ text }: { text: string }) {
  return <pre className="m-0 max-h-60 overflow-auto rounded-lg border border-border bg-surface-inset p-3 font-mono text-[length:var(--type-code-size)] leading-[var(--type-code-line)] whitespace-pre-wrap break-all">
    {text}
  </pre>;
}
