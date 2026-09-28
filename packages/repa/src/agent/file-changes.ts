import { DEFAULT_MAX_BYTES, generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import type { ContentChangeResult, ContentInfo } from "../content/schema.js";
import type { ContentStore } from "../content/store.js";
import { RepaFault } from "../errors.js";
import { SerialQueue } from "../storage/atomic.js";

type Mode = "on-demand" | "notice" | "diff";
type Observation = {
  info: ContentInfo;
  complete: boolean;
  bytes?: Buffer;
  unreported?: string | null;
};
type Difference = { patch?: string; bytes?: Buffer; reason?: string };
type Change = {
  path: string;
  previousPath?: string;
  target: ContentInfo["target"];
  before: string | null;
  after: string | null;
  status: ContentInfo["status"];
  kind: "notice" | "diff";
  reason?: string;
};

function key(info: ContentInfo): string {
  return info.ref ? `content:${info.ref.spaceId}:${info.ref.id}` : `file:${info.location.path}`;
}

function sameBody(left: ContentInfo, right: ContentInfo): boolean {
  return left.bodyRevision === right.bodyRevision && left.status === right.status;
}

function text(bytes: Buffer, info: ContentInfo): string | undefined {
  if (bytes.length > DEFAULT_MAX_BYTES || bytes.includes(0) || info.mediaType === "application/pdf" ||
    /^(?:audio|video)\//.test(info.mediaType) || /^image\/(?!svg\+xml)/.test(info.mediaType)) return undefined;
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return undefined; }
}

/** 当前 Host 已观察文件的内存基准；通过内容模块检查当前权限与实际版本。 */
export class FileChanges {
  readonly #observed = new Map<string, Observation>();
  readonly #queue = new SerialQueue();

  constructor(readonly content: ContentStore) {}

  #inSpace(info: ContentInfo): boolean {
    const spaceId = info.target.kind === "content" ? info.target.ref.spaceId : info.target.spaceId;
    return info.location.kind === "relative" && spaceId === this.content.options.spaceId;
  }

  #previous(info: ContentInfo): [string, Observation] | undefined {
    const exact = this.#observed.get(key(info));
    if (exact) return [key(info), exact];
    // 原路径随后登记了内容身份时，沿用同一文件已有的观察。
    const fileKey = `file:${info.location.path}`;
    const file = this.#observed.get(fileKey);
    return file ? [fileKey, file] : undefined;
  }

  #remember(info: ContentInfo, value: Omit<Observation, "info">): void {
    const previous = this.#previous(info);
    if (previous) this.#observed.delete(previous[0]);
    this.#observed.set(key(info), { info: structuredClone(info), ...value });
  }

  recordRead(info: ContentInfo, bytes: Buffer, complete: boolean): void {
    if (!this.#inSpace(info) || info.status !== "available" || !info.bodyRevision) return;
    const previous = this.#previous(info)?.[1];
    const retained = previous?.complete && sameBody(previous.info, info);
    this.#remember(info, {
      complete: complete || Boolean(retained),
      ...(complete && bytes.length <= DEFAULT_MAX_BYTES ? { bytes: Buffer.from(bytes) }
        : retained && previous.bytes ? { bytes: previous.bytes } : {}),
    });
  }

  async recordSaved(result: ContentChangeResult): Promise<void> {
    for (const info of result.contents) {
      if (!this.#inSpace(info)) continue;
      const previous = this.#previous(info)?.[1];
      if (!previous && !info.bodyRevision) continue;
      const change = result.changes.find((item) => item.path === info.location.path && item.after === info.bodyRevision);
      const unchanged = previous && sameBody(previous.info, info);
      const movedFrom = previous && previous.info.location.path !== info.location.path &&
        result.changes.some((item) => item.path === previous.info.location.path &&
          item.before === previous.info.bodyRevision && item.after === null);
      const knownBase = previous && change && (change.before === previous.info.bodyRevision ||
        (movedFrom && change.before === null));
      const unreported = previous?.unreported !== undefined ? previous.unreported
        : previous && !unchanged && !knownBase ? previous.info.bodyRevision ?? null : undefined;
      this.#remember(info, {
        complete: Boolean(previous?.complete && (unchanged || knownBase) &&
          unreported === undefined && info.status === "available" && info.bodyRevision),
        ...(unchanged && previous.bytes ? { bytes: previous.bytes } : {}),
        ...(unreported !== undefined ? { unreported } : {}),
      });
    }
  }

  async #difference(previous: Observation, current: ContentInfo): Promise<Difference> {
    if (previous.unreported !== undefined) return { reason: "unreported_before_save" };
    if (!previous.complete) return { reason: "partial" };
    if (!previous.info.bodyRevision || !current.bodyRevision || current.status !== "available")
      return { reason: "unavailable" };
    if ((previous.info.size ?? 0) > DEFAULT_MAX_BYTES || (current.size ?? 0) > DEFAULT_MAX_BYTES)
      return { reason: "large" };
    let before: Buffer, after: Buffer;
    try {
      [before, after] = await Promise.all([
        previous.bytes ?? this.content.blobs.get(previous.info.bodyRevision),
        this.content.blobs.get(current.bodyRevision),
      ]);
    } catch { return { reason: "unavailable" }; }
    const oldText = text(before, previous.info), newText = text(after, current);
    if (oldText === undefined || newText === undefined) return { reason: "binary" };
    const patch = generateUnifiedPatch(current.location.path, oldText, newText);
    return Buffer.byteLength(patch) <= DEFAULT_MAX_BYTES ? { patch, bytes: after } : { reason: "large" };
  }

  prepare(mode: Mode): Promise<{ text: string; details: unknown } | undefined> {
    if (mode === "on-demand") return Promise.resolve(undefined);
    return this.#queue.run(async () => {
      const parts = ["已观察文件有变化："];
      const changes: Change[] = [];
      for (const [id, previous] of [...this.#observed]) {
        let current: ContentInfo;
        try { current = await this.content.get(previous.info.target); }
        catch (error) {
          // 临时 Skill 读取与后来移到空间外的文件不扩展此跟踪器的读取授权。
          if (error instanceof RepaFault && error.code === "permission_required") continue;
          throw error;
        }
        if (this.#observed.get(id) !== previous || !this.#inSpace(current)) continue;
        const moved = previous.info.location.path !== current.location.path;
        const unchanged = sameBody(previous.info, current);
        if (unchanged && !moved && previous.unreported === undefined) {
          this.#remember(current, { complete: previous.complete, ...(previous.bytes ? { bytes: previous.bytes } : {}) });
          continue;
        }
        const difference = mode === "diff" && !unchanged ? await this.#difference(previous, current) : {};
        if (this.#observed.get(id) !== previous) continue;
        const label = JSON.stringify(current.location.path);
        let reason = difference.reason;
        let patch = difference.patch;
        if (patch && Buffer.byteLength([...parts, `${label}\n${patch}`].join("\n\n")) > DEFAULT_MAX_BYTES) {
          patch = undefined;
          reason = "large";
        }
        const notice = current.status === "missing" ? "文件已不存在。"
          : current.status === "detached" ? "材料关联已移除。"
          : current.status === "needs_recovery" ? "内容正在等待恢复。"
          : !current.bodyRevision ? "目标已不是普通文件。"
          : previous.unreported !== undefined ? "工具保存前已有其他变化，需要时重新读取。"
          : unchanged && moved ? `位置已从 ${JSON.stringify(previous.info.location.path)} 移到此处。`
          : reason === "partial" ? "正文已变化；此前未取得完整正文，需要时重新读取。"
          : reason === "binary" ? "非文本内容已变化，需要时重新读取。"
          : reason === "large" ? "正文或差异较大，已保留路径提示。"
          : "正文已变化，需要时重新读取。";
        const part = patch ? `${label}\n${patch}` : `${label}：${notice}`;
        if (changes.length && Buffer.byteLength([...parts, part].join("\n\n")) > DEFAULT_MAX_BYTES) break;
        parts.push(part);
        changes.push({
          path: current.location.path,
          ...(moved ? { previousPath: previous.info.location.path } : {}),
          target: structuredClone(current.target),
          before: previous.unreported !== undefined ? previous.unreported : previous.info.bodyRevision ?? null,
          after: current.bodyRevision ?? null,
          status: current.status,
          kind: patch ? "diff" : "notice",
          ...(reason ? { reason } : {}),
        });
        this.#remember(current, {
          complete: Boolean(patch || (unchanged && previous.complete && previous.unreported === undefined)),
          ...(patch && difference.bytes ? { bytes: difference.bytes }
            : unchanged && previous.bytes ? { bytes: previous.bytes } : {}),
        });
      }
      return changes.length ? { text: parts.join("\n\n"), details: { mode, changes } } : undefined;
    });
  }
}
