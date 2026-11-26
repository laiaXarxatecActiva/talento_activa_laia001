/**
 * Limitador de intentos fallidos en ventana fija, en memoria (una instancia de
 * la app). Suficiente para un único proceso; con varias réplicas habría que
 * moverlo a un almacén compartido (p. ej. Redis o una tabla).
 */
export class FixedWindowLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  isBlocked(key: string): boolean {
    const h = this.hits.get(key);
    if (!h) return false;
    if (this.now() >= h.resetAt) {
      this.hits.delete(key);
      return false;
    }
    return h.count >= this.max;
  }

  fail(key: string): void {
    const t = this.now();
    const h = this.hits.get(key);
    if (!h || t >= h.resetAt) this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
    else h.count++;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}

export interface RateLimitConfig {
  /** Fallos de login por email normalizado. */
  loginPerEmail: number;
  /** Fallos de login por IP. */
  loginPerIp: number;
  /** Fallos de verificación por IP. */
  verifyPerIp: number;
  windowMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  loginPerEmail: 10,
  loginPerIp: 50,
  verifyPerIp: 20,
  windowMs: 15 * 60 * 1000,
};

export interface Limiters {
  loginEmail: FixedWindowLimiter;
  loginIp: FixedWindowLimiter;
  verifyIp: FixedWindowLimiter;
}

export function createLimiters(cfg: RateLimitConfig): Limiters {
  return {
    loginEmail: new FixedWindowLimiter(cfg.loginPerEmail, cfg.windowMs),
    loginIp: new FixedWindowLimiter(cfg.loginPerIp, cfg.windowMs),
    verifyIp: new FixedWindowLimiter(cfg.verifyPerIp, cfg.windowMs),
  };
}
