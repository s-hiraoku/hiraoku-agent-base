import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  ContractError,
  type ContractLimits,
} from "../src/messaging/contract.ts";
import {
  checkNativeTrialMessage,
  prepareNativeTrialMessage,
} from "./lib/native-trial-message.ts";

// Operator-selected JSON only. This command has no credentials or transport.
try {
  const [action, inputPath, limitsPath, outputPath, ...extra] =
    process.argv.slice(2);
  if (
    extra.length ||
    !inputPath ||
    !limitsPath ||
    (action !== "prepare" && action !== "check") ||
    (action === "prepare" ? !outputPath : outputPath !== undefined)
  )
    throw Error("invalid_arguments");
  const input: unknown = JSON.parse(readFileSync(inputPath, "utf8"));
  const limits = JSON.parse(readFileSync(limitsPath, "utf8")) as ContractLimits;
  if (action === "prepare") {
    const message = prepareNativeTrialMessage(input, limits);
    const fd = openSync(outputPath!, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(message) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    console.log(JSON.stringify({ prepared: true, submitted: false }));
  } else {
    checkNativeTrialMessage(input, limits);
    console.log(
      JSON.stringify({
        schema_valid: true,
        unexpired: true,
        authorization_verified: false,
        submitted: false,
      }),
    );
  }
} catch (error) {
  const code =
    error instanceof ContractError
      ? error.code
      : error instanceof Error && error.message === "trial_message_expired"
        ? error.message
        : "invalid_or_unreadable_trial_message";
  console.error(code);
  process.exitCode = 1;
}
