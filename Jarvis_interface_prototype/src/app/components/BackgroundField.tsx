import { useMemo } from "react";

interface Particle {
  id: number;
  x: number;
  y: number;
  size: number;
  duration: number;
  delay: number;
  opacity: number;
}

function GridLines() {
  return (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none"
      style={{ opacity: 0.04 }}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <pattern id="grid" width="60" height="60" patternUnits="userSpaceOnUse">
          <path d="M 60 0 L 0 0 0 60" fill="none" stroke="#00aaff" strokeWidth="0.5" />
        </pattern>
        <radialGradient id="gridFade" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="white" stopOpacity="1" />
          <stop offset="70%" stopColor="white" stopOpacity="0.5" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </radialGradient>
        <mask id="gridMask">
          <rect width="100%" height="100%" fill="url(#gridFade)" />
        </mask>
      </defs>
      <rect width="100%" height="100%" fill="url(#grid)" mask="url(#gridMask)" />
    </svg>
  );
}

function FloatingParticles({ particles }: { particles: Particle[] }) {
  return (
    <>
      {particles.map((p) => (
        <div
          key={p.id}
          className="absolute rounded-full"
          style={{
            left: `${p.x}%`,
            top: `${p.y}%`,
            width: p.size,
            height: p.size,
            background: "rgba(0, 160, 255, 0.6)",
            boxShadow: `0 0 ${p.size * 4}px rgba(0, 150, 255, 0.4)`,
            animation: `particleFloat ${p.duration}s ease-in-out ${p.delay}s infinite`,
            opacity: p.opacity,
          }}
        />
      ))}
    </>
  );
}

function CornerDecoration({ position }: { position: "tl" | "tr" | "bl" | "br" }) {
  const isLeft = position === "tl" || position === "bl";
  const isTop = position === "tl" || position === "tr";

  return (
    <div
      className="absolute animate-corner-glow"
      style={{
        [isTop ? "top" : "bottom"]: 24,
        [isLeft ? "left" : "right"]: 24,
      }}
    >
      <div className="relative" style={{ width: 50, height: 50 }}>
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: 20,
            height: 20,
            borderTop: "1px solid rgba(0, 180, 255, 0.4)",
            borderLeft: isLeft ? "1px solid rgba(0, 180, 255, 0.4)" : "none",
            borderRight: !isLeft ? "1px solid rgba(0, 180, 255, 0.4)" : "none",
            transform: !isLeft ? "scaleX(-1)" : undefined,
          }}
        />
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            width: 20,
            height: 20,
            borderBottom: "1px solid rgba(0, 180, 255, 0.4)",
            borderLeft: isLeft ? "1px solid rgba(0, 180, 255, 0.4)" : "none",
            borderRight: !isLeft ? "1px solid rgba(0, 180, 255, 0.4)" : "none",
            transform: !isLeft ? "scaleX(-1)" : undefined,
          }}
        />
      </div>
    </div>
  );
}

export function BackgroundField() {
  const particles = useMemo<Particle[]>(() => {
    return Array.from({ length: 30 }, (_, i) => ({
      id: i,
      x: Math.random() * 100,
      y: Math.random() * 100,
      size: 1 + Math.random() * 2,
      duration: 4 + Math.random() * 6,
      delay: Math.random() * 5,
      opacity: 0.1 + Math.random() * 0.3,
    }));
  }, []);

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {/* Base gradient */}
      <div
        className="absolute inset-0"
        style={{
          background: "radial-gradient(ellipse at 50% 40%, rgba(0, 40, 120, 0.4) 0%, rgba(0, 10, 40, 0.6) 50%, rgba(2, 5, 20, 0.8) 100%)",
        }}
      />

      {/* Secondary ambient glow */}
      <div
        className="absolute"
        style={{
          top: "20%",
          left: "50%",
          transform: "translateX(-50%)",
          width: 600,
          height: 400,
          background: "radial-gradient(ellipse, rgba(0, 80, 200, 0.12) 0%, transparent 70%)",
          borderRadius: "50%",
        }}
      />

      {/* Grid */}
      <GridLines />

      {/* Floating particles */}
      <FloatingParticles particles={particles} />

      {/* Corner decorations */}
      <CornerDecoration position="tl" />
      <CornerDecoration position="tr" />
      <CornerDecoration position="bl" />
      <CornerDecoration position="br" />

      {/* Scan line effect */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 1,
          background: "linear-gradient(to right, transparent 0%, rgba(0, 180, 255, 0.3) 50%, transparent 100%)",
          animation: "scanLine 8s linear infinite",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
