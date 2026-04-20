// Animated waveform bars component
interface WaveformProps {
  level?: number;
  active?: boolean;
  accent?: string;
}

export function Waveform({ level = 0.5, active = true, accent = 'var(--accent)' }: WaveformProps) {
  const bars = 36;
  const now = Date.now();

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 3,
        height: '100%',
        width: '100%',
        justifyContent: 'center',
      }}
    >
      {Array.from({ length: bars }).map((_, i) => {
        const phase = now / 150 + i * 0.4;
        const base = active
          ? (Math.sin(phase) * 0.5 + Math.sin(phase * 2.3) * 0.3 + 0.5) * level
          : 0.1;
        const h = Math.max(4, base * 100);
        return (
          <div
            key={i}
            style={{
              width: 2.5,
              height: `${h}%`,
              background: accent,
              borderRadius: 2,
              transition: 'height 80ms ease',
              opacity: active ? 1 : 0.3,
            }}
          />
        );
      })}
    </div>
  );
}
