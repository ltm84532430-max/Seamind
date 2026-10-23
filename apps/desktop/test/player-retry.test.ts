import { describe, expect, it } from 'vitest';
import { RETRY_DELAYS_MS, withRetries } from '../src/player/retry-fetch';

function answer(status: number): Response {
  return new Response(`status ${status}`, { status });
}

/** A fetch that gives the planned answers in turn and remembers how it was called. */
function plannedFetch(plan: (Response | Error)[]) {
  const calls: { input: unknown; init: RequestInit | undefined }[] = [];
  const fetchOnce = (async (input: unknown, init?: RequestInit) => {
    calls.push({ input, init });
    const next = plan[Math.min(calls.length - 1, plan.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetchOnce, calls };
}

const noWaiting = {
  sleep: async () => undefined,
};

describe('repeating a lookup that the connection dropped', () => {
  it('returns the first answer when it is a good one, without waiting', async () => {
    const waits: number[] = [];
    const { fetchOnce, calls } = plannedFetch([answer(200)]);
    const response = await withRetries(fetchOnce, {
      sleep: async (ms) => void waits.push(ms),
    })('https://www.youtube.com/x', { method: 'POST', body: 'b' });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('asks again after a 502 and returns the answer that follows', async () => {
    const waits: number[] = [];
    const { fetchOnce, calls } = plannedFetch([answer(502), answer(200)]);
    const response = await withRetries(fetchOnce, {
      sleep: async (ms) => void waits.push(ms),
    })('https://www.youtube.com/x');
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([RETRY_DELAYS_MS[0]]);
  });

  it('asks again after the connection fails to open', async () => {
    const { fetchOnce, calls } = plannedFetch([
      new TypeError('Failed to fetch'),
      new TypeError('Failed to fetch'),
      answer(200),
    ]);
    const response = await withRetries(fetchOnce, noWaiting)('https://x.test/');
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it('asks the same thing every time', async () => {
    const { fetchOnce, calls } = plannedFetch([answer(503), answer(200)]);
    const init = { method: 'POST', body: '{"a":1}' };
    await withRetries(fetchOnce, noWaiting)('https://x.test/path', init);
    expect(calls.map((call) => call.input)).toEqual([
      'https://x.test/path',
      'https://x.test/path',
    ]);
    expect(calls[1].init).toBe(init);
  });

  it('gives up after the last wait and hands back the last answer', async () => {
    const waits: number[] = [];
    const { fetchOnce, calls } = plannedFetch([answer(502)]);
    const response = await withRetries(fetchOnce, {
      delaysMs: [1, 2],
      sleep: async (ms) => void waits.push(ms),
    })('https://x.test/');
    expect(response.status).toBe(502);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([1, 2]);
  });

  it('throws the last error when every attempt failed to connect', async () => {
    const { fetchOnce, calls } = plannedFetch([
      new TypeError('Failed to fetch'),
    ]);
    await expect(
      withRetries(fetchOnce, { delaysMs: [0], sleep: async () => undefined })(
        'https://x.test/',
      ),
    ).rejects.toThrow('Failed to fetch');
    expect(calls).toHaveLength(2);
  });

  it('does not repeat an answer that repeating would not change', async () => {
    for (const status of [400, 403, 404, 429]) {
      const { fetchOnce, calls } = plannedFetch([answer(status), answer(200)]);
      const response = await withRetries(
        fetchOnce,
        noWaiting,
      )('https://x.test/');
      expect(response.status).toBe(status);
      expect(calls).toHaveLength(1);
    }
  });

  it('does not repeat a request that timed out', async () => {
    const timeout = new DOMException('signal timed out', 'TimeoutError');
    const { fetchOnce, calls } = plannedFetch([timeout, answer(200)]);
    await expect(
      withRetries(fetchOnce, noWaiting)('https://x.test/'),
    ).rejects.toBe(timeout);
    expect(calls).toHaveLength(1);
  });

  it('does not repeat a request the caller cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchOnce, calls } = plannedFetch([
      new DOMException('aborted', 'AbortError'),
      answer(200),
    ]);
    await expect(
      withRetries(fetchOnce, noWaiting)('https://x.test/', {
        signal: controller.signal,
      }),
    ).rejects.toThrow('aborted');
    expect(calls).toHaveLength(1);
  });

  it('waits a little longer before each repeat by default', () => {
    expect(RETRY_DELAYS_MS.length).toBeGreaterThanOrEqual(2);
    for (let index = 1; index < RETRY_DELAYS_MS.length; index += 1)
      expect(RETRY_DELAYS_MS[index]).toBeGreaterThan(
        RETRY_DELAYS_MS[index - 1],
      );
  });
});
