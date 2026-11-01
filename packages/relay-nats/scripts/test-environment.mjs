export function testEnvironment(binary, temporaryDirectory) {
  const environment = {
    HAB_NATS_SERVER: binary,
    TMPDIR: temporaryDirectory,
    TZ: "UTC",
  };
  for (const name of ["PATH", "LANG", "LC_ALL", "SystemRoot"]) {
    if (typeof process.env[name] === "string")
      environment[name] = process.env[name];
  }
  return environment;
}
