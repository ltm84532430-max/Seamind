import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText } from './player-api';

interface LoadState<T> {
  data: T | null;
  error: string;
  loading: boolean;
}

/**
 * Runs `load` when the component appears and again on `reload()`. The data of the previous run
 * stays in place while a reload is under way, so a list does not blink. A view that shows another
 * list is given another React key, which starts it from an empty state.
 */
export function useLoad<T>(load: () => Promise<T>) {
  const [state, setState] = useState<LoadState<T>>({
    data: null,
    error: '',
    loading: true,
  });
  const [version, setVersion] = useState(0);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    let current = true;
    setState((previous) => ({ data: previous.data, error: '', loading: true }));
    loadRef.current().then(
      (data) => {
        if (current) setState({ data, error: '', loading: false });
      },
      (error: unknown) => {
        if (current)
          setState((previous) => ({
            data: previous.data,
            error: errorText(error, '读取失败'),
            loading: false,
          }));
      },
    );
    return () => {
      current = false;
    };
  }, [version]);

  const reload = useCallback(() => setVersion((value) => value + 1), []);
  const setData = useCallback(
    (update: (data: T | null) => T | null) =>
      setState((previous) => ({ ...previous, data: update(previous.data) })),
    [],
  );
  return { ...state, reload, setData };
}
