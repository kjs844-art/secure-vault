import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { createCatalogHttpHandler } from "../../src/server/http/catalog-http.ts";
import type { CatalogAdmissionRequest, CatalogHttpDependencies, CatalogSessionContext }
  from "../../src/server/http/catalog-http-contracts.ts";
import { REVIEW_NOW, SYNTHETIC_PRIVATE, createReviewMemoryStore, reviewAuthority }
  from "./review-memory-store.ts";

// SYNTHETIC LOOPBACK TEST SUPPORT ONLY. This helper owns a 127.0.0.1 server
// with an OS-chosen port(0) that calls the real catalog handler with synthetic
// session/admission/memory adapters. It is not the production server, route
// mount, real limiter, database, or evidence about deployment infrastructure.
// The socket body is handed to the handler as a live stream, so the handler's
// own byte ceiling, deadline and cancellation observe the real HTTP framing
// and no unbounded buffering happens before the Request is created.

export interface LoopbackFixtureOptions {
  requestTimeoutMs?: number;
  readSession?: CatalogHttpDependencies["readSession"];
  admit?: CatalogHttpDependencies["admit"];
  now?: () => number;
}

export interface LoopbackFixture {
  origin: string;
  store: ReturnType<typeof createReviewMemoryStore>;
  sessions: Array<{ context: CatalogSessionContext; signal: AbortSignal }>;
  admissions: Array<{ request: CatalogAdmissionRequest; signal: AbortSignal }>;
  openSockets: number;
  whenIdle(): Promise<void>;
  close(): Promise<void>;
}

function grant(request: CatalogAdmissionRequest) {
  return Object.freeze({ allowed: true, requestId: request.requestId, action: request.action,
    authority: request.authority, expiresAt: request.notAfter });
}

/**
 * Start a throwaway loopback server. The caller must await close() in a
 * finally block; only this server and its sockets are cleaned up here.
 */
export async function startCatalogLoopback(options: LoopbackFixtureOptions = {}): Promise<LoopbackFixture> {
  const store = createReviewMemoryStore();
  store.rows.services.clear();
  const sessions: Array<{ context: CatalogSessionContext; signal: AbortSignal }> = [];
  const admissions: Array<{ request: CatalogAdmissionRequest; signal: AbortSignal }> = [];
  const pending = new Set<Promise<void>>();
  const idleWaiters = new Set<() => void>();
  const sockets = new Set<Socket>();
  const whenIdle = () => pending.size === 0 ? Promise.resolve() : new Promise<void>((resolve) => {
    idleWaiters.add(resolve);
  });
  let deps: CatalogHttpDependencies = {
    trustedOrigin: "http://127.0.0.1:1",
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    now: () => (options.now ? options.now() : store.controls.now),
    newId: () => store.catalogDependencies.newId(),
    readSession: async (context, signal) => {
      sessions.push({ context, signal });
      if (options.readSession) return options.readSession(context, signal);
      return structuredClone(store.controls.authority);
    },
    admit: async (request, signal) => {
      admissions.push({ request, signal });
      if (options.admit) return options.admit(request, signal);
      return grant(request);
    },
    transaction: store.catalogDependencies.transaction,
  };

  let handler: (request: Request) => Promise<Response>;
  let server: Server;
  const origin = await new Promise<string>((resolve, reject) => {
    server = createServer((message: IncomingMessage, response: ServerResponse) => {
      // Errors on a fixture socket after the peer disappears must not crash
      // the suite; the fixture owns only its own sockets and responses.
      response.on("error", () => undefined);
      message.on("error", () => undefined);
      const connection = new AbortController();
      const settle = (write: () => void) => {
        if (response.writableEnded || response.destroyed) return;
        write();
      };
      response.on("close", () => {
        if (!response.writableEnded) {
          // Preserve the connection abort as the request signal so the handler
          // observes a real disconnect instead of running forever.
          connection.abort();
          message.destroy();
        }
      });
      const job = (async () => {
        try {
          const url = new URL(message.url ?? "/", "http://127.0.0.1");
          const headers = new Headers();
          for (const [name, value] of Object.entries(message.headers)) {
            if (value === undefined) continue;
            for (const entry of Array.isArray(value) ? value : [value]) headers.append(name, entry);
          }
          const hasBody = message.method !== "GET" && message.method !== "HEAD";
          let bodyCancelled = false;
          const body: ReadableStream<Uint8Array> | undefined = hasBody ? new ReadableStream<Uint8Array>({
            start(controller) {
              const pass = (action: () => void) => {
                if (bodyCancelled) return;
                try { action(); } catch { /* The handler already closed or errored the body. */ }
              };
              message.on("data", (chunk: Buffer) => pass(() => controller.enqueue(new Uint8Array(chunk))));
              message.on("end", () => pass(() => controller.close()));
              message.on("error", (error) => pass(() => controller.error(error)));
            },
            cancel() {
              // A web body in production is not coupled to the socket. Draining
              // keeps the connection alive so the handler's fixed error reply
              // still reaches the client after it rejects the body.
              bodyCancelled = true;
              message.removeAllListeners("data");
              message.resume();
            },
          }) : undefined;
          const request = new Request(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
            method: message.method ?? "POST",
            headers,
            ...(hasBody ? { body: body!, duplex: "half" } : {}),
            signal: connection.signal,
          });
          const reply = await handler(request);
          const bytes = new Uint8Array(await reply.arrayBuffer());
          settle(() => {
            const out: Record<string, string> = {};
            for (const [name, value] of reply.headers) {
              if (name !== "content-length" && name !== "transfer-encoding") out[name] = value;
            }
            response.writeHead(reply.status, out);
            response.end(bytes);
          });
        } catch {
          settle(() => {
            if (!response.headersSent) response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
            response.end("{\"ok\":false,\"code\":\"API_UNAVAILABLE\"}");
          });
        }
      })();
      pending.add(job);
      const finished = () => {
        pending.delete(job);
        if (pending.size === 0) {
          for (const resolve of idleWaiters) resolve();
          idleWaiters.clear();
        }
      };
      void job.then(finished, finished);
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => { sockets.delete(socket); });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      resolve(`http://127.0.0.1:${address.port}`);
    });
    server.on("error", reject);
  });
  const port = Number(new URL(origin).port);
  handler = createCatalogHttpHandler({ ...deps, trustedOrigin: origin });

  return {
    origin, store, sessions, admissions, get openSockets() { return sockets.size; }, whenIdle,
    close: async () => {
      // Wait for in-flight fixture responses to settle so a still-connected
      // socket cannot hang close(); bounded so a stuck handler cannot block.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([whenIdle(), new Promise<void>((resolve) => { timer = setTimeout(resolve, 1000); })]);
      } finally {
        clearTimeout(timer);
      }
      const closedSockets = [...sockets].map((socket) => new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
      }));
      const closedServer = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      await Promise.all([closedServer, ...closedSockets]);
    },
  };
}

/** Minimal loopback HTTP client using the ambient fetch against the fixture origin. */
export interface LoopbackRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  path?: string;
  signal?: AbortSignal;
}

export async function loopbackRequest(f: LoopbackFixture, options: LoopbackRequestOptions = {}): Promise<Response> {
  const method = options.method ?? "POST";
  const headers: Record<string, string> = { "content-type": "application/json", origin: f.origin,
    "x-keyatlas-request": "catalog-v1", cookie: "synthetic-session=fixture", ...options.headers };
  return fetch(f.origin + (options.path ?? "/api/catalog/create"), {
    method, headers, ...(method === "GET" || method === "HEAD" ? {} : { body: options.body ?? "{}" }),
    ...(options.signal ? { signal: options.signal } : {}), redirect: "error",
  });
}

export { REVIEW_NOW, SYNTHETIC_PRIVATE, reviewAuthority };
