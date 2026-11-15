import { useEffect, useId, useState, type FormEvent } from "react";
import { RefreshCw } from "lucide-react";
import type { Result } from "@repa/base/protocol";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { StatusNotice } from "@/components/ui/status-notice";
import { ErrorNotice } from "@/components/domain/error-notice";
import { useAppStore } from "@/hooks/use-app-store";
import { errorCode } from "@/lib/errors";
import { dateTime } from "@/lib/format";
import type { BackupSettings } from "@/lib/store";
import { t } from "@/lib/strings";

// 与后端的设置 schema 一致：间隔 5 至 1440 分钟，保留 1 至 100 份。
const INTERVAL = { min: 5, max: 1440 } as const;
const KEEP = { min: 1, max: 100 } as const;

/**
 * 设置页的备份：当前空间最近一次备份成功的时间、上一次失败的原因和立即备份，以及检查间隔与保留份数。
 * 平时只是一行状态；状态随 backup.updated 更新，不另外提示。
 */
export function BackupSection() {
  const space = useAppStore((state) => state.space);
  return <section aria-labelledby="backup-settings" className="grid gap-3">
    <h3 id="backup-settings" className="text-title weight-semibold">{t("settings.backup.title")}</h3>
    {space !== undefined && <BackupStatusCard />}
    <BackupSettingsForm />
  </section>;
}

function BackupStatusCard() {
  const status = useAppStore((state) => state.resources.backupStatus);
  const loadBackupStatus = useAppStore((state) => state.loadBackupStatus);
  const createBackup = useAppStore((state) => state.createBackup);
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<Result<"backup.create">>();
  const [failure, setFailure] = useState<unknown>();

  useEffect(() => {
    void loadBackupStatus();
  }, [loadBackupStatus]);

  async function backupNow() {
    setCreating(true);
    setResult(undefined);
    setFailure(undefined);
    try {
      setResult(await createBackup());
    } catch (error) {
      // backup_failed 的原因已记进备份状态，下面的状态里会显示；其余错误（例如连接中断）在这里显示。
      if (errorCode(error) !== "backup_failed") setFailure(error);
    } finally {
      setCreating(false);
    }
  }

  const data = status.data;
  if (data === undefined) {
    return status.status === "error"
      ? <div className="grid gap-3">
        <ErrorNotice title={t("settings.backup.status.load.error")} error={status.error} />
        <div><Button variant="tertiary" onClick={() => { void loadBackupStatus(); }} leadingIcon={RefreshCw}>{t("common.retry.action")}</Button></div>
      </div>
      : <p role="status" className="text-body text-muted-foreground">{t("common.loading.status")}</p>;
  }
  return <div className="grid gap-3">
    <Card className="flex-row flex-wrap items-center justify-between">
      <span role="status" className="text-body">
        {data?.lastSuccess ? t("settings.backup.lastSuccess.status", { time: dateTime(data.lastSuccess) }) : t("settings.backup.none.status")}
        {/* 没有变化时最近一份就是刚才检查的结果；之后有了新的备份，这句话不再适用。 */}
        {result?.created === false && result.backup.createdAt === data?.lastSuccess && t("settings.backup.unchanged.status")}
      </span>
      <Button variant="tertiary" disabled={creating || data === null} aria-busy={creating} onClick={() => { void backupNow(); }}>
        {creating ? t("settings.backup.now.running.status") : t("settings.backup.now.action")}
      </Button>
    </Card>
    {data?.failure && <StatusNotice status="error" title={t("settings.backup.failure.title", { time: dateTime(data.failure.at) })}>
      <p>{data.failure.message}</p>
    </StatusNotice>}
    {failure !== undefined && <ErrorNotice title={t("settings.backup.now.error")} error={failure} />}
  </div>;
}

/** 检查间隔与保留份数。改了才能保存；超出范围时标出那一项，不发给后端。 */
function BackupSettingsForm() {
  const settings = useAppStore((state) => state.resources.backupSettings);
  const loadBackupSettings = useAppStore((state) => state.loadBackupSettings);

  useEffect(() => {
    void loadBackupSettings();
  }, [loadBackupSettings]);

  if (settings.data === undefined) {
    return settings.status === "error"
      ? <div className="grid gap-3">
        <ErrorNotice title={t("settings.backup.load.error")} error={settings.error} />
        <div><Button variant="tertiary" onClick={() => { void loadBackupSettings(); }} leadingIcon={RefreshCw}>{t("common.retry.action")}</Button></div>
      </div>
      : <p role="status" className="text-body text-muted-foreground">{t("common.loading.status")}</p>;
  }
  // 保存以后换成后端返回的设置，表单从新的值重新开始。
  return <SettingsFields key={`${settings.data.intervalMinutes}:${settings.data.keep}`} saved={settings.data} />;
}

function SettingsFields({ saved }: { saved: BackupSettings }) {
  const saveBackupSettings = useAppStore((state) => state.saveBackupSettings);
  const [interval, setIntervalText] = useState(String(saved.intervalMinutes));
  const [keep, setKeep] = useState(String(saved.keep));
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const intervalId = useId();
  const keepId = useId();
  const intervalErrorId = useId();
  const keepErrorId = useId();

  const intervalValue = whole(interval, INTERVAL);
  const keepValue = whole(keep, KEEP);
  const changed = intervalValue !== saved.intervalMinutes || keepValue !== saved.keep;
  const steps = { increase: t("common.increase.label"), decrease: t("common.decrease.label") };

  async function save(event: FormEvent) {
    event.preventDefault();
    if (intervalValue === undefined || keepValue === undefined) return;
    setSaving(true);
    setFailure(undefined);
    try {
      await saveBackupSettings({ intervalMinutes: intervalValue, keep: keepValue });
    } catch (error) {
      setFailure(error);
      setSaving(false);
    }
  }

  return <form className="grid gap-3" onSubmit={(event) => { void save(event); }}>
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="grid content-start gap-2">
        <label htmlFor={intervalId} className="text-body weight-semibold">{t("settings.backup.interval.label")}</label>
        <Input
          id={intervalId}
          type="number"
          inputMode="numeric"
          min={INTERVAL.min}
          max={INTERVAL.max}
          step={5}
          value={interval}
          disabled={saving}
          stepLabels={steps}
          aria-invalid={intervalValue === undefined || undefined}
          aria-describedby={intervalValue === undefined ? intervalErrorId : undefined}
          onChange={(event) => setIntervalText(event.target.value)}
        />
        {intervalValue === undefined && <p id={intervalErrorId} className="m-0 text-body text-destructive">{t("settings.backup.interval.invalid.error", INTERVAL)}</p>}
      </div>
      <div className="grid content-start gap-2">
        <label htmlFor={keepId} className="text-body weight-semibold">{t("settings.backup.keep.label")}</label>
        <Input
          id={keepId}
          type="number"
          inputMode="numeric"
          min={KEEP.min}
          max={KEEP.max}
          value={keep}
          disabled={saving}
          stepLabels={steps}
          aria-invalid={keepValue === undefined || undefined}
          aria-describedby={keepValue === undefined ? keepErrorId : undefined}
          onChange={(event) => setKeep(event.target.value)}
        />
        {keepValue === undefined && <p id={keepErrorId} className="m-0 text-body text-destructive">{t("settings.backup.keep.invalid.error", KEEP)}</p>}
      </div>
    </div>
    {failure !== undefined && <ErrorNotice title={t("settings.backup.save.error")} error={failure} />}
    {changed && <div>
      <Button type="submit" variant="tertiary" disabled={saving || intervalValue === undefined || keepValue === undefined}>
        {saving ? t("common.saving.status") : t("common.save.action")}
      </Button>
    </div>}
  </form>;
}

/** 范围内的整数；空的、带小数的或超出范围的为 undefined。 */
function whole(text: string, range: { min: number; max: number }): number | undefined {
  if (!/^\d+$/u.test(text.trim())) return undefined;
  const value = Number(text.trim());
  return value >= range.min && value <= range.max ? value : undefined;
}
