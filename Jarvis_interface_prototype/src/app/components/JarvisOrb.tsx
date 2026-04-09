import { useEffect, useRef } from "react";
import { motion } from "motion/react";

export type AgentState = "idle" | "listening" | "thinking" | "acting" | "done";

interface JarvisOrbProps {
  state: AgentState;
}

const stateConfig = {
  idle: {
    coreColor: "rgba(0, 80, 180, 0.9)",
    coreGlow: "0 0 30px rgba(0, 150, 255, 0.4), 0 0 80px rgba(0, 80, 200, 0.2)",
    innerColor: "rgba(0, 120, 220, 0.5)",
    ring1Color: "rgba(0, 180, 255, 0.3)",
    ring2Color: "rgba(0, 120, 200, 0.2)",
    ring3Color: "rgba(0, 80, 160, 0.15)",
    ring4Color: "rgba(0, 60, 140, 0.1)",
    particleColor: "#0088cc",
    radarColor: "rgba(0, 150, 255, 0.15)",
  },
  listening: {
    coreColor: "rgba(0, 140, 255, 0.95)",
    coreGlow: "0 0 50px rgba(0, 200, 255, 0.7), 0 0 120px rgba(0, 150, 255, 0.5), 0 0 180px rgba(0, 100, 255, 0.3)",
    innerColor: "rgba(0, 180, 255, 0.7)",
    ring1Color: "rgba(0, 220, 255, 0.5)",
    ring2Color: "rgba(0, 180, 255, 0.35)",
    ring3Color: "rgba(0, 140, 220, 0.25)",
    ring4Color: "rgba(0, 100, 180, 0.15)",
    particleColor: "#00ccff",
    radarColor: "rgba(0, 200, 255, 0.25)",
  },
  thinking: {
    coreColor: "rgba(20, 80, 255, 0.9)",
    coreGlow: "0 0 40px rgba(60, 130, 255, 0.6), 0 0 100px rgba(30, 80, 255, 0.4), 0 0 160px rgba(0, 50, 220, 0.3)",
    innerColor: "rgba(60, 120, 255, 0.65)",
    ring1Color: "rgba(80, 160, 255, 0.45)",
    ring2Color: "rgba(60, 130, 255, 0.35)",
    ring3Color: "rgba(40, 100, 220, 0.25)",
    ring4Color: "rgba(20, 70, 190, 0.15)",
    particleColor: "#4488ff",
    radarColor: "rgba(80, 150, 255, 0.2)",
  },
  acting: {
    coreColor: "rgba(255, 120, 20, 0.9)",
    coreGlow: "0 0 50px rgba(255, 150, 30, 0.7), 0 0 120px rgba(255, 100, 0, 0.4), 0 0 200px rgba(200, 60, 0, 0.25)",
    innerColor: "rgba(255, 150, 50, 0.65)",
    ring1Color: "rgba(255, 180, 80, 0.4)",
    ring2Color: "rgba(255, 140, 40, 0.3)",
    ring3Color: "rgba(220, 100, 20, 0.2)",
    ring4Color: "rgba(180, 70, 0, 0.12)",
    particleColor: "#ff8833",
    radarColor: "rgba(255, 140, 50, 0.2)",
  },
  done: {
    coreColor: "rgba(0, 200, 130, 0.9)",
    coreGlow: "0 0 50px rgba(0, 240, 160, 0.7), 0 0 120px rgba(0, 200, 120, 0.4), 0 0 200px rgba(0, 160, 80, 0.25)",
    innerColor: "rgba(0, 230, 150, 0.65)",
    ring1Color: "rgba(0, 255, 180, 0.4)",
    ring2Color: "rgba(0, 220, 150, 0.3)",
    ring3Color: "rgba(0, 180, 110, 0.2)",
    ring4Color: "rgba(0, 140, 80, 0.12)",
    particleColor: "#00ffaa",
    radarColor: "rgba(0, 220, 150, 0.18)",
  },
};

const orbAnimClass = {
  idle: "animate-orb-idle animate-glow-idle",
  listening: "animate-orb-listen animate-glow-listen",
  thinking: "",
  acting: "animate-orb-vibrate animate-glow-act",
  done: "animate-glow-done",
};

const ring1SpeedClass = {
  idle: "animate-ring-cw-slow",
  listening: "animate-ring-cw-medium",
  thinking: "animate-ring-cw-fast",
  acting: "animate-ring-cw-fast",
  done: "animate-ring-cw-slow",
};

const ring2SpeedClass = {
  idle: "animate-ring-ccw-slow",
  listening: "animate-ring-ccw-medium",
  thinking: "animate-ring-ccw-fast",
  acting: "animate-ring-ccw-fast",
  done: "animate-ring-ccw-slow",
};

const ring3SpeedClass = {
  idle: "animate-ring-cw-slow",
  listening: "animate-ring-cw-medium",
  thinking: "animate-ring-cw-medium",
  acting: "animate-ring-cw-fast",
  done: "animate-ring-cw-slow",
};

const radarSpeedClass = {
  idle: "animate-radar",
  listening: "animate-radar",
  thinking: "animate-radar-fast",
  acting: "animate-radar-fast",
  done: "animate-radar",
};

function OrbParticles({ state }: { state: AgentState }) {
  const config = stateConfig[state];
  const count = state === "idle" ? 6 : state === "thinking" || state === "acting" ? 12 : 8;
  
  return (
    <div className="absolute inset-0 pointer-events-none">
      {Array.from({ length: count }).map((_, i) => {
        const angle = (360 / count) * i;
        const radius = state === "thinking" || state === "acting" ? 
          100 + Math.random() * 60 : 
          80 + Math.random() * 40;
        const size = 2 + Math.random() * 3;
        const x = Math.cos((angle * Math.PI) / 180) * radius;
        const y = Math.sin((angle * Math.PI) / 180) * radius;
        const delay = (i / count) * 2;
        const duration = 2 + Math.random() * 3;
        
        return (
          <div
            key={i}
            className="absolute rounded-full"
            style={{
              width: size,
              height: size,
              background: config.particleColor,
              left: "50%",
              top: "50%",
              transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`,
              boxShadow: `0 0 ${size * 3}px ${config.particleColor}`,
              animation: `particleFloat ${duration}s ease-in-out ${delay}s infinite`,
            }}
          />
        );
      })}
    </div>
  );
}

export function JarvisOrb({ state }: JarvisOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const config = stateConfig[state];
  const animFrameRef = useRef<number>(0);
  
  // Draw waveform on canvas for listening/acting states
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    
    let t = 0;
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      if (state === "listening" || state === "acting") {
        const intensity = state === "acting" ? 2.5 : 1.5;
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        const baseRadius = 58;
        const color = state === "acting" ? "rgba(255, 150, 50, 0.7)" : "rgba(0, 220, 255, 0.7)";
        
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        
        for (let angle = 0; angle <= Math.PI * 2; angle += 0.05) {
          const wave = Math.sin(angle * 8 + t) * intensity * Math.random() * 5 +
                       Math.sin(angle * 12 - t * 1.3) * intensity * 3;
          const r = baseRadius + wave;
          const x = cx + Math.cos(angle) * r;
          const y = cy + Math.sin(angle) * r;
          if (angle === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.stroke();
      }
      
      t += 0.12;
      animFrameRef.current = requestAnimationFrame(draw);
    };
    
    draw();
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [state]);

  return (
    <div className="relative flex items-center justify-center" style={{ width: 340, height: 340 }}>
      {/* Outer ambient rings */}
      <motion.div
        className="absolute rounded-full"
        style={{
          width: 340,
          height: 340,
          border: `1px solid ${config.ring4Color}`,
          borderRadius: "50%",
        }}
        animate={{ opacity: [0.3, 0.7, 0.3] }}
        transition={{ duration: 4, repeat: Infinity }}
      />
      
      {/* Ring 4 - Outermost rotating */}
      <div
        className={`absolute rounded-full ${ring3SpeedClass[state]}`}
        style={{
          width: 300,
          height: 300,
          border: `1px dashed ${config.ring4Color}`,
          borderRadius: "50%",
        }}
      />
      
      {/* Ring 3 */}
      <div
        className={`absolute rounded-full ${ring2SpeedClass[state]}`}
        style={{
          width: 260,
          height: 260,
          border: `1px solid ${config.ring3Color}`,
          borderRadius: "50%",
        }}
      >
        {/* Tick marks on ring 3 */}
        {[0, 90, 180, 270].map((a) => (
          <div
            key={a}
            className="absolute"
            style={{
              width: 8,
              height: 2,
              background: config.ring3Color,
              top: "50%",
              left: a === 180 ? -4 : a === 0 ? "calc(100% - 4px)" : "50%",
              transform: a === 90 || a === 270
                ? `translateX(-50%) ${a === 90 ? "translateY(-65px)" : "translateY(63px)"}`
                : "translateY(-50%)",
            }}
          />
        ))}
      </div>
      
      {/* Ring 2 - Medium */}
      <div
        className={`absolute rounded-full ${ring1SpeedClass[state]}`}
        style={{
          width: 220,
          height: 220,
          border: `1.5px solid ${config.ring2Color}`,
          borderRadius: "50%",
          boxShadow: `inset 0 0 20px ${config.ring2Color}`,
        }}
      >
        {/* Small dots on ring 2 */}
        {Array.from({ length: 12 }).map((_, i) => {
          const a = (360 / 12) * i;
          return (
            <div
              key={i}
              className="absolute rounded-full"
              style={{
                width: 3,
                height: 3,
                background: config.ring2Color,
                top: "50%",
                left: "50%",
                transformOrigin: "0 0",
                transform: `rotate(${a}deg) translate(107px, -1.5px)`,
              }}
            />
          );
        })}
      </div>
      
      {/* Radar sweep layer */}
      <div
        className={`absolute rounded-full overflow-hidden ${radarSpeedClass[state]}`}
        style={{
          width: 180,
          height: 180,
          borderRadius: "50%",
        }}
      >
        <div
          style={{
            width: "100%",
            height: "100%",
            background: `conic-gradient(from 0deg, transparent 300deg, ${config.radarColor} 360deg)`,
            borderRadius: "50%",
          }}
        />
      </div>
      
      {/* Ring 1 - Inner */}
      <div
        className={`absolute rounded-full ${ring2SpeedClass[state]}`}
        style={{
          width: 170,
          height: 170,
          border: `2px solid ${config.ring1Color}`,
          borderRadius: "50%",
          boxShadow: `0 0 15px ${config.ring1Color}, inset 0 0 15px ${config.ring1Color}`,
        }}
      />
      
      {/* Ripple effects for listening */}
      {state === "listening" && (
        <>
          <div
            className="absolute rounded-full animate-ripple"
            style={{
              width: 140,
              height: 140,
              border: "1px solid rgba(0, 220, 255, 0.5)",
              animationDelay: "0s",
            }}
          />
          <div
            className="absolute rounded-full animate-ripple"
            style={{
              width: 140,
              height: 140,
              border: "1px solid rgba(0, 200, 255, 0.3)",
              animationDelay: "0.7s",
            }}
          />
          <div
            className="absolute rounded-full animate-ripple"
            style={{
              width: 140,
              height: 140,
              border: "1px solid rgba(0, 180, 255, 0.2)",
              animationDelay: "1.4s",
            }}
          />
        </>
      )}
      
      {/* Waveform canvas overlay */}
      <canvas
        ref={canvasRef}
        width={180}
        height={180}
        className="absolute"
        style={{ borderRadius: "50%" }}
      />
      
      {/* Core orb */}
      <motion.div
        className={`relative rounded-full flex items-center justify-center ${orbAnimClass[state]}`}
        style={{
          width: 130,
          height: 130,
          background: `radial-gradient(circle at 35% 35%, ${config.innerColor}, ${config.coreColor})`,
          boxShadow: config.coreGlow,
          borderRadius: "50%",
        }}
        animate={{ scale: state === "thinking" ? [1, 1.05, 0.97, 1.03, 1] : undefined }}
        transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
      >
        {/* Core inner glow */}
        <div
          className="absolute rounded-full"
          style={{
            width: 80,
            height: 80,
            background: `radial-gradient(circle, rgba(255,255,255,0.35) 0%, transparent 70%)`,
          }}
        />
        
        {/* Center dot */}
        <div
          className="absolute rounded-full"
          style={{
            width: 18,
            height: 18,
            background: "rgba(255,255,255,0.9)",
            boxShadow: `0 0 20px ${config.particleColor}, 0 0 40px ${config.particleColor}`,
          }}
        />
        
        {/* Hex pattern overlay */}
        <div
          className="absolute inset-0 rounded-full overflow-hidden opacity-20"
          style={{
            backgroundImage: `repeating-linear-gradient(0deg, transparent, transparent 8px, rgba(255,255,255,0.3) 8px, rgba(255,255,255,0.3) 9px), repeating-linear-gradient(60deg, transparent, transparent 8px, rgba(255,255,255,0.3) 8px, rgba(255,255,255,0.3) 9px), repeating-linear-gradient(120deg, transparent, transparent 8px, rgba(255,255,255,0.3) 8px, rgba(255,255,255,0.3) 9px)`,
          }}
        />
      </motion.div>
      
      {/* Floating particles */}
      <OrbParticles state={state} />
    </div>
  );
}