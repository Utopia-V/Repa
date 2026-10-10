import type { ActivitySource, Revision, Snapshot, UndoResult } from "@repa/space-history";
import type { Files, History } from "./plugin.js";

export interface Space {
  root: string;
  dataDir: string;
  sessionsDir: string;
  history: History & {
    undo(revision: string): Promise<UndoResult>;
  };
  files: Files;
  filesFor(source: ActivitySource): Files;
  pluginDataDir(id: string): Promise<string>;
  record<T>(source: ActivitySource, action: () => Promise<T>): Promise<{ value: T; snapshot: Snapshot }>;
  onRevision(listener: (revision: Revision) => void): () => void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface SpaceOptions {
  watch?: boolean;
  onError?(error: unknown): void;
}

export { openSpace, createSpace } from "./space/space.js";
