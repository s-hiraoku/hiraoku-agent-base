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
  if (!owner.visible || (!view.cards.length && !view.error)) return null;
  return h(
    "section",
    {
      "aria-label": "HAB received messages",
      style: { maxHeight: "16rem", overflow: "auto" },
    },
    h("div", null, "HAB からの受信 · ", owner.storedSessionId),
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
    ...view.cards.map((card: any) =>
      h(
        "article",
        { key: displayKey(card.notice) },
        h(
          "div",
          null,
          "送信元: ",
          card.notice.address || card.notice.sender_id,
        ),
        h(
          "p",
          { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } },
          card.notice.text,
        ),
        h(
          "div",
          { role: "status" },
          card.unavailable ? "状態確認待ち" : card.decision?.state,
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
                      void controller.current?.decide(
                        displayKey(card.notice),
                        choice.choice,
                      ),
                  },
                  choice.label,
                ),
              ),
            )
          : null,
      ),
    ),
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
