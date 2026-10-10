import type { ClientConnection } from "@repa/base/client";

declare global {
  interface Window {
    repaHost: {
      getConnection(): Promise<ClientConnection>;
    };
  }
}

export {};
