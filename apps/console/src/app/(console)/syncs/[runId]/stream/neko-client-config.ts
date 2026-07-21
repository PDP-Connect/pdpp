export const NEKO_CLIENT_CONFIG_UNAVAILABLE_MESSAGE =
  "The browser stream could not finish loading. Check your network connection and try again.";

const CONFIG_FETCH_ATTEMPTS = 3;
const CONFIG_FETCH_RETRY_MS = 250;
const NETWORK_ERROR_MESSAGE_RE = /failed to fetch|network/i;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
type SleepLike = (ms: number) => Promise<void>;

function isRetryableConfigFetchError(err: unknown): boolean {
  if (err instanceof TypeError) {
    return true;
  }
  if (err instanceof DOMException && err.name === "NetworkError") {
    return true;
  }
  return err instanceof Error && NETWORK_ERROR_MESSAGE_RE.test(err.message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchNekoClientConfigResponse(
  clientConfigPath: string,
  options: { fetchImpl?: FetchLike; sleepImpl?: SleepLike } = {}
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? sleep;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= CONFIG_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(clientConfigPath, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`n.eko client config failed with HTTP ${response.status}`);
      }
      return await response.json();
    } catch (err) {
      lastError = err;
      if (!isRetryableConfigFetchError(err)) {
        throw err;
      }
      if (attempt >= CONFIG_FETCH_ATTEMPTS) {
        break;
      }
      await sleepImpl(CONFIG_FETCH_RETRY_MS * attempt);
    }
  }

  throw new Error(NEKO_CLIENT_CONFIG_UNAVAILABLE_MESSAGE, { cause: lastError });
}
