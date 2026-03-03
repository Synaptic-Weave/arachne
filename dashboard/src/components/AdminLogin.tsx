import { useState, FormEvent } from 'react';
import { ADMIN_BASE, setAdminToken } from '../utils/adminApi';
import ForceChangePassword from './ForceChangePassword';
import './AdminLogin.css';

interface AdminLoginProps {
  onLogin: () => void;
}

function AdminLogin({ onLogin }: AdminLoginProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [mustChangePassword, setMustChangePassword] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await fetch(`${ADMIN_BASE}/v1/admin/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      if (response.ok) {
        const data = await response.json();
        setAdminToken(data.token);
        if (data.mustChangePassword) {
          setMustChangePassword(true);
        } else {
          onLogin();
        }
      } else {
        setError('Invalid credentials');
      }
    } catch (err) {
      setError('Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  function handlePasswordChanged() {
    setMustChangePassword(false);
    onLogin();
  }

  if (mustChangePassword) {
    return <ForceChangePassword onPasswordChanged={handlePasswordChanged} />;
  }

  return (
    <div className="admin-login-overlay" role="dialog" aria-modal="true" aria-label="Admin Login">
      <div className="admin-login-card">
        <h2 className="admin-login-title">Admin Login</h2>
        <p className="admin-login-desc">
          Enter your admin credentials to access tenant management.
        </p>
        <form onSubmit={handleSubmit}>
          <input
            type="text"
            className="admin-login-input"
            placeholder="Username"
            value={username}
            onChange={e => setUsername(e.target.value)}
            autoFocus
            aria-label="Username"
            disabled={loading}
          />
          <input
            type="password"
            className="admin-login-input"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            aria-label="Password"
            disabled={loading}
          />
          {error && <div className="admin-login-error">{error}</div>}
          <button
            type="submit"
            className="admin-login-btn"
            disabled={!username.trim() || !password.trim() || loading}
          >
            {loading ? 'Logging in...' : 'Login'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default AdminLogin;
