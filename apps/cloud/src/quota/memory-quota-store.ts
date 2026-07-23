import type {
  QuotaConsumption,
  QuotaOperation,
  QuotaStore,
} from './quota-store.js';

const utc8OffsetMilliseconds = 8 * 60 * 60 * 1_000;

const limits: Readonly<Record<QuotaOperation, number>> = {
  ocr: 20,
  translate: 10,
};

type Counter = {
  day: string;
  consumed: number;
  expiresAt: number;
};

export class MemoryQuotaStore implements QuotaStore {
  private readonly counters = new Map<string, Counter>();
  private nextSweepAt = Number.POSITIVE_INFINITY;

  get entryCount(): number {
    return this.counters.size;
  }

  async consume(
    deviceId: string,
    operation: QuotaOperation,
    nowMilliseconds: number,
  ): Promise<QuotaConsumption> {
    this.sweepExpired(nowMilliseconds);
    const period = getUtc8Period(nowMilliseconds);
    const key = `${deviceId}\n${operation}`;
    const existing = this.counters.get(key);
    const counter =
      existing?.day === period.day
        ? existing
        : { day: period.day, consumed: 0, expiresAt: period.resetsAtMilliseconds };
    const limit = limits[operation];

    if (counter.consumed >= limit) {
      return { accepted: false, remaining: 0, resetsAt: period.resetsAt };
    }

    counter.consumed += 1;
    this.counters.set(key, counter);
    this.nextSweepAt = Math.min(this.nextSweepAt, counter.expiresAt);
    return {
      accepted: true,
      remaining: limit - counter.consumed,
      resetsAt: period.resetsAt,
    };
  }

  private sweepExpired(nowMilliseconds: number): void {
    if (nowMilliseconds < this.nextSweepAt) {
      return;
    }

    let nextSweepAt = Number.POSITIVE_INFINITY;
    for (const [key, counter] of this.counters) {
      if (counter.expiresAt <= nowMilliseconds) {
        this.counters.delete(key);
      } else {
        nextSweepAt = Math.min(nextSweepAt, counter.expiresAt);
      }
    }
    this.nextSweepAt = nextSweepAt;
  }
}

function getUtc8Period(nowMilliseconds: number): Readonly<{
  day: string;
  resetsAt: string;
  resetsAtMilliseconds: number;
}> {
  const utc8Date = new Date(nowMilliseconds + utc8OffsetMilliseconds);
  const year = utc8Date.getUTCFullYear();
  const month = utc8Date.getUTCMonth();
  const date = utc8Date.getUTCDate();
  const day = `${year}-${String(month + 1).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
  const nextMidnight = Date.UTC(year, month, date + 1) - utc8OffsetMilliseconds;
  return {
    day,
    resetsAt: new Date(nextMidnight).toISOString(),
    resetsAtMilliseconds: nextMidnight,
  };
}
