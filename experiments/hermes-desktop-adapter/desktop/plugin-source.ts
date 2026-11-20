import * as sdk from "@hermes/plugin-sdk";
import { createElement as h, useEffect, useRef, useState } from "react";
import { canChoose, createDisplayController, ownerKey } from "./controller.ts";
import { displayKey } from "../../../src/agent-notify/display-projection.ts";

function Receiver({ ctx, owner }: any) {
  const [view, setView] = useState({
    cards: [],
    error: "",
    busy: false,
  } as any);
  const controller = useRef<any>(null);
  const storageKey = `hab-desktop-adapter:dismissed:${ownerKey(owner)}`;
  const [dismissed, setDismissed] = useState(() => loadDismissed(storageKey));
  useEffect(() => {
    const instance = createDisplayController(ctx.rest, owner, setView);
    controller.current = instance;
    void instance.refresh();
    const cancel = ctx.setInterval(() => void instance.refresh(), 10000);
    return () => {
      instance.dispose();
      cancel();
      controller.current = null;
    };
  }, [ctx, ownerKey(owner), owner.visible]);
  return h(ReceivedMessages, {
    view,
    visible: owner.visible,
    onChoose: (key: string, choice: string) =>
      void controller.current?.decide(key, choice),
    dismissed,
    onDismiss: (keys: string[]) =>
      setDismissed((current: string[]) => {
        const next = rememberDismissed(current, keys);
        saveDismissed(storageKey, next);
        return next;
      }),
  });
}

/** How many closed cards this screen remembers; the oldest are forgotten first. */
export const DISMISSED_LIMIT = 200;
/**
 * Closing a card is this screen's own choice: it moves the card into the closed history
 * and never changes HAB's decision, the cursor, or the conversation (owner, 2026-11-20).
 */
export function rememberDismissed(
  current: readonly string[],
  keys: readonly string[],
) {
  const next = current.filter((key) => !keys.includes(key));
  next.push(...new Set(keys));
  return next.slice(-DISMISSED_LIMIT);
}
function loadDismissed(storageKey: string): string[] {
  try {
    const value = JSON.parse(
      globalThis.localStorage?.getItem(storageKey) ?? "[]",
    );
    return Array.isArray(value)
      ? value.filter((key) => typeof key === "string").slice(-DISMISSED_LIMIT)
      : [];
  } catch {
    return [];
  }
}
function saveDismissed(storageKey: string, keys: readonly string[]) {
  try {
    globalThis.localStorage?.setItem(storageKey, JSON.stringify(keys));
  } catch {
    // Storage may be unavailable; the card stays closed until the window reloads.
  }
}

const historyStates = new Set(["queued", "started", "declined", "expired"]);
/** Handed to the conversation: the newest stay readable above the input (owner, 2026-11-18). */
const acceptedStates = new Set(["queued", "started"]);
/** How many of the newest accepted messages stay visible; older ones fold into history. */
export const RECENT_ACCEPTED = 5;
const stateLabels: Record<string, string> = {
  showing: "通知を準備中",
  shown: "未対応",
  later: "あとで対応",
  declining: "辞退を確認中",
  declined: "対応しない",
  accepting: "受付を確認中",
  accept_waiting: "受付を確認中",
  queued: "会話への受付済み（実行・返信完了ではありません）",
  started: "実行開始（返信完了ではありません）",
  unsupported: "この操作は未対応です",
  unknown: "結果不明です。再送せず状況を確認してください",
  unavailable: "状態を確認できません",
  expired: "期限切れ",
};

/** Each message is a bordered card with an "HAB" badge, so it reads as HAB mail, not chat (owner, 2026-11-18). */
const cardStyle = {
  border: "1px solid rgba(127, 127, 127, 0.45)",
  borderLeft: "4px solid #5b6cff",
  borderRadius: "8px",
  padding: "8px 12px",
  margin: "6px 0",
};
const cardHeaderStyle = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  marginBottom: "4px",
};
const badgeStyle = {
  background: "#5b6cff",
  color: "#ffffff",
  borderRadius: "4px",
  padding: "0 6px",
  fontSize: "0.75em",
  fontWeight: 700,
  letterSpacing: "0.05em",
};

const metaStyle = { fontSize: "0.85em", opacity: 0.8, marginBottom: "6px" };
/** The sender's words sit in their own box, drawn as plain text, never as markup. */
const bodyStyle = {
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  background: "rgba(127, 127, 127, 0.08)",
  borderRadius: "6px",
  padding: "6px 10px",
  margin: "4px 0",
};

/** HAB's facts for a card drawn in fields (ADR-026); null for an older notice. */
export function presentationOf(notice: any) {
  const p = notice?.presentation;
  return p &&
    typeof p === "object" &&
    p.version === 1 &&
    typeof p.heading === "string" &&
    typeof p.kind_label === "string" &&
    typeof notice.body === "string"
    ? p
    : null;
}

/** A deadline as local month/day and time, or the raw value when it is not a date. */
export function shortTime(value: unknown) {
  const time = Date.parse(String(value));
  return Number.isFinite(time)
    ? new Date(time).toLocaleString("ja-JP", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : String(value);
}

/** Presentation only: retain controller state, cursor, and all HAB decisions. */
export function ReceivedMessages({
  view,
  visible,
  onChoose,
  dismissed = [],
  onDismiss,
}: any) {
  if (!visible || (!view.cards.length && !view.error)) return null;
  const closed = new Set<string>(dismissed);
  const canDismiss = typeof onDismiss === "function";
  // An automatic accept hands the message off within seconds, before anyone looks, so
  // the arrival and its body stay on screen after the handoff instead of folding away,
  // until the owner closes it (2026-11-20).
  // Take the newest five first, then drop the closed ones, so closing a card never
  // brings an older one back out of the history.
  const accepted = view.cards.filter((card: any) =>
    acceptedStates.has(card.decision?.state),
  );
  const recent = new Set(
    accepted
      .slice(-RECENT_ACCEPTED)
      .filter((card: any) => !closed.has(displayKey(card.notice))),
  );
  const history = view.cards.filter(
    (card: any) => historyStates.has(card.decision?.state) && !recent.has(card),
  );
  const pending = view.cards.filter(
    (card: any) => !historyStates.has(card.decision?.state),
  );
  let pendingList: HTMLDivElement | null = null;
  // With HAB's facts the heading, kind, deadline and body each get their own place
  // (ADR-026); an older notice keeps the whole display text as it was.
  const renderMessage = (notice: any) => {
    const p = presentationOf(notice);
    if (!p)
      return [
        h(
          "header",
          { style: cardHeaderStyle },
          h("span", { style: badgeStyle }, "HAB"),
          h("strong", null, "HAB からのメッセージ"),
        ),
        h("div", null, "送信元: ", notice.address || notice.sender_id),
        h(
          "p",
          { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } },
          notice.text,
        ),
      ];
    const meta = [
      p.kind_label,
      p.is_reply
        ? "あなたが送ったメッセージへの返事"
        : `返信期限 ${shortTime(p.reply_by)}`,
    ];
    return [
      h(
        "header",
        { style: cardHeaderStyle },
        h("span", { style: badgeStyle }, "HAB"),
        h("strong", null, p.heading),
      ),
      h("div", { style: metaStyle }, meta.join("・")),
      h("div", { style: bodyStyle, "aria-label": "受信内容" }, notice.body),
      p.hidden_data_parts > 0
        ? h(
            "div",
            { style: metaStyle },
            `表示していない構造化データが ${p.hidden_data_parts} 件あります`,
          )
        : null,
    ];
  };
  const renderCard = (card: any, closable = false) =>
    h(
      "article",
      {
        key: displayKey(card.notice),
        "aria-label": "HAB からのメッセージ",
        style: cardStyle,
      },
      ...renderMessage(card.notice),
      h(
        "div",
        { role: "status" },
        card.unavailable
          ? "状態確認待ち（操作できません）"
          : Object.hasOwn(stateLabels, card.decision?.state)
            ? stateLabels[card.decision.state]
            : "状態確認待ち（操作できません）",
      ),
      canChoose(card)
        ? h(
            "div",
            null,
            "対応しますか？",
            ...card.decision.choices.map((choice: any) =>
              h(
                sdk.Button,
                {
                  key: choice.choice,
                  disabled: card.unavailable || view.busy || !!view.error,
                  onClick: () =>
                    onChoose(displayKey(card.notice), choice.choice),
                },
                choice.label,
              ),
            ),
          )
        : null,
      closable && canDismiss
        ? h(
            sdk.Button,
            {
              "aria-label": "このカードを閉じる",
              onClick: () => onDismiss([displayKey(card.notice)]),
            },
            "閉じる",
          )
        : null,
    );
  return h(
    "section",
    { "aria-label": "HAB received messages" },
    pending.length
      ? h(
          "div",
          { role: "status", "aria-live": "polite" },
          "HAB からの受信 · 要確認 ",
          pending.length,
          "件",
        )
      : null,
    view.limited
      ? h(
          "div",
          { role: "status" },
          "古い履歴の一部を表示から省略しました。メッセージへの判断は変更していません。",
        )
      : null,
    view.error
      ? h(
          "div",
          { role: "status" },
          "受信状態を確認できません。操作は停止しています。",
        )
      : null,
    pending.length > 1
      ? h(
          sdk.Button,
          {
            onClick: () => {
              // Explicit navigation only: polling never moves the reader's position.
              if (pendingList) pendingList.scrollTop = pendingList.scrollHeight;
            },
          },
          "末尾の受信通知を表示",
        )
      : null,
    pending.length
      ? h(
          "div",
          {
            ref: (element: HTMLDivElement | null) => {
              pendingList = element;
            },
            tabIndex: 0,
            role: "region",
            "aria-label": "要確認のHAB通知",
            style: { maxHeight: "16rem", overflow: "auto" },
          },
          ...pending.map((card: any) => renderCard(card)),
        )
      : null,
    recent.size
      ? h(
          "div",
          {
            role: "region",
            "aria-label": "最近会話に渡したHAB通知",
            style: { maxHeight: "16rem", overflow: "auto" },
          },
          h(
            "div",
            { role: "status", "aria-live": "polite" },
            "HAB からの受信 · 会話に渡したメッセージ（新しい順に最大 ",
            RECENT_ACCEPTED,
            " 件）",
          ),
          recent.size > 1 && canDismiss
            ? h(
                sdk.Button,
                {
                  onClick: () =>
                    onDismiss(
                      [...recent].map((card: any) => displayKey(card.notice)),
                    ),
                },
                "すべて閉じる",
              )
            : null,
          ...[...recent].reverse().map((card: any) => renderCard(card, true)),
        )
      : null,
    history.some((card: any) => card.unavailable)
      ? h(
          "div",
          { role: "status" },
          "履歴の一部は状態確認待ちです。操作はできません。",
        )
      : null,
    history.length
      ? h(
          "details",
          { key: "history" },
          h(
            "summary",
            null,
            "受付済み・辞退・期限切れの履歴（",
            history.length,
            "件）",
          ),
          h(
            "div",
            { style: { maxHeight: "16rem", overflow: "auto" } },
            ...history.map((card: any) => renderCard(card)),
          ),
        )
      : null,
  );
}

function InlineReceiver({ ctx }: any) {
  const owner = sdk.usePluginComposerContext();
  return owner && owner.visible
    ? h(Receiver, { key: ownerKey(owner), ctx, owner })
    : null;
}
export default {
  id: "hab-desktop-adapter",
  name: "HAB conversation receiver",
  defaultEnabled: false,
  description:
    "Shows received messages in their bound existing conversation; actions require your choice.",
  register(ctx: any) {
    if (
      sdk.PLUGIN_REST_OWNER_SUPPORTED !== true ||
      typeof sdk.usePluginComposerContext !== "function"
    ) {
      ctx.register({
        id: "unsupported",
        area: sdk.COMPOSER_AREAS.top,
        render: () =>
          h(
            "div",
            { role: "status" },
            "HAB: この Desktop は会話所有者を指定する SDK に未対応です。受信・操作は開始していません。",
          ),
      });
      return;
    }
    ctx.register({
      id: "receiver",
      area: sdk.COMPOSER_AREAS.top,
      render: () => h(InlineReceiver, { ctx }),
    });
  },
};
