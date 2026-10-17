/** Presentation only: supplied terminal IO confers no management/individual authority. */
import { EnrollmentError } from "./enrollment.ts";
import type { EnrollmentUI } from "./enrollment.ts";
export interface EnrollmentTerminal {
  write(text: string): void;
  /** Host must bound input size, idle time and terminal lifetime. null means EOF/cancel. */
  question(prompt: string): Promise<string | null>;
}
export function enrollmentTerminalUI(io: EnrollmentTerminal): EnrollmentUI {
  const ask = async (prompt: string) => {
    const result = await io.question(prompt);
    if (
      result !== null &&
      (typeof result !== "string" ||
        result.length > 256 ||
        /[\x00-\x1f\x7f]/.test(result))
    )
      throw new EnrollmentError("invalid_enrollment_choice");
    return result;
  };
  return {
    async product(page) {
      io.write("登録する製品を選択してください。\n");
      page.products.forEach((p, i) => io.write(`${i + 1}. ${p.agent_name}\n`));
      const value = await ask(
        page.next ? "番号 / n: 次のページ / q: 中断 > " : "番号 / q: 中断 > ",
      );
      if (value === null || value === "q") return null;
      if (value === "n" && page.next) return "next";
      if (!/^[1-9][0-9]{0,2}$/.test(value))
        throw new EnrollmentError("invalid_enrollment_choice");
      const product = page.products[Number(value) - 1];
      if (!product) throw new EnrollmentError("invalid_enrollment_choice");
      return product.product_id;
    },
    async botName(product) {
      const value = await ask(
        `<bot_name>@${product.agent_name}.hab のbot_name（小文字英数字・ハイフン、1–48文字） / q: 中断 > `,
      );
      return value === "q" ? null : value;
    },
    async confirm(value) {
      if (value.kind === "reserve")
        io.write(
          `${value.address} を確定します。確定後は変更・再割当てできません。まだ送受信は有効になりません。\n`,
        );
      else if (value.kind === "bind")
        io.write(
          `${value.address} に検証済み接続「${value.connection_label}」を結び付けます。送受信は別途有効化します。\n`,
        );
      else
        io.write(
          `${value.address} を有効化します。許可する操作: ${value.operations.join(", ")}\n`,
        );
      // Requiring the exact visible address avoids a generic yes applying to a different proposal.
      return (
        (await ask("確認するHABアドレスを入力 / それ以外: 中断 > ")) ===
        value.address
      );
    },
    async operations(agent, allowed) {
      io.write(`${agent.address} に必要な操作だけを選択してください。\n`);
      allowed.forEach((op, i) => io.write(`${i + 1}. ${op}\n`));
      const value = await ask("番号をカンマ区切りで指定 / q: 中断 > ");
      if (value === null || value === "q") return null;
      if (!/^[1-5](?:,[1-5]){0,4}$/.test(value))
        throw new EnrollmentError("invalid_enrollment_choice");
      return value.split(",").map((n) => allowed[Number(n) - 1]);
    },
  };
}
