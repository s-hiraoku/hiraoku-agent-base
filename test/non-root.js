import process from "node:process";
/** Write-denial and ownership checks rely on file permissions, which root bypasses. */
export function skipAsRoot(t) {
  if (process.getuid?.() !== 0) return false;
  t.skip("requires a non-root user: root bypasses file write denial");
  return true;
}
