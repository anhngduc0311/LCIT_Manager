import { useState } from 'react';

export function useLocalPage<T>(items: readonly T[], pageSize: number) {
  const [requestedPage, setPage] = useState(1);
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(items.length / pageSize)));
  if (page !== requestedPage) setPage(page);

  return {
    items: items.slice((page - 1) * pageSize, page * pageSize),
    page, pageSize, total: items.length, change: setPage,
  };
}
