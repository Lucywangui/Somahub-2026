import { useState } from "react";
import { motion } from "framer-motion";
import { useSomaStore } from "@/lib/storage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Props {
  onNext: () => void;
}

export function NamePage({ onNext }: Props) {
  const { setName } = useSomaStore();
  const [inputName, setInputName] = useState("");

  const handleContinue = () => {
    const trimmed = inputName.trim();

    if (!trimmed) return;

    setName(trimmed);
    onNext();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleContinue();
    }
  };

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center px-6"
      style={{
        background:
          "linear-gradient(135deg, #0d2137 0%, #1a3a5c 50%, #1e4d7b 100%)",
      }}
    >
      {/* Card */}
      <motion.div
        className="w-full max-w-md rounded-3xl p-10 flex flex-col items-center text-center shadow-2xl"
        style={{
          background: "rgba(255,255,255,0.07)",
          backdropFilter: "blur(20px)",
          border: "1px solid rgba(255,255,255,0.15)",
        }}
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{
          duration: 0.5,
          ease: "easeOut",
        }}
      >
        {/* Icon */}
        <div
          className="text-7xl mb-6 select-none"
          style={{
            filter: "drop-shadow(0 4px 12px rgba(0,0,0,0.3))",
          }}
        >
          👋
        </div>

        <h1
          className="text-4xl font-extrabold mb-2"
          style={{ color: "#ffffff" }}
        >
          Hello there!
        </h1>

        <p
          className="text-lg mb-8"
          style={{ color: "rgba(255,255,255,0.65)" }}
        >
          What's your name? We'll use it to personalise your experience.
        </p>

        {/* Input */}
        <Input
          type="text"
          placeholder="Enter your name..."
          value={inputName}
          onChange={(e) => setInputName(e.target.value)}
          onKeyDown={handleKeyDown}
          maxLength={30}
          className="text-xl text-center py-6 rounded-2xl border-0 mb-8 font-semibold"
          style={{
            background: "rgba(255,255,255,0.12)",
            color: "#ffffff",
            caretColor: "#e67e22",
          }}
          data-testid="input-name"
        />

        <motion.div
          className="w-full"
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.97 }}
        >
          <Button
            size="lg"
            disabled={!inputName.trim()}
            className="w-full text-xl font-bold py-7 rounded-2xl border-0"
            style={{
              background: inputName.trim()
                ? "linear-gradient(135deg, #e67e22, #d35400)"
                : "rgba(255,255,255,0.1)",
              color: "#fff",
              boxShadow: inputName.trim()
                ? "0 6px 24px rgba(230,126,34,0.45)"
                : "none",
            }}
            onClick={handleContinue}
            data-testid="btn-continue-name"
          >
            CONTINUE →
          </Button>
        </motion.div>

        {/* Step indicator */}
        <div className="flex gap-2 mt-8">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="rounded-full transition-all"
              style={{
                width: i === 0 ? 24 : 8,
                height: 8,
                background:
                  i === 0
                    ? "#e67e22"
                    : "rgba(255,255,255,0.25)",
              }}
            />
          ))}
        </div>
      </motion.div>
    </div>
  );
}