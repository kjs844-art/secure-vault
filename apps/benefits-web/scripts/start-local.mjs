import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { localEnvironment } from "./local-environment.mjs";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const child = spawn(process.execPath, [".output/server/index.mjs"], {
  cwd, env: localEnvironment(process.env), stdio: "inherit", windowsHide: true,
});
child.on("error", () => { console.error("Local server could not start."); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { child.kill(signal); });
}
