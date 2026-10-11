import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ExternalLink, KeyRound, LogIn } from "lucide-react";
import type { Result } from "@repa/base/protocol";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SearchInput } from "@/components/ui/search-input";
import { ErrorNotice } from "@/components/domain/error-notice";
import { useAppStore } from "@/hooks/use-app-store";
import { errorCode } from "@/lib/errors";
import type { PendingConfirmation } from "@/lib/store";

type Provider = Result<"model.providers">[number];
type Method = Provider["methods"][number];

/** 对话框里的步骤：选提供方、选登录方式、填 key、交互登录。 */
type Step =
  | { kind: "pick" }
  | { kind: "method"; provider: Provider }
  | { kind: "key"; provider: Provider; method: Method }
  | { kind: "login"; provider: Provider; type: Method["type"] };

const methodLabel = { api_key: "填写 API key", oauth: "用账号登录" } as const;

/**
 * 连接模型提供方。key 由 auth.setKey 保存；账号登录和需要多项信息的 key 走 auth.login，
 * 过程中后端发来的输入、选择和链接显示在同一个对话框里。
 */
export function ProviderConnectDialog({ open, onOpenChange, providers, initial }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  providers: Provider[];
  /** 直接从某个提供方开始，跳过选择。 */
  initial?: Provider | undefined;
}) {
  const cancelLogin = useAppStore((state) => state.cancelLogin);
  const [step, setStep] = useState<Step>({ kind: "pick" });

  // 每次打开都从头开始。
  useEffect(() => {
    if (open) setStep(initial ? firstStep(initial) : { kind: "pick" });
  }, [open, initial]);

  function close(next: boolean) {
    if (!next && step.kind === "login") cancelLogin();
    onOpenChange(next);
  }

  const toPick = initial ? undefined : () => setStep({ kind: "pick" });
  // 从填 key 或登录返回：有方式可选时回到方式页，否则回到提供方列表；从某个提供方直接打开时关闭。
  function back(provider: Provider) {
    const first = firstStep(provider);
    if (first.kind === "method") setStep(first);
    else if (toPick) toPick();
    else onOpenChange(false);
  }
  return <Dialog open={open} onOpenChange={close}>
    <DialogContent>
      {step.kind === "pick" && <PickProvider providers={providers} onPick={(provider) => setStep(firstStep(provider))} />}
      {step.kind === "method" && <PickMethod
        provider={step.provider}
        onBack={toPick}
        onPick={(method) => setStep(method.type === "api_key"
          ? { kind: "key", provider: step.provider, method }
          : { kind: "login", provider: step.provider, type: method.type })}
      />}
      {step.kind === "key" && <KeyForm
        provider={step.provider}
        method={step.method}
        onBack={() => back(step.provider)}
        onSaved={() => onOpenChange(false)}
        onNeedsLogin={() => setStep({ kind: "login", provider: step.provider, type: "api_key" })}
      />}
      {step.kind === "login" && <LoginFlow
        provider={step.provider}
        type={step.type}
        onDone={() => onOpenChange(false)}
        onBack={() => back(step.provider)}
      />}
    </DialogContent>
  </Dialog>;
}

/** 只有一种方式、并且能在 Repa 里完成时直接进入；否则先选方式或看外部配置说明。 */
function firstStep(provider: Provider): Step {
  const [only] = provider.methods;
  if (provider.methods.length !== 1 || !only?.login) return { kind: "method", provider };
  return only.type === "api_key" ? { kind: "key", provider, method: only } : { kind: "login", provider, type: only.type };
}

function PickProvider({ providers, onPick }: { providers: Provider[]; onPick(provider: Provider): void }) {
  const [query, setQuery] = useState("");
  const keyword = query.trim().toLowerCase();
  const matched = providers.filter((provider) => !keyword
    || provider.name.toLowerCase().includes(keyword)
    || provider.id.toLowerCase().includes(keyword));

  return <>
    <DialogHeader>
      <DialogTitle>添加提供方</DialogTitle>
      <DialogDescription>选择模型服务的提供方，之后填写 API key 或登录账号。</DialogDescription>
    </DialogHeader>
    <SearchInput label="搜索提供方" value={query} onChange={(event) => setQuery(event.target.value)} onClear={() => setQuery("")} />
    {matched.length === 0
      ? <p className="text-sm text-muted-foreground">没有找到匹配的提供方。</p>
      : <ul aria-label="提供方" className="m-0 grid max-h-80 list-none gap-1 overflow-y-auto p-0">
        {matched.map((provider) => <li key={provider.id}>
          <Button variant="ghost" className="w-full justify-start" onClick={() => onPick(provider)}>
            <span className="min-w-0 text-left break-all">{provider.name}</span>
            {provider.configured && <Badge variant="secondary" className="ml-auto">已连接</Badge>}
          </Button>
        </li>)}
      </ul>}
  </>;
}

function PickMethod({ provider, onPick, onBack }: { provider: Provider; onPick(method: Method): void; onBack?: (() => void) | undefined }) {
  const outside = provider.methods.filter((method) => !method.login);
  return <>
    <DialogHeader>
      <DialogTitle>连接 {provider.name}</DialogTitle>
      <DialogDescription>选择连接方式。</DialogDescription>
    </DialogHeader>
    <ul aria-label="连接方式" className="m-0 grid list-none gap-2 p-0">
      {provider.methods.filter((method) => method.login).map((method) => <li key={method.type}>
        <Button variant="outline" className="w-full justify-start" onClick={() => onPick(method)}>
          {method.type === "api_key" ? <KeyRound aria-hidden="true" /> : <LogIn aria-hidden="true" />}
          <span className="grid min-w-0 text-left">
            <span>{methodLabel[method.type]}</span>
            <span className="text-xs font-normal break-all text-muted-foreground">{method.name}</span>
          </span>
        </Button>
      </li>)}
    </ul>
    {outside.map((method) => <p key={method.type} className="text-sm text-muted-foreground">
      {method.name} 需要在 Repa 之外配置，例如设置环境变量。
    </p>)}
    {onBack && <DialogFooter>
      <Button variant="outline" onClick={onBack}>返回</Button>
    </DialogFooter>}
  </>;
}

function KeyForm({ provider, method, onBack, onSaved, onNeedsLogin }: {
  provider: Provider;
  method: Method;
  onBack(): void;
  onSaved(): void;
  onNeedsLogin(): void;
}) {
  const saveKey = useAppStore((state) => state.saveKey);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const inputId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      await saveKey(provider.id, key.trim());
      onSaved();
    } catch (failure) {
      setSaving(false);
      // 只填一个 key 不够的提供方（例如还要选区域），改走后端的交互登录。
      if (errorCode(failure) === "requires_interactive_login") onNeedsLogin();
      else setError(failure);
    }
  }

  return <form className="grid gap-4" onSubmit={(event) => { void submit(event); }}>
    <DialogHeader>
      <DialogTitle>连接 {provider.name}</DialogTitle>
      <DialogDescription>key 保存在本机的 Repa 数据目录里，只用于向 {provider.name} 发送请求。</DialogDescription>
    </DialogHeader>
    <div className="grid gap-1">
      <label htmlFor={inputId} className="text-sm font-medium">{method.name}</label>
      <Input id={inputId} type="password" autoComplete="off" spellCheck={false} value={key} onChange={(event) => setKey(event.target.value)} autoFocus />
    </div>
    {error !== undefined && <ErrorNotice title="没有保存" error={error} />}
    <DialogFooter>
      <Button variant="outline" disabled={saving} onClick={onBack}>返回</Button>
      <Button type="submit" disabled={saving || key.trim() === ""}>{saving ? "正在保存…" : "保存"}</Button>
    </DialogFooter>
  </form>;
}

function LoginFlow({ provider, type, onDone, onBack }: {
  provider: Provider;
  type: Method["type"];
  onDone(): void;
  onBack(): void;
}) {
  const login = useAppStore((state) => state.login);
  const activeLogin = useAppStore((state) => state.activeLogin);
  const [error, setError] = useState<unknown>();
  const [attempt, setAttempt] = useState(0);
  const started = useRef(-1);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    // 每次进入或重试只发起一次登录，开发模式重复执行 effect 时也不重复发起。
    if (started.current === attempt) return;
    started.current = attempt;
    setError(undefined);
    login(provider.id, type).then(
      () => { if (mounted.current) onDone(); },
      // 关闭对话框即取消，之后的失败不再显示。
      (failure: unknown) => { if (mounted.current) setError(failure); },
    );
  }, [attempt]);

  const running = activeLogin?.provider === provider.id && error === undefined;
  const prompt = activeLogin?.prompts[0];
  return <>
    <DialogHeader>
      <DialogTitle>登录 {provider.name}</DialogTitle>
      <DialogDescription>{type === "oauth" ? "按提示在浏览器里完成登录，完成后这里会自动继续。" : "这个提供方需要几项信息，按提示填写。"}</DialogDescription>
    </DialogHeader>
    {activeLogin && activeLogin.notices.length > 0 && <ul aria-label="登录说明" className="m-0 grid list-none gap-2 p-0">
      {activeLogin.notices.map((notice, index) => <li key={index} className="grid gap-2 text-sm">
        <p className="break-words">{notice.title}</p>
        {notice.url && <div>
          <Button asChild variant={prompt ? "outline" : "default"}>
            <a href={notice.url} target="_blank" rel="noreferrer">
              <ExternalLink aria-hidden="true" />打开链接
            </a>
          </Button>
        </div>}
      </li>)}
    </ul>}
    {running && prompt && <LoginPrompt key={prompt.id} prompt={prompt} />}
    {running && !prompt && <p role="status" className="text-sm text-muted-foreground">正在等待登录完成…</p>}
    {error !== undefined && <ErrorNotice title="登录没有完成" error={error} />}
    {error !== undefined && <DialogFooter>
      <Button variant="outline" onClick={onBack}>返回</Button>
      <Button onClick={() => setAttempt((value) => value + 1)}>重试</Button>
    </DialogFooter>}
  </>;
}

/** 登录过程中后端要用户回答的一项：输入（可能是密文）或从选项中选一个。 */
function LoginPrompt({ prompt }: { prompt: PendingConfirmation }) {
  const answer = useAppStore((state) => state.answerLoginPrompt);
  const [value, setValue] = useState("");
  const inputId = useId();
  const messageId = useId();
  const { request } = prompt;

  if (request.kind === "select") {
    const options = request.options ?? [];
    // 底座把每个选项写成 message 里的一行“id：名称 — 说明”；每项都能对上时直接用这行作按钮文字。
    const lines = request.message?.split("\n") ?? [];
    const labels = options.map((option) => lines.find((line) => line.startsWith(`${option}：`))?.slice(option.length + 1));
    const labelled = labels.every((label) => label !== undefined);
    return <div className="grid gap-3">
      <p className="text-sm font-medium">{request.title}</p>
      {request.message && !labelled && <p className="text-sm whitespace-pre-wrap text-muted-foreground">{request.message}</p>}
      <ul aria-label={request.title} className="m-0 grid list-none gap-2 p-0">
        {options.map((option, index) => <li key={option}>
          <Button variant="outline" className="w-full justify-start" onClick={() => { void answer(prompt.id, option); }}>
            <span className="min-w-0 text-left break-words">{labels[index] ?? option}</span>
          </Button>
        </li>)}
      </ul>
    </div>;
  }

  return <form className="grid gap-3" onSubmit={(event) => {
    event.preventDefault();
    void answer(prompt.id, value);
  }}>
    <div className="grid gap-1">
      <label htmlFor={inputId} className="text-sm font-medium break-words">{request.title}</label>
      {request.message && <p id={messageId} className="text-sm whitespace-pre-wrap text-muted-foreground">{request.message}</p>}
      <Input
        id={inputId}
        type={request.secret ? "password" : "text"}
        autoComplete="off"
        spellCheck={false}
        aria-describedby={request.message ? messageId : undefined}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        autoFocus
      />
    </div>
    <div className="flex justify-end">
      <Button type="submit" disabled={value.trim() === ""}>继续</Button>
    </div>
  </form>;
}
