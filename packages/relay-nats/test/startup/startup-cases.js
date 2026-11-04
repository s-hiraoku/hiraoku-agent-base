export const startupCases = [
  "broker startup reports an owned pre-readiness signal exit without respawning",
  "broker startup accepts a healthy authenticated child delayed beyond the old attempt budget",
  "broker startup retains a finite deadline for a live child that never becomes ready",
  "broker startup handles an actual spawn failure without leaking private details",
  "broker startup reports a nonzero child exit with bounded safe diagnostics",
];
