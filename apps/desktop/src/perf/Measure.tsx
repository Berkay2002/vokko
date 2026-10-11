// Render accounting for the perf harness (e2e/perf.bench.ts). <Measure id> wraps a subtree in a React <Profiler>: every commit that
// re-rendered something inside it bumps `window.__vokkoPerf.stats[id]`. Profiler callbacks only fire in development and in the
// profiling build (`vite build --mode perf` aliases react-dom/client to react-dom/profiling); a normal production build skips them.

import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";
import { MOCK } from "../api/config";

export interface RenderStat {
  commits: number;
  ms: number;
}

const stats: Record<string, RenderStat> = {};

const onRender: ProfilerOnRenderCallback = (id, _phase, actualDuration) => {
  const stat = (stats[id] ??= { commits: 0, ms: 0 });
  stat.commits += 1;
  stat.ms += actualDuration;
};

if (MOCK && typeof window !== "undefined") {
  (window as unknown as { __vokkoPerf: unknown }).__vokkoPerf = {
    stats,
    reset(): void {
      for (const key of Object.keys(stats)) delete stats[key];
    },
  };
}

export function Measure({ id, children }: { id: string; children: ReactNode }) {
  if (!MOCK) return <>{children}</>;
  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  );
}
