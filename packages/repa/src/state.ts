import type { Change, Scope, SessionKey, Snapshot } from "./protocol.js";

export function contains(scope: Scope, key: Partial<SessionKey>): boolean {
  return (
    (!("spaceId" in scope) || scope.spaceId === key.spaceId) &&
    (!("sessionId" in scope) || scope.sessionId === key.sessionId)
  );
}

export function relevant(scope: Scope, change: Change): boolean {
  if (change.type === "settings") {
    if (change.scope.kind === "application") return true;
    if (change.scope.kind === "space") return !("spaceId" in scope) || scope.spaceId === change.scope.spaceId;
    return contains(scope, change.scope);
  }
  if (change.type === "content") return !("spaceId" in scope) || scope.spaceId === change.spaceId;
  if (change.type === "lifecycle") return true;
  if (change.type === "space")
    return !("spaceId" in scope) || scope.spaceId === change.space.id;
  if (change.type === "session") return contains(scope, change.session);
  if (change.type === "run") return contains(scope, change.run);
  return contains(scope, change);
}

function upsert<T>(items: T[], item: T, matches: (item: T) => boolean): void {
  const index = items.findIndex(matches);
  if (index < 0) items.push(item);
  else items[index] = item;
}

/** Applies the public changes in place; callers choose when to copy or render their state. */
export function applyChange(state: Snapshot, change: Change): void {
  if (change.type === "session_removed") {
    state.sessions = state.sessions.filter(session => session.spaceId !== change.spaceId || session.sessionId !== change.sessionId);
    return;
  }
  if (change.type === "settings") return;
  if (change.type === "content") {
    const space = state.spaces.find((entry) => entry.id === change.spaceId);
    if (space) space.contentRevision = change.revision;
    return;
  }
  if (change.type === "lifecycle") {
    state.lifecycle = change.lifecycle;
    return;
  }
  if (change.type === "space") {
    upsert(state.spaces, change.space, (x) => x.id === change.space.id);
    return;
  }
  if (change.type === "session") {
    upsert(
      state.sessions,
      change.session,
      (x) =>
        x.spaceId === change.session.spaceId &&
        x.sessionId === change.session.sessionId,
    );
    return;
  }
  const key = change.type === "run" ? change.run : change;
  const session = state.sessions.find(
    (x) => x.spaceId === key.spaceId && x.sessionId === key.sessionId,
  );
  if (!session) return;
  if (change.type === "message") {
    upsert(
      session.messages,
      change.message,
      (x) => x.id === change.message.id || x.id === change.replaces,
    );
  } else if (change.type === "delta") {
    const message = session.messages.find((x) => x.id === change.messageId);
    if (!message) return;
    while (message.content.length <= change.index)
      message.content.push({ type: change.kind, text: "" });
    const block = message.content[change.index];
    if (block?.type === change.kind) block.text += change.text;
  } else if (change.type === "run") {
    upsert(session.runs, change.run, (x) => x.id === change.run.id);
  } else if (change.type === "interaction") {
    session.interactions = session.interactions.filter(
      (x) => x.id !== change.id,
    );
    if (change.interaction) session.interactions.push(change.interaction);
  } else if (change.type === "notice") {
    upsert(session.notices, change.notice, (x) => x.id === change.notice.id);
  }
}
