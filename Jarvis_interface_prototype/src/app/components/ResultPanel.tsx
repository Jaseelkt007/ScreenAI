import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ChevronUp, ChevronDown, CheckCircle, ExternalLink } from "lucide-react";
import { AgentState } from "./JarvisOrb";

interface ResultPanelProps {
  state: AgentState;
  result: {
    summary: string;
    details: string;
    source?: string;
    confidence?: number;
  } | null;
}

export function ResultPanel({ state, result }: ResultPanelProps) {
  const [expanded, setExpanded] = useState(false);

  if (state !== "done" || !result) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 30, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 20, scale: 0.96 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-2xl mx-auto"
        style={{
          background: "rgba(0, 25, 50, 0.75)",
          border: "1px solid rgba(0, 255, 170, 0.2)",
          borderRadius: 4,
          backdropFilter: "blur(20px)",
          boxShadow: "0 0 40px rgba(0, 200, 120, 0.1), 0 20px 60px rgba(0,0,0,0.4)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3 cursor-pointer"
          onClick={() => setExpanded(!expanded)}
          style={{ borderBottom: expanded ? "1px solid rgba(0, 200, 120, 0.15)" : "none" }}
        >
          <div className="flex items-center gap-3">
            <CheckCircle size={16} color="#00ffaa" />
            <span
              className="font-orbitron text-xs tracking-widest"
              style={{ color: "#00ffaa", textShadow: "0 0 10px rgba(0, 255, 170, 0.5)" }}
            >
              TASK COMPLETE
            </span>
            {result.confidence !== undefined && (
              <div
                className="flex items-center gap-1.5 px-2 py-0.5"
                style={{
                  background: "rgba(0, 200, 120, 0.1)",
                  border: "1px solid rgba(0, 200, 120, 0.2)",
                  borderRadius: 2,
                }}
              >
                <div
                  className="rounded-full"
                  style={{ width: 5, height: 5, background: "#00ffaa" }}
                />
                <span
                  className="font-orbitron"
                  style={{ color: "rgba(0, 220, 140, 0.7)", fontSize: 9, letterSpacing: "0.1em" }}
                >
                  {result.confidence}% CONFIDENCE
                </span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            {result.source && (
              <span
                className="font-rajdhani text-xs flex items-center gap-1"
                style={{ color: "rgba(0, 180, 120, 0.5)" }}
              >
                <ExternalLink size={10} />
                {result.source}
              </span>
            )}
            <button
              className="flex items-center gap-1 cursor-pointer"
              style={{ color: "rgba(0, 200, 140, 0.6)", background: "none", border: "none" }}
            >
              <span className="font-orbitron" style={{ fontSize: 9, letterSpacing: "0.1em" }}>
                {expanded ? "COLLAPSE" : "EXPAND"}
              </span>
              {expanded ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
            </button>
          </div>
        </div>

        {/* Summary */}
        <div className="px-5 py-4">
          <p
            className="font-rajdhani"
            style={{
              color: "rgba(180, 230, 255, 0.9)",
              fontSize: 15,
              lineHeight: 1.6,
              letterSpacing: "0.03em",
            }}
          >
            {result.summary}
          </p>
        </div>

        {/* Expanded details */}
        <AnimatePresence>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
              style={{ overflow: "hidden" }}
            >
              <div
                className="px-5 pb-5"
                style={{ borderTop: "1px solid rgba(0, 200, 120, 0.1)" }}
              >
                <div className="pt-4">
                  <div
                    className="font-orbitron text-xs mb-3"
                    style={{ color: "rgba(0, 180, 120, 0.5)", letterSpacing: "0.15em" }}
                  >
                    FULL ANALYSIS
                  </div>
                  <p
                    className="font-rajdhani"
                    style={{
                      color: "rgba(140, 190, 220, 0.7)",
                      fontSize: 14,
                      lineHeight: 1.7,
                    }}
                  >
                    {result.details}
                  </p>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Bottom glow line */}
        <div
          style={{
            height: 2,
            background: "linear-gradient(to right, transparent, rgba(0, 255, 170, 0.4), transparent)",
          }}
        />
      </motion.div>
    </AnimatePresence>
  );
}
