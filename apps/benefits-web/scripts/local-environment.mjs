// Do not inherit provider tokens/URLs, NODE_OPTIONS or any VITE_* donor settings.
export function localEnvironment(source, port = 4317) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("Invalid local port");
  }
  const env = {};
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATH", "Path", "LANG", "TZ"]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return {
    ...env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port),
    NITRO_HOST: "127.0.0.1", NITRO_PORT: String(port), KEYATLAS_BENEFITS_MODE: "synthetic",
  };
}
