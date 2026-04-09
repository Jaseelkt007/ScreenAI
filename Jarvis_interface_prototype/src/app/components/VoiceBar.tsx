import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Mic, MicOff, Square, Activity } from "lucide-react";
import { AgentState } from "./JarvisOrb";

interface VoiceBarProps {
  state: AgentState;
  onAbort: () => void;
  onToggleListen: () => void;
}

function WaveformBars({ state }: { state: AgentState }) {
  const isActive = state === "listening" || state === "acting";
  const barCount = 24;

  return (
    <div className="flex items-center gap-0.5" style={{ height: 32 }}>
      {Array.from({ length: barCount }).map((_, i) => {
        const isCenterBar = Math.abs(i - barCount / 2) < 4;
        const baseHeight = isCenterBar ? 20 : 10;
        const delay = (i / barCount) * 1.5;

        return (
          <motion.div
            key={i}
            className="rounded-full"
            style={{
              width: 2,
              background: state === "acting"
                ? "rgba(255, 140, 50, 0.8)"
                : state === "done"
                ? "rgba(0, 255, 160, 0.8)"
                : "rgba(0, 200, 255, 0.8)",
              boxShadow: isActive
                ? `0 0 4px ${state === "acting" ? "rgba(255, 140, 50, 0.6)" : "rgba(0, 200, 255, 0.5)"}`
                : "none",
            }}
            animate={
              isActive
                ? {
                    height: [
                      baseHeight * 0.3,
                      baseHeight * (0.5 + Math.random() * 0.8),
                      baseHeight * 0.4,
                      baseHeight * (0.7 + Math.random() * 0.5),
                      baseHeight * 0.3,
                    ],
                  }
                : { height: 3 }
            }
            transition={
              isActive
                ? {
                    duration: 0.8 + Math.random() * 0.6,
                    repeat: Infinity,
                    delay,
                    ease: "easeInOut",
                  }
                : { duration: 0.4 }
            }
          />
        );
      })}
    </div>
  );
}

const voiceStateText = {
  idle: "Voice Standby",
  listening: "Listening...",
  thinking: "Processing...",
  acting: "Executing...",
  done: "Ready",
};

const voiceStateColor = {
  idle: "rgba(80, 120, 200, 0.6)",
  listening: "#00d4ff",
  thinking: "#7799ff",
  acting: "#ff9944",
  done: "#00ffaa",
};

export function VoiceBar({ state, onAbort, onToggleListen }: VoiceBarProps) {
  const color = voiceStateColor[state];
  const isActive = state !== "idle";

  return (
    <div
      className="relative w-full flex items-center gap-4 px-6 py-4"
      style={{
        background: "rgba(2, 15, 40, 0.8)",
        borderTop: `1px solid rgba(0, 100, 200, 0.2)`,
        backdropFilter: "blur(20px)",
      }}
    >
      {/* Left: Mic button */}
      <motion.button
        onClick={onToggleListen}
        className="relative flex items-center justify-center rounded-full cursor-pointer"
        style={{
          width: 44,
          height: 44,
          background: state === "listening"
            ? "rgba(0, 180, 255, 0.2)"
            : "rgba(0, 50, 120, 0.4)",
          border: `1px solid ${color}`,
          boxShadow: state === "listening" ? `0 0 20px rgba(0, 200, 255, 0.4)` : "none",
        }}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
      >
        {state === "listening" ? (
          <Mic size={18} color="#00d4ff" />
        ) : (
          <MicOff size={18} color={color as string} />
        )}
        {state === "listening" && (
          <div
            className="absolute inset-0 rounded-full"
            style={{
              border: "1px solid rgba(0, 212, 255, 0.4)",
              animation: "rippleOut 1.5s ease-out infinite",
            }}
          />
        )}
      </motion.button>

      {/* Center: Waveform and label */}
      <div className="flex-1 flex flex-col gap-1">
        <AnimatePresence mode="wait">
          <motion.span
            key={state}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 10 }}
            transition={{ duration: 0.3 }}
            className="font-orbitron text-xs tracking-widest"
            style={{ color, textShadow: `0 0 10px ${color}` }}
          >
            {voiceStateText[state]}
          </motion.span>
        </AnimatePresence>
        <WaveformBars state={state} />
      </div>

      {/* Right: System metrics */}
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          <Activity size={12} color="rgba(0, 150, 255, 0.5)" />
          <span
            className="font-orbitron text-xs animate-data-flicker"
            style={{ color: "rgba(0, 150, 255, 0.5)", fontSize: 10 }}
          >
            SYS NOMINAL
          </span>
        </div>
        <div
          className="font-orbitron text-xs"
          style={{ color: "rgba(0, 100, 200, 0.4)", fontSize: 9, letterSpacing: "0.1em" }}
        >
          CORE v3.1.4 · ARC REACTOR ONLINE
        </div>
      </div>

      {/* Abort button - only shown when active */}
      <AnimatePresence>
        {isActive && (
          <motion.button
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            onClick={onAbort}
            className="flex items-center gap-2 px-3 py-2 cursor-pointer"
            style={{
              background: "rgba(180, 30, 30, 0.2)",
              border: "1px solid rgba(255, 60, 60, 0.3)",
              borderRadius: 2,
            }}
            whileHover={{
              background: "rgba(200, 40, 40, 0.35)",
              boxShadow: "0 0 15px rgba(255, 60, 60, 0.3)",
            }}
            whileTap={{ scale: 0.95 }}
          >
            <Square size={12} color="rgba(255, 100, 100, 0.9)" />
            <span
              className="font-orbitron text-xs tracking-widest"
              style={{ color: "rgba(255, 100, 100, 0.9)", fontSize: 10 }}
            >
              ABORT
            </span>
          </motion.button>
        )}
      </AnimatePresence>

      {/* Scan line */}
      <div
        className="absolute top-0 left-0 right-0 pointer-events-none"
        style={{
          height: 1,
          background: `linear-gradient(to right, transparent, ${color}, transparent)`,
          opacity: 0.4,
        }}
      />
    </div>
  );
}
