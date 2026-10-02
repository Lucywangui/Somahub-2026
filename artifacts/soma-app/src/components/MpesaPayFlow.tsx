import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import {
  MAX_TOPUP_AMOUNT,
  MIN_TOPUP_AMOUNT,
  isValidTopUpAmount,
  pollPaymentStatus,
  simulateTestPayment,
  startTopUp,
  type PaymentPurpose,
} from "@/lib/payments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

export interface PaymentCompleted {
  amount: number;
  walletBalance: number;
  /** "done", "failed: <reason>", or null for a plain top-up. */
  purposeResult: string | null;
}

interface Props {
  /** Amount for a purchase. Omit to let the student choose a top-up. */
  fixedAmount?: number;
  purpose?: PaymentPurpose;
  /** Shown above the form, e.g. what the payment is for. */
  description?: string;
  submitLabel?: string;
  onBack: () => void;
  onCompleted: (result: PaymentCompleted) => void;
  onClose: () => void;
}

type Step =
  | { name: "form" }
  | {
      name: "waiting";
      sessionId: string;
      amount: number;
      paymentUrl?: string | null;
    }
  | { name: "failed"; message: string }
  | { name: "timeout" };

const QUICK_AMOUNTS = [20, 50, 100, 200];

const PHONE_STORAGE_KEY = "soma_payment_phone";

const FAILURE_MESSAGES = {
  failed:
    "The payment was cancelled or didn't go through. No money was taken.",
  expired:
    "The payment request expired before it was completed.",
};

export const formatKsh = (amount: number) =>
  `KSh ${amount.toLocaleString()}`;

function loadSavedPhone(): string {
  try {
    return localStorage.getItem(PHONE_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function savePhone(phone: string) {
  try {
    localStorage.setItem(PHONE_STORAGE_KEY, phone);
  } catch {
    // Remembering the number is only a convenience.
  }
}

/**
 * IntaSend payment flow:
 * payment details -> IntaSend checkout -> payment confirmation ->
 * wallet update.
 *
 * The backend remains responsible for confirming the payment and
 * crediting the student's paid SOMA Points wallet.
 */
export function MpesaPayFlow({
  fixedAmount,
  purpose,
  description,
  submitLabel,
  onBack,
  onCompleted,
  onClose,
}: Props) {
  const { toast } = useToast();

  const [step, setStep] = useState<Step>({ name: "form" });
  const [phone, setPhone] = useState(loadSavedPhone);
  const [amount, setAmount] = useState(
    fixedAmount ? String(fixedAmount) : "",
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const pollAbort = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      pollAbort.current?.abort();
    },
    [],
  );

  const waitForPayment = async (
    sessionId: string,
    paidAmount: number,
  ) => {
    pollAbort.current?.abort();

    const controller = new AbortController();
    pollAbort.current = controller;

    const outcome = await pollPaymentStatus(sessionId, {
      signal: controller.signal,
    });

    if (outcome.status === "aborted") {
      return;
    }

    if (outcome.status === "completed") {
      onCompleted({
        amount: paidAmount,
        walletBalance: outcome.walletBalance,
        purposeResult: outcome.purposeResult,
      });
    } else if (outcome.status === "timeout") {
      setStep({ name: "timeout" });
    } else {
      setStep({
        name: "failed",
        message: FAILURE_MESSAGES[outcome.status],
      });
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    const numericAmount = fixedAmount ?? Number(amount);

    if (!isValidTopUpAmount(numericAmount)) {
      setFormError(
        `Enter a whole amount between ${formatKsh(
          MIN_TOPUP_AMOUNT,
        )} and ${formatKsh(MAX_TOPUP_AMOUNT)}.`,
      );
      return;
    }

    if (!phone.trim()) {
      setFormError("Enter your phone number for the payment.");
      return;
    }

    setFormError(null);
    setIsSubmitting(true);

    try {
      const result = await startTopUp(
        phone.trim(),
        numericAmount,
        purpose,
      );

      savePhone(phone.trim());

      setStep({
        name: "waiting",
        sessionId: result.sessionId,
        amount: numericAmount,
        paymentUrl: result.paymentUrl,
      });

      /*
       * If IntaSend returns a hosted checkout URL, open it in a
       * new browser tab/window. The payment is still confirmed
       * by the backend before the wallet is credited.
       */
      if (result.paymentUrl) {
        window.open(
          result.paymentUrl,
          "_blank",
          "noopener,noreferrer",
        );
      }

      void waitForPayment(
        result.sessionId,
        numericAmount,
      );
    } catch (error) {
      setFormError(
        error instanceof ApiError
          ? error.message
          : "Something went wrong. Please try again.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSimulate = async (sessionId: string) => {
    try {
      await simulateTestPayment(sessionId);
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Simulation failed",
        description:
          error instanceof Error
            ? error.message
            : undefined,
      });
    }
  };

  if (step.name === "form") {
    return (
      <form
        className="px-6 py-5 space-y-4"
        onSubmit={handleSubmit}
      >
        {description && (
          <p className="text-sm text-muted-foreground">
            {description}
          </p>
        )}

        <div className="space-y-1.5">
          <label
            htmlFor="payment-phone"
            className="text-sm font-bold"
          >
            Phone number
          </label>

          <Input
            id="payment-phone"
            type="tel"
            inputMode="tel"
            placeholder="0712 345 678"
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value);
              setFormError(null);
            }}
            className="rounded-xl"
          />
        </div>

        {fixedAmount === undefined && (
          <div className="space-y-1.5">
            <label
              htmlFor="payment-amount"
              className="text-sm font-bold"
            >
              Amount (KSh)
            </label>

            <div className="grid grid-cols-4 gap-2">
              {QUICK_AMOUNTS.map((quick) => (
                <Button
                  key={quick}
                  type="button"
                  variant="outline"
                  aria-pressed={amount === String(quick)}
                  className={
                    amount === String(quick)
                      ? "rounded-xl border-[#25D366] bg-[#25D366]/15 font-bold"
                      : "rounded-xl"
                  }
                  onClick={() => {
                    setAmount(String(quick));
                    setFormError(null);
                  }}
                >
                  {quick}
                </Button>
              ))}
            </div>

            <Input
              id="payment-amount"
              type="number"
              inputMode="numeric"
              min={MIN_TOPUP_AMOUNT}
              max={MAX_TOPUP_AMOUNT}
              step={1}
              placeholder="Or enter an amount"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setFormError(null);
              }}
              className="rounded-xl"
            />
          </div>
        )}

        {formError && (
          <p
            role="alert"
            className="text-sm text-destructive"
          >
            {formError}
          </p>
        )}

        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            className="flex-1 rounded-xl"
            onClick={() => {
              setFormError(null);
              onBack();
            }}
          >
            Back
          </Button>

          <Button
            type="submit"
            disabled={isSubmitting}
            className="flex-1 rounded-xl text-white"
            style={{ background: "#25D366" }}
          >
            {isSubmitting
              ? "Opening payment…"
              : submitLabel ??
                (fixedAmount
                  ? `Pay ${formatKsh(fixedAmount)}`
                  : "Pay")}
          </Button>
        </div>
      </form>
    );
  }

  if (step.name === "waiting") {
    return (
      <div className="px-6 py-6 space-y-4 text-center">
        <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-muted border-t-[#25D366]" />

        <div>
          <p className="font-bold">
            Complete your payment
          </p>

          <p className="text-sm text-muted-foreground mt-1">
            Complete the IntaSend payment for{" "}
            {formatKsh(step.amount)}. We’ll update your
            SOMA Points wallet as soon as the payment is
            confirmed.
          </p>
        </div>

        {step.paymentUrl && (
          <Button
            variant="outline"
            className="w-full rounded-xl"
            onClick={() =>
              window.open(
                step.paymentUrl!,
                "_blank",
                "noopener,noreferrer",
              )
            }
          >
            Open payment page
          </Button>
        )}

        {import.meta.env.DEV && (
          <Button
            variant="ghost"
            className="rounded-xl text-xs text-muted-foreground"
            onClick={() =>
              handleSimulate(step.sessionId)
            }
          >
            Simulate success (dev)
          </Button>
        )}

        <Button
          variant="outline"
          className="w-full rounded-xl"
          onClick={onClose}
        >
          Close
        </Button>
      </div>
    );
  }

  if (step.name === "failed") {
    return (
      <div className="px-6 py-6 space-y-4 text-center">
        <div className="text-4xl">⚠️</div>

        <p className="text-sm text-muted-foreground">
          {step.message}
        </p>

        <div className="flex gap-2">
          <Button
            variant="outline"
            className="flex-1 rounded-xl"
            onClick={onClose}
          >
            Close
          </Button>

          <Button
            className="flex-1 rounded-xl"
            onClick={() =>
              setStep({ name: "form" })
            }
          >
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="px-6 py-6 space-y-4 text-center">
      <div className="text-4xl">⏳</div>

      <p className="text-sm text-muted-foreground">
        We haven’t received the payment confirmation yet.
        If you completed the payment, your SOMA Points
        wallet will update once IntaSend confirms it.
      </p>

      <Button
        className="w-full rounded-xl"
        onClick={onClose}
      >
        Done
      </Button>
    </div>
  );
}