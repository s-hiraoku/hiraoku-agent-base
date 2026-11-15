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
  });
}

const historyStates = new Set(["queued", "started", "declined", "expired"]);
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

/** Presentation only: retain controller state, cursor, and all HAB decisions. */
export function ReceivedMessages({ view, visible, onChoose }: any) {
  if (!visible || (!view.cards.length && !view.error)) return null;
  const history = view.cards.filter((card: any) =>
    historyStates.has(card.decision?.state),
  );
  const pending = view.cards.filter(
    (card: any) => !historyStates.has(card.decision?.state),
  );
  let pendingList: HTMLDivElement | null = null;
  const renderCard = (card: any) =>
    h(
      "article",
      { key: displayKey(card.notice) },
      h("div", null, "送信元: ", card.notice.address || card.notice.sender_id),
      h(
        "p",
        { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } },
        card.notice.text,
      ),
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
          ...pending.map(renderCard),
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
            ...history.map(renderCard),
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
