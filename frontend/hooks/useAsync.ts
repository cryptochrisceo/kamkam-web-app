'use client';
import { DependencyList, useCallback, useEffect, useRef, useState } from 'react';

/** Load data with loading / error state. `reload()` refetches. */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList, opts: { enabled?: boolean; pollMs?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const enabled = opts.enabled ?? true;

  const run = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const d = await fnRef.current();
      setData(d);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    run();
    if (!opts.pollMs) return;
    const t = setInterval(() => run(true), opts.pollMs);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled]);

  return { data, setData, error, loading, reload: () => run(true) };
}
