import { useState, useEffect } from 'react';
import AdminLogin from '../components/AdminLogin';
import TenantsList from '../components/TenantsList';
import TenantDetail from '../components/TenantDetail';
import ChangePasswordModal from '../components/ChangePasswordModal';
import { getAdminToken, clearAdminToken } from '../utils/adminApi';
import './AdminPage.css';

function AdminPage() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [showChangePassword, setShowChangePassword] = useState(false);

  useEffect(() => {
    const token = getAdminToken();
    setIsLoggedIn(!!token);
  }, []);

  function handleLogin() {
    setIsLoggedIn(true);
  }

  function handleLogout() {
    clearAdminToken();
    setIsLoggedIn(false);
  }

  function handleTenantSelect(tenantId: string) {
    setSelectedTenantId(tenantId);
  }

  function handleBackToList() {
    setSelectedTenantId(null);
  }

  if (!isLoggedIn) {
    return <AdminLogin onLogin={handleLogin} />;
  }

  return (
    <div className="admin-page">
      <div className="admin-header">
        <h1>Admin Panel</h1>
        <div className="admin-header-actions">
          <button className="admin-change-password-btn" onClick={() => setShowChangePassword(true)}>
            Change Password
          </button>
          <button className="admin-logout-btn" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </div>
      <div className="admin-content">
        {selectedTenantId ? (
          <TenantDetail tenantId={selectedTenantId} onBack={handleBackToList} />
        ) : (
          <TenantsList onTenantSelect={handleTenantSelect} />
        )}
      </div>
      {showChangePassword && (
        <ChangePasswordModal onClose={() => setShowChangePassword(false)} />
      )}
    </div>
  );
}

export default AdminPage;
