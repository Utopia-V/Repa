import { useEffect, useId, useState } from "react";
import { Link } from "react-router";
import { CircleAlert, FileText, Plus } from "lucide-react";
import { MATERIAL_EXTENSIONS, type Material } from "@repa/materials/protocol";

import { Button } from "@/components/ui/button";
import { StatusNotice } from "@/components/ui/status-notice";
import { Textarea } from "@/components/ui/textarea";
import { ErrorNotice } from "@/components/domain/error-notice";
import { FilePickerDialog } from "@/features/file-picker";
import { useAppStore, useAppStoreApi } from "@/hooks/use-app-store";
import { t } from "@/lib/strings";

/** 文件名：materials/ 下的路径去掉前面的 materials/。 */
function fileName(path: string): string {
  return path.replace(/^materials\//u, "");
}

/** 页数、张数或段数；文字文件没有页数。 */
function partsText(file: Extract<Material, { status: "text" }>): string {
  if (file.format === "pdf") return t("making.materials.pages.label", { count: file.parts });
  if (file.format === "pptx" || file.format === "ppt") return t("making.materials.slides.label", { count: file.parts });
  return t("making.materials.paragraphs.label", { count: file.parts });
}

/**
 * 还没有选定课的空间里学习页的起点：materials/ 里的课件、添加课件、要求，和“开始”；有随包的课时另有一个改学它的次要动作。
 * 有课件时要求可以不填；没有课件时写了想学什么也能开始，Agent 先问清需求、到网上找资料。
 * 开始以后由做课的对话接手，这一块随做课的状态换成轮廓；按钮在运行结束前不再可用。
 */
export function MakingStart({ onStarted, onUseBundled }: {
  onStarted(): void;
  /** 空间里有随包的课时给出：没有课件的学习者改学它，起点随之让开。 */
  onUseBundled?: (() => void) | undefined;
}) {
  const listMaterials = useAppStore((state) => state.listMaterials);
  const addMaterials = useAppStore((state) => state.addMaterials);
  const startMaking = useAppStore((state) => state.startMaking);
  const run = useAppStore((state) => state.conversation.run);
  const defaultModel = useAppStore((state) => state.resources.defaultModel);
  const loadModelSettings = useAppStore((state) => state.loadModelSettings);
  const [files, setFiles] = useState<Material[]>();
  const [listError, setListError] = useState<unknown>();
  const [picking, setPicking] = useState(false);
  const [request, setRequest] = useState("");
  const [startError, setStartError] = useState<unknown>();
  const requestId = useId();
  const store = useAppStoreApi();

  useEffect(() => {
    listMaterials().then((result) => setFiles(result.files), setListError);
  }, [listMaterials]);

  useEffect(() => {
    void loadModelSettings();
  }, [loadModelSettings]);

  const noModel = defaultModel.status === "ready" && defaultModel.data === null;
  const hasMaterials = files !== undefined && files.length > 0;
  const canStart = files !== undefined && (hasMaterials || request.trim() !== "");

  async function start() {
    setStartError(undefined);
    onStarted();
    const sent = await startMaking(request, hasMaterials);
    // 会话建好、第一条消息发出以后，页面已经换成做课的对话；没发出去时错误留在这里，要求也还在。
    if (!sent) setStartError(store.getState().conversation.sendError);
  }

  return <div className="grid gap-8">
    <section aria-labelledby="making-materials-title" className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <h3 id="making-materials-title" className="m-0 text-title weight-semibold">{t("making.materials.title")}</h3>
        <Button variant="tertiary" leadingIcon={Plus} onClick={() => setPicking(true)}>{t("making.materials.add.action")}</Button>
      </div>
      {listError !== undefined && <ErrorNotice title={t("making.materials.load.error")} error={listError} />}
      {files === undefined && listError === undefined && <p role="status" className="m-0 text-body text-muted-foreground">{t("common.loading.status")}</p>}
      {files?.length === 0 && <p className="m-0 text-body text-muted-foreground">{t("making.materials.empty")}</p>}
      {files && files.length > 0 && <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3 p-0">
        {files.map((file) => <li key={file.path} className="grid content-between gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground">
          <span className="text-body break-all">{fileName(file.path)}</span>
          {file.status === "failed"
            ? <span className="flex items-start gap-1 text-caption text-destructive">
              <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{file.message}
            </span>
            : <span className="flex items-center gap-1 text-caption text-muted-foreground tabular-nums">
              <FileText aria-hidden="true" className="size-4 shrink-0" />
              {file.status === "text" ? partsText(file) : t("making.materials.plain.label")}
            </span>}
        </li>)}
      </ul>}
    </section>

    <div className="grid gap-2">
      <label htmlFor={requestId} className="text-body weight-semibold">{t(files?.length === 0 ? "making.request.wish.label" : "making.request.label")}</label>
      <Textarea id={requestId} rows={3} value={request} onChange={(event) => setRequest(event.target.value)} />
    </div>

    {noModel && <div className="grid gap-3">
      <StatusNotice status="error" title={t("common.noModel.title")}><p>{t("making.noModel.description")}</p></StatusNotice>
      <div><Button asChild variant="tertiary"><Link to="/settings">{t("common.setupModel.action")}</Link></Button></div>
    </div>}
    {startError !== undefined && <ErrorNotice title={t("making.start.error")} error={startError} />}
    <div className="flex flex-wrap items-center gap-3">
      <Button disabled={noModel || !canStart || run !== "idle"} onClick={() => { void start(); }}>{t("making.start.action")}</Button>
      {onUseBundled && <Button variant="ghost" disabled={run !== "idle"} onClick={onUseBundled}>{t("making.useBundled.action")}</Button>}
    </div>

    <FilePickerDialog
      open={picking}
      onOpenChange={setPicking}
      extensions={MATERIAL_EXTENSIONS}
      onPick={async (paths) => setFiles((await addMaterials(paths)).files)}
    />
  </div>;
}
