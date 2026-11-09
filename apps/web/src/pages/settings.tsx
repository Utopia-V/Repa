import { useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";

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
import { ErrorNotice } from "@/components/domain/error-notice";
import { DefaultModelDialog } from "@/features/model-picker";
import { PromptSettingsSection } from "@/features/prompt-settings";
import { ProviderConnectDialog } from "@/features/provider-connect";
import { useAppStore } from "@/hooks/use-app-store";
import type { CommandPolicy } from "@/lib/store";
import { t } from "@/lib/strings";

const authLabel = { api_key: "API key", oauth: t("settings.provider.oauth.label") } as const;

export function SettingsPage() {
  const providers = useAppStore((state) => state.resources.providers);
  const models = useAppStore((state) => state.resources.models);
  const defaultModel = useAppStore((state) => state.resources.defaultModel);
  const loadModelSettings = useAppStore((state) => state.loadModelSettings);
  const logout = useAppStore((state) => state.logout);
  const [connecting, setConnecting] = useState(false);
  const [picking, setPicking] = useState(false);
  const [removing, setRemoving] = useState<string>();
  const [failure, setFailure] = useState<{ provider: string; error: unknown }>();

  useEffect(() => {
    void loadModelSettings();
  }, [loadModelSettings]);

  const providerNames = useMemo(
    () => new Map((providers.data ?? []).map((provider) => [provider.id, provider.name])),
    [providers.data],
  );
  const available = useMemo(() => (models.data ?? []).filter((model) => model.available), [models.data]);
  const connected = (providers.data ?? []).filter((provider) => provider.configured);

  const loadError = [providers, models, defaultModel].find((resource) => resource.status === "error")?.error;
  const loaded = providers.data !== undefined && models.data !== undefined && defaultModel.data !== undefined;

  async function disconnect(provider: string) {
    setRemoving(provider);
    setFailure(undefined);
    try {
      await logout(provider);
    } catch (error) {
      setFailure({ provider, error });
    } finally {
      setRemoving(undefined);
    }
  }

  const current = defaultModel.data;
  const currentModel = current && models.data?.find((model) => model.provider === current.provider && model.id === current.id);
  const currentProvider = current && providers.data?.find((provider) => provider.id === current.provider);

  return <div className="mx-auto grid w-full max-w-xl gap-8 px-4 py-16 md:px-8">
    <header className="grid gap-2">
      <h2 className="text-display weight-semibold">{t("settings.page.title")}</h2>
      <p className="text-body text-muted-foreground">{t("settings.page.description")}</p>
    </header>

    {!loaded && loadError === undefined && <p role="status" className="text-body text-muted-foreground">{t("common.loading.status")}</p>}
    {loadError !== undefined && <div className="grid gap-3">
      <ErrorNotice title={t("settings.load.error")} error={loadError} />
      <div>
        <Button variant="tertiary" onClick={() => { void loadModelSettings(); }} leadingIcon={RefreshCw}>{t("common.retry.action")}
        </Button>
      </div>
    </div>}

    {loaded && <>
      <section aria-labelledby="default-model" className="grid gap-3">
        <h3 id="default-model" className="text-title weight-semibold">{t("settings.defaultModel.title")}</h3>
        {current === null
          ? <p className="text-body text-muted-foreground">{t("settings.defaultModel.empty")}</p>
          : <Card className="flex-row items-center justify-between">
            <div className="grid min-w-0 gap-1">
              <span className="weight-semibold break-all">{currentModel?.name ?? current?.id}</span>
              <span className="text-body break-all text-muted-foreground">
                {currentProvider?.name ?? current?.provider}
                {currentProvider && !currentProvider.configured && t("settings.defaultModel.disconnected.hint")}
              </span>
            </div>
            <Button variant="tertiary" disabled={available.length === 0} onClick={() => setPicking(true)}>{t("settings.defaultModel.change.action")}</Button>
          </Card>}
      </section>

      <section aria-labelledby="model-providers" className="grid gap-3">
        <div className="flex items-center justify-between gap-3">
          <h3 id="model-providers" className="text-title weight-semibold">{t("settings.provider.title")}</h3>
          {/* 还没有连接时添加是唯一要做的事，用主按钮。 */}
          <Button variant={connected.length === 0 ? "primary" : "tertiary"} onClick={() => setConnecting(true)} leadingIcon={Plus}>{t("settings.provider.add.action")}
          </Button>
        </div>
        {failure && <ErrorNotice title={t("settings.provider.disconnect.error", { value: providerNames.get(failure.provider) ?? failure.provider })} error={failure.error} />}
        {connected.length === 0
          ? <p className="text-body text-muted-foreground">{t("settings.provider.empty")}</p>
          : <ul aria-labelledby="model-providers" className="m-0 grid list-none gap-2 p-0">
            {connected.map((provider) => <li key={provider.id}>
              <Card className="flex-row items-center justify-between">
                <div className="grid min-w-0 gap-1">
                  <span className="weight-semibold break-all">{provider.name}</span>
                  <span className="text-body text-muted-foreground">
                    {provider.configured && authLabel[provider.configured]}
                    {/* 环境变量或 models.json 里的凭据不归 Repa 管，只能在外部移除。 */}
                    {!provider.stored && t("settings.provider.external.hint")}
                  </span>
                </div>
                {provider.stored && <Button
                  variant="tertiary"
                  disabled={removing !== undefined}
                  aria-busy={removing === provider.id}
                  onClick={() => { void disconnect(provider.id); }}
                >
                  {removing === provider.id ? t("settings.provider.disconnecting.status") : t("settings.provider.disconnect.action")}
                </Button>}
              </Card>
            </li>)}
          </ul>}
      </section>
    </>}

    <CommandPolicySection />

    <PromptSettingsSection />

    <ProviderConnectDialog open={connecting} onOpenChange={setConnecting} providers={providers.data ?? []} />
    <DefaultModelDialog open={picking} onOpenChange={setPicking} models={available} providerNames={providerNames} current={current} />
  </div>;
}

const policyOptions: { value: CommandPolicy; label: string; description: string }[] = [
  { value: "ask", label: t("settings.commandPolicy.ask.label"), description: t("settings.commandPolicy.ask.description") },
  { value: "fullAccess", label: t("settings.commandPolicy.full.label"), description: t("settings.commandPolicy.full.description") },
];

/** 命令授权策略。后端在每条命令执行前读取设置，所以保存后立即生效，正在运行的对话也一样。 */
function CommandPolicySection() {
  const policy = useAppStore((state) => state.resources.commandPolicy);
  const loadCommandPolicy = useAppStore((state) => state.loadCommandPolicy);
  const setCommandPolicy = useAppStore((state) => state.setCommandPolicy);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<unknown>();

  useEffect(() => {
    void loadCommandPolicy();
  }, [loadCommandPolicy]);

  async function save(next: CommandPolicy) {
    setConfirming(false);
    setSaving(true);
    setFailure(undefined);
    try {
      await setCommandPolicy(next);
    } catch (error) {
      setFailure(error);
    } finally {
      setSaving(false);
    }
  }

  function choose(value: string) {
    // 完全访问让命令不经确认就运行，先说明后果再保存；改回询问没有风险，直接保存。
    if (value === "fullAccess") setConfirming(true);
    else if (value === "ask") void save("ask");
  }

  return <section aria-labelledby="command-policy" className="grid gap-3">
    <div className="grid gap-1">
      <h3 id="command-policy" className="text-title weight-semibold">{t("settings.commandPolicy.title")}</h3>
      <p className="text-body text-muted-foreground">{t("settings.commandPolicy.description")}</p>
    </div>
    {policy.data === undefined && policy.status !== "error" && <p role="status" className="text-body text-muted-foreground">{t("common.loading.status")}</p>}
    {policy.data === undefined && policy.status === "error" && <div className="grid gap-3">
      <ErrorNotice title={t("settings.commandPolicy.load.error")} error={policy.error} />
      <div>
        <Button variant="tertiary" onClick={() => { void loadCommandPolicy(); }} leadingIcon={RefreshCw}>{t("common.retry.action")}
        </Button>
      </div>
    </div>}
    {failure !== undefined && <ErrorNotice title={t("settings.commandPolicy.save.error")} error={failure} />}
    {policy.data !== undefined && <Card>
      <RadioGroup aria-labelledby="command-policy" value={policy.data} onValueChange={choose} disabled={saving}>
        {policyOptions.map((option) => <div key={option.value} className="flex items-start gap-3">
          {/* 圆点与标签第一行对齐。 */}
          <RadioGroupItem
            id={`command-policy-${option.value}`}
            value={option.value}
            aria-describedby={`command-policy-${option.value}-description`}
            className="mt-1"
          />
          <div className="grid min-w-0 gap-1">
            <label htmlFor={`command-policy-${option.value}`} className="text-body weight-semibold">{option.label}</label>
            <p id={`command-policy-${option.value}-description`} className="text-body text-muted-foreground">{option.description}</p>
          </div>
        </div>)}
      </RadioGroup>
    </Card>}

    <Dialog open={confirming} onOpenChange={setConfirming}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings.commandPolicy.confirm.title")}</DialogTitle>
          <DialogDescription>
            {t("settings.commandPolicy.confirm.description")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="tertiary" onClick={() => setConfirming(false)}>{t("common.cancel.action")}</Button>
          <Button onClick={() => { void save("fullAccess"); }}>{t("settings.commandPolicy.confirm.action")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}
