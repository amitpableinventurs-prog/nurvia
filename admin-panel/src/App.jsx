import { Activity, CalendarHeart, CreditCard, GalleryHorizontal, LayoutDashboard, MapPinned, Megaphone, ScrollText, Shapes, ShieldCheck, Siren, Store, TicketPercent, Users } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { NurviaMark } from './icons.jsx';
import { useSession } from './session.jsx';
import Topbar from './Topbar.jsx';
import { ErrorNote, useApi } from './ui.jsx';

// Screens are downloaded on first visit, so opening the panel loads only the shell.
const Announcements = lazy(() => import('./pages/Announcements.jsx'));
const AuditLog = lazy(() => import('./pages/AuditLog.jsx'));
const Banners = lazy(() => import('./pages/Banners.jsx'));
const BookingDetail = lazy(() => import('./pages/BookingDetail.jsx'));
const Bookings = lazy(() => import('./pages/Bookings.jsx'));
const Categories = lazy(() => import('./pages/Categories.jsx'));
const Coupons = lazy(() => import('./pages/Coupons.jsx'));
const Customers = lazy(() => import('./pages/Customers.jsx'));
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Moderation = lazy(() => import('./pages/Moderation.jsx'));
const Overview = lazy(() => import('./pages/Overview.jsx'));
const Plans = lazy(() => import('./pages/Plans.jsx'));
const Platform = lazy(() => import('./pages/Platform.jsx'));
const Reports = lazy(() => import('./pages/Reports.jsx'));
const VendorDetail = lazy(() => import('./pages/VendorDetail.jsx'));
const Vendors = lazy(() => import('./pages/Vendors.jsx'));

// Each screen is shown only to staff holding its permission; the API enforces the same rule.
// `count` reads a live queue size from /admin/badges; `tone` colours that count (`crit` also colours the label).
const NAV = [
  { section: 'Administration scope' },
  { to: '/', label: 'Overview', icon: LayoutDashboard, permission: 'analytics.read', element: <Overview /> },
  { to: '/analytics', label: 'Analytics', icon: Activity, permission: 'analytics.read', element: <Dashboard /> },
  { section: 'Operations' },
  { to: '/vendors', label: 'Vendor verification', icon: Store, permission: 'vendors.read', element: <Vendors />, count: (d) => d.vendors.awaitingApproval, tone: 'warn' },
  { to: '/customers', label: 'Customers', icon: Users, permission: 'users.read', element: <Customers /> },
  { to: '/bookings', label: 'Bookings & payments', icon: CalendarHeart, permission: 'bookings.read', element: <Bookings /> },
  { to: '/plans', label: 'Plans & subscriptions', icon: CreditCard, permission: 'plans.manage', element: <Plans /> },
  { section: 'Trust & safety' },
  { to: '/moderation', label: 'Moderation', icon: ShieldCheck, permission: 'content.moderate', element: <Moderation />, count: (d) => d.adoption.awaitingReview, tone: 'warn' },
  { to: '/reports', label: 'Safety reports', icon: Siren, permission: 'reports.manage', element: <Reports />, count: (d) => d.reports.open, tone: 'crit' },
  { section: 'Marketing' },
  { to: '/banners', label: 'Banners', icon: GalleryHorizontal, permission: 'marketing.manage', element: <Banners /> },
  { to: '/coupons', label: 'Discounts & coupons', icon: TicketPercent, permission: 'marketing.manage', element: <Coupons /> },
  { section: 'Platform' },
  { to: '/platform', label: 'Cities & features', icon: MapPinned, permission: 'analytics.read', element: <Platform /> },
  { to: '/categories', label: 'Categories', icon: Shapes, permission: 'vendors.read', element: <Categories /> },
  { to: '/announcements', label: 'Announcements', icon: Megaphone, permission: 'announcements.send', element: <Announcements /> },
  { to: '/audit', label: 'System audit log', icon: ScrollText, permission: 'audit.read', element: <AuditLog /> },
];

// Which API instance and database this panel is talking to.
function InstanceCard() {
  const { data } = useApi('/admin/system/status');
  if (!data) return null;
  const db = data.database;
  return (
    <div className="instance small">
      <div className="instance-head">
        <span>Instance node</span>
        <span className="mono">{data.node}</span>
      </div>
      <div>
        Database:{' '}
        <strong className={db.status === 'ok' ? '' : 'ov-crit'}>{db.status === 'ok' ? `${db.name} · ${db.replicaSet ? 'replica set' : 'standalone'}` : 'unreachable'}</strong>
      </div>
      <div>
        Environment: <strong>{data.environment}</strong>
      </div>
      <div className="instance-foot">Release {data.release}</div>
    </div>
  );
}

function Sidebar() {
  const { can } = useSession();
  const { pathname } = useLocation();
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

  return (
    <nav className="sidebar" aria-label="Main">
      {items.map((n) =>
        n.section ? (
          <div key={n.section} className="nav-section">
            {n.section}
          </div>
        ) : (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={`nav-link ${n.tone === 'crit' ? 'crit' : ''}`}>
            <n.icon size={18} strokeWidth={1.8} />
            {n.label}
            {counts && n.count?.(counts) > 0 && <span className={`count ${n.tone ?? ''}`}>{n.count(counts)}</span>}
          </NavLink>
        ),
      )}
      <div className="sidebar-foot">{can('analytics.read') && <InstanceCard />}</div>
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
      <Topbar />
      <Sidebar />
      <main className="main">
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
          <NurviaMark size={44} color="var(--brand)" />
          <div>
            <div className="brand-name">Nurvia Petcare</div>
            <div className="eyebrow">Admin portal</div>
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
