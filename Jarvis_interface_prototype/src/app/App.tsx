import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { JarvisOrb, AgentState } from "./components/JarvisOrb";
import { StatusBadge } from "./components/StatusBadge";
import { StateDisplay } from "./components/StateDisplay";
import { VoiceBar } from "./components/VoiceBar";
import { ResultPanel } from "./components/ResultPanel";
import { BackgroundField } from "./components/BackgroundField";
import { SideMetrics } from "./components/SideMetrics";

interface Step {
  state: AgentState;
  message: string;
  subMessage?: string;
  duration: number;
}

const DEMO_SEQUENCE: Step[] = [
  { state: "idle", message: "System Ready", subMessage: "Awaiting command", duration: 2500 },
  { state: "listening", message: "Listening...", subMessage: "Speak your command", duration: 3000 },
  { state: "thinking", message: "Understanding your request", subMessage: "Parsing intent", duration: 1800 },
  { state: "thinking", message: "Analyzing context", subMessage: "Cross-referencing knowledge", duration: 1500 },
  { state: "acting", message: "Searching the web", subMessage: "Querying 12 sources", duration: 2000 },
  { state: "acting", message: "Opening Chrome", subMessage: "Launching browser process", duration: 1500 },
  { state: "acting", message: "Clicking first result", subMessage: "Simulating user input", duration: 1200 },
  { state: "acting", message: "Reading page content", subMessage: "Extracting relevant data", duration: 2000 },
  { state: "acting", message: "Scrolling to findings", subMessage: "Locating key information", duration: 1200 },
  { state: "thinking", message: "Synthesizing information", subMessage: "Formulating response", duration: 2000 },
  { state: "done", message: "Task Complete", subMessage: "Result ready", duration: 6000 },
];

const DEMO_RESULT = {
  summary:
    "The latest advances in quantum computing have achieved a 1,000-qubit milestone by IBM, enabling error correction at unprecedented scale. Commercial availability is projected for 2026.",
  details:
    "IBM's Eagle processor has reached 1,000 operational qubits with sub-0.1% error rates through surface code correction. This breakthrough enables factoring 2048-bit RSA keys theoretically, though practical implementations require ~4,000 physical qubits per logical qubit. Google's competing Willow chip demonstrated similar quantum supremacy in random circuit sampling, completing tasks in 5 minutes that would take classical supercomputers 10 septillion years. The convergence of these milestones marks the beginning of the NISQ (Noisy Intermediate-Scale Quantum) era transitioning to fault-tolerant quantum computing.",
  source: "nature.com · techcrunch.com",
  confidence: 97,
};

function CommandInput({
  onSubmit,
  disabled,
}: {
  onSubmit: (cmd: string) => void;
  disabled: boolean;
}) {
  const [value, setValue] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (value.trim() && !disabled) {
      onSubmit(value.trim());
      setValue("");
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-3 w-full max-w-lg">
      <div className="relative flex-1">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={disabled}
          placeholder={disabled ? "Processing..." : "Enter command or press mic..."}
          className="w-full font-rajdhani"
          style={{
            background: "rgba(0, 20, 50, 0.6)",
            border: "1px solid rgba(0, 120, 220, 0.3)",
            borderRadius: 2,
            padding: "8px 16px",
            color: "rgba(160, 210, 255, 0.9)",
            fontSize: 14,
            letterSpacing: "0.05em",
            outline: "none",
            backdropFilter: "blur(10px)",
          }}
        />
        <div
          className="absolute bottom-0 left-0 right-0"
          style={{
            height: 1,
            background: disabled
              ? "transparent"
              : "linear-gradient(to right, transparent, rgba(0, 180, 255, 0.5), transparent)",
          }}
        />
      </div>
      <motion.button
        type="submit"
        disabled={disabled || !value.trim()}
        whileHover={!disabled && value.trim() ? { scale: 1.02 } : {}}
        whileTap={!disabled && value.trim() ? { scale: 0.98 } : {}}
        className="font-orbitron cursor-pointer"
        style={{
          padding: "8px 20px",
          background: disabled || !value.trim() ? "rgba(0, 40, 80, 0.3)" : "rgba(0, 80, 180, 0.4)",
          border: `1px solid ${disabled || !value.trim() ? "rgba(0, 80, 150, 0.2)" : "rgba(0, 150, 255, 0.4)"}`,
          borderRadius: 2,
          color: disabled || !value.trim() ? "rgba(0, 120, 200, 0.3)" : "rgba(0, 200, 255, 0.9)",
          fontSize: 10,
          letterSpacing: "0.15em",
          cursor: disabled || !value.trim() ? "not-allowed" : "pointer",
          transition: "all 0.3s ease",
          boxShadow: !disabled && value.trim() ? "0 0 15px rgba(0, 120, 255, 0.2)" : "none",
        }}
      >
        EXECUTE
      </motion.button>
    </form>
  );
}

export default function App() {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [isRunning, setIsRunning] = useState(true);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentStep = DEMO_SEQUENCE[Math.min(currentStepIndex, DEMO_SEQUENCE.length - 1)];
  const agentState = currentStep.state;
  const isDone = agentState === "done";

  const runStep = useCallback(
    (index: number) => {
      if (index >= DEMO_SEQUENCE.length) {
        // Loop back after done
        timeoutRef.current = setTimeout(() => {
          setCurrentStepIndex(0);
          runStep(0);
        }, 2000);
        return;
      }
      const step = DEMO_SEQUENCE[index];
      timeoutRef.current = setTimeout(() => {
        setCurrentStepIndex(index + 1);
        runStep(index + 1);
      }, step.duration);
    },
    []
  );

  useEffect(() => {
    if (isRunning) {
      runStep(currentStepIndex);
    }
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [isRunning]);

  const handleAbort = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setCurrentStepIndex(0);
    setIsRunning(false);
    setTimeout(() => setIsRunning(true), 100);
  };

  const handleToggleListen = () => {
    if (agentState === "listening") {
      handleAbort();
    } else {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      setCurrentStepIndex(1);
      setIsRunning(false);
      setTimeout(() => setIsRunning(true), 100);
    }
  };

  const handleCommand = (_cmd: string) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setCurrentStepIndex(2);
    setIsRunning(false);
    setTimeout(() => setIsRunning(true), 100);
  };

  return (
    <div
      className="relative flex flex-col"
      style={{
        width: "100vw",
        height: "100vh",
        background: "#020b18",
        overflow: "hidden",
      }}
    >
      {/* Background */}
      <BackgroundField />

      {/* Header */}
      <div
        className="relative z-10 flex items-center justify-between px-8 py-5"
        style={{
          borderBottom: "1px solid rgba(0, 80, 160, 0.15)",
          background: "rgba(2, 10, 30, 0.5)",
          backdropFilter: "blur(10px)",
        }}
      >
        {/* Left: JARVIS Branding */}
        <div className="flex items-center gap-4">
          {/* Logo mark */}
          <div className="relative" style={{ width: 36, height: 36 }}>
            <div
              className="absolute inset-0 rounded-full animate-corner-glow"
              style={{
                border: "1px solid rgba(0, 180, 255, 0.5)",
                boxShadow: "0 0 15px rgba(0, 150, 255, 0.3)",
              }}
            />
            <div
              className="absolute inset-0 flex items-center justify-center"
              style={{ color: "rgba(0, 200, 255, 0.9)" }}
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <polygon
                  points="9,1 17,5 17,13 9,17 1,13 1,5"
                  stroke="rgba(0, 200, 255, 0.8)"
                  strokeWidth="1"
                  fill="none"
                />
                <circle cx="9" cy="9" r="3" fill="rgba(0, 200, 255, 0.6)" />
              </svg>
            </div>
          </div>

          <div>
            <h1
              className="font-orbitron"
              style={{
                fontSize: 22,
                letterSpacing: "0.3em",
                color: "rgba(0, 200, 255, 0.95)",
                textShadow: "0 0 20px rgba(0, 180, 255, 0.5), 0 0 60px rgba(0, 100, 255, 0.2)",
                lineHeight: 1,
              }}
            >
              JARVIS
            </h1>
            <p
              className="font-rajdhani"
              style={{
                fontSize: 9,
                letterSpacing: "0.25em",
                color: "rgba(0, 120, 200, 0.5)",
                marginTop: 2,
              }}
            >
              JUST A RATHER VERY INTELLIGENT SYSTEM
            </p>
          </div>
        </div>

        {/* Center: Command input */}
        <CommandInput onSubmit={handleCommand} disabled={agentState !== "idle" && agentState !== "done"} />

        {/* Right: Status badge */}
        <div className="flex items-center gap-4">
          {/* Time display */}
          <div className="flex flex-col items-end">
            <span
              className="font-orbitron animate-data-flicker"
              style={{ fontSize: 10, color: "rgba(0, 120, 200, 0.5)", letterSpacing: "0.1em" }}
            >
              {new Date().toLocaleTimeString("en-US", { hour12: false })}
            </span>
            <span
              className="font-orbitron"
              style={{ fontSize: 8, color: "rgba(0, 80, 160, 0.4)", letterSpacing: "0.08em" }}
            >
              STARK INDUSTRIES
            </span>
          </div>
          <StatusBadge state={agentState} />
        </div>
      </div>

      {/* Main content */}
      <div className="relative z-10 flex-1 flex items-center justify-center gap-8 px-8 py-4">
        {/* Left metrics */}
        <motion.div
          initial={{ opacity: 0, x: -30 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.8, delay: 0.3 }}
          className="hidden lg:flex"
        >
          <SideMetrics state={agentState} side="left" />
        </motion.div>

        {/* Center: Orb + State display */}
        <div className="flex flex-col items-center gap-8 flex-1" style={{ maxWidth: 500 }}>
          {/* Orb */}
          <motion.div
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 1.2, ease: [0.22, 1, 0.36, 1] }}
          >
            <JarvisOrb state={agentState} />
          </motion.div>

          {/* State display */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.8, delay: 0.5 }}
            className="w-full max-w-sm"
          >
            <StateDisplay
              state={agentState}
              message={currentStep.message}
              subMessage={currentStep.subMessage}
            />
          </motion.div>

          {/* Result panel */}
          <div className="w-full">
            <AnimatePresence>
              {isDone && (
                <ResultPanel state={agentState} result={DEMO_RESULT} />
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Right metrics */}
        <motion.div
          initial={{ opacity: 0, x: 30 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.8, delay: 0.3 }}
          className="hidden lg:flex"
        >
          <SideMetrics state={agentState} side="right" />
        </motion.div>
      </div>

      {/* Voice bar */}
      <div className="relative z-10">
        <VoiceBar
          state={agentState}
          onAbort={handleAbort}
          onToggleListen={handleToggleListen}
        />
      </div>

      {/* Overlay vignette */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: "radial-gradient(ellipse at center, transparent 40%, rgba(0, 0, 10, 0.5) 100%)",
        }}
      />
    </div>
  );
}