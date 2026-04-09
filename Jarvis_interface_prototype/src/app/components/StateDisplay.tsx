import { motion, AnimatePresence } from "motion/react";
import { AgentState } from "./JarvisOrb";

const stateColors = {
  idle: "rgba(100, 160, 255, 0.6)",
  listening: "#00d4ff",
  thinking: "#7799ff",
  acting: "#ff9944",
  done: "#00ffaa",
};

interface StateDisplayProps {
  state: AgentState;
  message: string;
  subMessage?: string;
}

export function StateDisplay({ state, message, subMessage }: StateDisplayProps) {
  const color = stateColors[state];

  return (
    <div className="flex flex-col items-center gap-3" style={{ minHeight: 80 }}>
      {/* Decorative line above */}
      <div className="flex items-center gap-3 w-full justify-center">
        <div
          style={{
            height: 1,
            width: 60,
            background: `linear-gradient(to right, transparent, ${color})`,
          }}
        />
        <div
          style={{
            width: 4,
            height: 4,
            background: color,
            borderRadius: 1,
            transform: "rotate(45deg)",
            boxShadow: `0 0 8px ${color}`,
          }}
        />
        <div
          style={{
            height: 1,
            width: 60,
            background: `linear-gradient(to left, transparent, ${color})`,
          }}
        />
      </div>

      {/* Main message */}
      <AnimatePresence mode="wait">
        <motion.div
          key={message}
          initial={{ opacity: 0, y: 16, filter: "blur(8px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: -16, filter: "blur(8px)" }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="text-center"
        >
          <p
            className="font-rajdhani tracking-widest"
            style={{
              color,
              fontSize: 18,
              letterSpacing: "0.15em",
              textShadow: `0 0 20px ${color}`,
              textTransform: "uppercase",
            }}
          >
            {message}
          </p>

          {subMessage && (
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.5 }}
              transition={{ delay: 0.3, duration: 0.4 }}
              className="font-rajdhani mt-1"
              style={{
                color: "rgba(150, 200, 255, 0.5)",
                fontSize: 12,
                letterSpacing: "0.1em",
              }}
            >
              {subMessage}
            </motion.p>
          )}
        </motion.div>
      </AnimatePresence>

      {/* Progress indicator */}
      {(state === "thinking" || state === "acting") && (
        <div className="flex gap-1.5 items-center mt-1">
          {[0, 1, 2, 3, 4].map((i) => (
            <motion.div
              key={i}
              className="rounded-full"
              style={{
                width: 4,
                height: 4,
                background: color,
              }}
              animate={{
                opacity: [0.2, 1, 0.2],
                scale: [0.8, 1.2, 0.8],
              }}
              transition={{
                duration: 1.2,
                repeat: Infinity,
                delay: i * 0.2,
                ease: "easeInOut",
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
