import { randomBytes } from "node:crypto";

const defaultTtlMs = 8 * 60 * 60 * 1_000;

export interface BrowserSessionStoreOptions {
  ttlMs?: number;
  maxSessions?: number;
  now?: () => number;
  tokenFactory?: () => string;
}

export class BrowserSessionStore {
  private readonly sessions = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly now: () => number;
  private readonly tokenFactory: () => string;

  constructor(options: BrowserSessionStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? defaultTtlMs;
    this.maxSessions = options.maxSessions ?? 32;
    this.now = options.now ?? Date.now;
    this.tokenFactory =
      options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
  }

  issue(): string {
    this.pruneExpired();
    while (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    const token = this.tokenFactory();
    this.sessions.set(token, this.now() + this.ttlMs);
    return token;
  }

  has(token: string): boolean {
    const expiresAt = this.sessions.get(token);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  cookieMaxAgeSeconds(): number {
    return Math.max(1, Math.floor(this.ttlMs / 1_000));
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [token, expiresAt] of this.sessions) {
      if (expiresAt <= now) this.sessions.delete(token);
    }
  }
}
