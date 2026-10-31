import { useState } from 'react';
import { api } from '../api.js';
import { ErrorNote, Pager, Table, formatDate, useApi, useConfirm } from '../ui.jsx';
import { useFilters } from '../useFilters.js';

const AUDIENCES = { all: 'Everyone', pet_parents: 'Pet parents', vendors: 'Vendors' };

export default function Announcements() {
  const [filters, setFilter] = useFilters();
  const { data, error, reload } = useApi('/admin/announcements', filters);
  const [form, setForm] = useState({ title: '', body: '', audience: 'all' });
  const [confirm, dialog] = useConfirm();
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const send = (e) => {
    e.preventDefault();
    confirm({
      title: `Send to ${AUDIENCES[form.audience].toLowerCase()}?`,
      message: 'Every matching user gets an in-app notification and a push notification. This cannot be undone.',
      confirmLabel: 'Send',
      onConfirm: async () => {
        await api.post('/admin/announcements', form);
        setForm({ title: '', body: '', audience: 'all' });
        reload();
      },
    });
  };

  return (
    <div className="stack">
      {dialog}
      <div className="page-head">
        <h1>Announcements</h1>
      </div>
      <form className="card stack" onSubmit={send} style={{ maxWidth: 640 }}>
        <h2>New announcement</h2>
        <label className="field">
          Title
          <input value={form.title} onChange={set('title')} required minLength={3} maxLength={120} />
        </label>
        <label className="field">
          Message
          <textarea value={form.body} onChange={set('body')} required minLength={3} maxLength={2000} />
        </label>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <label className="row small">
            Audience
            <select value={form.audience} onChange={set('audience')}>
              {Object.entries(AUDIENCES).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <button className="primary">Send…</button>
        </div>
      </form>
      <ErrorNote error={error} />
      <section className="card">
        <h2>Sent</h2>
        <Table
          rows={data?.items}
          empty="No announcements sent yet"
          columns={[
            { label: 'Announcement', render: (a) => <><strong>{a.title}</strong><div className="small muted">{a.body}</div></> },
            { label: 'Audience', render: (a) => AUDIENCES[a.audience] },
            { label: 'Recipients', num: true, render: (a) => a.recipientCount?.toLocaleString('en-IN') ?? '—' },
            { label: 'Sent by', render: (a) => a.sentBy?.name ?? '—' },
            { label: 'When', render: (a) => formatDate(a.createdAt) },
          ]}
        />
        <Pager data={data} onPage={(p) => setFilter('page', p)} />
      </section>
    </div>
  );
}
