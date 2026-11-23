import { useEffect, useState } from 'react';
import { useAuth } from './AuthProvider.jsx';

export function useAccountResource(path) {
  const { request } = useAuth();
  const [result, setResult] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    request(path, { signal: abort.signal }).then(data => {
      if (!abort.signal.aborted) setResult({ path, attempt, data });
    }).catch(error => {
      if (!abort.signal.aborted) setResult({ path, attempt, error });
    });
    return () => abort.abort();
  }, [path, attempt, request]);

  const current = result?.path === path && result.attempt === attempt ? result : null;
  return {
    pending: !current,
    error: current?.error,
    data: current?.data,
    update: data => setResult({ path, attempt, data }),
    retry: () => setAttempt(count => count + 1),
  };
}
