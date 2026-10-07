import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const applyAccount = vi.fn();
const showInLibrary = vi.fn();
const syncStudentToBackend = vi.fn();

const state = {
  somaHubCode: "SH-ABC123",
  name: "Wanjiku",
  schoolName: "Test School",
  grade: "Grade 7",
  wallet: 80,
  purchased: ["m1"],
  libraryHidden: ["m2"],
  applyAccount,
  showInLibrary,
};

vi.mock("@/lib/storage", () => ({
  SOMA_API_BASE_URL: "http://api.test",

  syncStudentToBackend: (
    ...args: unknown[]
  ) => syncStudentToBackend(...args),

  useSomaStore: {
    getState: () => state,
  },
}));

import {
  syncAccount,
  toServerAccount,
  unlockMaterial,
} from "@/lib/account";

const ACCOUNT = {
  success: true,

  // Server wallet balance.
  // This is the paid SOMA Points balance.
  coins: 10,
  ksh: 10,

  unlocked: ["m1"],

  earned_today: 0,

  imported: true,

  prices: {
    material_coins: 5,
    ksh_per_coin: 1,
    daily_cap: 0,
    subscription_ksh: 100,
    subscription_days: 30,
  },

  subscription: null,
};

function jsonResponse(
  status: number,
  body: unknown
) {
  return new Response(
    JSON.stringify(body),
    {
      status,
      headers: {
        "Content-Type":
          "application/json",
      },
    }
  );
}

function sentBodies(
  fetchMock: ReturnType<typeof vi.fn>
) {
  return fetchMock.mock.calls.map(
    ([url, init]) => ({
      url: String(url).replace(
        "http://api.test",
        ""
      ),
      body: init?.body
        ? JSON.parse(
            init.body as string
          )
        : undefined,
    })
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();

  applyAccount.mockReset();
  showInLibrary.mockReset();
  syncStudentToBackend.mockReset();
});


// ============================================================
// syncAccount
// ============================================================

describe("syncAccount", () => {
  it("loads the account directly from the server", async () => {
    const fetchMock = vi.fn(
      async () =>
        jsonResponse(
          200,
          ACCOUNT
        )
    );

    vi.stubGlobal(
      "fetch",
      fetchMock
    );

    await syncAccount();

    expect(
      sentBodies(fetchMock)
    ).toEqual([
      {
        url:
          "/api/account/SH-ABC123",
        body: undefined,
      },
    ]);

    expect(
      applyAccount
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        coins: 10,
        ksh: 10,
        unlocked: ["m1"],
      })
    );
  });

  it("does not import local wallet balance or local unlocks", async () => {
    const fetchMock = vi.fn(
      async () =>
        jsonResponse(
          200,
          {
            ...ACCOUNT,
            coins: 0,
            ksh: 0,
            unlocked: [],
            imported: false,
          }
        )
    );

    vi.stubGlobal(
      "fetch",
      fetchMock
    );

    await syncAccount();

    const calls =
      sentBodies(fetchMock);

    expect(calls).toHaveLength(1);

    expect(calls[0].url).toBe(
      "/api/account/SH-ABC123"
    );

    expect(
      calls.some(
        (call) =>
          call.url ===
          "/api/account/import"
      )
    ).toBe(false);

    expect(
      syncStudentToBackend
    ).not.toHaveBeenCalled();
  });

  it("uses the server balance even when local state has a different balance", async () => {
    const fetchMock = vi.fn(
      async () =>
        jsonResponse(
          200,
          {
            ...ACCOUNT,
            coins: 25,
            ksh: 25,
          }
        )
    );

    vi.stubGlobal(
      "fetch",
      fetchMock
    );

    await syncAccount();

    expect(
      applyAccount
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        coins: 25,
        ksh: 25,
      })
    );
  });

  it("does not create free SOMA Points when the server balance is zero", async () => {
    const fetchMock = vi.fn(
      async () =>
        jsonResponse(
          200,
          {
            ...ACCOUNT,
            coins: 0,
            ksh: 0,
            unlocked: [],
          }
        )
    );

    vi.stubGlobal(
      "fetch",
      fetchMock
    );

    await syncAccount();

    expect(
      applyAccount
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        coins: 0,
        ksh: 0,
        unlocked: [],
      })
    );
  });
});


// ============================================================
// toServerAccount
// ============================================================

describe("toServerAccount", () => {
  it("maps the paid wallet balance correctly", () => {
    const account =
      toServerAccount(
        ACCOUNT
      );

    expect(
      account.coins
    ).toBe(10);

    expect(
      account.ksh
    ).toBe(10);
  });

  it("maps unlocked materials correctly", () => {
    const account =
      toServerAccount(
        ACCOUNT
      );

    expect(
      account.unlocked
    ).toEqual(["m1"]);
  });

  it("maps material pricing correctly", () => {
    const account =
      toServerAccount(
        ACCOUNT
      );

    expect(
      account.prices.materialCoins
    ).toBe(5);

    expect(
      account.prices.kshPerCoin
    ).toBe(1);

    expect(
      account.prices.dailyCap
    ).toBe(0);
  });

  it("keeps subscription data as null when no subscription exists", () => {
    const account =
      toServerAccount({
        ...ACCOUNT,
        subscription: null,
      });

    expect(
      account.subscription
    ).toBeNull();
  });

  it("maps legacy subscription data without affecting the wallet", () => {
    const account =
      toServerAccount({
        ...ACCOUNT,
        subscription: {
          grade_key: "cbc-7",
          expires_at:
            "2026-10-26 12:00:00",
          active: true,
        },
      });

    expect(
      account.subscription
    ).toEqual({
      gradeKey: "cbc-7",
      expiresAt:
        "2026-10-26 12:00:00",
      active: true,
    });

    expect(
      account.coins
    ).toBe(10);

    expect(
      account.ksh
    ).toBe(10);
  });
});


// ============================================================
// unlockMaterial
// ============================================================

describe("unlockMaterial", () => {
  it("unlocks a material using the paid wallet", async () => {
    const fetchMock = vi.fn(
      async () =>
        jsonResponse(
          200,
          {
            ...ACCOUNT,
            coins: 5,
            ksh: 5,
            coins_spent: 5,
            ksh_spent: 0,
            already_unlocked:
              false,
          }
        )
    );

    vi.stubGlobal(
      "fetch",
      fetchMock
    );

    const result =
      await unlockMaterial(
        "m9"
      );

    expect(result).toEqual({
      status: "unlocked",
      coinsSpent: 5,
      kshSpent: 0,
      alreadyUnlocked: false,
    });

    expect(
      applyAccount
    ).toHaveBeenCalled();

    expect(
      showInLibrary
    ).toHaveBeenCalledWith(
      "m9"
    );
  });

  it("sends the material unlock request to the server", async () => {
    const fetchMock = vi.fn(
      async () =>
        jsonResponse(
          200,
          {
            ...ACCOUNT,
            coins_spent: 5,
            ksh_spent: 0,
            already_unlocked:
              false,
          }
        )
    );

    vi.stubGlobal(
      "fetch",
      fetchMock
    );

    await unlockMaterial(
      "m9"
    );

    const calls =
      sentBodies(fetchMock);

    expect(
      calls[0].url
    ).toBe("/api/unlocks");

    expect(
      calls[0].body
    ).toMatchObject({
      soma_hub_code:
        "SH-ABC123",
      material_id: "m9",
    });
  });

  it("maps insufficient paid wallet balance to a shortfall", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          402,
          {
            success: false,
            message:
              "Not enough wallet balance",
            coins: 2,
            ksh: 2,
            price: 5,
            shortfall_coins: 3,
            ksh_needed: 3,
            can_pay_with_ksh:
              true,
          }
        )
      )
    );

    expect(
      await unlockMaterial(
        "m9"
      )
    ).toEqual({
      status: "short",
      coins: 2,
      ksh: 2,
      price: 5,
      shortfallCoins: 3,
      kshNeeded: 3,
      canPayWithKsh: true,
    });
  });

  it("sends allow_ksh when explicitly confirmed", async () => {
    const fetchMock = vi.fn(
      async () =>
        jsonResponse(
          200,
          {
            ...ACCOUNT,
            coins_spent: 2,
            ksh_spent: 3,
            already_unlocked:
              false,
          }
        )
    );

    vi.stubGlobal(
      "fetch",
      fetchMock
    );

    await unlockMaterial(
      "m9",
      true
    );

    expect(
      sentBodies(fetchMock)[0]
        .body.allow_ksh
    ).toBe(true);
  });

  it("does not send allow_ksh by default", async () => {
    const fetchMock = vi.fn(
      async () =>
        jsonResponse(
          200,
          {
            ...ACCOUNT,
            coins_spent: 5,
            ksh_spent: 0,
            already_unlocked:
              false,
          }
        )
    );

    vi.stubGlobal(
      "fetch",
      fetchMock
    );

    await unlockMaterial(
      "m9"
    );

    expect(
      sentBodies(fetchMock)[0]
        .body.allow_ksh
    ).not.toBe(true);
  });

  it("handles an already unlocked material", async () => {
    const fetchMock = vi.fn(
      async () =>
        jsonResponse(
          200,
          {
            ...ACCOUNT,
            unlocked: [
              "m1",
              "m9",
            ],
            coins_spent: 0,
            ksh_spent: 0,
            already_unlocked:
              true,
          }
        )
    );

    vi.stubGlobal(
      "fetch",
      fetchMock
    );

    const result =
      await unlockMaterial(
        "m9"
      );

    expect(result).toEqual({
      status: "unlocked",
      coinsSpent: 0,
      kshSpent: 0,
      alreadyUnlocked: true,
    });

    expect(
      showInLibrary
    ).toHaveBeenCalledWith(
      "m9"
    );
  });

  it("returns an error when offline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError(
          "offline"
        );
      })
    );

    const result =
      await unlockMaterial(
        "m9"
      );

    expect(
      result.status
    ).toBe("error");
  });
});


// ============================================================
// No free reward APIs
// ============================================================

describe("paid-wallet economy", () => {
  it("does not expose reward or coin-purchase behavior through account syncing", async () => {
    const fetchMock = vi.fn(
      async () =>
        jsonResponse(
          200,
          ACCOUNT
        )
    );

    vi.stubGlobal(
      "fetch",
      fetchMock
    );

    await syncAccount();

    const urls =
      sentBodies(fetchMock).map(
        (call) => call.url
      );

    expect(
      urls.some(
        (url) =>
          url ===
          "/api/coins/reward"
      )
    ).toBe(false);

    expect(
      urls.some(
        (url) =>
          url ===
          "/api/coins/buy"
      )
    ).toBe(false);

    expect(
      urls.some(
        (url) =>
          url ===
          "/api/dev/grant-coins"
      )
    ).toBe(false);
  });

  it("never converts local wallet state into a server deposit", async () => {
    const fetchMock = vi.fn(
      async () =>
        jsonResponse(
          200,
          {
            ...ACCOUNT,
            coins: 0,
            ksh: 0,
          }
        )
    );

    vi.stubGlobal(
      "fetch",
      fetchMock
    );

    await syncAccount();

    const urls =
      sentBodies(fetchMock).map(
        (call) => call.url
      );

    expect(
      urls
    ).not.toContain(
      "/api/account/import"
    );

    expect(
      urls
    ).not.toContain(
      "/api/coins/reward"
    );

    expect(
      urls
    ).not.toContain(
      "/api/coins/buy"
    );
  });
});