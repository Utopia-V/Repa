// 壳：可折叠的左栏、中间的一页、右侧可开合的对话面板。布局只由“中间看什么”和“对话是否打开”决定；
// 每个页面只接收路径，不知道自己挂在哪里，所以换一种排法只改这里。
import { useEffect } from "react";

import { CardPage } from "./card";
import { Chat } from "./chat";
import { FolderPage, KbPage } from "./kb";
import { SettingsPage } from "./settings";
import { Side } from "./side";
import { current, go, update, useApp, type Route } from "./store";
import { t } from "./strings";
import { TodayPage } from "./today";
import { comboOf, IconButton, keyOf } from "./ui";

function Page({ route }: { route: Route }) {
  switch (route.page) {
    case "today": return <TodayPage />;
    case "kb": return <KbPage />;
    case "folder": return <FolderPage path={route.path} agents={route.agents ?? false} />;
    case "card": return <CardPage path={route.path} />;
    case "settings": return <SettingsPage />;
    case "review": return null;
  }
}

// 外观：跟随系统时随系统的亮暗切换；设置读到以前先用上次的，免得打开时闪一下。
function useTheme(appearance: string | undefined) {
  useEffect(() => {
    const chosen = appearance ?? localStorage.getItem("repa.appearance") ?? "system";
    localStorage.setItem("repa.appearance", chosen);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = chosen === "dark" || (chosen === "system" && media.matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [appearance]);
}

/** 整个应用。 */
export function App() {
  const { route, side, chat, offline, settings, at, last } = useApp();
  useTheme(settings?.appearance);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const combo = comboOf(event);
      const keys = current().settings?.keys;
      if (combo === keyOf(keys, "side")) update((state) => ({ side: !state.side }));
      else if (combo === keyOf(keys, "chat")) update((state) => ({ chat: !state.chat }));
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // 复习时中间没有内容；在复习里点开一张卡片，中间显示它，对话退到右侧。
  const alone = route.page === "review";
  useEffect(() => {
    if (alone && !chat) go({ page: "today" });
  }, [alone, chat]);
  return <div className="app" data-side={side ? "open" : "closed"}>
    <Side />
    {alone
      ? <Chat alone />
      : <>
        <div className="sheet">
          <div className="hist">
            <IconButton icon="arrow-left" label={t("nav.back")} disabled={at === 0} onClick={() => window.history.back()} />
            <IconButton icon="arrow-right" label={t("nav.forward")} disabled={at >= last} onClick={() => window.history.forward()} />
          </div>
          {!chat && <div className="sheet-tools"><IconButton icon="panel-right" label={t("nav.chatOpen")} expanded={false} onClick={() => update({ chat: true })} /></div>}
          <Page route={route} />
        </div>
        {chat && <Chat alone={false} />}
      </>}
    {offline && <p className="offline" role="status">{t("app.offline")}</p>}
  </div>;
}
