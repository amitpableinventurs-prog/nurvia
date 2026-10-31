import { useState } from 'react';
import { api } from '../api.js';
import { Badge, ErrorNote, Pager, Table, formatDate, formatRupees, useApi, useConfirm } from '../ui.jsx';
import { useFilters } from '../useFilters.js';

// Return requests for this partner's products. A request moves requested → approved → picked up →
// received → refunded, or is rejected with a reason. The refund covers what the customer actually paid
// for the returned items; cash-on-delivery refunds are sent by UPI or bank and tracked as manual.

const STATUS_TABS = [
  ['', 'All'],
  ['requested', 'New'],
  ['approved', 'Approved'],
  ['picked_up', 'Picked up'],
  ['received', 'Received'],
  ['refunded', 'Refunded'],
  ['rejected', 'Rejected'],
];

const REASONS = {
  damaged: 'Damaged',
  wrong_item: 'Wrong item',
  expired: 'Expired',
  not_as_described: 'Not as described',
  pet_did_not_like: 'Pet did not like it',
  other: 'Other',
};

export default function Returns() {
  const [filters, setFilter] = useFilters();
  const { data, error, reload } = useApi('/shop/seller/returns', { status: filters.status, page: filters.page });
  const [confirm, dialog] = useConfirm();
  const [actionError, setActionError] = useState(null);

  const decide = async (r, action, extra = {}) => {
    setActionError(null);
    try {
      await api.post(`/shop/seller/returns/${r._id}/decision`, { action, ...extra });
      reload();
    } catch (err) {
      setActionError(err);
    }
  };

  const reject = (r) =>
    confirm({
      title: `Reject return ${r.code}?`,
      message: 'The customer sees your reason.',
      reason: 'required',
      confirmLabel: 'Reject',
      danger: true,
      onConfirm: async (note) => {
        await api.post(`/shop/seller/returns/${r._id}/decision`, { action: 'reject', note });
        reload();
      },
    });

  const receive = (r) =>
    confirm({
      title: `Received ${r.code}?`,
      message: 'Confirm the items reached you. Use "Received and restock" instead if they can be sold again.',
      confirmLabel: 'Mark received',
      onConfirm: async () => {
        await api.post(`/shop/seller/returns/${r._id}/decision`, { action: 'mark_received', restock: false });
        reload();
      },
    });

  const refund = (r) =>
    confirm({
      title: `Refund ${r.code}?`,
      message: 'Online payments are refunded to the customer straight away. For cash on delivery, send the money by UPI or bank transfer.',
      confirmLabel: 'Issue refund',
      onConfirm: async () => {
        await api.post(`/shop/seller/returns/${r._id}/decision`, { action: 'refund' });
        reload();
      },
    });

  const actions = (r) => {
    switch (r.status) {
      case 'requested':
        return (
          <>
            <button className="primary" onClick={() => decide(r, 'approve')}>
              Approve
            </button>
            <button onClick={() => reject(r)}>Reject</button>
          </>
        );
      case 'approved':
      case 'picked_up':
        return (
          <>
            {r.status === 'approved' && <button onClick={() => decide(r, 'mark_picked_up')}>Picked up</button>}
            <button className={r.status === 'picked_up' ? 'primary' : undefined} onClick={() => decide(r, 'mark_received', { restock: true })}>
              Received and restock
            </button>
            <button onClick={() => receive(r)}>Received</button>
          </>
        );
      case 'received':
        return (
          <button className="primary" onClick={() => refund(r)}>
            Refund
          </button>
        );
      default:
        return null;
    }
  };

  return (
    <div>
      {dialog}
      <div className="page-head">
        <div>
          <h1>Returns</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>Customers can return delivered items within 7 days. Approve or reject each request, then refund once the items are back.</p>
        </div>
      </div>
      <ErrorNote error={error ?? actionError} />
      <div className="card">
        <div className="tabs" role="tablist">
          {STATUS_TABS.map(([key, label]) => (
            <button key={key || 'all'} role="tab" aria-selected={(filters.status ?? '') === key} className={`tab ${(filters.status ?? '') === key ? 'active' : ''}`} onClick={() => setFilter('status', key)}>
              {label}
            </button>
          ))}
        </div>
        <Table
          rows={data?.items}
          empty={filters.status ? 'No returns here.' : 'No return requests yet.'}
          columns={[
            {
              label: 'Return',
              render: (r) => (
                <>
                  <div style={{ fontWeight: 600 }} className="num">
                    {r.code}
                  </div>
                  <div className="small muted">
                    Order {r.orderCode} · {formatDate(r.createdAt)}
                  </div>
                </>
              ),
            },
            {
              label: 'Customer',
              render: (r) => (
                <>
                  <div>{r.user?.name ?? 'Customer'}</div>
                  <div className="small muted">{r.user?.phone}</div>
                </>
              ),
            },
            {
              label: 'Items',
              render: (r) => (
                <ul style={{ margin: 0, paddingLeft: 16 }} className="small">
                  {r.items.map((i) => (
                    <li key={i.sku}>
                      {i.name} <span className="muted">· {i.variantLabel}</span> × {i.qty}
                    </li>
                  ))}
                </ul>
              ),
            },
            {
              label: 'Reason',
              render: (r) => (
                <>
                  {REASONS[r.reason] ?? r.reason}
                  {r.details && <div className="small muted" style={{ maxWidth: 280 }}>{r.details}</div>}
                  {r.photos?.length > 0 && (
                    <div className="row small" style={{ gap: 6 }}>
                      {r.photos.map((p, i) => (
                        <a key={p.file} href={p.url} target="_blank" rel="noreferrer">
                          Photo {i + 1}
                        </a>
                      ))}
                    </div>
                  )}
                </>
              ),
            },
            {
              label: 'Status',
              render: (r) => (
                <>
                  <Badge value={r.status} />
                  {r.refund?.amountPaise != null && (
                    <div className="small muted">
                      {formatRupees(r.refund.amountPaise)} · {r.refund.method === 'manual' ? 'send by UPI/bank' : 'to original payment'} · {r.refund.status}
                    </div>
                  )}
                  {r.restocked && <div className="small muted">Restocked</div>}
                </>
              ),
            },
            {
              label: 'Actions',
              render: (r) => (
                <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                  {actions(r)}
                </div>
              ),
            },
          ]}
        />
        <Pager data={data} onPage={(p) => setFilter('page', p)} />
      </div>
    </div>
  );
}
