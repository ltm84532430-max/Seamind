/**
 * Looking things up on YouTube goes through the loopback proxy and, from there, over whatever
 * connection the user has; on a proxied or flaky one a request now and then is refused or cut off
 * and works a moment later. The lookups the player page makes only read, so repeating one is safe.
 */

/**
 * Waits before the first and the second repeat of a request. A connection that hangs gives up
 * after 10 seconds, so a request that fails every time takes about half a minute to report it.
 */
export const RETRY_DELAYS_MS: readonly number[] = [600, 1500];

/** What the proxy says when it could not reach YouTube, and what YouTube says when it is busy. */
function isTransientStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError';
}

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

/**
 * Wraps `fetchOnce` so a request that is answered 502, 503 or 504, or that fails to connect, is
 * made again after a short wait. A request that timed out is not repeated (that already cost the
 * whole timeout), nor one the caller cancelled. After the last repeat the final answer is returned
 * or the final error thrown, as if there had been no retries.
 */
export function withRetries(
  fetchOnce: typeof fetch,
  options: {
    delaysMs?: readonly number[];
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): typeof fetch {
  const delays = options.delaysMs ?? RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
  return async (input, init) => {
    for (let attempt = 0; ; attempt += 1) {
      const lastAttempt = attempt >= delays.length;
      try {
        const response = await fetchOnce(input, init);
        if (lastAttempt || !isTransientStatus(response.status)) return response;
      } catch (error) {
        if (lastAttempt || init?.signal?.aborted || isTimeout(error))
          throw error;
      }
      await sleep(delays[attempt]);
    }
  };
}
