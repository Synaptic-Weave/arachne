import { Navigate } from 'react-router-dom';

interface Props {
  children: React.ReactNode;
}

export default function AdminProtectedRoute({ children }: Props) {
  const token = localStorage.getItem('loom_admin_token');
  if (!token) return <Navigate to="/admin/login" replace />;
  return <>{children}</>;
}
