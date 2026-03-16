import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { ApiKeyEntry, ApiKeyCreated, Agent } from '../lib/api';
import { getToken } from '../lib/auth';
import ApiKeyReveal from '../components/ApiKeyReveal';
import ConfirmDialog from '../components/ConfirmDialog';

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKeyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState('');
  const [revealKey, setRevealKey] = useState<ApiKeyCreated | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<{ id: string; name: string } | null>(null);
  const [revoking, setRevoking] = useState(false);

  useEffect(() => {
    fetchKeys();
    fetchAgents();
  }, []);

  function fetchKeys() {
    const token = getToken();
    if (!token) return;
    setLoading(true);
    api.listApiKeys(token)
      .then(({ apiKeys }) => setKeys(apiKeys))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }

  function fetchAgents() {
    const token = getToken();
    if (!token) return;
    setAgentsLoading(true);
    api.listAgents(token)
      .then(({ agents }) => {
        setAgents(agents);
        if (agents.length > 0) setSelectedAgentId(agents[0].id);
      })
      .catch(() => {})
      .finally(() => setAgentsLoading(false));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newKeyName.trim() || !selectedAgentId) return;
    setCreateLoading(true);
    setCreateError('');
    try {
      const token = getToken()!;
      const created = await api.createApiKey(token, { name: newKeyName.trim(), agentId: selectedAgentId });
      setRevealKey(created);
      setNewKeyName('');
      setCreating(false);
      setKeys(prev => [created, ...prev]);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create key');
    } finally {
      setCreateLoading(false);
    }
  }

  async function handleRevoke(id: string) {
    setRevoking(true);
    try {
      const token = getToken()!;
      await api.revokeApiKey(token, id);
      setKeys(prev =>
        prev.map(k => k.id === id ? { ...k, status: 'revoked', revokedAt: new Date().toISOString() } : k)
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Revoke failed');
    } finally {
      setRevoking(false);
      setConfirmRevoke(null);
    }
  }

  return (
    <div className="p-8 space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">API Keys</h1>
          <p className="text-gray-400 text-sm mt-1">
            Keys used to authenticate requests through the Arachne gateway.
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
        >
          + New key
        </button>
      </div>

      {/* One-time reveal after creation */}
      {revealKey && (
        <ApiKeyReveal keyData={revealKey} onDismiss={() => setRevealKey(null)} />
      )}

      {/* Create form */}
      {creating && (
        <form
          onSubmit={handleCreate}
          className="bg-gray-900 border border-gray-700 rounded-xl p-5 space-y-3"
        >
          <h2 className="text-sm font-semibold text-gray-200">Create new API key</h2>
          {!agentsLoading && agents.length === 0 ? (
            <p className="text-sm text-yellow-400">
              Create an agent first before generating API keys.
            </p>
          ) : (
            <div className="space-y-2">
              <select
                required
                value={selectedAgentId}
                onChange={e => setSelectedAgentId(e.target.value)}
                className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-gray-100 focus:outline-none focus:border-indigo-500 text-sm"
              >
                <option value="" disabled>Select agent…</option>
                {agents.map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              <div className="flex gap-2">
                <input
                  type="text"
                  required
                  autoFocus
                  value={newKeyName}
                  onChange={e => setNewKeyName(e.target.value)}
                  placeholder="Key name (e.g. production)"
                  className="flex-1 bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-gray-100 placeholder-gray-600 focus:outline-none focus:border-indigo-500 text-sm"
                />
                <button
                  type="submit"
                  disabled={createLoading || agents.length === 0}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  {createLoading ? 'Creating…' : 'Create'}
                </button>
                <button
                  type="button"
                  onClick={() => { setCreating(false); setCreateError(''); }}
                  className="px-3 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {agentsLoading && agents.length === 0 && (
            <div className="flex gap-2">
              <input
                type="text"
                disabled
                placeholder="Key name (e.g. production)"
                className="flex-1 bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-gray-100 placeholder-gray-600 focus:outline-none focus:border-indigo-500 text-sm opacity-50"
              />
              <button
                type="button"
                onClick={() => { setCreating(false); setCreateError(''); }}
                className="px-3 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
              >
                Cancel
              </button>
            </div>
          )}
          {createError && (
            <p className="text-sm text-red-400">{createError}</p>
          )}
        </form>
      )}

      {/* Keys table */}
      <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden">
        {loading && (
          <div className="px-6 py-8 text-gray-500 animate-pulse text-sm">Loading…</div>
        )}
        {error && (
          <div className="px-6 py-4 text-red-400 text-sm">{error}</div>
        )}
        {!loading && !error && keys.length === 0 && (
          <div className="px-6 py-10 text-center text-gray-500 text-sm">
            No API keys yet. Create one to start using the gateway.
          </div>
        )}
        {!loading && keys.length > 0 && (
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-700 text-left">
                <th className="px-4 py-3 text-left text-xs uppercase tracking-wide text-gray-500 font-medium">Name</th>
                <th className="px-4 py-3 text-left text-xs uppercase tracking-wide text-gray-500 font-medium">Agent</th>
                <th className="px-4 py-3 text-left text-xs uppercase tracking-wide text-gray-500 font-medium">Prefix</th>
                <th className="px-4 py-3 text-left text-xs uppercase tracking-wide text-gray-500 font-medium">Status</th>
                <th className="px-4 py-3 text-left text-xs uppercase tracking-wide text-gray-500 font-medium">Created</th>
                <th className="px-4 py-3 text-right text-xs uppercase tracking-wide text-gray-500 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {keys.map(key => (
                <tr key={key.id} className="hover:bg-gray-800/50 transition-colors">
                  <td className="px-4 py-3 text-gray-100">
                    <span className={key.status === 'revoked' ? 'line-through text-gray-500' : ''}>
                      {key.name}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">
                    {key.agentName
                      ? key.agentName
                      : key.agentId
                        ? agents.find(a => a.id === key.agentId)?.name ?? <span className="text-gray-600">—</span>
                        : <span className="text-gray-600">—</span>
                    }
                  </td>
                  <td className="px-4 py-3 font-mono text-gray-400 text-xs">
                    {key.keyPrefix}…
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                        key.status === 'active'
                          ? 'bg-green-900/50 text-green-400'
                          : 'bg-gray-800 text-gray-500'
                      }`}
                    >
                      {key.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-400">
                    {new Date(key.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {key.status === 'active' && (
                      <button
                        onClick={() => setConfirmRevoke({ id: key.id, name: key.name })}
                        className="text-xs text-red-400 hover:text-red-300 transition-colors"
                      >
                        Revoke
                      </button>
                    )}
                    {key.status === 'revoked' && key.revokedAt && (
                      <span className="text-xs text-gray-600">
                        Revoked {new Date(key.revokedAt).toLocaleDateString()}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmRevoke !== null}
        onClose={() => setConfirmRevoke(null)}
        onConfirm={() => { if (confirmRevoke) handleRevoke(confirmRevoke.id); }}
        title="Revoke API key"
        description={confirmRevoke ? `Revoke API key "${confirmRevoke.name}"? This cannot be undone.` : ''}
        confirmLabel="Revoke"
        confirmVariant="danger"
        loading={revoking}
      />
    </div>
  );
}
