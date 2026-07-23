import { describe, expect, it } from 'vitest';

import { MemoryQuotaStore } from './memory-quota-store.js';

const utc8Midnight = Date.parse('2026-07-22T16:00:00.000Z');

describe('MemoryQuotaStore', () => {
  it('accepts exactly 20 OCR consumptions per device and UTC+8 day', async () => {
    const store = new MemoryQuotaStore();

    for (let request = 1; request <= 20; request += 1) {
      await expect(store.consume('device-a', 'ocr', utc8Midnight)).resolves.toEqual({
        accepted: true,
        remaining: 20 - request,
        resetsAt: '2026-07-23T16:00:00.000Z',
      });
    }

    await expect(store.consume('device-a', 'ocr', utc8Midnight)).resolves.toEqual({
      accepted: false,
      remaining: 0,
      resetsAt: '2026-07-23T16:00:00.000Z',
    });
  });

  it('accepts exactly 10 translation consumptions independently of OCR', async () => {
    const store = new MemoryQuotaStore();

    await expect(store.consume('device-a', 'ocr', utc8Midnight)).resolves.toMatchObject({
      accepted: true,
      remaining: 19,
    });

    for (let request = 1; request <= 10; request += 1) {
      await expect(store.consume('device-a', 'translate', utc8Midnight)).resolves.toEqual({
        accepted: true,
        remaining: 10 - request,
        resetsAt: '2026-07-23T16:00:00.000Z',
      });
    }

    await expect(store.consume('device-a', 'translate', utc8Midnight)).resolves.toMatchObject({
      accepted: false,
      remaining: 0,
    });
    await expect(store.consume('device-a', 'ocr', utc8Midnight)).resolves.toMatchObject({
      accepted: true,
      remaining: 18,
    });
  });

  it('resets at UTC+8 midnight, including the exact millisecond boundary', async () => {
    const store = new MemoryQuotaStore();
    const beforeMidnight = utc8Midnight - 1;

    await expect(store.consume('device-a', 'ocr', beforeMidnight)).resolves.toMatchObject({
      accepted: true,
      remaining: 19,
      resetsAt: '2026-07-22T16:00:00.000Z',
    });
    await expect(store.consume('device-a', 'ocr', beforeMidnight)).resolves.toMatchObject({
      accepted: true,
      remaining: 18,
    });

    await expect(store.consume('device-a', 'ocr', utc8Midnight)).resolves.toEqual({
      accepted: true,
      remaining: 19,
      resetsAt: '2026-07-23T16:00:00.000Z',
    });
  });

  it('isolates devices', async () => {
    const store = new MemoryQuotaStore();

    await expect(store.consume('device-a', 'translate', utc8Midnight)).resolves.toMatchObject({
      remaining: 9,
    });
    await expect(store.consume('device-b', 'translate', utc8Midnight)).resolves.toMatchObject({
      remaining: 9,
    });
  });

  it('reports full independent remaining counts for a new device without consuming quota', async () => {
    const store = new MemoryQuotaStore();

    await expect(store.status('new-device', utc8Midnight)).resolves.toEqual({
      ocr: { limit: 20, remaining: 20 },
      translate: { limit: 10, remaining: 10 },
      resetsAt: '2026-07-23T16:00:00.000Z',
    });
    expect(store.entryCount).toBe(0);
  });

  it('reports current independent counts with the same reset and does not consume them', async () => {
    const store = new MemoryQuotaStore();
    await store.consume('device-a', 'ocr', utc8Midnight);
    await store.consume('device-a', 'ocr', utc8Midnight);
    await store.consume('device-a', 'translate', utc8Midnight);

    const first = await store.status('device-a', utc8Midnight);
    const second = await store.status('device-a', utc8Midnight);

    expect(first).toEqual({
      ocr: { limit: 20, remaining: 18 },
      translate: { limit: 10, remaining: 9 },
      resetsAt: '2026-07-23T16:00:00.000Z',
    });
    expect(second).toEqual(first);
  });

  it('expires abandoned device counters at their UTC+8 reset time', async () => {
    const store = new MemoryQuotaStore();
    const beforeMidnight = utc8Midnight - 1;

    await store.consume('abandoned-device', 'ocr', beforeMidnight);
    await store.consume('abandoned-device', 'translate', beforeMidnight);
    expect(store.entryCount).toBe(2);

    await store.consume('active-device', 'ocr', utc8Midnight);
    expect(store.entryCount).toBe(1);
  });
});
