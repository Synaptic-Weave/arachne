import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import LandingPage from './pages/LandingPage';
import LoginPage from './pages/LoginPage';
import SignupPage from './pages/SignupPage';
import AppLayout from './components/AppLayout';
import DashboardHome from './pages/DashboardHome';
import SettingsPage from './pages/SettingsPage';
import ApiKeysPage from './pages/ApiKeysPage';
import TracesPage from './pages/TracesPage';
import AnalyticsPage from './pages/AnalyticsPage';
import MembersPage from './pages/MembersPage';
import SubtenantsPage from './pages/SubtenantsPage';
import AgentsPage from './pages/AgentsPage';
import SandboxPage from './pages/SandboxPage';
import ConversationsPage from './pages/ConversationsPage';
import KnowledgeBasesPage from './pages/KnowledgeBasesPage';
import DeploymentsPage from './pages/DeploymentsPage';
import AuthGuard from './components/AuthGuard';
import AdminProtectedRoute from './components/AdminProtectedRoute';
import AdminLoginPage from './pages/AdminLoginPage';
import AdminTenantsPage from './pages/AdminTenantsPage';
import PrivacyPage from './pages/PrivacyPage';
import AboutPage from './pages/AboutPage';

const ALLOW_SIGNUPS = import.meta.env.VITE_ALLOW_SIGNUPS === 'true';

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/signup"
          element={ALLOW_SIGNUPS ? <SignupPage /> : <Navigate to="/#beta-signup" replace />}
        />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/about" element={<AboutPage />} />
        <Route path="/app" element={<AuthGuard><AppLayout /></AuthGuard>}>
          <Route index element={<DashboardHome />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="api-keys" element={<ApiKeysPage />} />
          <Route path="traces" element={<TracesPage />} />
          <Route path="analytics" element={<AnalyticsPage />} />
          <Route path="members" element={<MembersPage />} />
          <Route path="subtenants" element={<SubtenantsPage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="sandbox" element={<SandboxPage />} />
          <Route path="conversations" element={<ConversationsPage />} />
          <Route path="knowledge-bases" element={<KnowledgeBasesPage />} />
          <Route path="deployments" element={<DeploymentsPage />} />
        </Route>
        <Route path="/admin/login" element={<AdminLoginPage />} />
        <Route path="/admin" element={<AdminProtectedRoute><Navigate to="/admin/tenants" replace /></AdminProtectedRoute>} />
        <Route path="/admin/tenants" element={<AdminProtectedRoute><AdminTenantsPage /></AdminProtectedRoute>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}

          <Route index element={<DashboardHome />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="api-keys" element={<ApiKeysPage />} />
          <Route path="traces" element={<TracesPage />} />
          <Route path="analytics" element={<AnalyticsPage />} />
          <Route path="members" element={<MembersPage />} />
          <Route path="subtenants" element={<SubtenantsPage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="sandbox" element={<SandboxPage />} />
          <Route path="conversations" element={<ConversationsPage />} />
          <Route path="knowledge-bases" element={<KnowledgeBasesPage />} />
          <Route path="deployments" element={<DeploymentsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
