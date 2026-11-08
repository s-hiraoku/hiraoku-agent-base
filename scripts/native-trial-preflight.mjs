import {
  preflightNativeTrial,
  readNativeTrialPlan,
} from "./lib/native-trial-preflight.mjs";

// This command only inspects an operator-supplied, secret-free plan. No launch.
try {
  if (process.argv.length !== 3) throw Error("manifest_required");
  const result = preflightNativeTrial(readNativeTrialPlan(process.argv[2]));
  console.log(JSON.stringify(result));
  process.exitCode = result.offlineValid ? 0 : 1;
} catch {
  console.error("invalid_or_unreadable_trial_plan");
  process.exitCode = 1;
}
