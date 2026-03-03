import { useState, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import type { ApiKeyCreated, InviteInfo } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import ApiKeyReveal from '../components/ApiKeyReveal';

export default function SignupPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const inviteToken = searchParams.get('invite');
  const { setLoginData } = useAuth();

  const [tenantName, setTenantName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [signupsDisabled, setSignupsDisabled] = useState(false);
  const [newKey, setNewKey] = useState<ApiKeyCreated | null>(null);

  // Invite-mode state
  const [inviteInfo, setInviteInfo] = useState<InviteInfo | null>(null);
  const [inviteLoading, setInviteLoading] = useState(!!inviteToken);
  const [inviteError, setInviteError] = useState('');

  useEffect(() => {
    if (!inviteToken) return;
    api.getInviteInfo(inviteToken)
      .then(info => {
        if (!info.isValid) {
          setInviteError('This invite link is invalid or has expired.');
        } else {
          setInviteInfo(info);
        }
      })
      .catch(() => setInviteError('This invite link is invalid or has expired.'))
      .finally(() => setInviteLoading(false));
  }, [inviteToken]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    setSignupsDisabled(false);
    try {
      if (inviteToken) {
        // Invite signup: no org name, skip API key reveal
        const result = await api.signup({ email, password, inviteToken });
        setLoginData(result.token, result.user, null, result.tenants ?? []);
        navigate('/app/traces');
      } else {
        // Normal signup: requires org name, shows API key
        const result = await api.signup({ tenantName, email, password });
        setLoginData(result.token, result.user, null, result.tenants ?? []);
        if (result.apiKey) {
          setNewKey({
            id: '',
            name: 'Default',
            key: result.apiKey,
            keyPrefix: result.apiKey.slice(0, 12),
            status: 'active',
            createdAt: new Date().toISOString(),
            revokedAt: null,
          });
        } else {
          navigate('/app');
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Signup failed';
      setError(msg === 'signups_disabled' ? 'Signups are currently closed.' : msg);
      if (msg === 'signups_disabled') setSignupsDisabled(true);
    } finally {
      setLoading(false);
    }
  }

  if (newKey) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
        <div className="w-full max-w-md space-y-4">
          <div className="text-center">
            <p className="text-2xl font-bold text-white">⧖ Arachne</p>
            <p className="text-gray-400 mt-2 text-sm">Account created — save your API key</p>
          </div>
          <ApiKeyReveal keyData={newKey} onDismiss={() => navigate('/app')} />
        </div>
      </div>
    );
  }

  // Invite token present but still loading invite info
  if (inviteToken && inviteLoading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
        <p className="text-gray-400 animate-pulse">Validating invite…</p>
      </div>
    );
  }

  // Invite token invalid/expired
  if (inviteToken && inviteError) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
        <div className="w-full max-w-sm text-center space-y-4">
          <p className="text-2xl font-bold text-white">⧖ Arachne</p>
          <div className="bg-red-950/30 border border-red-800 rounded-xl p-6">
            <p className="text-red-400 font-medium">{inviteError}</p>
            <p className="text-gray-500 text-sm mt-2">
              Ask your team to send you a new invite link.
            </p>
          </div>
          <p className="text-sm text-gray-500">
            Want to create your own org?{' '}
            <Link to="/signup" className="text-indigo-400 hover:text-indigo-300">Sign up free</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        {/* Logo */}
        <div className="text-center">
          <Link to="/" className="text-2xl font-bold text-white">⧖ Arachne</Link>
          <p className="text-gray-400 mt-2 text-sm">
            {inviteInfo ? `Join ${inviteInfo.tenantName}` : 'Create your account'}
          </p>
        </div>

        {/* Form */}
        <form
          onSubmit={handleSubmit}
          className="bg-gray-900 border border-gray-700 rounded-xl p-6 space-y-4"
        >
          {/* Org name only for fresh signups */}
          {!inviteToken && (
            <div>
              <label className="block text-sm text-gray-400 mb-1">Organization name</label>
              <input
                type="text"
                required
                autoFocus
                value={tenantName}
                onChange={e => setTenantName(e.target.value)}
                className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-gray-100 placeholder-gray-600 focus:outline-none focus:border-indigo-500"
                placeholder="Acme Corp"
              />
            </div>
          )}

          <div>
            <label className="block text-sm text-gray-400 mb-1">Email</label>
            <input
              type="email"
              required
              autoFocus={!!inviteToken}
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-gray-100 placeholder-gray-600 focus:outline-none focus:border-indigo-500"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Password</label>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-gray-100 placeholder-gray-600 focus:outline-none focus:border-indigo-500"
              placeholder="Min. 8 characters"
            />
          </div>

          {error && (
            <p className="text-sm text-red-400 bg-red-950/30 border border-red-800 rounded-lg px-3 py-2">
              {error}{signupsDisabled && <> <a href="/#beta-signup" className="underline">Join the beta waitlist</a>.</>}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium rounded-lg transition-colors"
          >
            {loading
              ? (inviteToken ? 'Joining…' : 'Creating account…')
              : (inviteToken ? `Join ${inviteInfo?.tenantName ?? 'team'}` : 'Create account')}
          </button>
        </form>

        <p className="text-center text-sm text-gray-500">
          Already have an account?{' '}
          <Link to="/login" className="text-indigo-400 hover:text-indigo-300">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
