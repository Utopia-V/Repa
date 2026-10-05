import assert from "node:assert/strict";
import { createConnection, createServer, type Socket } from "node:net";
import type { ClientConnection } from "repa/client";

/** 只控制真实 TCP 通道的通断，不解析或伪造应用协议与客户端状态。 */
export async function connectionProxy(connection: ClientConnection) {
  const upstream = new URL(connection.url);
  const sockets = new Set<Socket>();
  let online = true;
  const server = createServer(incoming => {
    if (!online) {
      incoming.destroy();
      return;
    }
    const outgoing = createConnection({ host: upstream.hostname, port: Number(upstream.port) });
    sockets.add(incoming);
    sockets.add(outgoing);
    incoming.pipe(outgoing).pipe(incoming);
    incoming.on("error", () => outgoing.destroy());
    outgoing.on("error", () => incoming.destroy());
    incoming.on("close", () => {
      sockets.delete(incoming);
      outgoing.destroy();
    });
    outgoing.on("close", () => {
      sockets.delete(outgoing);
      incoming.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = new URL(connection.url);
  url.host = `127.0.0.1:${address.port}`;
  return {
    connection: { ...connection, url: url.toString() },
    disconnect(): void {
      online = false;
      for (const socket of sockets) socket.destroy();
    },
    reconnect(): void { online = true; },
    async close(): Promise<void> {
      online = false;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
