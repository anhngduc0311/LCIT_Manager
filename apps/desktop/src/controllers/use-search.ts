import { FormEvent, useState } from 'react';
import { Page, RequestApi } from '../models/api';
import { SearchResult } from '../models/catalog';
import { useRemote } from './use-remote';

export function useSearch(api: RequestApi) {
  const [value, setValue] = useState('');
  const [search, setSearch] = useState({ term: '', page: 1, revision: 0 });
  const result = useRemote<Page<SearchResult>>(api, search.term ? `/search?q=${encodeURIComponent(search.term)}&page=${search.page}` : '', search.revision);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (value.trim()) setSearch((previous) => ({ term: value.trim(), page: 1, revision: previous.revision + 1 }));
  }
  const changePage = (page: number) => setSearch((previous) => ({ ...previous, page }));
  return { value, setValue, term: search.term, result, submit, changePage };
}
