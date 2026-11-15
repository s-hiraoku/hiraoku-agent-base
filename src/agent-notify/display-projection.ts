/** Pure, product-neutral display cache. Never authorizes delivery or performs I/O. */
export interface DisplayKey {
  binding_id: string;
  sender_id: string;
  message_id: string;
}
export interface DisplayState extends DisplayKey {
  state: string;
  revision: number;
  choices: { choice: string; label: string }[];
}
export interface DisplayNotice extends DisplayKey {
  text: string;
  [key: string]: unknown;
}
export interface DisplayCard {
  notice: DisplayNotice;
  decision?: DisplayState;
  unavailable: boolean;
}
export const displayKey = (key: DisplayKey): string =>
  JSON.stringify([key.binding_id, key.sender_id, key.message_id]);
export function projectDisplaySnapshot(
  previous: DisplayCard[],
  page: {
    events: DisplayNotice[];
    decision_states: DisplayState[];
    decision_checked_keys: DisplayKey[];
    decision_error_keys: DisplayKey[];
  },
  bindingId: string,
  onTruncate?: () => void,
): DisplayCard[] {
  if (
    !page ||
    !Array.isArray(page.events) ||
    page.events.length > 400 ||
    !Array.isArray(page.decision_states) ||
    !Array.isArray(page.decision_checked_keys) ||
    !Array.isArray(page.decision_error_keys) ||
    page.decision_states.length > 450 ||
    page.decision_checked_keys.length > 450 ||
    page.decision_error_keys.length > 450
  )
    throw new Error("Invalid display snapshot");
  const keyOf = (key: DisplayKey) => {
    if (
      !key ||
      key.binding_id !== bindingId ||
      ![key.sender_id, key.message_id].every(
        (v) => typeof v === "string" && v.length > 0 && v.length <= 2048,
      )
    )
      throw new Error("Invalid display identity");
    return displayKey(key);
  };
  const checked = new Set(page.decision_checked_keys.map(keyOf));
  const errors = new Set(page.decision_error_keys.map(keyOf));
  if (
    checked.size !== page.decision_checked_keys.length ||
    errors.size !== page.decision_error_keys.length ||
    [...errors].some((key) => checked.has(key))
  )
    throw new Error("Conflicting display scope");
  const states = new Map<string, DisplayState>();
  for (const state of page.decision_states) {
    const key = keyOf(state);
    if (
      !checked.has(key) ||
      states.has(key) ||
      !Number.isSafeInteger(state.revision) ||
      state.revision < 0 ||
      typeof state.state !== "string" ||
      !/^[a-z_]{1,32}$/.test(state.state) ||
      !Array.isArray(state.choices) ||
      state.choices.length > 3 ||
      state.choices.some(
        (choice) =>
          !choice ||
          !["accept", "later", "decline"].includes(choice.choice) ||
          typeof choice.label !== "string" ||
          !choice.label ||
          choice.label.length > 128,
      ) ||
      new Set(state.choices.map((choice) => choice.choice)).size !==
        state.choices.length
    )
      throw new Error("Invalid display state");
    states.set(key, state);
  }
  const cards = new Map(previous.map((card) => [keyOf(card.notice), card]));
  for (const notice of page.events) {
    const key = keyOf(notice);
    if (typeof notice.text !== "string" || notice.text.length > 131072)
      throw new Error("Invalid display notice");
    const old = cards.get(key);
    // Stable field order is not part of the transport contract.
    const canonical = (value: DisplayNotice) =>
      JSON.stringify(
        Object.keys(value)
          .filter((key) => !["event_id", "received_at"].includes(key))
          .sort()
          .map((k) => [k, value[k]]),
      );
    if (old && canonical(old.notice) !== canonical(notice))
      throw new Error("Immutable notice changed");
    if (!old) cards.set(key, { notice, unavailable: true });
  }
  const projected = [...cards].map(([key, card]) => {
    if (errors.has(key)) return { ...card, unavailable: true };
    if (!checked.has(key)) return card;
    const next = states.get(key);
    if (!next) return { ...card, unavailable: true };
    const old = card.decision;
    if (old && old.revision > next.revision) return card;
    if (
      old &&
      old.revision === next.revision &&
      (old.state !== next.state ||
        JSON.stringify(old.choices) !== JSON.stringify(next.choices))
    )
      throw new Error("Conflicting state revision");
    return { ...card, decision: next, unavailable: false };
  });
  const sizes = new Map(
    projected.map((card) => [
      card,
      new TextEncoder().encode(JSON.stringify(card)).length + 1,
    ]),
  );
  let bytes = 2 + [...sizes.values()].reduce((a, b) => a + b, 0);
  let truncated = false;
  while (projected.length > 1000 || bytes > 8 * 1024 * 1024) {
    const terminal = projected.findIndex(
      (card) =>
        card.decision &&
        [
          "queued",
          "started",
          "declined",
          "expired",
          "unavailable",
          "unsupported",
        ].includes(card.decision.state),
    );
    const [removed] = projected.splice(terminal >= 0 ? terminal : 0, 1);
    bytes -= sizes.get(removed)!;
    truncated = true;
  }
  if (truncated) onTruncate?.();
  return projected;
}
