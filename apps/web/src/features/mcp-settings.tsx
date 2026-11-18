import { useEffect, useId, useState, type FormEvent } from "react";
import { Plus, RefreshCw } from "lucide-react";

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
import { StatusNotice } from "@/components/ui/status-notice";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ErrorNotice } from "@/components/domain/error-notice";
import { useAppStore } from "@/hooks/use-app-store";
import { errorCode } from "@/lib/errors";
import type { McpServer } from "@/lib/store";
import { t } from "@/lib/strings";

/**
 * 设置页的 MCP 服务器：每个服务器的连接状态、启用与调用前询问两个开关、重新连接和删除，以及粘贴一段配置来添加。
 * 状态随 mcp.updated 更新；连上、失败都在这里看到，不另外提示。
 */
export function McpSection() {
  const servers = useAppStore((state) => state.resources.mcpServers);
  const loadMcpServers = useAppStore((state) => state.loadMcpServers);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<McpServer>();

  useEffect(() => {
    void loadMcpServers();
  }, [loadMcpServers]);

  // 没有通用 Agent 的装配用不上 MCP，不显示这一节。
  if (servers.status === "error" && errorCode(servers.error) === "mcp_unavailable") return null;
  const list = servers.data;
  return <section aria-labelledby="mcp-servers" className="grid gap-3">
    <div className="flex items-center justify-between gap-3">
      <h3 id="mcp-servers" className="text-title weight-semibold">{t("settings.mcp.title")}</h3>
      <Button variant="tertiary" onClick={() => setAdding(true)} leadingIcon={Plus}>{t("settings.mcp.add.action")}</Button>
    </div>
    <p className="text-body text-muted-foreground">{t("settings.mcp.description")}</p>
    {servers.status === "error" && <div className="grid gap-3">
      <ErrorNotice title={t("settings.mcp.load.error")} error={servers.error} />
      <div><Button variant="tertiary" onClick={() => { void loadMcpServers(); }} leadingIcon={RefreshCw}>{t("common.retry.action")}</Button></div>
    </div>}
    {list === undefined && servers.status !== "error" && <p role="status" className="text-body text-muted-foreground">{t("common.loading.status")}</p>}
    {list?.length === 0 && <p className="text-body text-muted-foreground">{t("settings.mcp.empty")}</p>}
    {list !== undefined && list.length > 0 && <ul aria-labelledby="mcp-servers" className="m-0 grid list-none gap-2 p-0">
      {list.map((server) => <li key={server.name}><ServerCard server={server} onRemove={() => setRemoving(server)} /></li>)}
    </ul>}
    <AddDialog open={adding} onOpenChange={setAdding} />
    <RemoveDialog server={removing} onDone={() => setRemoving(undefined)} />
  </section>;
}

function ServerCard({ server, onRemove }: { server: McpServer; onRemove: () => void }) {
  const setMcpServer = useAppStore((state) => state.setMcpServer);
  const reconnectMcpServer = useAppStore((state) => state.reconnectMcpServer);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();

  async function change(action: () => Promise<void>) {
    setBusy(true);
    setFailure(undefined);
    try {
      await action();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  return <Card className="gap-3">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="grid min-w-0 gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="weight-semibold break-all">{server.name}</span>
          <ServerState server={server} />
        </div>
        {server.target !== "" && <span className="text-body break-all text-muted-foreground">{server.target}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {server.state === "failed" && <Button variant="tertiary" disabled={busy} onClick={() => { void change(() => reconnectMcpServer(server.name)); }} leadingIcon={RefreshCw}>{t("settings.mcp.reconnect.action")}</Button>}
        <Button variant="ghost" disabled={busy} aria-label={t("settings.mcp.remove.label", { name: server.name })} onClick={onRemove}>{t("settings.mcp.remove.action")}</Button>
      </div>
    </div>
    {server.state === "failed" && server.reason && <StatusNotice status="error" title={t("settings.mcp.failed.status")}>
      <p className="whitespace-pre-wrap break-all">{server.reason.message}</p>
    </StatusNotice>}
    <div className="grid gap-2">
      <Switch
        label={t("settings.mcp.enable.label", { name: server.name })}
        checked={server.enabled}
        disabled={busy}
        onToggle={() => { void change(() => setMcpServer(server.name, { enabled: !server.enabled })); }}
      />
      <Switch
        label={t("settings.mcp.ask.label", { name: server.name })}
        checked={server.ask}
        disabled={busy}
        onToggle={() => { void change(() => setMcpServer(server.name, { ask: !server.ask })); }}
      />
    </div>
    {failure !== undefined && <ErrorNotice title={t("settings.mcp.change.error", { name: server.name })} error={failure} />}
  </Card>;
}

/** 状态同时用文字表达；失败的原因在卡片下方。 */
function ServerState({ server }: { server: McpServer }) {
  switch (server.state) {
    case "connected":
      return <Badge variant="dot" color="green">{t("settings.mcp.connected.status", { count: server.tools.length })}</Badge>;
    case "connecting":
      // 本机命令形式的服务器第一次运行时常要先下载（npx、uvx），握手因此可以很久。
      return <Badge variant="dot" color="amber">{t(server.transport === "stdio" ? "settings.mcp.connectingLocal.status" : "settings.mcp.connecting.status")}</Badge>;
    case "disabled":
      return <Badge variant="dot" color="gray">{t("settings.mcp.disabled.status")}</Badge>;
    case "failed":
      return <Badge variant="dot" color="red">{t("settings.mcp.failed.status")}</Badge>;
  }
}

/** 粘贴服务器说明里给的一段配置；格式不对时后端说明原因，输入保留。 */
function AddDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const addMcpServers = useAppStore((state) => state.addMcpServers);
  const [config, setConfig] = useState("");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const fieldId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFailure(undefined);
    try {
      await addMcpServers(config);
      setConfig("");
      onOpenChange(false);
    } catch (error) {
      setFailure(error);
    } finally {
      setSaving(false);
    }
  }

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent>
      <form className="grid gap-4" onSubmit={(event) => { void submit(event); }}>
        <DialogHeader>
          <DialogTitle>{t("settings.mcp.add.title")}</DialogTitle>
          <DialogDescription>{t("settings.mcp.add.description")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <label htmlFor={fieldId} className="text-body weight-semibold">{t("settings.mcp.add.config.label")}</label>
          <Textarea id={fieldId} rows={6} spellCheck={false} value={config} disabled={saving} onChange={(event) => setConfig(event.target.value)} />
        </div>
        {failure !== undefined && <ErrorNotice title={t("settings.mcp.add.error")} error={failure} />}
        <DialogFooter>
          <Button variant="tertiary" onClick={() => onOpenChange(false)}>{t("common.cancel.action")}</Button>
          <Button type="submit" disabled={saving || config.trim() === ""} aria-busy={saving}>{t("settings.mcp.add.submit.action")}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

/** 删除会丢掉这一项里的令牌，先确认。 */
function RemoveDialog({ server, onDone }: { server: McpServer | undefined; onDone: () => void }) {
  const removeMcpServer = useAppStore((state) => state.removeMcpServer);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<unknown>();

  async function remove(name: string) {
    setSaving(true);
    setFailure(undefined);
    try {
      await removeMcpServer(name);
      onDone();
    } catch (error) {
      setFailure(error);
    } finally {
      setSaving(false);
    }
  }

  return <Dialog open={server !== undefined} onOpenChange={(open) => { if (!open) { setFailure(undefined); onDone(); } }}>
    {server && <DialogContent>
      <DialogHeader>
        <DialogTitle>{t("settings.mcp.remove.confirm.title", { name: server.name })}</DialogTitle>
        <DialogDescription>{t("settings.mcp.remove.confirm.description")}</DialogDescription>
      </DialogHeader>
      {failure !== undefined && <ErrorNotice title={t("settings.mcp.change.error", { name: server.name })} error={failure} />}
      <DialogFooter>
        <Button variant="tertiary" onClick={onDone}>{t("common.cancel.action")}</Button>
        <Button variant="destructive" disabled={saving} aria-busy={saving} onClick={() => { void remove(server.name); }}>{t("settings.mcp.remove.action")}</Button>
      </DialogFooter>
    </DialogContent>}
  </Dialog>;
}
