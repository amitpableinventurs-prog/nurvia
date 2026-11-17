import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from './api.js';

// Loads `path` with `params`, reloading whenever either changes. Pass { enabled: false } to skip.
export function useApi(path, params, { enabled = true } = {}) {
  const key = JSON.stringify(params ?? {});
  const [state, setState] = useState({ data: null, error: null, loading: enabled });

  const load = useCallback(async () => {
    if (!enabled || !path) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      setState({ data: await api.get(path, JSON.parse(key)), error: null, loading: false });
    } catch (error) {
      setState({ data: null, error, loading: false });
    }
  }, [path, key, enabled]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, reload: load };
}

export function ErrorNote({ error }) {
  if (!error) return null;
  return (
    <div className="error" role="alert">
      {error.message}
      {error.status === 402 && (
        <>
          {' '}
          <Link to="/billing">See plans</Link>
        </>
      )}
      {Array.isArray(error.details) && error.details.length > 0 && (
        <ul className="small">
          {error.details.map((d) => (
            <li key={d.path + d.message}>
              {d.path}: {d.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const TONES = {
  good: ['active', 'approved', 'visible', 'open', 'accepted', 'completed', 'paid', 'actioned', 'delivered', 'refunded'],
  warning: ['pending', 'submitted', 'pending_review', 'on_hold', 'refund_pending', 'shortlisted', 'placed', 'requested'],
  serious: ['hidden', 'no_show', 'failed', 'unpaid'],
  critical: ['suspended', 'rejected', 'removed', 'cancelled', 'deleted', 'blocked'],
};

// `label` replaces the shown text when the stored value reads badly (shipped is "Out for delivery").
export function Badge({ value, label }) {
  if (!value) return null;
  const tone = Object.keys(TONES).find((t) => TONES[t].includes(value)) ?? '';
  return <span className={`badge ${tone}`}>{label ?? value.replaceAll('_', ' ')}</span>;
}

// Trade licence state for a vendor; the tone follows the same dot + label pattern as Badge.
const LICENSE = {
  verified: ['good', 'Licence verified'],
  manual_review: ['warning', 'Manual check needed'],
  pending_upload: ['', 'Licence not uploaded'],
  failed: ['critical', 'Licence mismatch'],
};

export function LicensePill({ status }) {
  const [tone, label] = LICENSE[status] ?? ['', status ?? '—'];
  return <span className={`badge ${tone}`} style={{ textTransform: 'none' }}>{label}</span>;
}

export const ago = (value) => {
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
};

export function Table({ columns, rows, empty = 'Nothing here yet', rowKey = (r) => r._id }) {
  if (!rows) return null;
  if (!rows.length) return <div className="empty">{empty}</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.label} className={c.num ? 'num' : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((c) => (
                <td key={c.label} className={c.num ? 'num' : undefined}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pager({ data, onPage }) {
  if (!data || data.pages <= 1) return null;
  return (
    <div className="pager">
      <span>
        Page {data.page} of {data.pages} · {data.total.toLocaleString('en-IN')} total
      </span>
      <button disabled={data.page <= 1} onClick={() => onPage(data.page - 1)}>
        Previous
      </button>
      <button disabled={data.page >= data.pages} onClick={() => onPage(data.page + 1)}>
        Next
      </button>
    </div>
  );
}

// A confirm dialog that optionally asks for a reason, which the API records in the audit log.
export function useConfirm() {
  const ref = useRef(null);
  const [request, setRequest] = useState(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const confirm = (options) => {
    setRequest(options);
    setReason('');
    setError(null);
    queueMicrotask(() => ref.current?.showModal());
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await request.onConfirm(reason.trim() || undefined);
      ref.current.close();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const dialog = (
    <dialog ref={ref} onClose={() => setRequest(null)}>
      {request && (
        <form className="stack" onSubmit={submit}>
          <h2>{request.title}</h2>
          {request.message && <p className="muted">{request.message}</p>}
          {request.reason && (
            <label className="field">
              Reason {request.reason === 'required' ? '' : '(optional)'}
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} required={request.reason === 'required'} maxLength={500} autoFocus />
            </label>
          )}
          <ErrorNote error={error} />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => ref.current.close()}>
              Cancel
            </button>
            <button type="submit" className={request.danger ? 'danger' : 'primary'} disabled={busy}>
              {request.confirmLabel ?? 'Confirm'}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );

  return [confirm, dialog];
}

export const formatDate = (value) =>
  value ? new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }) : '—';

export const formatDay = (value) => (value ? new Date(value).toLocaleDateString('en-IN', { dateStyle: 'medium', timeZone: 'Asia/Kolkata' }) : '—');

export const formatRupees = (paise) =>
  paise === undefined || paise === null ? '—' : (paise / 100).toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });

export const formatTime = (value) => (value ? new Date(value).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—');

// Today's date in IST as YYYY-MM-DD, plus or minus whole days.
export const istDay = (offsetDays = 0) => new Date(Date.now() + 330 * 60_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);

// Indian-style compact currency: ₹12,450 · ₹1.2L · ₹3.4Cr
export function rupeesCompact(paise) {
  const r = (paise ?? 0) / 100;
  if (r >= 1e7) return `₹${(r / 1e7).toFixed(1).replace(/\.0$/, '')}Cr`;
  if (r >= 1e5) return `₹${(r / 1e5).toFixed(1).replace(/\.0$/, '')}L`;
  return `₹${Math.round(r).toLocaleString('en-IN')}`;
}

export const compact = (n) => (n >= 1000 ? Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(n) : String(n));
