import { ArrowLeft } from 'lucide-react';
import { useRef, useState } from 'react';
import { api } from '../api.js';
import { NurviaMark } from '../icons.jsx';
import { useSession } from '../session.jsx';
import { ErrorNote } from '../ui.jsx';

const toE164 = (digits) => `+91${digits}`;

// Partners sign in with their mobile number and a one-time code. A number new to Nurvia is verified
// first, then the register step (name and Terms) creates the account with the token verification
// returned; the business itself is set up next, in Onboarding.
export default function Login() {
  const { signIn } = useSession();
  const [step, setStep] = useState('phone'); // phone → code → (register)
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [terms, setTerms] = useState(false);
  const [registrationToken, setRegistrationToken] = useState(null);
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const codeInput = useRef(null);
  const valid = /^[6-9]\d{9}$/.test(phone);

  // New and registered numbers alike get a code. Resend repeats the same call.
  const requestCode = async (e) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post('/auth/otp/request', { phone: toE164(phone) });
      setDevCode(res.devCode ?? null);
      setCode('');
      setStep('code');
      setTimeout(() => codeInput.current?.focus(), 50);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const changeNumber = () => {
    setRegistrationToken(null);
    setError(null);
    setStep('phone');
  };

  // A registered number is signed in; a new one moves on to the register step.
  const verify = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post('/auth/otp/verify', { phone: toE164(phone), code });
      if (res.registrationRequired) {
        setRegistrationToken(res.registrationToken);
        setStep('register');
      } else {
        await signIn(res);
      }
    } catch (err) {
      setError(err);
      setCode('');
      codeInput.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  // The token from verification is good for 10 minutes and one use; after that the number is verified again.
  const register = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(await api.post('/auth/register', { registrationToken, name: name.trim(), acceptTerms: true }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      {step === 'phone' ? (
        <form className="card" onSubmit={requestCode}>
          <div className="row" style={{ gap: 12, marginBottom: 6 }}>
            <NurviaMark size={44} />
            <div>
              <div className="brand-name" style={{ color: 'var(--ink)' }}>nurvia</div>
              <div className="eyebrow">Partner panel</div>
            </div>
          </div>
          <h1 style={{ fontSize: 24 }}>
            Run your <em>practice</em>
          </h1>
          <p className="muted" style={{ margin: 0 }}>
            Bookings, services, reviews and payouts for vets, groomers and pet care providers.
          </p>
          <label className="field">
            Mobile number
            <div className="vp-phone">
              <span>+91</span>
              <input
                inputMode="numeric"
                autoComplete="tel-national"
                maxLength={10}
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
                placeholder="98450 00000"
                autoFocus
                required
              />
            </div>
          </label>
          <ErrorNote error={error} />
          <button className="primary" disabled={!valid || busy} style={{ minHeight: 42 }}>
            {busy ? 'Sending code…' : 'Send code'}
          </button>
        </form>
      ) : step === 'register' ? (
        <form className="card" onSubmit={register}>
          <button type="button" className="link small" style={{ alignSelf: 'flex-start' }} onClick={changeNumber}>
            <ArrowLeft size={14} /> Change number
          </button>
          <h1 style={{ fontSize: 24 }}>Create your account</h1>
          <p className="muted" style={{ margin: 0 }}>+91 {phone} is verified and new to Nurvia. Add your name to sign up; you will set up your business next.</p>
          <label className="field">
            Your name
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={120} required autoFocus />
          </label>
          <label className="row small">
            <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} style={{ minHeight: 0 }} required /> I agree to the Nurvia Terms of Service and Privacy Policy
          </label>
          <ErrorNote error={error} />
          {error?.status === 401 ? (
            <button type="button" className="primary" onClick={changeNumber} style={{ minHeight: 42 }}>
              Verify the number again
            </button>
          ) : (
            <button className="primary" disabled={!name.trim() || !terms || busy} style={{ minHeight: 42 }}>
              {busy ? 'Creating account…' : 'Create account'}
            </button>
          )}
        </form>
      ) : (
        <form className="card" onSubmit={verify}>
          <button type="button" className="link small" style={{ alignSelf: 'flex-start' }} onClick={changeNumber}>
            <ArrowLeft size={14} /> Change number
          </button>
          <h1 style={{ fontSize: 24 }}>Enter the code</h1>
          <p className="muted" style={{ margin: 0 }}>Sent to +91 {phone}.</p>
          {devCode && (
            <div className="notice small">
              Development mode: no SMS is sent. Your code is <strong className="mono">{devCode}</strong>.
            </div>
          )}
          <label className="field">
            6-digit code
            <input
              ref={codeInput}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              className="vp-otp"
              required
            />
          </label>
          <ErrorNote error={error} />
          <button className="primary" disabled={code.length !== 6 || busy} style={{ minHeight: 42 }}>
            {busy ? 'Checking…' : 'Sign in'}
          </button>
          <button type="button" className="link small" onClick={() => requestCode()} disabled={busy}>
            Resend code
          </button>
        </form>
      )}
    </div>
  );
}
