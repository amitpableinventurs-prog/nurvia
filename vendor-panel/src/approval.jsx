import { Check, Circle, Clock, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { formatDate } from './ui.jsx';

const REVIEW_HOURS = 24;

// Register → submit documents → Nurvia review → live, with where the partner is right now and what
// happens next. Each step is done, current (waiting on someone), blocked (needs the partner) or todo.
export function approvalSteps(vendor) {
  const kyc = vendor.kyc ?? { status: 'not_submitted' };
  const live = vendor.status === 'active';
  const sentBack = vendor.status === 'rejected' || kyc.status === 'rejected';
  const submitted = ['submitted', 'approved'].includes(kyc.status);
  const due = kyc.submittedAt && new Date(new Date(kyc.submittedAt).getTime() + REVIEW_HOURS * 3_600_000);

  return [
    { key: 'register', title: 'Business registered', state: 'done', detail: formatDate(vendor.createdAt) },
    {
      key: 'documents',
      title: 'KYC documents and licence',
      state: submitted ? 'done' : sentBack ? 'blocked' : 'current',
      detail: submitted ? `Submitted ${formatDate(kyc.submittedAt)}` : sentBack ? 'Fix what the team asked for and submit again' : 'Upload your documents to start the review',
      action: !submitted && { to: '/documents', label: sentBack ? 'Update documents' : 'Upload documents' },
    },
    {
      key: 'review',
      title: 'Review by the Nurvia team',
      state: live || kyc.status === 'approved' ? 'done' : sentBack ? 'failed' : submitted ? 'current' : 'todo',
      detail:
        live || kyc.status === 'approved'
          ? `Approved ${formatDate(kyc.reviewedAt)}`
          : sentBack
            ? `Changes requested${kyc.rejectionReason ? `: ${kyc.rejectionReason}` : ''}`
            : submitted
              ? due < new Date()
                ? 'Taking longer than the usual 24 hours. The team reviews the oldest applications first, so yours is near the front.'
                : `They check your documents and licence. Decision expected by ${formatDate(due)}.`
              : 'Starts when you submit your documents',
    },
    {
      key: 'live',
      title: 'Live on Nurvia',
      state: live ? 'done' : 'todo',
      detail: live ? 'Customers can find and book you' : 'Customers can find and book you once approved. Set up services and hours meanwhile.',
      action: !live && !sentBack && { to: '/services', label: 'Add services' },
    },
  ];
}

const ICONS = { done: Check, current: Clock, failed: X, blocked: Circle, todo: Circle };

export function ApprovalSteps({ vendor, compact = false }) {
  if (vendor.status === 'suspended') return null;
  const steps = approvalSteps(vendor);
  return (
    <ol className={`vp-steps ${compact ? 'compact' : ''}`} aria-label="Approval progress">
      {steps.map((s, i) => {
        const Icon = ICONS[s.state];
        return (
          <li key={s.key} className={s.state} aria-current={['current', 'blocked', 'failed'].includes(s.state) ? 'step' : undefined}>
            <span className="vp-step-dot">
              <Icon size={14} strokeWidth={3} />
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="vp-step-title">
                <span className="muted small">Step {i + 1}</span> {s.title}
              </div>
              <div className="small muted">{s.detail}</div>
              {s.action && !compact && (
                <Link to={s.action.to} className="small">
                  {s.action.label} →
                </Link>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
