import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { createReviewHttpHandler } from "../../src/server/http/review-http.ts";
import { REVIEW_REQUEST_HEADER, type ReviewAdmissionRequest, type ReviewHttpDependencies,
  type ReviewSessionContext } from "../../src/server/http/review-http-contracts.ts";
import { createReviewMemoryStore } from "./review-memory-store.ts";

// SYNTHETIC ONLY. Selectively reuses the catalog fixture's Node -> Fetch stream
// bridge without modifying that fixture or mounting a production route. Real
// 127.0.0.1 HTTP framing; fake session/permits and serialized memory transactions.
// This data-event bridge has NO production backpressure/resource guarantee.
export interface ReviewLoopbackOptions {
  requestTimeoutMs?: number;
  readSession?: ReviewHttpDependencies["readSession"];
  admit?: ReviewHttpDependencies["admit"];
  now?: () => number;
}
export interface ReviewLoopbackFixture {
  readonly origin: string;
  readonly store: ReturnType<typeof createReviewMemoryStore>;
  readonly sessions: Array<{ context: ReviewSessionContext; signal: AbortSignal }>;
  readonly admissions: Array<{ request: ReviewAdmissionRequest; signal: AbortSignal }>;
  readonly completedStatuses: number[];
  readonly openSockets: number;
  readonly disconnects: number;
  /** Handler compositions only; cannot cancel/await uncooperative adapter work. */
  whenIdle(): Promise<void>;
  close(): Promise<void>;
}
export function reviewPermit(request: ReviewAdmissionRequest) {
  return Object.freeze({ allowed: true, surface: REVIEW_REQUEST_HEADER, requestId: request.requestId,
    action: request.action, authority: request.authority, expiresAt: request.notAfter });
}

function bounded<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`SYNTHETIC_REVIEW_LOOPBACK_${label}`)), milliseconds);
  })]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

/** The caller must close this fixture in finally; no other process is touched. */
export async function startReviewLoopback(options: ReviewLoopbackOptions = {}): Promise<ReviewLoopbackFixture> {
  const store = createReviewMemoryStore(); // Keep the review fixture's synthetic service/candidate.
  const sessions: ReviewLoopbackFixture["sessions"] = [], admissions: ReviewLoopbackFixture["admissions"] = [];
  const completedStatuses: number[] = [], sockets = new Set<Socket>(), idleListeners = new Set<() => void>();
  let activeHandlers = 0, disconnects = 0;
  let origin = "http://127.0.0.1:1";
  let handler: (request: Request) => Promise<Response>;
  let closing: Promise<void> | undefined;
  function whenIdle(): Promise<void> {
    if (activeHandlers === 0) return Promise.resolve();
    let done!: () => void;
    const promise = new Promise<void>((resolve) => { done = resolve; idleListeners.add(done); });
    return bounded(promise, 2000, "HANDLER_IDLE_TIMEOUT").finally(() => { idleListeners.delete(done); });
  }
  const server = createServer((message: IncomingMessage, response: ServerResponse) => {
    activeHandlers++;
    response.on("error", () => undefined);
    message.on("error", () => undefined);
    const connection = new AbortController();
    const disconnect = () => {
      if (connection.signal.aborted) return;
      disconnects++;
      connection.abort();
      message.destroy();
    };
    message.once("aborted", disconnect);
    response.once("close", () => { if (!response.writableEnded) disconnect(); });
    const write = (action: () => void) => {
      if (!response.writableEnded && !response.destroyed) action();
    };
    void (async () => {
      try {
        const url = new URL(message.url ?? "/", origin);
        const headers = new Headers();
        for (const [name, value] of Object.entries(message.headers)) {
          if (value === undefined) continue;
          for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
        }
        const hasBody = message.method !== "GET" && message.method !== "HEAD";
        let bodyCancelled = false;
        const body = hasBody ? new ReadableStream<Uint8Array>({
          start(controller) {
            const pass = (action: () => void) => {
              if (bodyCancelled) return;
              try { action(); } catch { /* Body already closed/errored by the handler. */ }
            };
            message.on("data", (chunk: Buffer) => pass(() => controller.enqueue(new Uint8Array(chunk))));
            message.on("end", () => pass(() => controller.close()));
            message.on("error", (error) => pass(() => controller.error(error)));
          },
          cancel() {
            bodyCancelled = true;
            message.removeAllListeners("data");
            // Drain rejected bodies so fixed handler errors can reach the client.
            message.resume();
          },
        }) : undefined;
        const request = new Request(`${origin}${url.pathname}${url.search}`, {
          method: message.method ?? "POST", headers, signal: connection.signal,
          ...(hasBody ? { body: body!, duplex: "half" } : {}),
        });
        const reply = await handler(request);
        const bytes = new Uint8Array(await reply.arrayBuffer());
        completedStatuses.push(reply.status);
        write(() => {
          const out: Record<string, string> = {};
          for (const [name, value] of reply.headers)
            if (name !== "content-length" && name !== "transfer-encoding") out[name] = value;
          response.writeHead(reply.status, out);
          response.end(bytes);
        });
      } catch {
        write(() => {
          if (!response.headersSent) response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
          response.end('{"ok":false,"code":"API_UNAVAILABLE"}');
        });
      } finally {
        activeHandlers--;
        if (activeHandlers === 0) for (const listener of [...idleListeners]) listener();
      }
    })();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => { sockets.delete(socket); });
  });
  // Register actual socket-close acknowledgement before destroying owned sockets.
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      const socketStops = [...sockets].map((socket) => new Promise<void>((resolve) => socket.once("close", resolve)));
      const stopped = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await bounded(Promise.all([stopped, ...socketStops, whenIdle()]), 2500, "CLEANUP_TIMEOUT");
      assert.equal(sockets.size, 0, "only this fixture's sockets must be closed");
    })();
    return closing;
  };
  try {
    origin = await new Promise<string>((resolve, reject) => {
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address !== "object") { reject(new Error("SYNTHETIC_REVIEW_LISTEN_FAILED")); return; }
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
    handler = createReviewHttpHandler({ trustedOrigin: origin,
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
      now: () => options.now ? options.now() : store.controls.now,
      newId: store.dependencies.newId,
      transaction: store.dependencies.transaction,
      readSession: async (context, signal) => {
        sessions.push({ context, signal });
        return options.readSession ? options.readSession(context, signal) : structuredClone(store.controls.authority);
      },
      admit: async (request, signal) => {
        admissions.push({ request, signal });
        return options.admit ? options.admit(request, signal) : reviewPermit(request);
      },
    });
  } catch (error) {
    await close();
    throw error;
  }
  return { origin, store, sessions, admissions, completedStatuses,
    get openSockets() { return sockets.size; }, get disconnects() { return disconnects; }, whenIdle, close };
}

export interface ReviewLoopbackRequest {
  method?: string;
  path?: string;
  body?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}
export async function reviewLoopbackRequest(f: ReviewLoopbackFixture, options: ReviewLoopbackRequest = {}): Promise<Response> {
  const method = options.method ?? "POST";
  return fetch(f.origin + (options.path ?? "/api/review/list"), {
    method, headers: { "content-type": "application/json", origin: f.origin,
      "x-keyatlas-request": REVIEW_REQUEST_HEADER, cookie: "synthetic-session=fixture", ...options.headers },
    ...(method === "GET" || method === "HEAD" ? {} : { body: options.body ?? "{}" }),
    ...(options.signal ? { signal: options.signal } : {}), redirect: "error",
  });
}
