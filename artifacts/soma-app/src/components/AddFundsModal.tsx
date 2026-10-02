import { useEffect, useState } from "react";
import { useSomaStore } from "@/lib/storage";
import {
  subscribeFromWallet,
  syncAccount,
} from "@/lib/account";
import { formatExpiry } from "@/lib/subscription";
import { gradeShortName } from "@/data/grade";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  MpesaPayFlow as IntaSendPayFlow,
  formatKsh,
  type PaymentCompleted,
} from "@/components/MpesaPayFlow";
import { useToast } from "@/hooks/use-toast";

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

type Step =
  | { name: "overview" }
  | { name: "top-up" }
  | { name: "subscribe-pay"; amount: number }
  | { name: "topped-up"; amount: number; balance: number }
  | { name: "subscribed" }
  | {
      name: "subscribe-failed";
      amount: number;
      reason: string;
    };

export function AddFundsModal({
  isOpen,
  onClose,
}: Props) {
  const {
    wallet,
    ksh: balance,
    prices,
    subscription,
    grade,
  } = useSomaStore();

  const { toast } = useToast();

  const [step, setStep] = useState<Step>({
    name: "overview",
  });

  const [isSubscribing, setIsSubscribing] =
    useState(false);

  const gradeKey = subscription?.active
    ? subscription.gradeKey
    : grade;

  const gradeLabel = gradeKey
    ? gradeShortName(gradeKey)
    : "your grade";

  useEffect(() => {
    if (!isOpen) return;

    syncAccount().catch(() => {
      // Keep showing the last known balance.
    });
  }, [isOpen]);

  const handleClose = () => {
    setStep({ name: "overview" });
    onClose();
  };

  const handleSubscribe = async () => {
    const shortfall =
      prices.subscriptionKsh - (balance ?? 0);

    if (shortfall > 0) {
      setStep({
        name: "subscribe-pay",
        amount: shortfall,
      });
      return;
    }

    setIsSubscribing(true);

    const result = await subscribeFromWallet();

    setIsSubscribing(false);

    if (result.status === "subscribed") {
      setStep({ name: "subscribed" });
    } else if (result.status === "short") {
      setStep({
        name: "subscribe-pay",
        amount: result.kshNeeded,
      });
    } else {
      toast({
        variant: "destructive",
        title: "Couldn't subscribe",
        description: result.message,
      });
    }
  };

  const handleTopUpCompleted = ({
    amount,
    walletBalance,
  }: PaymentCompleted) => {
    void syncAccount().catch(() => {});

    setStep({
      name: "topped-up",
      amount,
      balance: walletBalance,
    });

    toast({
      title: `✅ ${formatKsh(amount)} added to your wallet`,
    });
  };

  const handleSubscribePaid = async ({
    amount,
    purposeResult,
  }: PaymentCompleted) => {
    await syncAccount().catch(() => {});

    if (purposeResult === "done") {
      setStep({ name: "subscribed" });
    } else {
      setStep({
        name: "subscribe-failed",
        amount,
        reason:
          purposeResult?.replace(
            /^failed:\s*/,
            ""
          ) ?? "unknown error",
      });
    }
  };

  const paymentHeader = (title: string) => (
    <div
      className="px-6 pt-6 pb-5 text-white text-center"
      style={{
        background:
          "linear-gradient(135deg, #128C7E, #25D366)",
      }}
    >
      <div className="text-5xl mb-2">📱</div>

      <h2 className="text-2xl font-extrabold">
        {title}
      </h2>

      <p className="text-sm opacity-80 mt-1">
        SOMA Points:{" "}
        {wallet === null ? "—" : wallet}
      </p>

      <p className="text-xs opacity-70 mt-1">
        Wallet balance:{" "}
        {balance === null
          ? "—"
          : formatKsh(balance)}
      </p>
    </div>
  );

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) =>
        !open && handleClose()
      }
    >
      <DialogContent className="p-0 overflow-hidden border-0 max-w-sm rounded-3xl max-h-[90vh] overflow-y-auto">

        {step.name === "overview" && (
          <>
            <div
              className="px-6 pt-6 pb-5 text-white text-center"
              style={{
                background:
                  "linear-gradient(135deg, #1a3a5c, #1e5799)",
              }}
            >
              <div className="text-5xl mb-2">
                🪙
              </div>

              <h2 className="text-2xl font-extrabold">
                SOMA Points
              </h2>

              <p className="text-4xl font-extrabold mt-2">
                {wallet}
              </p>

              <p className="text-sm opacity-80 mt-1">
                Available to open learning materials
              </p>
            </div>

            <div className="px-6 py-5 space-y-4">

              <div className="flex items-center justify-between rounded-xl border px-3 py-3">
                <div>
                  <p className="text-xs text-muted-foreground">
                    Paid wallet
                  </p>

                  <p className="font-extrabold">
                    {balance === null
                      ? "—"
                      : formatKsh(balance)}
                  </p>

                  <p className="text-xs text-muted-foreground mt-1">
                    1 KSh = 1 SOMA Point
                  </p>
                </div>

                <Button
                  className="rounded-xl text-white"
                  style={{ background: "#25D366" }}
                  onClick={() =>
                    setStep({
                      name: "top-up",
                    })
                  }
                >
                  Add Funds
                </Button>
              </div>

              <div
                className="rounded-xl border px-3 py-3 space-y-2"
                data-testid="subscription-card"
              >
                <div>
                  <p className="text-xs text-muted-foreground">
                    Subscription
                  </p>

                  {subscription?.active ? (
                    <p className="font-extrabold">
                      All {gradeLabel} materials · until{" "}
                      {formatExpiry(
                        subscription.expiresAt
                      )}
                    </p>
                  ) : (
                    <p className="font-extrabold">
                      All {gradeLabel} materials for{" "}
                      {prices.subscriptionDays} days
                    </p>
                  )}
                </div>

                <Button
                  variant={
                    subscription?.active
                      ? "outline"
                      : "default"
                  }
                  className="w-full rounded-xl"
                  disabled={
                    isSubscribing ||
                    balance === null
                  }
                  onClick={handleSubscribe}
                >
                  {isSubscribing
                    ? "Subscribing…"
                    : `${
                        subscription?.active
                          ? "Renew"
                          : "Subscribe"
                      } · ${formatKsh(
                        prices.subscriptionKsh
                      )}`}
                </Button>
              </div>

              <div className="rounded-xl border px-3 py-3 space-y-3">
                <p className="font-bold text-sm text-foreground">
                  How SOMA Points work
                </p>

                <div className="flex items-start gap-3">
                  <span className="text-xl">💳</span>

                  <div>
                    <p className="text-sm font-semibold">
                      Add real funds
                    </p>

                    <p className="text-xs text-muted-foreground">
                      Pay through IntaSend to add funds
                      to your SOMA HUB wallet.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <span className="text-xl">🪙</span>

                  <div>
                    <p className="text-sm font-semibold">
                      Receive the same amount in SOMA Points
                    </p>

                    <p className="text-xs text-muted-foreground">
                      KSh 50 paid means 50 SOMA Points
                      available for materials.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <span className="text-xl">📚</span>

                  <div>
                    <p className="text-sm font-semibold">
                      Use Points to unlock materials
                    </p>

                    <p className="text-xs text-muted-foreground">
                      A material costing{" "}
                      {prices.materialCoins} SOMA Points
                      deducts exactly that amount.
                    </p>
                  </div>
                </div>
              </div>

              <p className="text-xs text-muted-foreground text-center">
                SOMA Points come from funds paid
                into your wallet. Quizzes do not
                generate free Points.
              </p>

              <Button
                variant="outline"
                className="w-full rounded-xl"
                onClick={handleClose}
              >
                Done
              </Button>
            </div>
          </>
        )}

        {step.name === "top-up" && (
          <>
            {paymentHeader("Wallet Top Up")}

            <IntaSendPayFlow
              onBack={() =>
                setStep({
                  name: "overview",
                })
              }
              onCompleted={handleTopUpCompleted}
              onClose={handleClose}
            />
          </>
        )}

        {step.name === "subscribe-pay" && (
          <>
            {paymentHeader("Subscribe")}

            <IntaSendPayFlow
              fixedAmount={step.amount}
              purpose="subscribe"
              description={
                (balance ?? 0) > 0
                  ? `${formatKsh(
                      balance ?? 0
                    )} from your wallet plus ${formatKsh(
                      step.amount
                    )} through IntaSend pays for ${
                      prices.subscriptionDays
                    } days of all ${gradeLabel} materials.`
                  : `${formatKsh(
                      step.amount
                    )} for ${
                      prices.subscriptionDays
                    } days of all ${gradeLabel} materials.`
              }
              onBack={() =>
                setStep({
                  name: "overview",
                })
              }
              onCompleted={handleSubscribePaid}
              onClose={handleClose}
            />
          </>
        )}

        {step.name === "topped-up" && (
          <>
            {paymentHeader("Wallet Top Up")}

            <div className="px-6 py-6 space-y-4 text-center">
              <div className="text-4xl">✅</div>

              <div>
                <p className="font-bold">
                  {formatKsh(step.amount)} added
                </p>

                <p className="text-sm text-muted-foreground mt-1">
                  Your wallet balance is now{" "}
                  {formatKsh(step.balance)}.
                </p>

                <p className="text-sm font-semibold mt-2">
                  You now have {step.balance} SOMA Points.
                </p>
              </div>

              <Button
                className="w-full rounded-xl"
                onClick={handleClose}
              >
                Done
              </Button>
            </div>
          </>
        )}

        {step.name === "subscribed" && (
          <>
            {paymentHeader("Subscribed")}

            <div className="px-6 py-6 space-y-4 text-center">
              <div className="text-4xl">🎉</div>

              <div>
                <p className="font-bold">
                  All {gradeLabel} materials are open
                </p>

                {subscription && (
                  <p className="text-sm text-muted-foreground mt-1">
                    Until{" "}
                    {formatExpiry(
                      subscription.expiresAt
                    )}
                    .
                  </p>
                )}
              </div>

              <Button
                className="w-full rounded-xl"
                onClick={handleClose}
              >
                Start learning
              </Button>
            </div>
          </>
        )}

        {step.name === "subscribe-failed" && (
          <>
            {paymentHeader("Subscribe")}

            <div className="px-6 py-6 space-y-4 text-center">
              <div className="text-4xl">⚠️</div>

              <p className="text-sm text-muted-foreground">
                {formatKsh(step.amount)} was added
                to your wallet, but the subscription
                didn't start ({step.reason}).
                Your money is safe in your wallet.
              </p>

              <Button
                className="w-full rounded-xl"
                onClick={() =>
                  setStep({
                    name: "overview",
                  })
                }
              >
                Back to wallet
              </Button>
            </div>
          </>
        )}

      </DialogContent>
    </Dialog>
  );
}