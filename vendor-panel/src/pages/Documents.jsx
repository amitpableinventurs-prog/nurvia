import { FileUp, X } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api.js';
import { ApprovalSteps } from '../approval.jsx';
import { useSession } from '../session.jsx';
import { Badge, ErrorNote, LicensePill, formatDate } from '../ui.jsx';

const DOC_TYPES = {
  shop_license: 'Trade licence (BBMP / municipal)',
  vet_license: 'Veterinary council registration',
  gst_certificate: 'GST certificate',
  pan: 'PAN card',
  aadhaar: 'Aadhaar (owner)',
  bank_proof: 'Cancelled cheque / bank proof',
  other: 'Other',
};
const LICENSES = ['shop_license', 'vet_license'];

// KYC documents are private: only the partner and Nurvia's vendor reviewers can open them.
export default function Documents() {
  const { session, refreshVendor } = useSession();
  const v = session.vendor;
  const kyc = v.kyc ?? { status: 'not_submitted' };
  const locked = kyc.status === 'approved';
  // While the team is reviewing, documents are shown read-only unless the partner chooses to replace them.
  const [editing, setEditing] = useState(false);
  const underReview = kyc.status === 'submitted' && !editing;

  const [gstin, setGstin] = useState(kyc.gstin ?? '');
  const [pan, setPan] = useState(kyc.pan ?? '');
  // Resubmitting replaces the whole set, so the current documents start in the list.
  const [docs, setDocs] = useState(() => (kyc.documents ?? []).map((d) => ({ type: d.type, fileId: d.file, name: d.name })));
  const [type, setType] = useState('shop_license');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const upload = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const stored = await api.upload(file, 'vendor_kyc');
      setDocs((d) => [...d, { type, fileId: stored._id, name: stored.originalName }]);
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
    try {
      await api.post('/vendors/me/kyc', {
        ...(gstin.trim() && { gstin: gstin.trim().toUpperCase() }),
        ...(pan.trim() && { pan: pan.trim().toUpperCase() }),
        documents: docs.map(({ type: t, fileId }) => ({ type: t, fileId })),
      });
      await refreshVendor();
      setDone(true);
      setEditing(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const hasLicense = docs.some((d) => LICENSES.includes(d.type));

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>KYC & licence</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>Nurvia verifies every partner before they go live. Reviews usually take under 24 hours.</p>
        </div>
      </div>

      <ApprovalSteps vendor={v} />

      <section className="card">
        <dl className="kv">
          <dt>KYC</dt>
          <dd>
            <Badge value={kyc.status} />
          </dd>
          <dt>Trade licence</dt>
          <dd>
            <LicensePill status={v.licenseStatus} />
            {v.licenseStatus === 'manual_review' && <span className="small muted"> · the Nurvia team checks it against the issuing authority</span>}
            {v.licenseStatus === 'failed' && kyc.licenseCheck?.note && <div className="small" style={{ color: 'var(--critical)' }}>{kyc.licenseCheck.note}</div>}
          </dd>
          <dt>Submitted</dt>
          <dd>{formatDate(kyc.submittedAt)}</dd>
          {kyc.reviewedAt && (
            <>
              <dt>Reviewed</dt>
              <dd>{formatDate(kyc.reviewedAt)}</dd>
            </>
          )}
          {kyc.rejectionReason && (
            <>
              <dt>What to fix</dt>
              <dd style={{ color: 'var(--critical)' }}>{kyc.rejectionReason}</dd>
            </>
          )}
        </dl>
      </section>

      {locked || underReview ? (
        <section className="card">
          <div className="card-head">
            <h2>Your documents</h2>
            {underReview && (
              <button onClick={() => setEditing(true)} title="Replacing documents sends your application to the back of the review queue">
                Change documents
              </button>
            )}
          </div>
          <ul>
            {(kyc.documents ?? []).map((d) => (
              <li key={d.file}>
                <button className="link" onClick={() => api.openFile(d.file).catch((err) => setError(err))}>
                  {DOC_TYPES[d.type]}
                </button>{' '}
                <span className="small muted">{d.name}</span>
              </li>
            ))}
          </ul>
          {underReview ? (
            <p className="small muted">These are with the Nurvia team now. Nothing else is needed from you; you will get a notification when they decide.</p>
          ) : (
            <p className="small muted">Your KYC is approved. To change these documents, contact Nurvia partner support.</p>
          )}
          <ErrorNote error={error} />
        </section>
      ) : (
        <form className="card stack" onSubmit={submit}>
          <h2 style={{ margin: 0 }}>{kyc.status === 'not_submitted' ? 'Submit your documents' : 'Update and resubmit'}</h2>
          <div className="vp-grid-2">
            <label className="field">
              GSTIN (if registered)
              <input value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} maxLength={15} placeholder="29ABCDE1234F1Z5" className="mono" />
            </label>
            <label className="field">
              PAN
              <input value={pan} onChange={(e) => setPan(e.target.value.toUpperCase())} maxLength={10} placeholder="ABCDE1234F" className="mono" />
            </label>
          </div>

          <div>
            <h3 style={{ marginBottom: 8 }}>Documents</h3>
            {docs.length ? (
              <ul className="vp-docs">
                {docs.map((d, i) => (
                  <li key={d.fileId}>
                    <span>
                      <strong>{DOC_TYPES[d.type]}</strong> <span className="small muted">{d.name}</span>
                    </span>
                    <button type="button" className="vp-icon-btn" onClick={() => setDocs((list) => list.filter((_, j) => j !== i))} aria-label={`Remove ${DOC_TYPES[d.type]}`}>
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small muted">No documents added yet.</p>
            )}
            <div className="row" style={{ marginTop: 10 }}>
              <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Document type">
                {Object.entries(DOC_TYPES).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
              <label className={`ov-btn ${uploading ? 'disabled' : ''}`} style={{ cursor: 'pointer' }}>
                <FileUp size={15} /> {uploading ? 'Uploading…' : 'Upload PDF or photo'}
                <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={upload} hidden disabled={uploading} />
              </label>
            </div>
          </div>
          {!hasLicense && (
            <div className="notice small">
              Add your trade licence (or veterinary council registration for clinics). Applications without one wait longer, because the Nurvia team has to request it.
            </div>
          )}
          <ErrorNote error={error} />
          {done && <div className="notice small">Submitted. We will notify you as soon as the review is done.</div>}
          <button className="primary" disabled={busy || !docs.length} style={{ alignSelf: 'flex-start' }}>
            {busy ? 'Submitting…' : 'Submit for review'}
          </button>
        </form>
      )}
    </div>
  );
}
