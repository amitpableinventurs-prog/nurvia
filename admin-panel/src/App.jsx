import { Activity, CalendarHeart, LayoutDashboard, MapPinned, LogOut, Megaphone, Moon, ScrollText, Shapes, ShieldCheck, Siren, Store, Sun, SunMoon } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { NurviaMark } from './icons.jsx';
import { useSession } from './session.jsx';
import Topbar from './Topbar.jsx';
import { ErrorNote, useApi } from './ui.jsx';

// Screens are downloaded on first visit, so opening the panel loads only the shell.
const Announcements = lazy(() => import('./pages/Announcements.jsx'));
const AuditLog = lazy(() => import('./pages/AuditLog.jsx'));
const BookingDetail = lazy(() => import('./pages/BookingDetail.jsx'));
const Bookings = lazy(() => import('./pages/Bookings.jsx'));
const Categories = lazy(() => import('./pages/Categories.jsx'));
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Moderation = lazy(() => import('./pages/Moderation.jsx'));
const Overview = lazy(() => import('./pages/Overview.jsx'));
const Platform = lazy(() => import('./pages/Platform.jsx'));
const Reports = lazy(() => import('./pages/Reports.jsx'));
const VendorDetail = lazy(() => import('./pages/VendorDetail.jsx'));
const Vendors = lazy(() => import('./pages/Vendors.jsx'));

// Each screen is shown only to staff holding its permission; the API enforces the same rule.
// `tone` tints the duotone icon on the dark rail; `count` reads a live queue size from /admin/badges.
const NAV = [
  { section: 'Overview' },
  { to: '/', label: 'Overview', icon: LayoutDashboard, tone: '#7fd8ac', permission: 'analytics.read', element: <Overview /> },
  { to: '/analytics', label: 'Analytics', icon: Activity, tone: '#8cc0f5', permission: 'analytics.read', element: <Dashboard /> },
  { section: 'Operations' },
  { to: '/vendors', label: 'Vendors', icon: Store, tone: '#ffd36b', permission: 'vendors.read', element: <Vendors />, count: (d) => d.vendors.awaitingApproval },
  { to: '/bookings', label: 'Bookings', icon: CalendarHeart, tone: '#ffab80', permission: 'bookings.read', element: <Bookings /> },
  { section: 'Trust & safety' },
  { to: '/moderation', label: 'Moderation', icon: ShieldCheck, tone: '#7fd6cf', permission: 'content.moderate', element: <Moderation />, count: (d) => d.adoption.awaitingReview },
  { to: '/reports', label: 'Reports', icon: Siren, tone: '#ff9fba', permission: 'reports.manage', element: <Reports />, count: (d) => d.reports.open },
  { section: 'Platform' },
  { to: '/platform', label: 'Cities & features', icon: MapPinned, tone: '#7fd6cf', permission: 'analytics.read', element: <Platform /> },
  { to: '/categories', label: 'Categories', icon: Shapes, tone: '#8cc0f5', permission: 'vendors.read', element: <Categories /> },
  { to: '/announcements', label: 'Announcements', icon: Megaphone, tone: '#ffab80', permission: 'announcements.send', element: <Announcements /> },
  { to: '/audit', label: 'Audit log', icon: ScrollText, tone: '#d2d8d3', permission: 'audit.read', element: <AuditLog /> },
];

const THEMES = [
  ['system', 'System', SunMoon],
  ['light', 'Light', Sun],
  ['dark', 'Dark', Moon],
];

function useTheme() {
  const [theme, setTheme] = useState(() => document.documentElement.getAttribute('data-theme') ?? 'system');
  const next = () => {
    const value = THEMES[(THEMES.findIndex(([k]) => k === theme) + 1) % THEMES.length][0];
    if (value === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', value);
    try {
      localStorage.setItem('nurvia.admin.theme', value);
    } catch {
      /* storage unavailable: lasts for this visit only */
    }
    setTheme(value);
  };
  return [theme, next];
}

function Sidebar() {
  const { session, logout, can } = useSession();
  const { pathname } = useLocation();
  const [theme, nextTheme] = useTheme();
  // Refreshed on navigation so badges drop as soon as a queue item is handled.
  const { data: counts } = useApi('/admin/badges', { _: pathname }, { enabled: can('analytics.read') });

  const items = NAV.filter((n, i) => {
    // A section heading shows only when at least one item under it is visible.
    if (n.section) {
      const next = NAV.slice(i + 1).find((x) => x.section || can(x.permission));
      return Boolean(next && !next.section);
    }
    return can(n.permission);
  });
  const role = session.user.roles.find((r) => ['super_admin', 'admin', 'staff'].includes(r))?.replace('_', ' ');
  const [, themeLabel, ThemeIcon] = THEMES.find(([k]) => k === theme);
  const name = session.user.name ?? session.user.email;

  return (
    <nav className="sidebar" aria-label="Main">
      <div className="brand">
        <NurviaMark />
        <div>
          <div className="brand-name">nurvia</div>
          <div className="brand-sub">Admin console</div>
        </div>
      </div>
      {items.map((n) =>
        n.section ? (
          <div key={n.section} className="nav-section">
            {n.section}
          </div>
        ) : (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className="nav-link" style={{ '--nav-tone': n.tone }}>
            <span className="nav-ico">
              <n.icon size={17} strokeWidth={1.9} />
            </span>
            {n.label}
            {counts && n.count?.(counts) > 0 && <span className="count">{n.count(counts)}</span>}
          </NavLink>
        ),
      )}
      <div className="sidebar-foot">
        <div className="me">
          <span className="me-avatar">{name.slice(0, 1).toUpperCase()}</span>
          <div style={{ minWidth: 0 }}>
            <div className="me-name">{name}</div>
            <div className="me-role">{role}</div>
          </div>
        </div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <button className="side-btn" onClick={nextTheme} title="Change theme">
            <ThemeIcon size={15} /> {themeLabel}
          </button>
          <button className="side-btn" onClick={logout}>
            <LogOut size={15} /> Sign out
          </button>
        </div>
      </div>
    </nav>
  );
}

export default function App() {
  const { session, can } = useSession();
  if (session === undefined) {
    return (
      <div className="login">
        <NurviaMark size={44} />
      </div>
    );
  }
  if (session === null) return <Login />;

  const pages = NAV.filter((n) => n.to && can(n.permission));
  return (
    <div className="shell">
      <Sidebar />
      <main className="main">
        <Topbar />
        <Suspense fallback={<div className="empty">Loading…</div>}>
          <Routes>
            {pages.map((n) => (
              <Route key={n.to} path={n.to} element={n.element} />
            ))}
            {can('vendors.read') && <Route path="/vendors/:id" element={<VendorDetail />} />}
            {can('bookings.read') && <Route path="/bookings/:id" element={<BookingDetail />} />}
            <Route path="*" element={<Navigate to={pages[0]?.to ?? '/'} replace />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}

function Login() {
  const { login } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(err.status === 403 ? new Error('This account does not have admin access') : err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div className="row" style={{ gap: 12, marginBottom: 6 }}>
          <NurviaMark size={44} />
          <div>
            <div className="brand-name" style={{ color: 'var(--ink)' }}>nurvia</div>
            <div className="eyebrow">Admin console</div>
          </div>
        </div>
        <h1 style={{ fontSize: 24 }}>
          Welcome <em>back</em>
        </h1>
        <label className="field">
          Email
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label className="field">
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <ErrorNote error={error} />
        <button className="primary" disabled={busy} style={{ minHeight: 42 }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
