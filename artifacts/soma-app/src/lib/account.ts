import {
  ApiError,
  apiRequest,
  postJson,
} from "@/lib/api";

import {
  syncStudentToBackend,
  useSomaStore,
  type ServerAccount,
} from "@/lib/storage";

/* =========================================================
   SERVER ACCOUNT: PAID WALLET, KSH AND UNLOCKS

   The server is the source of truth for:
   - SOMA Points / paid wallet balance
   - KSh wallet balance
   - material unlocks
   - subscription information

   Local purchased/unlocked data is NEVER uploaded to the
   server as a free import.
   ========================================================= */

interface AccountResponse {
  coins: number;
  ksh: number;
  unlocked: string[];
  earned_today: number;
  imported: boolean;
  prices: {
    material_coins: number;
    ksh_per_coin: number;
    daily_cap: number;
    subscription_ksh: number;
    subscription_days: number;
  };
  subscription: {
    grade_key: string;
    expires_at: string;
    active: boolean;
  } | null;
}

export function toServerAccount(
  response: AccountResponse
): ServerAccount {
  return {
    coins: response.coins,
    ksh: response.ksh,
    unlocked: response.unlocked,
    earnedToday: response.earned_today,
    imported: response.imported,
    prices: {
      materialCoins: response.prices.material_coins,
      kshPerCoin: response.prices.ksh_per_coin,
      dailyCap: response.prices.daily_cap,
      subscriptionKsh: response.prices.subscription_ksh,
      subscriptionDays: response.prices.subscription_days,
    },
    subscription: response.subscription
      ? {
          gradeKey: response.subscription.grade_key,
          expiresAt: response.subscription.expires_at,
          active: response.subscription.active,
        }
      : null,
  };
}

function apply(response: AccountResponse) {
  useSomaStore
    .getState()
    .applyAccount(toServerAccount(response));
}

function student() {
  const state = useSomaStore.getState();

  return {
    soma_hub_code: state.somaHubCode,
    name: state.name ?? "",
    school_name: state.schoolName ?? "",
    grade: state.grade ?? "",
  };
}

/** Retries once after registering the student if the server doesn't know them. */
async function withRegistration<T>(
  call: () => Promise<T>
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.httpStatus === 404 &&
      student().name
    ) {
      await syncStudentToBackend(student());
      return call();
    }

    throw error;
  }
}

/* ---------------------------------------------------------
   Account Sync
   --------------------------------------------------------- */

let syncInFlight: Promise<void> | null = null;

/**
 * Loads the paid server account into the local store.
 *
 * IMPORTANT:
 * The server is the source of truth.
 *
 * Local wallet balances and local material unlocks are NOT
 * imported into the server.
 *
 * This prevents old/local state from creating free SOMA
 * Points or free material unlocks.
 */
export function syncAccount(): Promise<void> {
  if (!syncInFlight) {
    syncInFlight = runSync().finally(() => {
      syncInFlight = null;
    });
  }

  return syncInFlight;
}

async function runSync(): Promise<void> {
  const code = student().soma_hub_code;

  const account = await withRegistration(() =>
    apiRequest<AccountResponse>(
      `/api/account/${encodeURIComponent(code)}`
    )
  );

  apply(account);
}

/* ---------------------------------------------------------
   Material Unlocking
   --------------------------------------------------------- */

export type UnlockResult =
  | {
      status: "unlocked";
      coinsSpent: number;
      kshSpent: number;
      alreadyUnlocked: boolean;
      viaSubscription: boolean;
    }
  | {
      status: "short";
      coins: number;
      ksh: number;
      price: number;
      shortfallCoins: number;
      kshNeeded: number;
      canPayWithKsh: boolean;
    }
  | {
      status: "error";
      message: string;
    };

/**
 * Unlocks a material through the server.
 *
 * The server verifies the paid wallet balance and performs
 * the actual debit/unlock atomically.
 *
 * Without allowKsh, a payment shortfall is returned as
 * "short" so the UI can ask before using the paid wallet.
 */
export async function unlockMaterial(
  materialId: string,
  allowKsh = false
): Promise<UnlockResult> {
  try {
    const response = await withRegistration(() =>
      postJson<
        AccountResponse & {
          coins_spent: number;
          ksh_spent: number;
          already_unlocked: boolean;
          via_subscription: boolean;
        }
      >("/api/unlocks", {
        soma_hub_code: student().soma_hub_code,
        material_id: materialId,
        allow_ksh: allowKsh,
      })
    );

    apply(response);

    useSomaStore
      .getState()
      .showInLibrary(materialId);

    return {
      status: "unlocked",
      coinsSpent: response.coins_spent,
      kshSpent: response.ksh_spent,
      alreadyUnlocked: response.already_unlocked,
      viaSubscription: response.via_subscription,
    };
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.httpStatus === 402
    ) {
      const body = error.body as Record<
        string,
        number | boolean
      >;

      return {
        status: "short",
        coins: Number(body.coins),
        ksh: Number(body.ksh),
        price: Number(body.price),
        shortfallCoins: Number(body.shortfall_coins),
        kshNeeded: Number(body.ksh_needed),
        canPayWithKsh:
          body.can_pay_with_ksh === true,
      };
    }

    return {
      status: "error",
      message:
        error instanceof Error
          ? error.message
          : "Couldn't unlock this material.",
    };
  }
}