// 设置：外观、每天建议的张数、默认的模型与思考强度、两个确认开关、键位、模式的文字和知识库的位置。
import { useEffect, useState } from "react";

import { get, put, type Settings } from "./api";
import { Icon } from "./glyph";
import { update, useApp, useData } from "./store";
import { t, type TextKey } from "./strings";
import { AutoText, comboOf, IconButton, KEY_DEFAULTS, keyOf, Menu, MenuChoice, Seg, Switch, type KeyAction } from "./ui";

// Pi 的 thinking 级别；当前模型不支持的级别由 Pi 收窄到它支持的。
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

const save = (change: Partial<Settings>) => void put<Settings>("/api/settings", change).then((settings) => update({ settings }));

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="set-row"><span className="set-l">{label}</span><span className="set-c">{children}</span></div>;
}

function Select({ value, items, onChange }: { value: string | undefined; items: Array<[string, string]>; onChange: (value: string) => void }) {
  return <Menu align="end" trigger={<button type="button" className="sel-in">{items.find(([key]) => key === value)?.[1] ?? value ?? t("settings.unset")}<Icon name="chevron-down" /></button>}>
    <MenuChoice items={items} value={value} onChange={onChange} />
  </Menu>;
}

function Daily({ limit }: { limit: number | null }) {
  const [text, setText] = useState(limit === null ? "" : String(limit));
  useEffect(() => setText(limit === null ? "" : String(limit)), [limit]);
  const commit = () => {
    const value = Number(text);
    if (text.trim() && Number.isInteger(value) && value >= 0 && value !== limit) save({ dailyLimit: value });
  };
  return <>
    <input className="num-in num" inputMode="numeric" aria-label={t("settings.daily")} value={text} onChange={(event) => setText(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") commit(); }} />
    <button type="button" className="chip-t" aria-pressed={limit === null} onClick={() => save({ dailyLimit: limit === null ? 10 : null })}>{t("settings.unlimited")}</button>
  </>;
}

/** 键位表：点一个键位，按下新的按键就换上；Esc 放弃。 */
function Keys({ keys }: { keys: Record<string, unknown> | undefined }) {
  const [waiting, setWaiting] = useState<KeyAction>();
  useEffect(() => {
    if (!waiting) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") return setWaiting(undefined);
      const combo = comboOf(event);
      if (!combo) return;
      save({ keys: { ...keys, [waiting]: combo } });
      setWaiting(undefined);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [waiting, keys]);
  const kbd = (combo: string) => combo.split(/\+(?=.)/u).flatMap((part, index) => [index ? <span key={`p${index}`} className="plus">+</span> : null, <kbd key={index}>{part}</kbd>]);
  return <table className="keys"><tbody>{(Object.keys(KEY_DEFAULTS) as KeyAction[]).map((action) => <tr key={action}>
    <td>{t(`key.${action}` as TextKey)}</td>
    <td>{waiting === action
      ? <button type="button" className="key wait" aria-label={t("settings.waitKey")}><span className="dots"><i /><i /><i /></span></button>
      : <button type="button" className="key" onClick={() => setWaiting(action)}>{kbd(keyOf(keys, action))}</button>}</td>
  </tr>)}</tbody></table>;
}

function Mode({ name }: { name: string }) {
  const [text, setText] = useState<string>();
  const open = () => void get<{ text: string }>(`/api/modes/${encodeURIComponent(name)}`).then((result) => setText(result.text));
  return <>
    <Row label={name}><IconButton icon="pencil" label={t("card.edit")} onClick={open} /></Row>
    {text !== undefined && <div className="mode-edit">
      <AutoText className="raw" aria-label={name} value={text} autoFocus onChange={(event) => setText(event.target.value)} />
      <span className="edit-acts">
        <button type="button" className="btn btn-solid btn-s" onClick={() => void put(`/api/modes/${encodeURIComponent(name)}`, { text }).then(() => setText(undefined))}>{t("card.done")}</button>
        <button type="button" className="btn btn-text" onClick={() => setText(undefined)}>{t("card.cancel")}</button>
      </span>
    </div>}
  </>;
}

/** 设置页。 */
export function SettingsPage() {
  const { settings } = useApp();
  const { data: models } = useData(() => get<{ models: Array<{ provider: string; id: string; name: string }> }>("/api/models"), []);
  const { data: modes } = useData(() => get<{ modes: string[] }>("/api/modes"), []);
  if (!settings) return null;
  return <main className="settings">
    <h1>{t("settings.title")}</h1>
    <section><h2>{t("settings.appearance")}</h2>
      <Seg label={t("settings.appearance")} value={settings.appearance} onChange={(appearance) => save({ appearance })} items={[["system", t("settings.system")], ["light", t("settings.light")], ["dark", t("settings.dark")]]} />
    </section>
    <section><h2>{t("settings.review")}</h2><Row label={t("settings.daily")}><Daily limit={settings.dailyLimit} /></Row></section>
    <section><h2>{t("settings.model")}</h2>
      <Row label={t("settings.defaultModel")}>{models?.models.length === 0
        ? <span className="hint">{t("chat.noModels")}</span>
        : <Select value={settings.model} items={(models?.models ?? []).map((item) => [`${item.provider}/${item.id}`, item.id])} onChange={(model) => save({ model })} />}</Row>
      <Row label={t("chat.thinking")}><Select value={settings.thinking} items={LEVELS.map((level) => [level, level])} onChange={(thinking) => save({ thinking })} /></Row>
    </section>
    <section><h2>{t("settings.confirm")}</h2>
      <Row label={t("chat.confirmEdits")}><Switch checked={settings.confirmEdits} onChange={(confirmEdits) => save({ confirmEdits })} label={t("chat.confirmEdits")} /></Row>
      <Row label={t("chat.confirmCommands")}><Switch checked={settings.confirmCommands} onChange={(confirmCommands) => save({ confirmCommands })} label={t("chat.confirmCommands")} /></Row>
    </section>
    <section><h2>{t("settings.keys")}</h2><Keys keys={settings.keys} /></section>
    <section><h2>{t("settings.modes")}</h2>{(modes?.modes ?? []).map((name) => <Mode key={name} name={name} />)}</section>
    <section><h2>{t("settings.kb")}</h2><Row label={t("settings.root")}><code className="path">{settings.root}</code></Row></section>
  </main>;
}
