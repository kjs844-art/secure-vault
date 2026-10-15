import type { CatalogHttpError } from "./catalog-http-contracts";

export class HttpBoundaryFailure extends Error {
  constructor(readonly code: CatalogHttpError) {
    super(code);
    this.name = "HttpBoundaryFailure";
  }
}

/** Request-local time/cancellation fence, not a database rollback mechanism. */
export class RequestLifetime {
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private reason: CatalogHttpError | null = null;
  private closed = false;
  private lastWall = -1;
  private lastMono = -1;
  private wallDeadline = Infinity;
  private monoDeadline = Infinity;
  private wallExpiryCode: CatalogHttpError = "API_TIMEOUT";
  private monoExpiryCode: CatalogHttpError = "API_TIMEOUT";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private rejectStop!: (reason: HttpBoundaryFailure) => void;
  private readonly stopped: Promise<never>;
  private readonly onAbort = () => this.stop("API_ABORTED");

  constructor(private readonly clock: () => number, private readonly incomingSignal: AbortSignal, timeoutMs: number) {
    this.stopped = new Promise<never>((_resolve, reject) => { this.rejectStop = reject; });
    // A pre-aborted request can stop before the first race attaches.
    void this.stopped.catch(() => undefined);
    const now = this.now();
    this.wallDeadline = Math.min(now + timeoutMs, 253402300799999);
    this.monoDeadline = this.lastMono + timeoutMs;
    this.schedule();
    incomingSignal.addEventListener("abort", this.onAbort, { once: true });
    if (incomingSignal.aborted) this.stop("API_ABORTED");
  }
  private stop(code: CatalogHttpError) {
    if (this.reason !== null || this.closed) return;
    this.reason = code;
    this.controller.abort();
    this.rejectStop(new HttpBoundaryFailure(code));
  }
  private schedule() {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (performance.now() < this.monoDeadline) this.schedule();
      else this.stop(this.monoExpiryCode);
    }, Math.max(1, Math.ceil(this.monoDeadline - performance.now())));
  }
  now(): number {
    if (this.closed) throw new HttpBoundaryFailure("API_ABORTED");
    if (this.reason !== null) throw new HttpBoundaryFailure(this.reason);
    const before = performance.now();
    const wall = this.clock();
    const after = performance.now();
    if (!Number.isSafeInteger(wall) || wall < this.lastWall || wall < 0 || wall > 253402300799999
      || !Number.isFinite(before) || before < this.lastMono || after < before) {
      this.stop("API_UNAVAILABLE");
      throw new HttpBoundaryFailure("API_UNAVAILABLE");
    }
    this.lastWall = wall;
    this.lastMono = before;
    // Check elapsed time synchronously: queued timers cannot protect a busy loop.
    if (wall >= this.wallDeadline || after >= this.monoDeadline) {
      const code = after >= this.monoDeadline ? this.monoExpiryCode : this.wallExpiryCode;
      this.stop(code);
      throw new HttpBoundaryFailure(code);
    }
    return wall;
  }
  tighten(notAfter: number, code: "API_TIMEOUT" | "API_SESSION_CHANGED") {
    const now = this.now();
    if (!Number.isSafeInteger(notAfter) || notAfter <= now || notAfter > 253402300799999) {
      this.stop(code);
      throw new HttpBoundaryFailure(code);
    }
    const mono = this.lastMono + (notAfter - now);
    if (notAfter < this.wallDeadline || mono < this.monoDeadline) {
      // The two clocks can advance differently. Retain the reason associated
      // with each minimum deadline, not whichever bound tightened most recently.
      if (notAfter < this.wallDeadline) {
        this.wallDeadline = notAfter;
        this.wallExpiryCode = code;
      }
      if (mono < this.monoDeadline) {
        this.monoDeadline = mono;
        this.monoExpiryCode = code;
      }
      this.schedule();
    }
  }
  get notAfter(): number {
    this.now();
    return this.wallDeadline;
  }
  async run<T>(action: () => Promise<T>): Promise<T> {
    this.now();
    const value = await Promise.race([action(), this.stopped]);
    this.now();
    return value;
  }
  finish() {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.incomingSignal.removeEventListener("abort", this.onAbort);
    // Ask pending cooperative adapters to release resources. No rollback claim.
    this.controller.abort();
  }
}
