import { motion, AnimatePresence } from "motion/react";
import { AgentState } from "./JarvisOrb";

interface SideMetricsProps {
  state: AgentState;
  side: "left" | "right";
}

const leftMetrics = [
  { label: "NEURAL NET", value: "ONLINE", subval: "4.2B PARAMS" },
  { label: "CONTEXT WIN", value: "128K", subval: "ACTIVE" },
  { label: "LATENCY", value: "42MS", subval: "OPTIMAL" },
  { label: "MODEL", value: "J-7", subval: "CLASSIFIED" },
];

const rightMetrics = [
  { label: "MEMORY", value: "98.2%", subval: "COHERENT" },
  { label: "ACCURACY", value: "99.1%", subval: "VERIFIED" },
  { label: "UPTIME", value: "847H", subval: "CONTINUOUS" },
  { label: "TASKS", value: "1,247", subval: "COMPLETED" },
];

function MetricItem({
  label,
  value,
  subval,
  index,
  state,
}: {
  label: string;
  value: string;
  subval: string;
  index: number;
  state: AgentState;
}) {
  const isActive = state !== "idle";
  const activeColor =
    state === "acting"
      ? "rgba(255, 150, 60, 0.8)"
      : state === "done"
      ? "rgba(0, 220, 140, 0.8)"
      : "rgba(0, 180, 255, 0.8)";

  return (
    <motion.div
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.1, duration: 0.5 }}
      className="flex flex-col gap-0.5"
      style={{
        padding: "8px 12px",
        borderLeft: `1px solid ${isActive ? "rgba(0, 140, 255, 0.2)" : "rgba(0, 80, 150, 0.15)"}`,
        transition: "border-color 0.5s ease",
      }}
    >
      <span
        className="font-orbitron"
        style={{
          fontSize: 8,
          letterSpacing: "0.15em",
          color: "rgba(0, 120, 200, 0.5)",
        }}
      >
        {label}
      </span>
      <span
        className="font-orbitron animate-data-flicker"
        style={{
          fontSize: 14,
          color: isActive ? activeColor : "rgba(0, 160, 255, 0.5)",
          textShadow: isActive ? `0 0 10px ${activeColor}` : "none",
          transition: "color 0.5s ease",
        }}
      >
        {value}
      </span>
      <span
        className="font-rajdhani"
        style={{
          fontSize: 9,
          color: "rgba(0, 100, 180, 0.4)",
          letterSpacing: "0.08em",
        }}
      >
        {subval}
      </span>
    </motion.div>
  );
}

export function SideMetrics({ state, side }: SideMetricsProps) {
  const metrics = side === "left" ? leftMetrics : rightMetrics;

  return (
    <div className="flex flex-col gap-2" style={{ width: 140 }}>
      {/* Section header */}
      <div
        className="font-orbitron px-3 mb-1"
        style={{
          fontSize: 8,
          letterSpacing: "0.2em",
          color: "rgba(0, 100, 180, 0.4)",
          paddingBottom: 6,
          borderBottom: "1px solid rgba(0, 80, 150, 0.15)",
        }}
      >
        {side === "left" ? "SYSTEM STATUS" : "PERFORMANCE"}
      </div>

      {metrics.map((metric, i) => (
        <MetricItem
          key={metric.label}
          label={metric.label}
          value={metric.value}
          subval={metric.subval}
          index={i}
          state={state}
        />
      ))}

      {/* Mini visualization */}
      <div className="px-3 mt-2">
        <div
          className="rounded-sm overflow-hidden"
          style={{
            height: 2,
            background: "rgba(0, 60, 120, 0.3)",
          }}
        >
          <motion.div
            className="h-full"
            style={{
              background:
                state === "acting"
                  ? "linear-gradient(to right, rgba(255, 100, 0, 0.8), rgba(255, 180, 50, 0.5))"
                  : state === "done"
                  ? "linear-gradient(to right, rgba(0, 200, 100, 0.8), rgba(0, 255, 160, 0.5))"
                  : "linear-gradient(to right, rgba(0, 120, 255, 0.8), rgba(0, 200, 255, 0.5))",
            }}
            animate={{
              width: state === "idle" ? "30%" : state === "thinking" || state === "acting" ? "75%" : state === "done" ? "100%" : "50%",
            }}
            transition={{ duration: 1, ease: "easeInOut" }}
          />
        </div>
      </div>
    </div>
  );
}
