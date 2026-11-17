import { Download } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../api.js';
import { ErrorNote, Table, formatDate, formatRupees, istDay, useApi } from '../ui.jsx';
import { addDays, ist } from '../workspace.jsx';

// Bookings, revenue, top services, repeat customers and no-shows for a date range, from Nurvia
// bookings and the business's own appointments together, with CSV exports.
const PRESETS = [
  [7, 'Last 7 days'],
  [30, 'Last 30 days'],
  [90, 'Last 90 days'],
];
const EXPORTS = [
  ['bookings', 'Bookings'],
  ['services', 'Services'],
  ['customers', 'Customers'],
  ['no_shows', 'No-shows'],
];

export default function Reports() {
  const [range, setRange] = useState({ from: istDay(-29), to: istDay(0) });
  const params = useMemo(() => ({ from: ist(range.from), to: ist(addDays(range.to, 1)) }), [range]);
  const { data, error } = useApi('/vendors/me/reports', params);
  const [exportError, setExportError] = useState(null);
  const preset = PRESETS.find(([days]) => range.to === istDay(0) && range.from === istDay(1 - days))?.[0];

  const exportCsv = async (kind) => {
    setExportError(null);
    try {
      await api.download('/vendors/me/reports/export', { ...params, kind }, `nurvia-${kind}.csv`);
    } catch (err) {
      setExportError(err);
    }
  };

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>Reports</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>Nurvia bookings and your own appointments together. Revenue is the value of completed visits plus packages sold.</p>
        </div>
      </div>

      <div className="row" style={{ alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="segmented" role="group" aria-label="Date range">
            {PRESETS.map(([days, label]) => (
              <button key={days} aria-pressed={preset === days} onClick={() => setRange({ from: istDay(1 - days), to: istDay(0) })}>
                {label}
              </button>
            ))}
          </div>
          <label className="field">
            From
            <input type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange((r) => ({ ...r, from: e.target.value }))} />
          </label>
          <label className="field">
            To
            <input type="date" value={range.to} min={range.from} onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: e.target.value }))} />
          </label>
        </div>
        <div className="row">
          <span className="small muted">Export CSV:</span>
          {EXPORTS.map(([kind, label]) => (
            <button key={kind} onClick={() => exportCsv(kind)}>
              <Download size={14} /> {label}
            </button>
          ))}
        </div>
      </div>
      <ErrorNote error={error ?? exportError} />

      {data && (
        <>
          <section className="ov-metrics">
            <Stat label="Bookings" value={data.summary.bookings} foot={`${data.summary.completed} completed · ${data.summary.upcoming} upcoming · ${data.summary.cancelled} cancelled`} />
            <Stat label="Revenue" value={formatRupees(data.revenue.totalPaise)} foot={`${formatRupees(data.revenue.visitsPaise)} visits · ${formatRupees(data.revenue.packagesPaise)} packages`} strong />
            <Stat label="Repeat customers" value={`${data.customers.repeat} of ${data.customers.unique}`} foot={`${data.customers.repeatPct}% came back more than once`} />
            <Stat label="No-shows" value={data.noShows.count} foot={`${data.noShows.ratePct}% of visits that were due`} />
          </section>
          {data.truncated && <div className="small muted">This range has more bookings than a report can count; choose a shorter range.</div>}
          <div className="vp-grid-2" style={{ alignItems: 'start' }}>
            <section className="card">
              <div className="card-head">
                <h2>Top services</h2>
              </div>
              <Table
                rows={data.topServices}
                rowKey={(s) => s.name}
                empty="No completed visits in this period"
                columns={[
                  { label: 'Service', render: (s) => s.name },
                  { label: 'Completed', num: true, render: (s) => s.count },
                  { label: 'Nurvia / own', num: true, render: (s) => `${s.nurvia} / ${s.own}` },
                  { label: 'Value', num: true, render: (s) => formatRupees(s.valuePaise) },
                ]}
              />
            </section>
            <section className="card">
              <div className="card-head">
                <h2>Repeat customers</h2>
              </div>
              <Table
                rows={data.customers.topRepeat}
                rowKey={(c) => `${c.name}${c.phone}`}
                empty="No customer came more than once in this period"
                columns={[
                  {
                    label: 'Customer',
                    render: (c) => (
                      <>
                        {c.name}
                        <div className="small muted">{c.phone}</div>
                      </>
                    ),
                  },
                  { label: 'Visits', num: true, render: (c) => c.visits },
                  { label: 'Value', num: true, render: (c) => formatRupees(c.valuePaise) },
                ]}
              />
            </section>
          </div>
          <section className="card">
            <div className="card-head">
              <h2>No-shows</h2>
              {data.noShows.count > data.noShows.items.length && <span className="small muted">Latest {data.noShows.items.length}; the CSV has all</span>}
            </div>
            <Table
              rows={data.noShows.items}
              rowKey={(r) => `${r.at}${r.customer}`}
              empty="No no-shows in this period"
              columns={[
                { label: 'When', render: (r) => formatDate(r.at) },
                {
                  label: 'Customer',
                  render: (r) => (
                    <>
                      {r.customer}
                      <div className="small muted">{r.phone}</div>
                    </>
                  ),
                },
                { label: 'Pet', render: (r) => r.pet ?? '—' },
                { label: 'Service', render: (r) => r.service },
                { label: 'Booked', render: (r) => (r.source === 'nurvia' ? <span className="mono small">{r.reference}</span> : 'Own appointment') },
              ]}
            />
          </section>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, foot, strong }) {
  return (
    <div className="card ov-metric" style={strong ? { background: 'var(--tint-good)' } : undefined}>
      <span className="kpi-label">{label}</span>
      <div className="kpi-value num">{value}</div>
      <div className="small muted">{foot}</div>
    </div>
  );
}
