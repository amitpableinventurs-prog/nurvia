import { useMemo, useState } from 'react';
import { TrendChart, bucket, fillDays } from '../charts.jsx';
import { Badge, ErrorNote, Table, formatDate, formatRupees, rupeesCompact, useApi } from '../ui.jsx';

const RANGES = [7, 30, 90];

export default function Earnings() {
  const [range, setRange] = useState(30);
  const [asTable, setAsTable] = useState(false);
  const period = useMemo(() => {
    const to = new Date();
    return { from: new Date(to.getTime() - (range - 1) * 86_400_000).toISOString(), to: to.toISOString() };
  }, [range]);
  const { data, error } = useApi('/vendors/me/earnings', period);
  const days = useMemo(() => (data ? bucket(fillDays(data.daily, data.from, data.to, 'grossPaise'), 60) : []), [data]);

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>Earnings</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>Online payments customers made for your bookings, by payment date. Cash collected at the counter is not included.</p>
        </div>
        <div className="segmented" role="group" aria-label="Date range">
          {RANGES.map((r) => (
            <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>
              {r} days
            </button>
          ))}
        </div>
      </div>
      <ErrorNote error={error} />

      {data && (
        <>
          <section className="ov-metrics">
            <Stat label="Collected" value={formatRupees(data.totals.grossPaise)} foot={`${data.totals.count} payments`} />
            <Stat label="Refunded" value={formatRupees(data.totals.refundedPaise)} foot="cancelled or declined" />
            <Stat label="Net" value={formatRupees(data.totals.netPaise)} foot="before platform fees" strong />
          </section>

          <section className="card hero-chart">
            <div className="card-head">
              <h2>Daily collections</h2>
              <button onClick={() => setAsTable((v) => !v)} aria-pressed={asTable}>
                {asTable ? 'Show chart' : 'Show table'}
              </button>
            </div>
            <TrendChart days={days} label="Collected" format={formatRupees} formatTick={rupeesCompact} showTable={asTable} />
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Payments</h2>
              {data.truncated && <span className="small muted">Showing the latest 200</span>}
            </div>
            <Table
              rows={data.transactions}
              empty="No online payments in this period"
              columns={[
                { label: 'Paid', render: (t) => formatDate(t.paidAt) },
                {
                  label: 'Booking',
                  render: (t) => (
                    <>
                      {t.service} <span className="small muted mono">{t.code}</span>
                      <div className="small muted">{t.customer ?? 'Customer'}</div>
                    </>
                  ),
                },
                { label: 'Visit', render: (t) => <Badge value={t.bookingStatus} /> },
                { label: 'Payment', render: (t) => <Badge value={t.paymentStatus} /> },
                {
                  label: 'Amount',
                  num: true,
                  render: (t) => <span style={t.paymentStatus === 'paid' ? undefined : { textDecoration: 'line-through', color: 'var(--muted)' }}>{formatRupees(t.amountPaise)}</span>,
                },
              ]}
            />
          </section>
          <p className="small muted" style={{ margin: 0 }}>
            Payouts to your bank account are settled by the Nurvia team. Automated settlement statements are coming in a later release.
          </p>
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
