import { useEffect, useState } from "react";
import { useSomaStore } from "@/lib/storage";
import { syncAccount } from "@/lib/account";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  MpesaPayFlow,
  formatKsh,
  type PaymentCompleted,
} from "@/components/MpesaPayFlow";

export interface UnlockPrompt {
  materialId: string;
  title: string;
  coins: number;
  price: number;
  ksh: number;
  kshNeeded: number;
  canPayWithKsh: boolean;
}

interface Props {
  prompt: UnlockPrompt | null;
  busy: boolean;
  /** Spend the wallet KSh that already covers the shortfall. */
  onPayWithKsh: () => void;
  /** The material is now open to this student. */
  onUnlocked: (materialId: string) => void;
  onTopUp: () => void;
  onCancel: () => void;
}

type View =
  | { name: "choose" }
  | { name: "pay-open"; amount: number }
  | { name: "problem"; message: string };

/**
 * Shown when SOMA Points don't cover an unlock.
 * Never spends KSh without the student choosing to.
 */
export function UnlockDialog({
  prompt,
  busy,
  onPayWithKsh,
  onUnlocked,
  onTopUp,
  onCancel,
}: Props) {
  useSomaStore();
  const [view, setView] = useState<View>({ name: "choose" });

  useEffect(() => {
    setView({ name: "choose" });
  }, [prompt?.materialId]);

  if (!prompt) {
    return <Dialog open={false} />;
  }

  const mpesaForMaterial = Math.max(prompt.kshNeeded - prompt.ksh, 1);

  const handlePaid = async ({
    amount,
    purposeResult,
  }: PaymentCompleted) => {
    await syncAccount().catch(() => {});

    if (purposeResult === "done") {
      onUnlocked(prompt.materialId);
    } else {
      setView({
        name: "problem",
        message: `${formatKsh(amount)} was added to your wallet, but it couldn't be used (${
          purposeResult?.replace(/^failed:\s*/, "") ?? "unknown error"
        }). Your money is safe in your wallet.`,
      });
    }
  };

  const close = () => {
    setView({ name: "choose" });
    onCancel();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-sm rounded-3xl p-0 overflow-hidden">
        {view.name === "choose" && (
          <div className="p-6 space-y-4 text-center">
            <div className="text-4xl">🔒</div>

            <div>
              <h2 className="text-lg font-extrabold">{prompt.title}</h2>

              <p className="text-sm text-muted-foreground mt-1">
                Unlocking costs {prompt.price} SOMA Points. You have{" "}
                {prompt.coins} SOMA Points.
              </p>
            </div>

            {prompt.canPayWithKsh ? (
              <>
                <p className="text-sm">
                  KSh {prompt.kshNeeded} will come from your M-Pesa wallet
                  (balance KSh {prompt.ksh}).
                </p>

                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="flex-1 rounded-xl"
                    onClick={close}
                  >
                    Cancel
                  </Button>

                  <Button
                    className="flex-1 rounded-xl text-white"
                    style={{ background: "#25D366" }}
                    disabled={busy}
                    onClick={onPayWithKsh}
                  >
                    {busy ? "Unlocking…" : `Pay KSh ${prompt.kshNeeded}`}
                  </Button>
                </div>
              </>
            ) : (
              <Button
                className="w-full rounded-xl text-white"
                style={{ background: "#25D366" }}
                onClick={() =>
                  setView({
                    name: "pay-open",
                    amount: mpesaForMaterial,
                  })
                }
              >
                Pay {formatKsh(mpesaForMaterial)} with M-Pesa & open
              </Button>
            )}

            {!prompt.canPayWithKsh && (
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  className="flex-1 rounded-xl"
                  onClick={close}
                >
                  Cancel
                </Button>

                <Button
                  variant="ghost"
                  className="flex-1 rounded-xl"
                  onClick={onTopUp}
                >
                  Top up
                </Button>
              </div>
            )}
          </div>
        )}

        {view.name === "pay-open" && (
          <MpesaPayFlow
            fixedAmount={view.amount}
            purpose={`unlock:${prompt.materialId}`}
            description={`Pay ${formatKsh(
              view.amount
            )} to open "${prompt.title}".`}
            submitLabel={`${`Pay ${formatKsh(view.amount)}`} & open`}
            onBack={() => setView({ name: "choose" })}
            onCompleted={handlePaid}
            onClose={close}
          />
        )}

        {view.name === "problem" && (
          <div className="p-6 space-y-4 text-center">
            <div className="text-4xl">⚠️</div>

            <p className="text-sm text-muted-foreground">
              {view.message}
            </p>

            <Button className="w-full rounded-xl" onClick={close}>
              Close
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}