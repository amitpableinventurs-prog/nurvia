import { Search } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api.js';
import { Badge, ErrorNote, Pager, Table, formatDate, formatRupees, useApi, useConfirm } from '../ui.jsx';
import { useFilters } from '../useFilters.js';

// Shop orders holding this partner's products. Only their own lines show, and fulfilment moves one
// step at a time: placed → confirmed → shipped → delivered. Unpaid online orders never appear here.

const STATUS_TABS = [
  ['', 'All'],
  ['placed', 'New'],
  ['confirmed', 'Confirmed'],
  ['shipped', 'Shipped'],
  ['delivered', 'Delivered'],
  ['cancelled', 'Cancelled'],
];

// [next status, button label] for each order the seller can move forward.
const NEXT = {
  placed: ['confirmed', 'Confirm'],
  confirmed: ['shipped', 'Mark shipped'],
  shipped: ['delivered', 'Mark delivered'],
};
const CANCELLABLE = ['placed', 'confirmed'];

export default function Orders() {
  const [filters, setFilter] = useFilters();
  const [q, setQ] = useState(filters.q ?? '');
  const { data, error, reload } = useApi('/shop/seller/orders', { status: filters.status, q: filters.q, page: filters.page });
  const [confirm, dialog] = useConfirm();
  const [actionError, setActionError] = useState(null);
  const counts = data?.counts;
  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : null;

  const move = async (o, status) => {
    setActionError(null);
    try {
      await api.post(`/shop/seller/orders/${o._id}/status`, { status });
      reload();
    } catch (err) {
      setActionError(err);
    }
  };

  const cancel = (o) =>
    confirm({
      title: `Cancel order ${o.code}?`,
      message: 'The customer is told, stock goes back to your products, and any online payment is refunded in full.',
      reason: 'required',
      confirmLabel: 'Cancel order',
      danger: true,
      onConfirm: async (note) => {
        await api.post(`/shop/seller/orders/${o._id}/status`, { status: 'cancelled', note });
        reload();
      },
    });

  return (
    <div>
      {dialog}
      <div className="page-head">
        <div>
          <h1>Orders</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>Confirm new orders, then mark them shipped and delivered. Cash on delivery is marked paid on delivery.</p>
        </div>
      </div>
      <ErrorNote error={error ?? actionError} />
      <div className="card">
        <div className="tabs" role="tablist">
          {STATUS_TABS.map(([key, label]) => (
            <button key={key || 'all'} role="tab" aria-selected={(filters.status ?? '') === key} className={`tab ${(filters.status ?? '') === key ? 'active' : ''}`} onClick={() => setFilter('status', key)}>
              {label}
              {counts && <span className="muted"> {key ? counts[key] : total}</span>}
            </button>
          ))}
        </div>
        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter('q', q.trim());
          }}
        >
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Order code" aria-label="Search by order code" style={{ minWidth: 200 }} />
          <button type="submit">
            <Search size={15} /> Search
          </button>
        </form>
        <Table
          rows={data?.items}
          empty={filters.q || filters.status ? 'No orders match.' : 'No orders yet. They show up here as soon as a customer buys one of your products.'}
          columns={[
            {
              label: 'Order',
              render: (o) => (
                <>
                  <div style={{ fontWeight: 600 }} className="num">
                    {o.code}
                  </div>
                  <div className="small muted">{formatDate(o.createdAt)}</div>
                </>
              ),
            },
            {
              label: 'Deliver to',
              render: (o) => (
                <>
                  <div>{o.address.name}</div>
                  <div className="small muted">
                    {o.address.phone} · {[o.address.city, o.address.pincode].filter(Boolean).join(' ')}
                  </div>
                </>
              ),
            },
            {
              label: 'Items',
              render: (o) => (
                <ul style={{ margin: 0, paddingLeft: 16 }} className="small">
                  {o.items.map((i) => (
                    <li key={i.sku}>
                      {i.name} <span className="muted">· {i.variantLabel}</span> × {i.qty}
                    </li>
                  ))}
                </ul>
              ),
            },
            {
              label: 'Amount',
              num: true,
              render: (o) => (
                <>
                  {formatRupees(o.sellerTotalPaise)}
                  <div className="small muted">{o.paymentMethod === 'cod' ? 'Cash on delivery' : 'Paid online'}</div>
                </>
              ),
            },
            {
              label: 'Status',
              render: (o) => (
                <>
                  <Badge value={o.status} />
                  {o.payment?.status && o.payment.status !== 'unpaid' && <div className="small muted">Payment {o.payment.status.replaceAll('_', ' ')}</div>}
                </>
              ),
            },
            {
              label: 'Actions',
              render: (o) => (
                <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                  {NEXT[o.status] && (
                    <button className={o.status === 'placed' ? 'primary' : undefined} onClick={() => move(o, NEXT[o.status][0])}>
                      {NEXT[o.status][1]}
                    </button>
                  )}
                  {CANCELLABLE.includes(o.status) && <button onClick={() => cancel(o)}>Cancel</button>}
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
