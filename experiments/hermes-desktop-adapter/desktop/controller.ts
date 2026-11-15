import {
  displayKey,
  projectDisplaySnapshot,
  type DisplayCard,
} from "../../../src/agent-notify/display-projection.ts";
export interface ComposerOwner {
  storedSessionId: string;
  connectionId: string;
  profile: string;
  visible: boolean;
}
export interface Binding {
  binding_id: string;
  stored_session_id: string;
  connection_id: string;
  profile: string;
  backend_namespace: string;
  profile_scope: string;
  receiver_id: string;
}
export const ownerKey = (owner: ComposerOwner) =>
  JSON.stringify([owner.connectionId, owner.profile, owner.storedSessionId]);
export function bindingMatches(
  binding: Binding,
  owner: ComposerOwner,
): boolean {
  return (
    !!binding &&
    [
      "binding_id",
      "stored_session_id",
      "connection_id",
      "profile",
      "backend_namespace",
      "profile_scope",
      "receiver_id",
    ].every(
      (key) =>
        typeof binding[key as keyof Binding] === "string" &&
        binding[key as keyof Binding].length > 0,
    ) &&
    binding.stored_session_id === owner.storedSessionId &&
    binding.connection_id === owner.connectionId &&
    binding.profile === owner.profile
  );
}
export function selectRetainedKeys(cards: DisplayCard[], offset: number) {
  const keys: { sender_id: string; message_id: string }[] = [];
  const skipped = new Set<string>();
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  let visited = 0;
  while (visited < cards.length && visited < 20) {
    const card = cards[(offset + visited) % cards.length];
    const key = {
      sender_id: card.notice.sender_id,
      message_id: card.notice.message_id,
    };
    if (
      bytes(key.sender_id) > 512 ||
      bytes(key.message_id) > 512 ||
      bytes(JSON.stringify([key])) > 12000
    ) {
      skipped.add(displayKey(card.notice));
      visited++;
      continue;
    }
    if (bytes(JSON.stringify([...keys, key])) > 12000) break;
    keys.push(key);
    visited++;
  }
  return {
    keys,
    skipped,
    offset: cards.length ? (offset + visited) % cards.length : 0,
  };
}
export function canChoose(card: DisplayCard): boolean {
  return (
    !card.unavailable &&
    !!card.decision &&
    ["shown", "later"].includes(card.decision.state) &&
    card.decision.choices.length > 0
  );
}
export function createDisplayController(
  rest: (path: string, options: any) => Promise<any>,
  owner: ComposerOwner,
  publish: (view: any) => void,
  now: () => number = () => performance.now(),
) {
  let closed = false,
    loading = false,
    busy = false,
    binding: Binding | undefined,
    after = "",
    offset = 0;
  let cards: DisplayCard[] = [];
  let limited = false;
  const options = {
    owner: { connectionId: owner.connectionId, profile: owner.profile },
    timeoutMs: 20000,
  };
  let lastError = "";
  const show = (error?: string) => {
    if (error !== undefined) lastError = error;
    if (!closed)
      publish({ cards, error: lastError, busy: busy || loading, limited });
  };
  const identity = () => ({
    binding_id: binding!.binding_id,
    stored_session_id: owner.storedSessionId,
    connection_id: owner.connectionId,
    profile: owner.profile,
  });
  const path = `/sessions/${encodeURIComponent(owner.storedSessionId)}`;
  async function refresh() {
    if (closed || loading || busy || !owner.visible) return;
    loading = true;
    const deadline = now() + 20000;
    show();
    try {
      if (!binding) {
        const result = await rest("/binding", options);
        if (closed) return;
        if (!bindingMatches(result, owner)) return;
        binding = result;
      }
      // Bound catch-up work; the timer resumes from the last validated cursor.
      for (let count = 0; count < 4; count++) {
        const remaining = deadline - now();
        if (remaining <= 0) break;
        const selected = selectRetainedKeys(cards, offset);
        const retained = selected.keys;
        offset = selected.offset;
        cards = cards.map((card) =>
          selected.skipped.has(displayKey(card.notice))
            ? { ...card, unavailable: true }
            : card,
        );
        const page = await rest(`${path}/query`, {
          ...options,
          timeoutMs: Math.max(1, Math.floor(remaining)),
          method: "POST",
          body: {
            ...identity(),
            ...(after ? { after } : {}),
            retained_keys: retained,
          },
        });
        if (closed) return;
        if (
          page.binding_id !== binding.binding_id ||
          typeof page.next_cursor !== "string" ||
          page.next_cursor.length > 2048
        )
          throw new Error("Receiver identity changed.");
        for (const event of page.events ?? []) {
          if (
            event.stored_session_id !== owner.storedSessionId ||
            event.backend_namespace !== binding.backend_namespace ||
            event.profile_scope !== binding.profile_scope ||
            event.receiver_id !== binding.receiver_id
          )
            throw new Error("Notice belongs to another conversation.");
        }
        cards = projectDisplaySnapshot(cards, page, binding.binding_id, () => {
          limited = true;
        });
        const previousCursor = after;
        after = page.next_cursor;
        show("");
        if (page.has_more !== true || after === previousCursor) break;
      }
    } catch (error) {
      cards = cards.map((card) => ({ ...card, unavailable: true }));
      show(String(error));
    } finally {
      loading = false;
      show();
    }
  }
  async function decide(key: string, choice: string) {
    const card = cards.find((item) => displayKey(item.notice) === key);
    if (
      closed ||
      loading ||
      busy ||
      !binding ||
      !owner.visible ||
      !card ||
      !canChoose(card) ||
      !card.decision?.choices.some((item) => item.choice === choice)
    )
      return false;
    busy = true;
    show();
    try {
      // Backend revalidates the single key and immutable binding before recording intent.
      await rest(`${path}/decision`, {
        ...options,
        timeoutMs: 60000,
        method: "POST",
        body: {
          ...identity(),
          sender_id: card.notice.sender_id,
          message_id: card.notice.message_id,
          choice,
        },
      });
      if (!closed)
        cards = cards.map((item) =>
          displayKey(item.notice) === key
            ? { ...item, unavailable: true }
            : item,
        );
      return true;
    } catch (error) {
      cards = cards.map((item) => ({ ...item, unavailable: true }));
      show(String(error));
      return false;
    } finally {
      busy = false;
      if (!closed) {
        show();
        await refresh();
      }
    }
  }
  return {
    refresh,
    decide,
    dispose() {
      closed = true;
    },
  };
}
