import { beforeEach, describe, expect, it, vi } from "vitest";

const syncStudentToBackend = vi.fn();

vi.mock("@/lib/storage", () => ({
  SOMA_API_BASE_URL: "http://api.test",
  syncStudentToBackend: (...args: unknown[]) => syncStudentToBackend(...args),
  useSomaStore: {
    getState: () => ({
      somaHubCode: "SH-ABC123",
      name: "Wanjiku",
      schoolName: "Test School",
      grade: "Grade 7",
    }),
  },
}));

import {
  isValidTopUpAmount,
  pollPaymentStatus,
  startTopUp,
  type PaymentStatus,
} from "@/lib/payments";

function statuses(...sequence: (PaymentStatus | Error)[]) {
  let i = 0;
  return vi.fn(async () => {
    const next = sequence[Math.min(i++, sequence.length - 1)];
    if (next instanceof Error) throw next;
    return { status: next, walletBalance: 70, purposeResult: null, refundAmount: next === "refunded" ? 20 : null };
  });
}

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    wait: async (ms: number) => {
      t += ms;
    },
  };
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

describe("isValidTopUpAmount", () => {
  it.each([1, 50, 150000])("accepts %s", (amount) => {
    expect(isValidTopUpAmount(amount)).toBe(true);
  });

  it.each([0, -1, 10.5, 150001, NaN])("rejects %s", (amount) => {
    expect(isValidTopUpAmount(amount)).toBe(false);
  });
});

describe("pollPaymentStatus", () => {
  it("returns completed with the new balance", async () => {
    const fetchStatus = statuses("pending", "pending", "completed");

    const outcome = await pollPaymentStatus("S1", { fetchStatus, ...fakeClock() });

    expect(outcome).toEqual({ status: "completed", walletBalance: 70, purposeResult: null });
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });

  it.each(["failed", "expired", "review"] as const)("stops on %s", async (status) => {
    const outcome = await pollPaymentStatus("S1", {
      fetchStatus: statuses("pending", status),
      ...fakeClock(),
    });

    expect(outcome).toEqual({ status });
  });

  it("stops on refunded and reports the refund amount", async () => {
    const outcome = await pollPaymentStatus("S1", {
      fetchStatus: statuses("pending", "refunded"),
      ...fakeClock(),
    });

    expect(outcome).toEqual({ status: "refunded", refundAmount: 20 });
  });

  it("waits five minutes by default before giving up", async () => {
    const fetchStatus = statuses("pending");
    const outcome = await pollPaymentStatus("S1", { fetchStatus, ...fakeClock() });

    expect(outcome).toEqual({ status: "timeout" });
    expect(fetchStatus).toHaveBeenCalledTimes(100); // every 3 s for 5 min
  });

  it("keeps polling through network errors", async () => {
    const outcome = await pollPaymentStatus("S1", {
      fetchStatus: statuses(new Error("offline"), "completed"),
      ...fakeClock(),
    });

    expect(outcome.status).toBe("completed");
  });

  it("times out when the payment stays pending", async () => {
    const fetchStatus = statuses("pending");

    const outcome = await pollPaymentStatus("S1", {
      fetchStatus,
      intervalMs: 3000,
      timeoutMs: 9000,
      ...fakeClock(),
    });

    expect(outcome).toEqual({ status: "timeout" });
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });

  it("stops when aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const outcome = await pollPaymentStatus("S1", {
      fetchStatus: statuses("pending"),
      signal: controller.signal,
      ...fakeClock(),
    });

    expect(outcome).toEqual({ status: "aborted" });
  });
});

describe("startTopUp", () => {
  it("sends the purpose when given", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { success: true, session_id: "S1" }));
    vi.stubGlobal("fetch", fetchMock);

    await startTopUp("0712345678", 100, "subscribe");

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).purpose).toBe("subscribe");
  });

  beforeEach(() => {
    syncStudentToBackend.mockReset();
    vi.unstubAllGlobals();
  });

  it("sends the student's code, phone and amount", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { success: true, session_id: "S1" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await startTopUp("0712345678", 50);

    expect(result).toEqual({ sessionId: "S1", paymentUrl: null });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api.test/api/intasend/payment-session");
    expect(JSON.parse(init.body as string)).toEqual({
      soma_hub_code: "SH-ABC123",
      phone_number: "0712345678",
      amount: 50,
    });
  });

  it("registers the student and retries once when unknown", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { success: false, message: "Student not found" }))
      .mockResolvedValueOnce(jsonResponse(200, { success: true, session_id: "S2" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await startTopUp("0712345678", 50);

    expect(result).toEqual({ sessionId: "S2", paymentUrl: null });
    expect(syncStudentToBackend).toHaveBeenCalledWith({
      soma_hub_code: "SH-ABC123",
      name: "Wanjiku",
      school_name: "Test School",
      grade: "Grade 7",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces the backend's `error` field when there is no `message`", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(502, { success: false, error: "Unable to initiate payment. Please try again." })),
    );

    await expect(startTopUp("0712345678", 50)).rejects.toThrow("Unable to initiate payment. Please try again.");
  });

  it("surfaces the backend's message on other errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(400, { success: false, message: "A valid M-Pesa phone number is required" })),
    );

    await expect(startTopUp("123", 50)).rejects.toThrow("A valid M-Pesa phone number is required");
    expect(syncStudentToBackend).not.toHaveBeenCalled();
  });
});
