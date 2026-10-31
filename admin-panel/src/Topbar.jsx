import { Bell, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api.js';
import { useSession } from './session.jsx';
import { ago, useApi } from './ui.jsx';

const TYPE_LABELS = { vendor: 'Vendor', booking: 'Booking', community_dog: 'Community dog', adoption_listing: 'Adoption' };

// Where each search hit opens in the panel. Users and pets have no screen, so their hits are left out.
const linkFor = (r) =>
  ({
    vendor: `/vendors/${r.id}`,
    booking: `/bookings/${r.id}`,
    community_dog: '/moderation?type=community-dogs',
    adoption_listing: '/moderation?type=adoption-listings',
  })[r.type];

function GlobalSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const input = useRef(null);

  // Ctrl/⌘ + K focuses search from anywhere in the panel.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return setResults(null);
    let stale = false;
    const t = setTimeout(async () => {
      try {
        const data = await api.get('/admin/search', { q: term });
        if (!stale) {
          setResults(data.results.filter(linkFor));
          setActive(0);
        }
      } catch {
        if (!stale) setResults([]);
      }
    }, 250);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [q]);

  const go = (r) => {
    navigate(linkFor(r));
    setOpen(false);
    setQ('');
  };
  const onKeyDown = (e) => {
    if (!results?.length) return;
    if (e.key === 'ArrowDown') setActive((i) => (i + 1) % results.length);
    else if (e.key === 'ArrowUp') setActive((i) => (i - 1 + results.length) % results.length);
    else if (e.key === 'Enter') go(results[active]);
    else if (e.key === 'Escape') setOpen(false);
    else return;
    e.preventDefault();
  };

  return (
    <div className="tb-search" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}>
      <Search size={16} className="muted" />
      <input
        ref={input}
        type="search"
        placeholder="Search vendors, bookings…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        aria-label="Global search"
        aria-expanded={open && Boolean(results)}
        role="combobox"
        aria-controls="tb-search-results"
      />
      <kbd>Ctrl K</kbd>
      {open && results && (
        <div className="tb-pop" id="tb-search-results" role="listbox">
          {results.length ? (
            results.map((r, i) => (
              <button key={`${r.type}${r.id}`} role="option" aria-selected={i === active} className="tb-result" onMouseEnter={() => setActive(i)} onClick={() => go(r)}>
                <span className="tb-type">{TYPE_LABELS[r.type]}</span>
                <span style={{ minWidth: 0 }}>
                  <span className="tb-title">{r.title}</span>
                  <span className="small muted">{r.subtitle}</span>
                </span>
              </button>
            ))
          ) : (
            <div className="empty small">Nothing matches “{q.trim()}”</div>
          )}
        </div>
      )}
    </div>
  );
}

function SystemPill() {
  const { pathname } = useLocation();
  const { data, error } = useApi('/admin/system/status', { _: pathname });
  const down = error || data?.status !== 'ok';
  if (!data && !error) return null;
  return (
    <span className={`tb-status ${down ? 'down' : ''}`} title={data ? `Checked ${new Date(data.checkedAt).toLocaleTimeString('en-IN')}` : error.message}>
      <span className="tb-dot" />
      {down ? 'Database unreachable' : 'All services normal'}
      {data?.database.latencyMs != null && <span className="muted"> · {data.database.latencyMs} ms</span>}
    </span>
  );
}

function Notifications() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const { data, reload } = useApi('/notifications', { limit: 6, _: pathname });
  const unread = data?.unreadCount ?? 0;
  const readAll = async () => {
    await api.post('/notifications/read-all');
    reload();
  };
  return (
    <div className="tb-bell" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}>
      <button className="tb-icon" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
        <Bell size={18} />
        {unread > 0 && <span className="tb-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="tb-pop right">
          <div className="row" style={{ justifyContent: 'space-between', padding: '4px 6px 8px' }}>
            <strong>Notifications</strong>
            {unread > 0 && (
              <button className="link small" onClick={readAll}>
                Mark all read
              </button>
            )}
          </div>
          {data?.items.length ? (
            data.items.map((n) => {
              const body = (
                <>
                  <div style={{ fontWeight: 600 }}>{n.title}</div>
                  {n.body && <div className="small muted">{n.body}</div>}
                  <div className="small muted">{ago(n.createdAt)}</div>
                </>
              );
              // A vendor application notification opens that application.
              return n.data?.vendorId ? (
                <Link
                  key={n._id}
                  to={`/vendors/${n.data.vendorId}`}
                  className={`tb-note ${n.readAt ? '' : 'unread'}`}
                  onClick={() => {
                    setOpen(false);
                    if (!n.readAt) api.post(`/notifications/${n._id}/read`).then(reload, () => {});
                  }}
                >
                  {body}
                </Link>
              ) : (
                <div key={n._id} className={`tb-note ${n.readAt ? '' : 'unread'}`}>
                  {body}
                </div>
              );
            })
          ) : (
            <div className="empty small">No notifications</div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Topbar() {
  const { session } = useSession();
  const name = session.user.name ?? session.user.email;
  return (
    <header className="topbar">
      <GlobalSearch />
      <div className="row" style={{ gap: 12, marginLeft: 'auto' }}>
        <SystemPill />
        <Notifications />
        <span className="tb-me" title={name} aria-hidden="true">
          {name
            .split(' ')
            .map((w) => w[0])
            .slice(0, 2)
            .join('')
            .toUpperCase()}
        </span>
      </div>
    </header>
  );
}
