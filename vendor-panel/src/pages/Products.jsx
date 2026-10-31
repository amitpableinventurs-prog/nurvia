import { FileUp, ImagePlus, Plus, Search, Trash2, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { api } from '../api.js';
import { Badge, ErrorNote, Pager, Table, formatDate, formatRupees, useApi, useConfirm } from '../ui.jsx';

// Products a partner sells on the Nurvia shop (website and app). Any approved business can add
// products straight away; the shop shows them once the seller details (GST, bank and pickup) are approved.

const PET_TYPES = { dog: 'Dog', cat: 'Cat', bird: 'Bird', fish: 'Fish', small_pet: 'Small pet' };
const GST_RATES = [0, 5, 12, 18, 28];
const LOW_STOCK = 5;
const STATUS_TABS = [
  ['', 'All'],
  ['active', 'Active'],
  ['draft', 'Draft'],
  ['hidden', 'Hidden'],
];

export default function Products() {
  const { data: profile, error, reload } = useApi('/shop/seller/profile');
  if (error) return <ErrorNote error={error} />;
  if (!profile) return null;
  if (profile.vendorStatus !== 'active') {
    return (
      <div>
        <div className="page-head">
          <div>
            <h1>Products</h1>
          </div>
        </div>
        <div className="card empty">Your business needs to be approved before you can add products. Finish KYC & licence first.</div>
      </div>
    );
  }
  return <ProductList profile={profile} onProfileSaved={reload} />;
}

// ---- Seller details (needed for products to show in the shop) ----

const DOC_TYPES = {
  gst_certificate: 'GST certificate',
  pan: 'PAN card',
  cancelled_cheque: 'Cancelled cheque',
  shop_license: 'Shop licence',
  other: 'Other',
};

// [tone, title, message, button] for each seller status other than approved.
const SELLER_NOTES = {
  none: ['warn', 'Not in the shop yet', 'Your products are saved. Add your GST, bank and pickup details so Nurvia can approve you to sell, and they will appear in the shop.', 'Add seller details'],
  submitted: ['warn', 'Seller details under review', 'Your products will appear in the shop as soon as the Nurvia team approves your seller details.', 'Update details'],
  rejected: ['crit', 'Seller details need changes', 'Your products are not shown in the shop until your seller details are approved.', 'Fix details'],
  suspended: ['crit', 'Not shown in the shop', 'Your seller account is suspended, so customers cannot see or buy your products. Contact Nurvia to reactivate it.', null],
};

function SellerNotice({ profile, onEdit }) {
  const status = profile.status ?? 'none';
  if (status === 'approved') return null;
  const [tone, title, message, action] = SELLER_NOTES[status] ?? SELLER_NOTES.none;
  return (
    <div className={`vp-status ${tone}`} role="status" style={{ alignItems: 'center' }}>
      <strong>{title}</strong>
      <span style={{ flex: 1 }}>
        {message}
        {status === 'rejected' && profile.reason ? ` ${profile.reason}` : ''}
        {status === 'submitted' && profile.submittedAt ? ` Sent ${formatDate(profile.submittedAt)}.` : ''}
      </span>
      {action && <button onClick={onEdit}>{action}</button>}
    </div>
  );
}

function SellerForm({ profile, onSubmitted, onCancel }) {
  const [form, setForm] = useState({
    legalName: profile.legalName ?? '',
    gstin: profile.gstin ?? '',
    pan: profile.pan ?? '',
    accountName: profile.bank?.accountName ?? '',
    accountNumber: '',
    ifsc: profile.bank?.ifsc ?? '',
    line1: profile.pickupAddress?.line1 ?? '',
    line2: profile.pickupAddress?.line2 ?? '',
    city: profile.pickupAddress?.city ?? '',
    state: profile.pickupAddress?.state ?? '',
    pincode: profile.pickupAddress?.pincode ?? '',
    phone: profile.pickupAddress?.phone ?? '',
  });
  const [docs, setDocs] = useState(() => (profile.documents ?? []).map((d) => ({ type: d.type, fileId: d.file, name: d.name })));
  const [docType, setDocType] = useState('gst_certificate');
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (key, upper = false) => (e) => setForm((f) => ({ ...f, [key]: upper ? e.target.value.toUpperCase() : e.target.value }));

  const upload = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const stored = await api.upload(file, 'seller_kyc');
      setDocs((d) => [...d, { type: docType, fileId: stored._id, name: stored.originalName }]);
    } catch (err) {
      setError(err);
    } finally {
      setUploading(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const optional = (v) => v.trim() || undefined;
    try {
      await api.put('/shop/seller/profile', {
        legalName: form.legalName.trim(),
        gstin: form.gstin.trim(),
        pan: optional(form.pan),
        bank: { accountName: form.accountName.trim(), accountNumber: form.accountNumber.trim(), ifsc: form.ifsc.trim() },
        pickupAddress: { line1: form.line1.trim(), line2: optional(form.line2), city: form.city.trim(), state: optional(form.state), pincode: form.pincode.trim(), phone: optional(form.phone) },
        documents: docs.map(({ type, fileId }) => ({ type, fileId })),
      });
      onSubmitted();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card stack" onSubmit={submit}>
      <h2 style={{ margin: 0 }}>Seller details</h2>
      <div className="vp-grid-2">
        <label className="field">
          Legal business name
          <input value={form.legalName} onChange={set('legalName')} required minLength={2} maxLength={160} />
        </label>
        <label className="field">
          GSTIN
          <input value={form.gstin} onChange={set('gstin', true)} required pattern="\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]" title="15-character GSTIN" placeholder="29ABCDE1234F1Z5" />
        </label>
        <label className="field">
          PAN (optional)
          <input value={form.pan} onChange={set('pan', true)} pattern="[A-Z]{5}\d{4}[A-Z]" title="10-character PAN" placeholder="ABCDE1234F" />
        </label>
      </div>
      <h3 style={{ margin: '8px 0 0' }}>Bank account for payouts</h3>
      <div className="vp-grid-2">
        <label className="field">
          Account holder name
          <input value={form.accountName} onChange={set('accountName')} required minLength={2} maxLength={120} />
        </label>
        <label className="field">
          Account number
          <input value={form.accountNumber} onChange={set('accountNumber')} required pattern="\d{9,18}" inputMode="numeric" title="9 to 18 digits" placeholder={profile.bank?.accountNumberLast4 ? `Ends in ${profile.bank.accountNumberLast4}` : ''} />
        </label>
        <label className="field">
          IFSC
          <input value={form.ifsc} onChange={set('ifsc', true)} required pattern="[A-Z]{4}0[A-Z0-9]{6}" title="11-character IFSC" placeholder="HDFC0001234" />
        </label>
      </div>
      <h3 style={{ margin: '8px 0 0' }}>Pickup address (where couriers collect orders)</h3>
      <div className="vp-grid-2">
        <label className="field">
          Address line 1
          <input value={form.line1} onChange={set('line1')} required minLength={3} maxLength={200} />
        </label>
        <label className="field">
          Address line 2
          <input value={form.line2} onChange={set('line2')} maxLength={200} />
        </label>
        <label className="field">
          City
          <input value={form.city} onChange={set('city')} required minLength={2} maxLength={80} />
        </label>
        <label className="field">
          State
          <input value={form.state} onChange={set('state')} maxLength={80} />
        </label>
        <label className="field">
          Pincode
          <input value={form.pincode} onChange={set('pincode')} required pattern="\d{6}" inputMode="numeric" />
        </label>
        <label className="field">
          Pickup phone
          <input value={form.phone} onChange={set('phone')} maxLength={20} inputMode="tel" />
        </label>
      </div>
      <h3 style={{ margin: '8px 0 0' }}>Documents</h3>
      {docs.length ? (
        <ul className="vp-docs">
          {docs.map((d) => (
            <li key={d.fileId}>
              <span>
                <strong>{DOC_TYPES[d.type]}</strong> <span className="muted small">{d.name}</span>
              </span>
              <button type="button" className="vp-icon-btn" onClick={() => setDocs((list) => list.filter((x) => x.fileId !== d.fileId))} aria-label={`Remove ${d.name}`}>
                <X size={15} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty small">Add at least your GST certificate.</div>
      )}
      <div className="row">
        <select value={docType} onChange={(e) => setDocType(e.target.value)} aria-label="Document type">
          {Object.entries(DOC_TYPES).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <label className={`ov-btn ${uploading ? 'disabled' : ''}`}>
          <FileUp size={15} /> {uploading ? 'Uploading…' : 'Upload PDF or photo'}
          <input type="file" accept="application/pdf,image/*" onChange={upload} hidden />
        </label>
      </div>
      <ErrorNote error={error} />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary" disabled={busy || !docs.length}>
          Send for approval
        </button>
      </div>
    </form>
  );
}

// ---- Product list ----

function priceRange(variants = []) {
  const prices = variants.map((v) => v.pricePaise);
  if (!prices.length) return '—';
  const [min, max] = [Math.min(...prices), Math.max(...prices)];
  return min === max ? formatRupees(min) : `${formatRupees(min)} – ${formatRupees(max)}`;
}

function ProductList({ profile, onProfileSaved }) {
  const [sellerFormOpen, setSellerFormOpen] = useState(false);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [lowStock, setLowStock] = useState(false);
  const [page, setPage] = useState(1);
  const { data, error, reload } = useApi('/shop/seller/products', { status, q: search, lowStock: lowStock ? 'true' : undefined, page });
  const { data: categories } = useApi('/shop/categories');
  const [editing, setEditing] = useState(null); // null = closed, {} = new, product = edit
  const [confirm, dialog] = useConfirm();
  const [actionError, setActionError] = useState(null);

  const filter = (fn) => (value) => {
    fn(value);
    setPage(1);
  };

  const setProductStatus = async (p, next) => {
    setActionError(null);
    try {
      await api.patch(`/shop/seller/products/${p._id}`, { status: next });
      reload();
    } catch (err) {
      setActionError(err);
    }
  };

  const remove = (p) =>
    confirm({
      title: `Delete ${p.name}?`,
      message: 'It disappears from the shop and from your list. If customers have ordered it, it is kept in the background so their orders stay complete.',
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: async () => {
        await api.del(`/shop/seller/products/${p._id}`);
        reload();
      },
    });

  const counts = data?.counts;
  const total = counts ? counts.active + counts.draft + counts.hidden : null;

  return (
    <div>
      {dialog}
      {editing && <ProductEditor product={editing} categories={categories ?? []} onClose={() => setEditing(null)} onSaved={reload} />}
      <div className="page-head">
        <div>
          <h1>Products</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>Active products appear in the Nurvia shop on the website and app.</p>
        </div>
        <button className="primary" onClick={() => setEditing({})}>
          <Plus size={16} /> Add product
        </button>
      </div>
      {sellerFormOpen ? (
        <SellerForm
          profile={profile}
          onCancel={() => setSellerFormOpen(false)}
          onSubmitted={() => {
            setSellerFormOpen(false);
            onProfileSaved();
            reload();
          }}
        />
      ) : (
        <SellerNotice profile={profile} onEdit={() => setSellerFormOpen(true)} />
      )}
      <ErrorNote error={error ?? actionError} />
      <div className="card">
        <div className="tabs" role="tablist">
          {STATUS_TABS.map(([key, label]) => (
            <button key={key || 'all'} role="tab" aria-selected={status === key} className={`tab ${status === key ? 'active' : ''}`} onClick={() => filter(setStatus)(key)}>
              {label}
              {counts && <span className="muted"> {key ? counts[key] : total}</span>}
            </button>
          ))}
        </div>
        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault();
            filter(setSearch)(q.trim());
          }}
        >
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or SKU" aria-label="Search products" style={{ minWidth: 240 }} />
          <button type="submit">
            <Search size={15} /> Search
          </button>
          <button type="button" className="vp-chip" aria-pressed={lowStock} onClick={() => filter(setLowStock)(!lowStock)}>
            Low stock (≤ {LOW_STOCK})
          </button>
        </form>
        <Table
          rows={data?.items}
          empty={search || lowStock || status ? 'No products match.' : 'No products yet. Add your first one to start selling.'}
          columns={[
            {
              label: 'Product',
              render: (p) => (
                <div className="row" style={{ gap: 10, flexWrap: 'nowrap' }}>
                  <span className="vp-thumb">{p.images?.[0]?.url ? <img src={p.images[0].url} alt="" /> : p.name.slice(0, 1)}</span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{p.name}</div>
                    <div className="small muted">{[p.brand, p.category?.name].filter(Boolean).join(' · ')}</div>
                  </div>
                </div>
              ),
            },
            { label: 'Price', num: true, render: (p) => priceRange(p.variants) },
            {
              label: 'Stock',
              num: true,
              render: (p) => {
                const total = p.variants.reduce((sum, v) => sum + v.stock, 0);
                const low = p.variants.some((v) => v.stock <= LOW_STOCK);
                return (
                  <>
                    {total.toLocaleString('en-IN')}
                    {low && <div className="small" style={{ color: 'var(--warning-ink, var(--critical))' }}>{p.variants.some((v) => v.stock === 0) ? 'Out of stock' : 'Low'}</div>}
                  </>
                );
              },
            },
            { label: 'Variants', num: true, render: (p) => p.variants.length },
            {
              label: 'Status',
              render: (p) => (
                <>
                  <Badge value={p.status} />
                  <div className="small muted">{p.shown ? 'In the shop' : 'Not in the shop'}</div>
                </>
              ),
            },
            {
              label: 'Actions',
              render: (p) => (
                <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                  <button onClick={() => setEditing(p)}>Edit</button>
                  {p.status === 'active' ? <button onClick={() => setProductStatus(p, 'hidden')}>Hide</button> : <button onClick={() => setProductStatus(p, 'active')}>Publish</button>}
                  <button className="vp-icon-btn danger" onClick={() => remove(p)} aria-label={`Delete ${p.name}`}>
                    <Trash2 size={15} />
                  </button>
                </div>
              ),
            },
          ]}
        />
        <Pager data={data} onPage={setPage} />
      </div>
    </div>
  );
}

// ---- Add / edit ----

const slugify = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);

const rupees = (paise) => (paise === undefined || paise === null ? '' : String(paise / 100));
const paise = (value) => Math.round(Number(value) * 100);
const blankVariant = () => ({ key: crypto.randomUUID(), sku: '', label: '', mrp: '', price: '', stock: '' });

function ProductEditor({ product, categories, onClose, onSaved }) {
  const ref = useRef(null);
  const isNew = !product._id;
  const [form, setForm] = useState(() => ({
    name: product.name ?? '',
    slug: product.slug ?? '',
    brand: product.brand ?? '',
    categoryId: product.category?._id ?? product.category ?? '',
    petTypes: product.petTypes ?? [],
    description: product.description ?? '',
    highlights: (product.highlights ?? []).join('\n'),
    tags: (product.tags ?? []).join(', '),
    gstRate: product.gstRate ?? 18,
    hsn: product.hsn ?? '',
    status: product.status ?? 'active',
  }));
  const [slugTouched, setSlugTouched] = useState(!isNew);
  const [images, setImages] = useState(() => (product.images ?? []).map((i) => ({ file: i.file, url: i.url })));
  const [variants, setVariants] = useState(() =>
    product.variants?.length
      ? product.variants.map((v) => ({ key: crypto.randomUUID(), sku: v.sku, label: v.label, mrp: rupees(v.mrpPaise), price: rupees(v.pricePaise), stock: String(v.stock) }))
      : [blankVariant()],
  );
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // The dialog opens once it is in the page.
  const attach = (node) => {
    ref.current = node;
    if (node && !node.open) node.showModal();
  };
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const setName = (e) => {
    const name = e.target.value;
    setForm((f) => ({ ...f, name, ...(!slugTouched && { slug: slugify(name) }) }));
  };
  const setVariant = (key, field) => (e) => setVariants((list) => list.map((v) => (v.key === key ? { ...v, [field]: field === 'sku' ? e.target.value.toUpperCase() : e.target.value } : v)));

  const upload = async (e) => {
    const files = [...e.target.files].slice(0, 8 - images.length);
    e.target.value = '';
    setUploading(true);
    setError(null);
    try {
      for (const file of files) {
        const stored = await api.upload(file, 'vendor_photo');
        setImages((list) => [...list, { file: stored._id, url: stored.url }]);
      }
    } catch (err) {
      setError(err);
    } finally {
      setUploading(false);
    }
  };

  const save = async (e) => {
    e.preventDefault();
    setError(null);
    const bad = variants.find((v) => Number(v.price) > Number(v.mrp));
    if (bad) return setError(new Error(`${bad.label || bad.sku}: the selling price cannot be more than the MRP`));
    setBusy(true);
    const list = (text, sep) => text.split(sep).map((s) => s.trim()).filter(Boolean);
    const body = {
      name: form.name.trim(),
      slug: form.slug,
      brand: form.brand.trim() || undefined,
      categoryId: form.categoryId,
      petTypes: form.petTypes,
      description: form.description.trim() || undefined,
      highlights: list(form.highlights, '\n'),
      tags: list(form.tags, ','),
      gstRate: Number(form.gstRate),
      hsn: form.hsn.trim() || undefined,
      status: form.status,
      imageFileIds: images.map((i) => i.file),
      variants: variants.map((v) => ({ sku: v.sku.trim(), label: v.label.trim(), mrpPaise: paise(v.mrp), pricePaise: paise(v.price), stock: Number(v.stock) })),
    };
    try {
      if (isNew) await api.post('/shop/seller/products', body);
      else await api.patch(`/shop/seller/products/${product._id}`, body);
      onSaved();
      ref.current.close();
    } catch (err) {
      setError(err.status === 409 && /duplicate|exists/i.test(err.message) ? new Error('Another product already uses this web address. Change the URL name.') : err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={attach} onClose={onClose} style={{ width: 'min(820px, calc(100vw - 32px))' }}>
      <form className="stack" onSubmit={save}>
        <h2>{isNew ? 'Add a product' : `Edit ${product.name}`}</h2>
        <div className="vp-grid-2">
          <label className="field">
            Product name
            <input value={form.name} onChange={setName} required minLength={2} maxLength={160} placeholder="Grain-free salmon kibble" autoFocus />
          </label>
          <label className="field">
            URL name
            <input
              value={form.slug}
              onChange={(e) => {
                setSlugTouched(true);
                setForm((f) => ({ ...f, slug: slugify(e.target.value) }));
              }}
              required
              maxLength={120}
              pattern="[a-z0-9-]+"
              title="Lowercase letters, numbers and dashes"
            />
          </label>
          <label className="field">
            Brand
            <input value={form.brand} onChange={set('brand')} maxLength={80} />
          </label>
          <label className="field">
            Category
            <select value={form.categoryId} onChange={set('categoryId')} required>
              <option value="">Choose…</option>
              {categories.map((c) => (
                <option key={c._id} value={c._id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <fieldset className="field vp-fieldset">
          <legend>For</legend>
          <div className="row">
            {Object.entries(PET_TYPES).map(([key, label]) => (
              <button
                type="button"
                key={key}
                className="vp-chip"
                aria-pressed={form.petTypes.includes(key)}
                onClick={() => setForm((f) => ({ ...f, petTypes: f.petTypes.includes(key) ? f.petTypes.filter((x) => x !== key) : [...f.petTypes, key] }))}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="field">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span>Photos ({images.length}/8)</span>
            <label className={`ov-btn ${uploading || images.length >= 8 ? 'disabled' : ''}`}>
              <ImagePlus size={15} /> {uploading ? 'Uploading…' : 'Add photos'}
              <input type="file" accept="image/*" multiple onChange={upload} hidden />
            </label>
          </div>
          {images.length ? (
            <div className="vp-photos">
              {images.map((img, i) => (
                <figure key={img.file}>
                  <img src={img.url} alt={i === 0 ? 'Main photo' : `Photo ${i + 1}`} />
                  <button type="button" className="vp-icon-btn" onClick={() => setImages((list) => list.filter((x) => x.file !== img.file))} aria-label="Remove photo">
                    <X size={14} />
                  </button>
                </figure>
              ))}
            </div>
          ) : (
            <div className="empty small">The first photo is the one shoppers see in the list.</div>
          )}
        </div>

        <div className="field">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span>Sizes and prices</span>
            <button type="button" onClick={() => setVariants((list) => [...list, blankVariant()])} disabled={variants.length >= 20}>
              <Plus size={15} /> Add size
            </button>
          </div>
          <div className="vp-variants">
            <div className="vp-variant small muted" aria-hidden="true">
              <span>SKU</span>
              <span>Size / label</span>
              <span>MRP (₹)</span>
              <span>Price (₹)</span>
              <span>Stock</span>
              <span />
            </div>
            {variants.map((v, i) => (
              <div key={v.key} className="vp-variant">
                <input value={v.sku} onChange={setVariant(v.key, 'sku')} required maxLength={60} aria-label={`SKU ${i + 1}`} placeholder="SK-1KG" />
                <input value={v.label} onChange={setVariant(v.key, 'label')} required maxLength={60} aria-label={`Size ${i + 1}`} placeholder="1 kg" />
                <input type="number" min="0" step="0.01" value={v.mrp} onChange={setVariant(v.key, 'mrp')} required aria-label={`MRP ${i + 1}`} />
                <input type="number" min="0" step="0.01" value={v.price} onChange={setVariant(v.key, 'price')} required aria-label={`Price ${i + 1}`} />
                <input type="number" min="0" max="100000" step="1" value={v.stock} onChange={setVariant(v.key, 'stock')} required aria-label={`Stock ${i + 1}`} />
                <button type="button" className="vp-icon-btn" onClick={() => setVariants((list) => list.filter((x) => x.key !== v.key))} disabled={variants.length === 1} aria-label={`Remove size ${i + 1}`}>
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>

        <label className="field">
          Description
          <textarea value={form.description} onChange={set('description')} maxLength={5000} rows={4} />
        </label>
        <div className="vp-grid-2">
          <label className="field">
            Highlights (one per line)
            <textarea value={form.highlights} onChange={set('highlights')} rows={3} placeholder={'Real salmon as the first ingredient\nNo artificial colours'} />
          </label>
          <label className="field">
            Search tags (comma-separated)
            <textarea value={form.tags} onChange={set('tags')} rows={3} placeholder="grain free, puppy, salmon" />
          </label>
          <label className="field">
            GST rate (prices include GST)
            <select value={form.gstRate} onChange={set('gstRate')}>
              {GST_RATES.map((r) => (
                <option key={r} value={r}>
                  {r}%
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            HSN code
            <input value={form.hsn} onChange={set('hsn')} maxLength={10} inputMode="numeric" />
          </label>
          <label className="field">
            Status
            <select value={form.status} onChange={set('status')}>
              <option value="active">Active: shown in the shop</option>
              <option value="draft">Draft: not shown yet</option>
              <option value="hidden">Hidden: taken off the shop</option>
            </select>
          </label>
        </div>
        <ErrorNote error={error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" onClick={() => ref.current.close()}>
            Cancel
          </button>
          <button className="primary" disabled={busy || uploading}>
            {isNew ? 'Add product' : 'Save changes'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
