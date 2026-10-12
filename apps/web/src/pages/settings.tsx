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

const authLabel = { api_key: "API key", oauth: "账号登录" } as const;

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
      <h2 className="text-2xl font-semibold">设置</h2>
      <p className="text-sm text-muted-foreground">连接模型服务，选择新会话使用的模型，并决定 Agent 执行命令前是否询问你。</p>
    </header>

    {!loaded && loadError === undefined && <p role="status" className="text-sm text-muted-foreground">正在读取…</p>}
    {loadError !== undefined && <div className="grid gap-3">
      <ErrorNotice title="无法读取模型设置" error={loadError} />
      <div>
        <Button variant="outline" onClick={() => { void loadModelSettings(); }}>
          <RefreshCw aria-hidden="true" />重试
        </Button>
      </div>
    </div>}

    {loaded && <>
      <section aria-labelledby="default-model" className="grid gap-3">
        <h3 id="default-model" className="text-lg font-semibold">默认模型</h3>
        {current === null
          ? <p className="text-sm text-muted-foreground">还没有可用的模型，先在下面连接一个提供方。</p>
          : <Card className="flex-row items-center justify-between">
            <div className="grid min-w-0 gap-1">
              <span className="font-medium break-all">{currentModel?.name ?? current?.id}</span>
              <span className="text-sm break-all text-muted-foreground">
                {currentProvider?.name ?? current?.provider}
                {currentProvider && !currentProvider.configured && "，提供方还没有连接，发送消息会失败"}
              </span>
            </div>
            <Button variant="outline" disabled={available.length === 0} onClick={() => setPicking(true)}>更换</Button>
          </Card>}
      </section>

      <section aria-labelledby="model-providers" className="grid gap-3">
        <div className="flex items-center justify-between gap-3">
          <h3 id="model-providers" className="text-lg font-semibold">模型提供方</h3>
          {/* 还没有连接时添加是唯一要做的事，用主按钮。 */}
          <Button variant={connected.length === 0 ? "default" : "outline"} onClick={() => setConnecting(true)}>
            <Plus aria-hidden="true" />添加提供方
          </Button>
        </div>
        {failure && <ErrorNotice title={`无法断开 ${providerNames.get(failure.provider) ?? failure.provider}`} error={failure.error} />}
        {connected.length === 0
          ? <p className="text-sm text-muted-foreground">还没有连接任何提供方。</p>
          : <ul aria-labelledby="model-providers" className="m-0 grid list-none gap-2 p-0">
            {connected.map((provider) => <li key={provider.id}>
              <Card className="flex-row items-center justify-between">
                <div className="grid min-w-0 gap-1">
                  <span className="font-medium break-all">{provider.name}</span>
                  <span className="text-sm text-muted-foreground">
                    {provider.configured && authLabel[provider.configured]}
                    {/* 环境变量或 models.json 里的凭据不归 Repa 管，只能在外部移除。 */}
                    {!provider.stored && "，由环境变量或配置文件提供"}
                  </span>
                </div>
                {provider.stored && <Button
                  variant="outline"
                  disabled={removing !== undefined}
                  aria-busy={removing === provider.id}
                  onClick={() => { void disconnect(provider.id); }}
                >
                  {removing === provider.id ? "正在断开…" : "断开"}
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
  { value: "ask", label: "每次询问", description: "Agent 每次执行命令前弹出确认，你允许后才运行。" },
  { value: "fullAccess", label: "完全访问", description: "Agent 执行命令不再询问。" },
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
      <h3 id="command-policy" className="text-lg font-semibold">命令授权</h3>
      <p className="text-sm text-muted-foreground">对所有学习空间生效。改动后 Agent 的下一条命令就按新设置处理，正在运行的对话也一样。</p>
    </div>
    {policy.data === undefined && policy.status !== "error" && <p role="status" className="text-sm text-muted-foreground">正在读取…</p>}
    {policy.data === undefined && policy.status === "error" && <div className="grid gap-3">
      <ErrorNotice title="无法读取命令授权设置" error={policy.error} />
      <div>
        <Button variant="outline" onClick={() => { void loadCommandPolicy(); }}>
          <RefreshCw aria-hidden="true" />重试
        </Button>
      </div>
    </div>}
    {failure !== undefined && <ErrorNotice title="无法保存命令授权设置" error={failure} />}
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
            <label htmlFor={`command-policy-${option.value}`} className="text-sm font-medium">{option.label}</label>
            <p id={`command-policy-${option.value}-description`} className="text-sm text-muted-foreground">{option.description}</p>
          </div>
        </div>)}
      </RadioGroup>
    </Card>}

    <Dialog open={confirming} onOpenChange={setConfirming}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>让 Agent 直接执行命令？</DialogTitle>
          <DialogDescription>
            开启后，Agent 执行命令前不再询问，插件在后台发起的命令也会直接运行。命令以你的系统账户权限在这台电脑上执行，可能修改或删除学习空间之外的文件，这些改动无法在 Repa 里撤回。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirming(false)}>取消</Button>
          <Button onClick={() => { void save("fullAccess"); }}>开启完全访问</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}
