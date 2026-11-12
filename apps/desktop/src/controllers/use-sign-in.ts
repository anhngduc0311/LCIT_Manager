import { FormEvent, useEffect, useState } from 'react';
import { checkHealth, requestApi, Session } from '../models/api';

export function useSignIn(onLogin: (session: Session) => void) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true); setError('');
    try { onLogin(await requestApi<Session>('/auth/login', { method: 'POST', body: { username: data.get('username'), password: data.get('password') } })); }
    catch (error) { setError(error instanceof Error ? error.message : 'Không thể đăng nhập.'); }
    finally { setBusy(false); }
  }
  return { error, busy, submit };
}

export function useHealth() {
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<'checking' | 'ready' | 'unavailable' | 'offline'>('checking');
  useEffect(() => {
    const controller = new AbortController();
    void checkHealth(controller.signal).then((result) => {
      if (!controller.signal.aborted) setStatus(result);
    }).catch(() => { if (!controller.signal.aborted) setStatus('offline'); });
    return () => controller.abort();
  }, [attempt]);
  function retry() {
    setStatus('checking');
    setAttempt((value) => value + 1);
  }
  return { status, retry };
}
