import { useState, useEffect } from 'react';
import { getBetaSignups, approveBetaSignup, type AdminBetaSignup } from '../utils/adminApi';
import './BetaSignupsPage.css';

const PORTAL_URL = import.meta.env.VITE_PORTAL_URL || window.location.origin;

function BetaSignupsPage() {
  const [signups, setSignups] = useState<AdminBetaSignup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    loadSignups();
  }, []);

  async function loadSignups() {
    try {
      setLoading(true);
      setError(null);
      const data = await getBetaSignups();
      setSignups(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load beta signups');
    } finally {
      setLoading(false);
    }
  }

  async function handleApprove(id: string) {
    try {
      setApprovingId(id);
      setError(null);
      const updated = await approveBetaSignup(id);
      // Update the signup in the list
      setSignups(prev => prev.map(s => s.id === id ? updated : s));
    } catch (err: any) {
      setError(err.message || 'Failed to approve signup');
    } finally {
      setApprovingId(null);
    }
  }

  function getStatusBadgeClass(status: string) {
    switch (status) {
      case 'pending': return 'status-pending';
      case 'approved': return 'status-approved';
      case 'used': return 'status-used';
      default: return '';
    }
  }

  function getSignupLink(inviteCode: string): string {
    return `${PORTAL_URL}/signup?invite=${inviteCode}`;
  }

  async function copyLink(signup: AdminBetaSignup) {
    if (!signup.inviteCode) return;
    const link = getSignupLink(signup.inviteCode);
    try {
      await navigator.clipboard.writeText(link);
      setCopiedId(signup.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error('Failed to copy link:', err);
    }
  }

  if (loading) {
    return (
      <div className="beta-signups-page">
        <div className="loading">Loading beta signups...</div>
      </div>
    );
  }

  return (
    <div className="beta-signups-page">
      <h1>Beta Signups</h1>

      {error && (
        <div className="error-message">{error}</div>
      )}

      {signups.length === 0 ? (
        <div className="empty-state">
          No beta signups yet
        </div>
      ) : (
        <div className="signups-table-container">
          <table className="signups-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Status</th>
                <th>Submitted</th>
                <th>Signup Link</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {signups.map((signup) => (
                <tr key={signup.id}>
                  <td>{signup.email}</td>
                  <td>{signup.name || '—'}</td>
                  <td>
                    <span className={`status-badge ${getStatusBadgeClass(signup.status)}`}>
                      {signup.status}
                    </span>
                  </td>
                  <td>{new Date(signup.createdAt).toLocaleDateString()}</td>
                  <td>
                    {signup.inviteCode ? (
                      <div className="link-cell">
                        <a
                          href={getSignupLink(signup.inviteCode)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="signup-link"
                        >
                          {getSignupLink(signup.inviteCode)}
                        </a>
                        <button
                          className="copy-btn"
                          onClick={() => copyLink(signup)}
                          title="Copy link"
                        >
                          {copiedId === signup.id ? '✓' : '📋'}
                        </button>
                      </div>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    {signup.status === 'pending' && (
                      <button
                        className="approve-btn"
                        onClick={() => handleApprove(signup.id)}
                        disabled={approvingId === signup.id}
                      >
                        {approvingId === signup.id ? 'Approving...' : 'Approve'}
                      </button>
                    )}
                    {signup.status === 'approved' && !signup.inviteUsedAt && (
                      <span className="status-text">Awaiting signup</span>
                    )}
                    {signup.status === 'used' && (
                      <span className="status-text">Completed</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default BetaSignupsPage;
