import { useState, FormEvent } from 'react';
import { ADMIN_BASE, getAdminToken } from '../utils/adminApi';
import './ForceChangePassword.css';

interface ForceChangePasswordProps {
  onPasswordChanged: () => void;
}

function ForceChangePassword({ onPasswordChanged }: ForceChangePasswordProps) {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);

    try {
      const response = await fetch(`${ADMIN_BASE}/v1/admin/auth/change-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${getAdminToken()}`,
        },
        body: JSON.stringify({ newPassword }),
      });

      if (response.ok) {
        onPasswordChanged();
      } else {
        const data = await response.json().catch(() => ({}));
        setError(data.error || 'Failed to change password');
      }
    } catch (err) {
      setError('Failed to change password. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="force-change-password-overlay" role="dialog" aria-modal="true" aria-label="Change Password">
      <div className="force-change-password-card">
        <h2 className="force-change-password-title">Change Your Password</h2>
        <p className="force-change-password-desc">
          Your password must be changed before you can continue.
        </p>
        <form onSubmit={handleSubmit}>
          <input
            type="password"
            className="force-change-password-input"
            placeholder="New Password (min 8 characters)"
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            autoFocus
            aria-label="New Password"
            disabled={loading}
          />
          <input
            type="password"
            className="force-change-password-input"
            placeholder="Confirm Password"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            aria-label="Confirm Password"
            disabled={loading}
          />
          {error && <div className="force-change-password-error">{error}</div>}
          <button
            type="submit"
            className="force-change-password-btn"
            disabled={!newPassword.trim() || !confirmPassword.trim() || loading}
          >
            {loading ? 'Changing Password...' : 'Change Password'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default ForceChangePassword;
