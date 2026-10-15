export class RequestTimeoutError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "RequestTimeoutError";
  }
}

/** One request, including its response body. A timeout never retries a write. */
export async function boundedJsonRequest<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  let timedOut = false;
  if (init.signal?.aborted) cancel();
  else init.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    cancel();
  }, timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const data = await response.json();
    if (!response.ok)
      throw new Error(
        data.error ?? "This step could not finish. Please try again.",
      );
    return data as T;
  } catch (cause) {
    if (timedOut) throw new RequestTimeoutError(timeoutMessage, cause);
    throw cause;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", cancel);
  }
}
