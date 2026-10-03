import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";

interface Props {
  onContinue: () => void;
  onDeveloperLogin: () => void;
}

export default function WelcomePage({
  onContinue,
  onDeveloperLogin,
}: Props) {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center relative overflow-hidden"
      style={{
        background:
          "linear-gradient(135deg, #0d2137 0%, #1a3a5c 50%, #1e4d7b 100%)",
      }}
    >
      {/* Background decorative circles */}
      <div
        className="absolute top-0 left-0 w-64 h-64 rounded-full opacity-10"
        style={{
          background:
            "radial-gradient(circle, #4a9eff, transparent)",
          transform: "translate(-30%, -30%)",
        }}
      />

      <div
        className="absolute bottom-0 right-0 w-96 h-96 rounded-full opacity-10"
        style={{
          background:
            "radial-gradient(circle, #e67e22, transparent)",
          transform: "translate(30%, 30%)",
        }}
      />

      <div
        className="absolute top-1/3 right-10 w-32 h-32 rounded-full opacity-5"
        style={{
          background:
            "radial-gradient(circle, #ffffff, transparent)",
        }}
      />

      {/* Dancing Lion */}
      <motion.div
        className="text-9xl mb-6 select-none"
        animate={{
          y: [0, -18, 0, -10, 0],
          rotate: [-4, 4, -4, 2, -2, 0],
          scale: [1, 1.08, 1, 1.05, 1],
        }}
        transition={{
          duration: 1.4,
          repeat: Infinity,
          ease: "easeInOut",
        }}
        style={{
          filter: "drop-shadow(0 8px 24px rgba(0,0,0,0.4))",
        }}
      >
        🦁
      </motion.div>

      {/* 3D SOMA HUB text */}
      <h1
        className="font-extrabold tracking-widest text-center mb-3 select-none"
        style={{
          fontSize: "clamp(3.5rem, 12vw, 7rem)",
          color: "#ffffff",
          textShadow: `
            3px 3px 0px #e67e22,
            6px 6px 0px #c0620f,
            9px 9px 0px #8b4510,
            12px 12px 20px rgba(0,0,0,0.5),
            0 0 40px rgba(230,126,34,0.3)
          `,
          letterSpacing: "0.12em",
        }}
      >
        SOMA HUB
      </h1>

      {/* Tagline */}
      <motion.p
        className="text-xl md:text-2xl font-semibold mb-12 tracking-wider italic"
        style={{ color: "#e67e22" }}
        animate={{ opacity: [0.7, 1, 0.7] }}
        transition={{
          duration: 2,
          repeat: Infinity,
          ease: "easeInOut",
        }}
      >
        SOMA, SCORE, SMILE!
      </motion.p>

      {/* Start button */}
      <motion.div
        whileHover={{ scale: 1.06 }}
        whileTap={{ scale: 0.97 }}
      >
        <Button
          size="lg"
          className="text-xl font-bold px-14 py-8 rounded-full shadow-2xl border-0"
          style={{
            background:
              "linear-gradient(135deg, #e67e22, #d35400)",
            color: "#fff",
            boxShadow:
              "0 8px 32px rgba(230,126,34,0.5), 0 2px 8px rgba(0,0,0,0.3)",
          }}
          onClick={onContinue}
          data-testid="btn-start-learning"
        >
          START LEARNING
        </Button>
      </motion.div>

      {/* Floating stars */}
      {[...Array(6)].map((_, i) => (
        <motion.div
          key={i}
          className="absolute text-2xl pointer-events-none select-none"
          style={{
            left: `${10 + i * 15}%`,
            top: `${15 + (i % 3) * 25}%`,
            opacity: 0.25,
          }}
          animate={{
            y: [0, -12, 0],
            opacity: [0.15, 0.35, 0.15],
          }}
          transition={{
            duration: 2 + i * 0.4,
            repeat: Infinity,
            delay: i * 0.3,
          }}
        >
          ⭐
        </motion.div>
      ))}
    </div>
  );
}