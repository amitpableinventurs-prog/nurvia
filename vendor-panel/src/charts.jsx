import { useRef, useState } from 'react';

const IST_OFFSET = 330 * 60_000;

// Every local (IST) date from `from` to `to`, with the API's sparse rows filled in as zero.
export function fillDays(rows, from, to, key = 'count') {
  const values = new Map(rows.map((r) => [r.date, r[key]]));
  const days = [];
  const end = new Date(new Date(to).getTime() + IST_OFFSET).toISOString().slice(0, 10);
  for (let t = new Date(from).getTime(); ; t += 86_400_000) {
    const date = new Date(t + IST_OFFSET).toISOString().slice(0, 10);
    days.push({ date, value: values.get(date) ?? 0 });
    if (date >= end) break;
  }
  return days;
}

// Sums days into at most `max` buckets so long ranges still read as a smooth trend.
export function bucket(days, max) {
  if (days.length <= max) return days;
  const size = Math.ceil(days.length / max);
  const out = [];
  for (let i = 0; i < days.length; i += size) {
    const chunk = days.slice(i, i + size);
    out.push({ date: chunk[0].date, end: chunk.at(-1).date, value: chunk.reduce((n, d) => n + d.value, 0) });
  }
  return out;
}

function niceMax(max) {
  if (max <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(max));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * pow * 4 >= max) * pow;
  return step * 4;
}

const fmtDay = (d, opts = { day: 'numeric', month: 'short' }) => new Date(`${d}T12:00:00+05:30`).toLocaleDateString('en-IN', { ...opts, timeZone: 'Asia/Kolkata' });

// Trend in the de-emphasis hue; the current (last) point in the accent.
export function Sparkline({ values, width = 110, height = 34 }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const step = (width - 8) / (values.length - 1);
  const pts = values.map((v, i) => [4 + i * step, height - 4 - (v / max) * (height - 8)]);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const [lx, ly] = pts.at(-1);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" style={{ overflow: 'visible' }}>
      <path d={d} fill="none" stroke="var(--axis)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <path d={`M${pts.at(-2)[0]},${pts.at(-2)[1]}L${lx},${ly}`} fill="none" stroke="var(--series-1)" strokeWidth="2" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r="4" fill="var(--series-1)" stroke="var(--surface)" strokeWidth="2" />
    </svg>
  );
}

const W = 760;
const H = 250;
const PAD = { top: 12, right: 12, bottom: 26, left: 44 };

// Single-series area chart with a hover crosshair and an accessible table view.
export function TrendChart({ days, label, format = (v) => v.toLocaleString('en-IN'), formatTick = format, showTable }) {
  const svgRef = useRef(null);
  const [hover, setHover] = useState(null);
  const max = niceMax(Math.max(0, ...days.map((d) => d.value)));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (i) => PAD.left + (days.length === 1 ? plotW / 2 : (i / (days.length - 1)) * plotW);
  const y = (v) => PAD.top + plotH - (v / max) * plotH;
  const line = days.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join('');
  const area = `${line}L${x(days.length - 1)},${y(0)}L${x(0)},${y(0)}Z`;
  const ticks = [0, max / 4, max / 2, (max * 3) / 4, max];
  const labelEvery = Math.max(1, Math.ceil(days.length / 6));

  const onMove = (e) => {
    const rect = svgRef.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - PAD.left) / plotW) * (days.length - 1));
    setHover(Math.min(days.length - 1, Math.max(0, i)));
  };

  const rangeLabel = (d) => (d.end && d.end !== d.date ? `${fmtDay(d.date)} – ${fmtDay(d.end)}` : fmtDay(d.date, { weekday: 'short', day: 'numeric', month: 'short' }));

  if (showTable) {
    return (
      <div className="table-wrap" style={{ maxHeight: H, overflowY: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th className="num">{label}</th>
            </tr>
          </thead>
          <tbody>
            {[...days].reverse().map((d) => (
              <tr key={d.date}>
                <td>{rangeLabel(d)}</td>
                <td className="num">{format(d.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="chart">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${label}, ${days.length} points`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        style={{ cursor: 'crosshair' }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--axis)' : 'var(--grid)'} strokeWidth="1" />
            <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize="11" fill="var(--muted)" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {formatTick(t)}
            </text>
          </g>
        ))}
        {days.map((d, i) =>
          i % labelEvery === 0 || i === days.length - 1 ? (
            <text key={d.date} x={x(i)} y={H - 6} textAnchor={i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'} fontSize="11" fill="var(--muted)">
              {fmtDay(d.date)}
            </text>
          ) : null,
        )}
        <path d={area} fill="var(--series-wash)" />
        <path d={line} fill="none" stroke="var(--series-1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {hover !== null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={y(0)} stroke="var(--axis)" strokeWidth="1" />
            <circle cx={x(hover)} cy={y(days[hover].value)} r="5" fill="var(--series-1)" stroke="var(--surface)" strokeWidth="2" />
          </>
        )}
        {hover === null && days.length > 0 && <circle cx={x(days.length - 1)} cy={y(days.at(-1).value)} r="4.5" fill="var(--series-1)" stroke="var(--surface)" strokeWidth="2" />}
      </svg>
      {hover !== null && (
        <div className="tooltip" style={{ left: `${(x(hover) / W) * 100}%`, top: `${(y(days[hover].value) / H) * 100}%` }}>
          <div className="t-date">{rangeLabel(days[hover])}</div>
          <strong>{format(days[hover].value)}</strong> {label.toLowerCase()}
        </div>
      )}
    </div>
  );
}

// Horizontal bars for a handful of categories; labels and values carry identity, so one hue suffices.
export function HBars({ rows, format = (v) => v.toLocaleString('en-IN') }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div>
      {rows.map((r) => (
        <div key={r.label} className="hbar-row" title={`${r.label}: ${format(r.value)}`}>
          <span className="small" style={{ color: 'var(--ink-2)', fontWeight: 600 }}>{r.label}</span>
          <div className="hbar-track">
            <div className="hbar-fill" style={{ width: `${(r.value / max) * 100}%`, opacity: r.value ? 1 : 0 }} />
          </div>
          <span className="num" style={{ textAlign: 'right', fontWeight: 700 }}>{format(r.value)}</span>
        </div>
      ))}
    </div>
  );
}
