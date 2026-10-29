import { randomUUID } from "node:crypto";

type ReverseResult<Value> = { value: Value } | { error: Error };

interface ReversePending<Peer, Data, Value = unknown> {
  id: string;
  peer: Peer;
  data: Data;
  result: Promise<Value>;
  end(result: ReverseResult<Value>, reason?: string): void;
  disconnect(): void;
  close(): void;
}

/** 三种反向请求共用编号、待答表和连接索引；各自的错误与关闭通知由调用方提供。 */
export class ReverseRequests<Peer, Data> {
  private readonly pending = new Map<string, ReversePending<Peer, Data>>();
  private readonly peers = new Map<Peer, Set<string>>();

  create<Value>(peer: Peer, data: Data, options: {
    signal?: AbortSignal;
    aborted(): Error;
    disconnected(): Error;
    closed(): Error;
    notifyClosed?(id: string, reason: string): void;
  }): ReversePending<Peer, Data, Value> {
    const id = randomUUID();
    const abort = () => pending.end({ error: options.aborted() }, "aborted");
    let resolve: (value: Value) => void = () => undefined;
    let reject: (error: Error) => void = () => undefined;
    const result = new Promise<Value>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    const pending: ReversePending<Peer, Data, Value> = {
      id,
      peer,
      data,
      result,
      end: (result, reason) => {
        if (!this.pending.delete(id)) return;
        const ids = this.peers.get(peer);
        ids?.delete(id);
        if (ids?.size === 0) this.peers.delete(peer);
        options.signal?.removeEventListener("abort", abort);
        if (reason !== undefined) options.notifyClosed?.(id, reason);
        if ("error" in result) reject(result.error);
        else resolve(result.value);
      },
      disconnect: () => pending.end({ error: options.disconnected() }),
      close: () => pending.end({ error: options.closed() }, "closed"),
    };
    this.pending.set(id, pending);
    let ids = this.peers.get(peer);
    if (ids === undefined) {
      ids = new Set();
      this.peers.set(peer, ids);
    }
    ids.add(id);
    options.signal?.addEventListener("abort", abort, { once: true });
    return pending;
  }

  get(id: string): ReversePending<Peer, Data> | undefined {
    return this.pending.get(id);
  }

  endPeer(peer: Peer): void {
    for (const id of [...this.peers.get(peer) ?? []]) this.pending.get(id)?.disconnect();
  }

  endWhere(predicate: (data: Data) => boolean): void {
    for (const pending of [...this.pending.values()]) {
      if (predicate(pending.data)) pending.close();
    }
  }
}
