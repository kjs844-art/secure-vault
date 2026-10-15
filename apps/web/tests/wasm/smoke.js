const result = document.querySelector("#result");
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
let finished = false;
const timeout = setTimeout(() => finish("fail", "WORKER_TIMEOUT"), 60_000);

function finish(status, code) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  worker.terminate();
  // Construct a fixed result; never display or serialize worker-supplied data.
  result.textContent = JSON.stringify({ schemaVersion: 1, status, code });
  document.documentElement.dataset.smokeStatus = status;
}

worker.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.schemaVersion === 1 && message.status === "pass" && message.code === "WASM_SMOKE_PASSED") {
    finish("pass", "WASM_SMOKE_PASSED");
  } else {
    finish("fail", "WASM_SMOKE_FAILED");
  }
});
worker.addEventListener("error", (event) => {
  event.preventDefault();
  finish("fail", "WORKER_ERROR");
});
worker.addEventListener("messageerror", () => finish("fail", "WORKER_MESSAGE_ERROR"));
