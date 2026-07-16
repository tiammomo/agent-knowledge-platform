import { useCallback, useEffect, useState } from "react";

export interface AsyncResource<T> {
  readonly data?: T;
  readonly error?: Error;
  readonly loading: boolean;
  readonly refresh: () => Promise<void>;
}

export function useAsyncResource<T>(
  loader: () => Promise<T>,
  dependencies: readonly unknown[] = [],
): AsyncResource<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setData(await loader());
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("未知错误"));
    } finally {
      setLoading(false);
    }
  }, dependencies);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { data, error, loading, refresh };
}
