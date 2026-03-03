import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

interface Tenant {
  id: string;
  name: string;
  status: string;
  created_at: string;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function AdminTenantsPage() {
  const navigate = useNavigate();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  // Inline edit
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [saving, setSaving] = useState(false);

  function getToken() {
    return localStorage.getItem('loom_admin_token') ?? '';
  }

  function logout() {
    localStorage.removeItem('loom_admin_token');
    navigate('/admin/login');
  }

  const fetchTenants = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${BASE_URL}/v1/admin/tenants`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (res.status === 401) { logout(); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { tenants: Tenant[] };
      setTenants(data.tenants);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tenants');
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { fetchTenants(); }, [fetchTenants]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const res = await fetch(`${BASE_URL}/v1/admin/tenants`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify({ name: newName }),
      });
      if (res.status === 401) { logout(); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setNewName('');
      setShowCreate(false);
      await fetchTenants();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create tenant');
    } finally {
      setCreating(false);
    }
  }

  async function handleSaveEdit(id: string) {
    setSaving(true);
    try {
      const res = await fetch(`${BASE_URL}/v1/admin/tenants/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify({ name: editName }),
      });
      if (res.status === 401) { logout(); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEditingId(null);
      await fetchTenants();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update tenant');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!window.confirm(`Delete tenant "${name}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`${BASE_URL}/v1/admin/tenants/${id}?confirm=true`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (res.status === 401) { logout(); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchTenants();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete tenant');
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold text-white">⧖ Arachne</span>
          <span className="text-gray-600">/</span>
          <span className="text-gray-300 text-sm font-medium">Admin</span>
        </div>
        <button
          onClick={logout}
          className="text-sm text-gray-400 hover:text-white transition-colors"
        >
          Sign out
        </button>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">Tenants</h1>
            <p className="text-gray-400 text-sm mt-1">Manage all tenants in the system</p>
          </div>
          <button
            onClick={() => { setShowCreate(true); setNewName(''); }}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            + Create Tenant
          </button>
        </div>

        {error && (
          <p className="text-sm text-red-400 bg-red-950/30 border border-red-800 rounded-lg px-4 py-3">
            {error}
          </p>
        )}

        {/* Create form */}
        {showCreate && (
          <form
            onSubmit={handleCreate}
            className="bg-gray-900 border border-gray-700 rounded-xl p-4 flex gap-3 items-end"
          >
            <div className="flex-1">
              <label className="block text-sm text-gray-400 mb-1">Tenant name</label>
              <input
                type="text"
                required
                autoFocus
                value={newName}
                onChange={e => setNewName(e.target.value)}
                className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-gray-100 placeholder-gray-600 focus:outline-none focus:border-indigo-500 text-sm"
                placeholder="e.g. acme-corp"
              />
            </div>
            <button
              type="submit"
              disabled={creating}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {creating ? 'Creating…' : 'Create'}
            </button>
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium rounded-lg transition-colors"
            >
              Cancel
            </button>
          </form>
        )}

        {/* Tenants table */}
        <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-700 text-left">
                  <th className="px-4 py-3 text-xs uppercase tracking-wide text-gray-500 font-medium">ID</th>
                  <th className="px-4 py-3 text-xs uppercase tracking-wide text-gray-500 font-medium">Name</th>
                  <th className="px-4 py-3 text-xs uppercase tracking-wide text-gray-500 font-medium">Status</th>
                  <th className="px-4 py-3 text-xs uppercase tracking-wide text-gray-500 font-medium">Created</th>
                  <th className="px-4 py-3 text-xs uppercase tracking-wide text-gray-500 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  Array.from({ length: 5 }, (_, i) => (
                    <tr key={i} className="border-b border-gray-800 animate-pulse">
                      {Array.from({ length: 5 }, (_, j) => (
                        <td key={j} className="px-4 py-3">
                          <div className="h-4 bg-gray-800 rounded w-3/4" />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : tenants.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center text-gray-500">
                      No tenants yet. Create one to get started.
                    </td>
                  </tr>
                ) : (
                  tenants.map(tenant => (
                    <tr key={tenant.id} className="border-b border-gray-800 hover:bg-gray-800/50 transition-colors">
                      <td className="px-4 py-3 text-gray-400 font-mono text-xs">{tenant.id}</td>
                      <td className="px-4 py-3">
                        {editingId === tenant.id ? (
                          <div className="flex gap-2 items-center">
                            <input
                              type="text"
                              autoFocus
                              value={editName}
                              onChange={e => setEditName(e.target.value)}
                              className="bg-gray-950 border border-indigo-500 rounded px-2 py-1 text-gray-100 text-sm focus:outline-none"
                            />
                            <button
                              onClick={() => handleSaveEdit(tenant.id)}
                              disabled={saving}
                              className="text-xs px-2 py-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded transition-colors"
                            >
                              {saving ? '…' : 'Save'}
                            </button>
                            <button
                              onClick={() => setEditingId(null)}
                              className="text-xs px-2 py-1 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <span
                            className="text-gray-200 cursor-pointer hover:text-indigo-300 transition-colors"
                            onClick={() => { setEditingId(tenant.id); setEditName(tenant.name); }}
                            title="Click to edit"
                          >
                            {tenant.name}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                          tenant.status === 'active'
                            ? 'bg-green-900 text-green-300'
                            : 'bg-gray-700 text-gray-400'
                        }`}>
                          {tenant.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs">{formatDate(tenant.created_at)}</td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => handleDelete(tenant.id, tenant.name)}
                          className="text-xs text-red-400 hover:text-red-300 transition-colors"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  );
}
