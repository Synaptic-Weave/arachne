import { useState, FormEvent } from 'react';
import { ADMIN_BASE, getAdminToken } from '../utils/adminApi';
import './ChangePasswordModal.css';

interface ChangePasswordModalProps {
  onClose: () => void;
}

function ChangePasswordModal({ onClose }: ChangePasswordModalProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

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
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      if (response.ok) {
        setSuccess(true);
        setTimeout(() => {
          onClose();
        }, 1500);
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

  if (success) {
    return (
      <div className="change-password-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Password Changed">
        <div className="change-password-card" onClick={e => e.stopPropagation()}>
          <div className="change-password-success">
            Password changed successfully!
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="change-password-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Change Password">
      <div className="change-password-card" onClick={e => e.stopPropagation()}>
        <div className="change-password-header">
          <h2 className="change-password-title">Change Password</h2>
          <button className="change-password-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <input
            type="password"
            className="change-password-input"
            placeholder="Current Password"
            value={currentPassword}
            onChange={e => setCurrentPassword(e.target.value)}
            autoFocus
            aria-label="Current Password"
            disabled={loading}
          />
          <input
            type="password"
            className="change-password-input"
            placeholder="New Password (min 8 characters)"
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            aria-label="New Password"
            disabled={loading}
          />
          <input
            type="password"
            className="change-password-input"
            placeholder="Confirm New Password"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            aria-label="Confirm New Password"
            disabled={loading}
          />
          {error && <div className="change-password-error">{error}</div>}
          <button
            type="submit"
            className="change-password-btn"
            disabled={!currentPassword.trim() || !newPassword.trim() || !confirmPassword.trim() || loading}
          >
            {loading ? 'Changing Password...' : 'Change Password'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default ChangePasswordModal;
