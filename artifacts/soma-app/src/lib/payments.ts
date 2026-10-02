import { ApiError, apiRequest as request } from "@/lib/api";
import {
  syncStudentToBackend,
  useSomaStore,
} from "@/lib/storage";

/* =========================================================
   INTASEND WALLET TOP-UP
   Talks to the Flask backend, which owns the KSh wallet.
   IntaSend handles the actual payment collection.
   ========================================================= */

export const MIN_TOPUP_AMOUNT = 1;
export const MAX_TOPUP_AMOUNT = 150000;

export type PaymentStatus =
  | "pending"
  | "completed"
  | "failed"
  | "expired";

/**
 * What the server does once the payment is confirmed.
 * Without one, the payment simply tops up the wallet.
 */
export type PaymentPurpose = "subscribe" | `unlock:${string}`;

export type PollOutcome =
  | {
      status: "completed";
      walletBalance: number;
      /** "done", "failed: <reason>", or null for a plain top-up. */
      purposeResult: string | null;
    }
  | { status: "failed" | "expired" }
  | { status: "timeout" }
  | { status: "aborted" };

function currentStudent() {
  const state = useSomaStore.getState();

  return {
    soma_hub_code: state.somaHubCode,
    name: state.name ?? "",
    school_name: state.schoolName ?? "",
    grade: state.grade ?? "",
  };
}

/** Returns true for a whole-number KSh amount accepted by the wallet. */
export function isValidTopUpAmount(amount: number): boolean {
  return (
    Number.isInteger(amount) &&
    amount >= MIN_TOPUP_AMOUNT &&
    amount <= MAX_TOPUP_AMOUNT
  );
}

/**
 * Starts an IntaSend payment session.
 *
 * The Flask backend creates the IntaSend payment request.
 * The frontend never handles the IntaSend secret key.
 *
 * If the backend doesn't know this student yet, the student is
 * registered and the request is retried once.
 */
export async function startTopUp(
  phoneNumber: string,
  amount: number,
  purpose?: PaymentPurpose
): Promise<{
  sessionId: string;
  paymentUrl?: string | null;
}> {
  const send = () =>
    request<{
      session_id: string;
      payment_url?: string | null;
    }>("/api/intasend/payment-session", {
      method: "POST",
      body: JSON.stringify({
        soma_hub_code: currentStudent().soma_hub_code,
        phone_number: phoneNumber,
        amount,
        purpose,
      }),
    });

  try {
    const result = await send();

    return {
      sessionId: result.session_id,
      paymentUrl: result.payment_url ?? null,
    };
  } catch (error) {
    if (
      !(error instanceof ApiError) ||
      error.httpStatus !== 404
    ) {
      throw error;
    }

    await syncStudentToBackend(currentStudent());

    const result = await send();

    return {
      sessionId: result.session_id,
      paymentUrl: result.payment_url ?? null,
    };
  }
}

/**
 * Checks the payment session.
 *
 * The backend is the source of truth for whether the payment
 * has actually been confirmed and whether the wallet was credited.
 */
export async function getPaymentStatus(
  sessionId: string
): Promise<{
  status: PaymentStatus;
  walletBalance: number;
  purposeResult: string | null;
}> {
  const result = await request<{
    status: PaymentStatus;
    wallet_balance: number;
    purpose_result?: string | null;
  }>(
    `/api/intasend/payment-status/${encodeURIComponent(sessionId)}`
  );

  return {
    status: result.status,
    walletBalance: result.wallet_balance,
    purposeResult: result.purpose_result ?? null,
  };
}

/**
 * Development/sandbox only.
 *
 * This endpoint allows a pending test payment to be completed
 * without waiting for an actual payment.
 */
export async function simulateTestPayment(
  sessionId: string
): Promise<void> {
  await request(
    `/api/dev/test-payment/${encodeURIComponent(sessionId)}`,
    {
      method: "POST",
    }
  );
}

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls the IntaSend payment session until:
 *
 * - payment is completed
 * - payment fails
 * - payment expires
 * - timeout is reached
 * - request is aborted
 *
 * Network errors while polling are ignored temporarily because
 * the payment may still be processing on the server.
 */
export async function pollPaymentStatus(
  sessionId: string,
  options: {
    intervalMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    fetchStatus?: typeof getPaymentStatus;
    wait?: (ms: number) => Promise<unknown>;
    now?: () => number;
  } = {}
): Promise<PollOutcome> {
  const {
    intervalMs = 3000,
    timeoutMs = 120000,
    signal,
    fetchStatus = getPaymentStatus,
    wait = sleep,
    now = Date.now,
  } = options;

  const deadline = now() + timeoutMs;

  while (now() < deadline) {
    await wait(intervalMs);

    if (signal?.aborted) {
      return { status: "aborted" };
    }

    try {
      const result = await fetchStatus(sessionId);

      if (result.status === "completed") {
        return {
          status: "completed",
          walletBalance: result.walletBalance,
          purposeResult: result.purposeResult,
        };
      }

      if (
        result.status === "failed" ||
        result.status === "expired"
      ) {
        return {
          status: result.status,
        };
      }
    } catch {
      // Keep polling. A later check may succeed.
    }
  }

  return {
    status: "timeout",
  };
}