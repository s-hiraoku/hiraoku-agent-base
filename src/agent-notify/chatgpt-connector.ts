/**
 * The screen for agents reached through a ChatGPT connector, such as Dots (ADR-021). ChatGPT
 * talks to HAB only as an MCP client: it calls tools when the model decides to, and its
 * widgets appear only as the result of such a call. There is no public way for HAB to show
 * something in a ChatGPT conversation, or to start work in it, from outside. So the notice is
 * shown outside ChatGPT (the notice file and an optional display command), and `handoff` is
 * always `unsupported`: after 対応する, the user opens the conversation and asks it to read
 * the message with `hab_inbox`. Nothing falls back to another session or a CLI.
 */
import type { HandoffResult } from "./contract.ts";

export interface ChatGptConnectorBinding {
  /** A label for the conversation or project the user uses with this agent. */
  conversation: string;
}

export const chatgptConnectorTarget = (binding: ChatGptConnectorBinding) =>
  `chatgpt-connector:${binding.conversation}`;

export const chatgptConnectorHandoff = async (): Promise<HandoffResult> =>
  "unsupported";
