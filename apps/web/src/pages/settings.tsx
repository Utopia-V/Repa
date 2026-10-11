import { useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorNotice } from "@/components/domain/error-notice";
import { DefaultModelDialog } from "@/features/model-picker";
import { ProviderConnectDialog } from "@/features/provider-connect";
import { useAppStore } from "@/hooks/use-app-store";

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
      <p className="text-sm text-muted-foreground">连接模型服务，并选择新会话使用的模型。</p>
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

    <ProviderConnectDialog open={connecting} onOpenChange={setConnecting} providers={providers.data ?? []} />
    <DefaultModelDialog open={picking} onOpenChange={setPicking} models={available} providerNames={providerNames} current={current} />
  </div>;
}
