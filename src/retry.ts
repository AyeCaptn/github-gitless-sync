export interface HttpResponseLike {
  status: number;
  headers?: Record<string, string>;
}

export function isTransientHttpResponse(response: HttpResponseLike): boolean {
  if (
    response.status === 408 ||
    response.status === 429 ||
    (response.status >= 500 && response.status <= 599)
  ) {
    return true;
  }

  if (response.status !== 403 || response.headers === undefined) {
    return false;
  }

  const headers = Object.keys(response.headers).reduce(
    (result: Record<string, string>, key: string) => {
      result[key.toLowerCase()] = response.headers![key];
      return result;
    },
    {},
  );

  return (
    headers["retry-after"] !== undefined ||
    headers["x-ratelimit-remaining"] === "0"
  );
}

export function getHttpRetryDelay(
  response: HttpResponseLike,
  fallbackDelay: number,
  now: number = Date.now(),
): number {
  if (response.headers === undefined) {
    return response.status === 429 ? Math.max(fallbackDelay, 60_000) : fallbackDelay;
  }

  const headers = Object.keys(response.headers).reduce(
    (result: Record<string, string>, key: string) => {
      result[key.toLowerCase()] = response.headers![key];
      return result;
    },
    {},
  );
  const retryAfter = headers["retry-after"];
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    const retryAt = Number.isFinite(seconds)
      ? now + seconds * 1000
      : Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.max(fallbackDelay, retryAt - now);
    }
  }

  const resetSeconds = Number(headers["x-ratelimit-reset"]);
  if (Number.isFinite(resetSeconds)) {
    return Math.max(fallbackDelay, resetSeconds * 1000 - now);
  }

  return response.status === 403 || response.status === 429
    ? Math.max(fallbackDelay, 60_000)
    : fallbackDelay;
}

/**
 * Retries rejected calls and unacceptable results with exponential backoff.
 * maxRetries is the number of retries after the initial attempt.
 */
export async function retryUntil<T>(
  fn: () => Promise<T>,
  condition: (result: T) => boolean,
  maxRetries: number = 5,
  initialDelay: number = 1000,
  backoffFactor: number = 2,
  getRetryDelay?: (result: T, fallbackDelay: number) => number,
): Promise<T> {
  let retries = 0;
  let delay = initialDelay;

  while (true) {
    let retryDelay = delay;
    try {
      const result = await fn();

      if (condition(result) || retries >= maxRetries) {
        return result;
      }
      retryDelay = getRetryDelay?.(result, delay) ?? delay;
    } catch (err) {
      if (retries >= maxRetries) {
        throw err;
      }
    }

    retries++;
    await new Promise((resolve) => setTimeout(resolve, retryDelay));
    delay *= backoffFactor;
  }
}
