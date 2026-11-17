import { Bell, Boxes, CalendarDays, CalendarHeart, CalendarOff, ChartColumn, CreditCard, FileBadge, ListTodo, Heart, LayoutDashboard, LogOut, Moon, Package, Scissors, ShoppingBag, Star, Store, Sun, SunMoon, Undo2, Wallet } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api.js';
import { NurviaMark } from './icons.jsx';
import Login from './pages/Login.jsx';
import Onboarding from './pages/Onboarding.jsx';
import { useSession } from './session.jsx';
import { ago, useApi } from './ui.jsx';

// Screens are downloaded on first visit, so opening the panel loads only the shell.
const Availability = lazy(() => import('./pages/Availability.jsx'));
const Billing = lazy(() => import('./pages/Billing.jsx'));
const Calendar = lazy(() => import('./pages/Calendar.jsx'));
const BookingDetail = lazy(() => import('./pages/BookingDetail.jsx'));
const Bookings = lazy(() => import('./pages/Bookings.jsx'));
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Documents = lazy(() => import('./pages/Documents.jsx'));
const Earnings = lazy(() => import('./pages/Earnings.jsx'));
const Orders = lazy(() => import('./pages/Orders.jsx'));
const Packages = lazy(() => import('./pages/Packages.jsx'));
const Products = lazy(() => import('./pages/Products.jsx'));
const Profile = lazy(() => import('./pages/Profile.jsx'));
const Returns = lazy(() => import('./pages/Returns.jsx'));
const Reports = lazy(() => import('./pages/Reports.jsx'));
const Reviews = lazy(() => import('./pages/Reviews.jsx'));
const Services = lazy(() => import('./pages/Services.jsx'));
const Waitlist = lazy(() => import('./pages/Waitlist.jsx'));
const Wishlist = lazy(() => import('./pages/Wishlist.jsx'));

// `count` reads a live number from /vendors/me/badges for the sidebar badge.
const NAV = [
  { section: 'Today' },
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, tone: '#7fd8ac', element: <Dashboard /> },
  { to: '/bookings', label: 'Bookings', icon: CalendarHeart, tone: '#ffab80', element: <Bookings />, count: (d) => d.pending.count },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays, tone: '#7fd6cf', element: <Calendar /> },
  { section: 'Workspace' },
  { to: '/waitlist', label: 'Waitlist', icon: ListTodo, tone: '#ffd36b', element: <Waitlist /> },
  { to: '/packages', label: 'Service packages', icon: Boxes, tone: '#b9adff', element: <Packages /> },
  { to: '/reports', label: 'Reports', icon: ChartColumn, tone: '#7fd8ac', element: <Reports /> },
  { section: 'Business' },
  { to: '/availability', label: 'Availability', icon: CalendarOff, tone: '#8cc0f5', element: <Availability />, count: (d) => (d.pause ? '!' : 0) },
  { to: '/services', label: 'Services & prices', icon: Scissors, tone: '#b9adff', element: <Services /> },
  { to: '/reviews', label: 'Reviews', icon: Star, tone: '#ffd36b', element: <Reviews />, count: (d) => d.reviews.unreplied },
  { to: '/earnings', label: 'Earnings', icon: Wallet, tone: '#7fd6cf', element: <Earnings /> },
  { section: 'Shop' },
  { to: '/products', label: 'Products', icon: Package, tone: '#ffab80', element: <Products /> },
  { to: '/orders', label: 'Orders', icon: ShoppingBag, tone: '#7fd8ac', element: <Orders /> },
  { to: '/returns', label: 'Returns', icon: Undo2, tone: '#ff9fba', element: <Returns /> },
  { to: '/wishlist', label: 'Wishlist', icon: Heart, tone: '#b9adff', element: <Wishlist /> },
  { section: 'Account' },
  { to: '/profile', label: 'Business profile', icon: Store, tone: '#8cc0f5', element: <Profile /> },
  { to: '/documents', label: 'KYC & licence', icon: FileBadge, tone: '#ff9fba', element: <Documents /> },
  { to: '/billing', label: 'Plan & billing', icon: CreditCard, tone: '#ffab80', element: <Billing />, count: (d) => (d.plan?.endsInDays != null ? `${d.plan.endsInDays}d` : 0) },
];

// Bumps once a minute while the tab is visible, so new booking requests show up without a reload.
function useTick(ms) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => document.visibilityState === 'visible' && setTick((t) => t + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return tick;
}

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
      localStorage.setItem('nurvia.vendor.theme', value);
    } catch {
      /* storage unavailable: lasts for this visit only */
    }
    setTheme(value);
  };
  return [theme, next];
}

function Sidebar() {
  const { session, signOut, refreshVendor } = useSession();
  const { pathname } = useLocation();
  const [theme, nextTheme] = useTheme();
  // Refreshed on navigation so badges drop as soon as a request is handled.
  const tick = useTick(60_000);
  const { data: counts } = useApi('/vendors/me/badges', { _: `${pathname}:${tick}` });
  // The once-a-minute summary also carries the approval state, so an approval, a request for changes
  // or a licence check shows up without signing in again.
  const fresh = counts?.vendor;
  const current = session.vendor;
  useEffect(() => {
    if (fresh && (fresh.status !== current.status || fresh.kycStatus !== current.kyc?.status || fresh.licenseStatus !== current.licenseStatus)) refreshVendor();
  }, [fresh, current, refreshVendor]);
  const [, themeLabel, ThemeIcon] = THEMES.find(([k]) => k === theme);
  const { vendor, user } = session;

  return (
    <nav className="sidebar" aria-label="Main">
      <div className="brand">
        <NurviaMark />
        <div>
          <div className="brand-name">nurvia</div>
          <div className="brand-sub">Partner panel</div>
        </div>
      </div>
      {NAV.map((n) =>
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
            {counts && n.count?.(counts) ? <span className="count">{n.count(counts)}</span> : null}
          </NavLink>
        ),
      )}
      <div className="sidebar-foot">
        <div className="me">
          <span className="me-avatar">{vendor.businessName.slice(0, 1).toUpperCase()}</span>
          <div style={{ minWidth: 0 }}>
            <div className="me-name">{vendor.businessName}</div>
            <div className="me-role" style={{ textTransform: 'none' }}>{user.name ?? user.phone}</div>
          </div>
        </div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <button className="side-btn" onClick={nextTheme} title="Change theme">
            <ThemeIcon size={15} /> {themeLabel}
          </button>
          <button className="side-btn" onClick={signOut}>
            <LogOut size={15} /> Sign out
          </button>
        </div>
      </div>
    </nav>
  );
}

const STATUS_NOTES = {
  pending: (v) =>
    v.kyc?.status === 'submitted'
      ? 'Your documents are with the Nurvia team for review. You can set up services and hours meanwhile; customers will see you once you are approved.'
      : 'Upload your KYC documents and trade licence so the Nurvia team can approve your business.',
  rejected: (v) => `Your application needs changes${v.kyc?.rejectionReason ? `: ${v.kyc.rejectionReason}` : ''}. Update your documents and submit them again.`,
  suspended: (v) => `Your listing is suspended${v.statusReason ? `: ${v.statusReason}` : ''}. Customers cannot book you until the Nurvia team reactivates it.`,
};

function StatusBanner() {
  const { session } = useSession();
  const { vendor } = session;
  const note = STATUS_NOTES[vendor.status]?.(vendor);
  if (!note) return null;
  return (
    <div className={`vp-status ${vendor.status === 'pending' ? 'warn' : 'crit'}`} role="status">
      <strong>{vendor.status === 'pending' ? 'Awaiting approval' : vendor.status === 'rejected' ? 'Changes needed' : 'Suspended'}</strong>
      <span>{note}</span>
      {vendor.status !== 'suspended' && (
        <NavLink to="/documents" className="ov-btn">
          KYC & licence
        </NavLink>
      )}
    </div>
  );
}

function Notifications() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const tick = useTick(60_000);
  const { data, reload } = useApi('/notifications', { limit: 6, _: `${pathname}:${tick}` });
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
            data.items.map((n) => (
              <div key={n._id} className={`tb-note ${n.readAt ? '' : 'unread'}`}>
                <div style={{ fontWeight: 600 }}>{n.title}</div>
                {n.body && <div className="small muted">{n.body}</div>}
                <div className="small muted">{ago(n.createdAt)}</div>
              </div>
            ))
          ) : (
            <div className="empty small">No notifications</div>
          )}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const { session } = useSession();
  if (session === undefined) {
    return (
      <div className="login">
        <NurviaMark size={44} />
      </div>
    );
  }
  if (session === null) return <Login />;
  if (!session.vendor) return <Onboarding />;

  return (
    <div className="shell">
      <Sidebar />
      <main className="main">
        <header className="topbar vp-topbar">
          <div>
            <div className="eyebrow">{new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' })}</div>
            <div className="vp-biz">{session.vendor.businessName}</div>
          </div>
          <div className="row" style={{ gap: 12, marginLeft: 'auto' }}>
            <span className={`tb-status ${session.vendor.status === 'active' ? '' : 'down'}`}>
              <span className="tb-dot" />
              {session.vendor.status === 'active' ? 'Live on Nurvia' : 'Not visible to customers'}
            </span>
            <Notifications />
          </div>
        </header>
        <StatusBanner />
        <Suspense fallback={<div className="empty">Loading…</div>}>
          <Routes>
            {NAV.filter((n) => n.to).map((n) => (
              <Route key={n.to} path={n.to} element={n.element} />
            ))}
            <Route path="/bookings/:id" element={<BookingDetail />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}
