import { useState } from 'react';
import { api } from '../api.js';
import { useSession } from '../session.jsx';
import { ErrorNote, Pager, ago, useApi } from '../ui.jsx';
import { useFilters } from '../useFilters.js';

export default function Reviews() {
  const { session } = useSession();
  const [filters, setFilter] = useFilters({ unreplied: 'true' });
  const { data, error, reload } = useApi('/vendors/me/reviews', { ...filters, limit: 20 });
  const { ratingAvg, ratingCount } = session.vendor;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Reviews</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            {ratingCount ? `${ratingAvg.toFixed(1)}★ from ${ratingCount} review${ratingCount === 1 ? '' : 's'}. ` : ''}A short, kind reply shows future customers you care.
          </p>
        </div>
        <div className="segmented" role="group" aria-label="Filter">
          <button aria-pressed={filters.unreplied === 'true'} onClick={() => setFilter('unreplied', 'true')}>
            Needs a reply
          </button>
          <button aria-pressed={filters.unreplied !== 'true'} onClick={() => setFilter('unreplied', 'false')}>
            All
          </button>
        </div>
      </div>
      <ErrorNote error={error} />
      <div className="stack">
        {data?.items.length === 0 && <div className="card empty">{filters.unreplied === 'true' ? 'You have replied to every review.' : 'No reviews yet.'}</div>}
        {data?.items.map((r) => (
          <ReviewCard key={r._id} review={r} onReplied={reload} />
        ))}
      </div>
      <Pager data={data} onPage={(p) => setFilter('page', p)} />
    </div>
  );
}

function ReviewCard({ review: r, onReplied }) {
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const reply = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/reviews/${r._id}/reply`, { text: text.trim() });
      setEditing(false);
      onReplied();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="vp-stars" aria-label={`${r.rating} out of 5`}>
          {'★'.repeat(r.rating)}
          <span>{'★'.repeat(5 - r.rating)}</span>
        </div>
        <span className="small muted">
          {r.author?.name ?? 'Customer'} · {ago(r.createdAt)}
        </span>
      </div>
      <p style={{ margin: '8px 0' }}>{r.text || <span className="muted">Rated without a comment.</span>}</p>
      {r.vendorReply?.text && !editing ? (
        <div className="vp-reply">
          <div className="small muted">Your reply · {ago(r.vendorReply.at)}</div>
          {r.vendorReply.text}
          <button
            className="link small"
            style={{ display: 'block', marginTop: 6 }}
            onClick={() => {
              setText(r.vendorReply.text);
              setEditing(true);
            }}
          >
            Edit reply
          </button>
        </div>
      ) : (
        <form className="stack" style={{ gap: 8 }} onSubmit={reply}>
          <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} placeholder="Thank the customer, or address their concern" required aria-label="Reply" />
          <ErrorNote error={error} />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            {editing && (
              <button type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
            <button className="primary" disabled={busy || !text.trim()}>
              {editing ? 'Update reply' : 'Post reply'}
            </button>
          </div>
        </form>
      )}
    </article>
  );
}
