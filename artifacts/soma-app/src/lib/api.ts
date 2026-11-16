import { SOMA_API_BASE_URL } from "@/lib/storage";

/* =========================================================
   FLASK BACKEND REQUESTS
   ========================================================= */

export class ApiError extends Error {
  constructor(
    message: string,
    /** Undefined when the server couldn't be reached. */
    public httpStatus?: number,
    public body: Record<string, unknown> = {}
  ) {
    super(message);
  }

  get isNetworkError() {
    return this.httpStatus === undefined;
  }
}

export async function apiRequest<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(
      `${SOMA_API_BASE_URL}${path}`,
      {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...init?.headers,
        },
      }
    );
  } catch {
    throw new ApiError(
      "Can't reach SOMA HUB. Check your internet connection."
    );
  }

  const body = await response
    .json()
    .catch(() => ({}));

  if (!response.ok || body.success === false) {
    throw new ApiError(
      body.message ||
        body.error ||
        "Something went wrong. Please try again.",
      response.status,
      body
    );
  }

  return body as T;
}

export function postJson<T>(
  path: string,
  body: unknown
): Promise<T> {
  return apiRequest<T>(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function newRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return (
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 12)
    );
  }
}

let lastWarmUp = 0;

/**
 * Wake the backend before the learner needs it.
 *
 * The free Render instance sleeps when idle and takes ~30 s to start, so the
 * first payment request after a quiet spell used to stall before the M-Pesa
 * prompt was even sent. Call this as soon as a payment screen opens; the
 * learner types their number while the server boots. Fire-and-forget.
 */
export function warmUpBackend(): void {
  const now = Date.now();
  if (now - lastWarmUp < 5 * 60 * 1000) return;
  lastWarmUp = now;
  fetch(`${SOMA_API_BASE_URL}/`, { method: "GET" }).catch(() => {
    lastWarmUp = 0;
  });
}
