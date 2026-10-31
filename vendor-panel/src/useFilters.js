import { useSearchParams } from 'react-router-dom';

// Keeps list filters and the page number in the URL so views can be linked and survive reloads.
export function useFilters(defaults = {}) {
  const [params, setParams] = useSearchParams();
  const filters = { ...defaults, ...Object.fromEntries(params) };

  // setFilter('status', 'open') or setFilter({ type: 'posts', status: '' }) to change several at once.
  const setFilter = (keyOrChanges, value) => {
    const changes = typeof keyOrChanges === 'string' ? { [keyOrChanges]: value } : keyOrChanges;
    const next = new URLSearchParams(params);
    for (const [key, v] of Object.entries(changes)) {
      if (v === '' || v === undefined || v === null) next.delete(key);
      else next.set(key, v);
    }
    if (!('page' in changes)) next.delete('page');
    setParams(next, { replace: true });
  };

  return [filters, setFilter];
}
