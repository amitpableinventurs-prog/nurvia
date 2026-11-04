import { MapPin } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { api } from './api.js';

// crypto.randomUUID needs https, and the panel is also opened over plain http on the Wi-Fi address.
const newSession = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

// The form fields a place from /geo fills in, as strings for controlled inputs.
export const addressFields = (address) => ({
  line1: address.line1 ?? '',
  line2: address.line2 ?? '',
  city: address.city ?? '',
  state: address.state ?? '',
  pincode: address.pincode ?? '',
});

// The first address line, with suggestions as the partner types. Picking one calls onPick with the
// place from GET /geo/places/:id ({ address, location, city }) to fill the other fields and the
// map pin. Without a pick it stays a plain text field. `near` ({ lat, lng }) ranks nearby places first.
export function AddressSearch({ value, onChange, onPick, near, ...inputProps }) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState(null);
  const [active, setActive] = useState(0);
  const [down, setDown] = useState(false);
  // Google bills the searches and the pick they end in as one session.
  const session = useRef(newSession());

  useEffect(() => {
    const term = value.trim();
    if (!open || term.length < 3) return setResults(null);
    let stale = false;
    const t = setTimeout(async () => {
      try {
        const data = await api.get('/geo/search', { q: term, lat: near?.lat, lng: near?.lng, session: session.current });
        if (!stale) {
          setResults(data.items);
          setActive(0);
          setDown(false);
        }
      } catch {
        if (!stale) {
          setResults(null);
          setDown(true);
        }
      }
    }, 300);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [value, open, near?.lat, near?.lng]);

  const pick = async (item) => {
    setOpen(false);
    try {
      const place = await api.get(`/geo/places/${encodeURIComponent(item.id)}`, { session: session.current });
      session.current = newSession();
      // Keeps a shop or house number typed before picking: "56 Sneh" then "Sneh Nagar" gives "56 Sneh Nagar".
      const number = value.match(/^\s*([^\s,]*\d[^\s,]*)[\s,]/)?.[1];
      const line1 = number && !place.address.line1.includes(number) ? `${number} ${place.address.line1}` : place.address.line1;
      onPick({ ...place, address: { ...place.address, line1 } });
    } catch {
      setDown(true);
    }
  };

  const onKeyDown = (e) => {
    if (!open || !results?.length) return;
    if (e.key === 'ArrowDown') setActive((i) => (i + 1) % results.length);
    else if (e.key === 'ArrowUp') setActive((i) => (i - 1 + results.length) % results.length);
    else if (e.key === 'Enter') pick(results[active]);
    else if (e.key === 'Escape') setOpen(false);
    else return;
    e.preventDefault();
  };

  return (
    <div className="vp-place" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}>
      <input
        {...inputProps}
        value={value}
        onChange={(e) => {
          onChange(e);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open && Boolean(results)}
        aria-controls={listId}
        autoComplete="off"
      />
      {open && results && (
        <div className="vp-place-pop" id={listId} role="listbox">
          {results.length ? (
            results.map((r, i) => (
              <button
                type="button"
                key={r.id}
                role="option"
                aria-selected={i === active}
                className="vp-place-option"
                onMouseEnter={() => setActive(i)}
                // Keeps focus in the field, so the list is not closed before the click lands.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(r)}
              >
                <MapPin size={15} className="muted" />
                <span>
                  <span className="vp-place-title">{r.title}</span>
                  {r.subtitle && <span className="small muted">{r.subtitle}</span>}
                </span>
              </button>
            ))
          ) : (
            <div className="small muted vp-place-empty">No matching place. Keep typing, or fill in the fields yourself.</div>
          )}
        </div>
      )}
      {down && <span className="small muted vp-place-down">Address search is not available right now. Fill in the fields yourself.</span>}
    </div>
  );
}
