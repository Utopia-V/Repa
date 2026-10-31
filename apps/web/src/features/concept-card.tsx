import { useEffect, useState } from "react";
import type { ContentPage, LearningResult } from "@repa/learning/protocol";

import { Button } from "@/components/ui/button";
import { DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { RenderLink } from "@/components/ui/markdown";
import { ErrorNotice } from "@/components/domain/error-notice";
import { Content } from "@/components/domain/item-parts";
import { useAppStore } from "@/hooks/use-app-store";

type Hit = LearningResult<"content.search">["hits"][number];
type Loaded = { hit: Hit; page: ContentPage };

/**
 * 概念卡：按知识点编号找到它的卡片（没有卡片时用知识点本身），记一次打开后显示内容。
 * 卡片的例子来自原来学它时的例题，可以展开看原题。课程换版后旧编号找不到，按读取失败显示。
 */
export function ConceptCardDialog({ kpId, renderLink }: { kpId: string; renderLink: RenderLink }) {
  const searchContent = useAppStore((state) => state.searchContent);
  const readContent = useAppStore((state) => state.readContent);
  const openContent = useAppStore((state) => state.openContent);
  const [loaded, setLoaded] = useState<Loaded>();
  const [origin, setOrigin] = useState<ContentPage>();
  const [error, setError] = useState<unknown>();
  const [originError, setOriginError] = useState<unknown>();

  useEffect(() => {
    let active = true;
    setLoaded(undefined);
    setOrigin(undefined);
    setError(undefined);
    setOriginError(undefined);
    void (async () => {
      try {
        const { hits } = await searchContent(kpId);
        const hit = hits.find((candidate) => candidate.ref.kind === "card" && candidate.ref.kpId === kpId)
          ?? hits.find((candidate) => candidate.ref.kind === "kp" && candidate.ref.kpId === kpId);
        if (!hit) throw new Error("没有找到这个知识点，可能是课程更新后编号变了。");
        await openContent(hit.ref);
        const [page] = await readContent(hit.ref);
        if (!page) throw new Error("这张卡片没有内容。");
        if (active) setLoaded({ hit, page });
      } catch (failure) {
        if (active) setError(failure);
      }
    })();
    return () => { active = false; };
  }, [kpId, searchContent, readContent, openContent]);

  async function showOrigin(hit: Hit) {
    setOriginError(undefined);
    try {
      const [page] = await readContent(hit.origin.content);
      setOrigin(page);
    } catch (failure) {
      setOriginError(failure);
    }
  }

  const sameAsCard = loaded && loaded.hit.origin.content.id === loaded.hit.ref.id;
  return <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
    <DialogHeader>
      <DialogTitle>{loaded?.hit.title ?? "概念卡"}</DialogTitle>
      <DialogDescription>学过的内容随时可以回来查。</DialogDescription>
    </DialogHeader>
    {!loaded && error === undefined && <p role="status" className="m-0 text-sm text-muted-foreground">正在读取…</p>}
    {error !== undefined && <ErrorNotice title="没能打开这张卡片" error={error} />}
    {loaded && <Content blocks={loaded.page.blocks} renderLink={renderLink} />}
    {loaded && !sameAsCard && !origin && <div>
      <Button variant="outline" onClick={() => { void showOrigin(loaded.hit); }}>看原来的例题</Button>
    </div>}
    {originError !== undefined && <ErrorNotice title="没能读取原来的例题" error={originError} />}
    {origin && <section aria-label="原来的例题" className="grid gap-2 border-t border-border pt-4">
      <h4 className="m-0 text-sm font-semibold">原来的例题</h4>
      <Content blocks={origin.blocks} renderLink={renderLink} />
    </section>}
  </DialogContent>;
}
