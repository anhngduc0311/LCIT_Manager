'use client';

import { useEffect, useState } from 'react';

const apiUrl = (process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
const labels = {
  checking: 'Đang kiểm tra',
  ready: 'API và cơ sở dữ liệu đang hoạt động',
  unavailable: 'API đang chạy, cơ sở dữ liệu chưa sẵn sàng',
  offline: 'Không kết nối được API. Kiểm tra địa chỉ và tiến trình API.',
};

export default function Home() {
  const [status, setStatus] = useState<keyof typeof labels>('checking');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    async function check() {
      try {
        const response = await fetch(`${apiUrl}/health/ready`, {
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]),
        });
        const health = await response.json();
        if (controller.signal.aborted) return;
        if (response.ok && health.status === 'ok' && health.database === 'up') {
          setStatus('ready');
        } else if (response.status === 503 && health.database === 'down') {
          setStatus('unavailable');
        } else {
          setStatus('offline');
        }
      } catch {
        if (!controller.signal.aborted) setStatus('offline');
      }
    }

    void check();
    return () => controller.abort();
  }, [attempt]);

  return (
    <main>
      <header>LCIT Manager</header>
      <section aria-labelledby="connection">
        <h1 id="connection">Kết nối hệ thống</h1>
        <dl>
          <div><dt>Địa chỉ API</dt><dd><code>{apiUrl}</code></dd></div>
          <div><dt>Trạng thái</dt><dd className={status} role="status">{labels[status]}</dd></div>
        </dl>
        <button
          disabled={status === 'checking'}
          onClick={() => {
            setStatus('checking');
            setAttempt((value) => value + 1);
          }}
        >
          Kiểm tra lại
        </button>
      </section>
    </main>
  );
}
