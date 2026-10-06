import { useCallback, useRef, useState } from "react";
/** Presentation-only scope history; snapshots reset it explicitly. */
export function useScopeNavigation() {
  const [scope, setCurrent] = useState<string[]>([]);
  const history = useRef<{ paths: string[][]; index: number }>({
    paths: [],
    index: -1,
  });
  function navigate(next: string[]) {
    const h = history.current;
    if (JSON.stringify(h.paths[h.index]) === JSON.stringify(next)) return;
    h.paths = h.paths.slice(0, h.index + 1);
    h.paths.push(next);
    h.index = h.paths.length - 1;
    setCurrent(next);
  }
  const reset = useCallback((next: string[]) => {
    history.current = { paths: [next], index: 0 };
    setCurrent(next);
  }, []);
  function move(delta: number) {
    const h = history.current;
    const next = h.index + delta;
    const path = h.paths[next];
    if (!path) return;
    h.index = next;
    setCurrent(path);
  }
  return {
    scope,
    navigate,
    reset,
    back: () => move(-1),
    forward: () => move(1),
    canBack: history.current.index > 0,
    canForward: history.current.index < history.current.paths.length - 1,
  };
}
