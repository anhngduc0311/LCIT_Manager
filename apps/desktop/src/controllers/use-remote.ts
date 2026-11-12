import { useEffect, useState } from 'react';
import { RequestApi } from '../models/api';

export const errorText = (error: unknown) => error instanceof Error ? error.message : 'Thao tác không thành công.';

export function useRemote<T>(api: RequestApi, path: string, revision = 0) {
  const [result, setResult] = useState<{ path: string; revision: number; data?: T; error?: string }>();
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    void api<T>(path, { signal: controller.signal }).then((data) => {
      if (!controller.signal.aborted) setResult({ path, revision, data });
    }).catch((error) => {
      if (!controller.signal.aborted) setResult({ path, revision, error: errorText(error) });
    });
    return () => controller.abort();
  }, [api, path, revision]);
  return result?.path === path && result.revision === revision ? result : undefined;
}
