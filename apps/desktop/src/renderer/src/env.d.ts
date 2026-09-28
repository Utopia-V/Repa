import type { ClientConnection } from "repa/client";

declare global {
  interface Window {
    repaHost: {
      getConnection(): Promise<ClientConnection>;
    };
  }
}

export {};
