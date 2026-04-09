import { motion, AnimatePresence } from "motion/react";
import { AgentState } from "./JarvisOrb";

const statusConfig = {
  idle: {
    label: "STANDBY",
    dotColor: "#4488ff",
    textColor: "#4488ff",
    borderColor: "rgba(68, 136, 255, 0.3)",
    bgColor: "rgba(10, 30, 80, 0.6)",
    pulse: false,
  },
  listening: {
    label: "LISTENING",
    dotColor: "#00d4ff",
    textColor: "#00d4ff",
    borderColor: "rgba(0, 212, 255, 0.4)",
    bgColor: "rgba(0, 30, 60, 0.6)",
    pulse: true,
  },
  thinking: {
    label: "THINKING",
    dotColor: "#6688ff",
    textColor: "#6688ff",
    borderColor: "rgba(100, 136, 255, 0.4)",
    bgColor: "rgba(10, 20, 70, 0.6)",
    pulse: true,
  },
  acting: {
    label: "ACTING",
    dotColor: "#ff8833",
    textColor: "#ff8833",
    borderColor: "rgba(255, 136, 50, 0.4)",
    bgColor: "rgba(60, 20, 0, 0.6)",
    pulse: true,
  },
  done: {
    label: "COMPLETE",
    dotColor: "#00ffaa",
    textColor: "#00ffaa",
    borderColor: "rgba(0, 255, 170, 0.4)",
    bgColor: "rgba(0, 40, 30, 0.6)",
    pulse: false,
  },
};

interface StatusBadgeProps {
  state: AgentState;
}

export function StatusBadge({ state }: StatusBadgeProps) {
  const config = statusConfig[state];

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={state}
        initial={{ opacity: 0, y: -10, scale: 0.9 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.9 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
        className="flex items-center gap-2 px-4 py-2"
        style={{
          background: config.bgColor,
          border: `1px solid ${config.borderColor}`,
          borderRadius: 2,
          backdropFilter: "blur(12px)",
          boxShadow: `0 0 20px ${config.borderColor}, inset 0 0 20px rgba(0,0,0,0.3)`,
        }}
      >
        {/* Status dot */}
        <div className="relative flex items-center justify-center" style={{ width: 10, height: 10 }}>
          {config.pulse && (
            <div
              className="absolute rounded-full"
              style={{
                width: 10,
                height: 10,
                background: config.dotColor,
                opacity: 0.3,
                animation: "rippleOut 1.5s ease-out infinite",
              }}
            />
          )}
          <div
            className="rounded-full"
            style={{
              width: 7,
              height: 7,
              background: config.dotColor,
              boxShadow: `0 0 8px ${config.dotColor}`,
              animation: config.pulse ? "blink 1.2s ease-in-out infinite" : "none",
            }}
          />
        </div>

        {/* Status label */}
        <span
          className="font-orbitron tracking-widest text-xs"
          style={{
            color: config.textColor,
            letterSpacing: "0.2em",
            textShadow: `0 0 10px ${config.textColor}`,
          }}
        >
          {config.label}
        </span>

        {/* Corner accent */}
        <div
          className="ml-1"
          style={{
            width: 6,
            height: 6,
            borderTop: `1px solid ${config.textColor}`,
            borderRight: `1px solid ${config.textColor}`,
            opacity: 0.6,
          }}
        />
      </motion.div>
    </AnimatePresence>
  );
}
