import { useState } from "react";

/** 发送输入框里的草稿：先清空；没发出去就还回来，除非用户已经开始写下一条。 */
export function useDraftSend(deliver: (text: string) => Promise<boolean>) {
  const [draft, setDraft] = useState("");

  async function send(): Promise<boolean> {
    const text = draft;
    setDraft("");
    const sent = await deliver(text);
    if (!sent) setDraft((current) => (current === "" ? text : current));
    return sent;
  }

  return { draft, setDraft, send };
}
