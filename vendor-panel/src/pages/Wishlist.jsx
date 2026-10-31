import { Badge, ErrorNote, Pager, Table, formatDate, formatRupees, useApi } from '../ui.jsx';
import { useFilters } from '../useFilters.js';

// How many customers saved each product to their wishlist, most wanted first. Customers stay
// anonymous: only the counts come back. A much-saved product that is hidden or out of stock is
// worth restocking or publishing.

export default function Wishlist() {
  const [filters, setFilter] = useFilters();
  const { data, error } = useApi('/shop/seller/wishlist', { page: filters.page });

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Wishlist</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>Products customers saved for later. Keep the most wanted ones in stock.</p>
        </div>
      </div>
      <ErrorNote error={error} />
      <div className="card">
        <Table
          rows={data?.items}
          empty="Nobody has saved your products yet."
          columns={[
            {
              label: 'Product',
              render: ({ product: p }) =>
                p ? (
                  <div className="row" style={{ gap: 10, flexWrap: 'nowrap' }}>
                    <span className="vp-thumb">{p.images?.[0]?.url ? <img src={p.images[0].url} alt="" /> : p.name.slice(0, 1)}</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>{p.name}</div>
                      {p.brand && <div className="small muted">{p.brand}</div>}
                    </div>
                  </div>
                ) : (
                  <span className="muted">Deleted product</span>
                ),
            },
            { label: 'Saved by', num: true, render: (r) => `${r.savedCount.toLocaleString('en-IN')} ${r.savedCount === 1 ? 'customer' : 'customers'}` },
            { label: 'Last saved', render: (r) => formatDate(r.lastSavedAt) },
            { label: 'Price from', num: true, render: (r) => formatRupees(r.product?.pricePaise) },
            {
              label: 'Stock',
              render: ({ product: p }) =>
                p && (
                  <>
                    <Badge value={p.status} />
                    {!p.inStock && <div className="small" style={{ color: 'var(--critical)' }}>Out of stock</div>}
                  </>
                ),
            },
          ]}
        />
        <Pager data={data} onPage={(p) => setFilter('page', p)} />
      </div>
    </div>
  );
}
