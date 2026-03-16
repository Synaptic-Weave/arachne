import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import type { Member, Invite } from '../lib/api';
import { getToken } from '../lib/auth';
import { useAuth } from '../context/AuthContext';
import ConfirmDialog from '../components/ConfirmDialog';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function MembersPage() {
  const { currentRole, user } = useAuth();
  const isOwner = currentRole === 'owner';

  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(true);
  const [loadingInvites, setLoadingInvites] = useState(true);
  const [error, setError] = useState('');

  // Create invite form state
  const [showCreateInvite, setShowCreateInvite] = useState(false);
  const [maxUses, setMaxUses] = useState('');
  const [expiresInHours, setExpiresInHours] = useState('168');
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [newInviteUrl, setNewInviteUrl] = useState('');
  const [copyFeedback, setCopyFeedback] = useState(false);

  // Per-row action states
  const [roleChanging, setRoleChanging] = useState<Record<string, boolean>>({});
  const [removing, setRemoving] = useState<Record<string, boolean>>({});
  const [revoking, setRevoking] = useState<Record<string, boolean>>({});
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const token = getToken()!;

  const loadMembers = useCallback(async () => {
    try {
      const { members } = await api.listMembers(token);
      setMembers(members);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load members');
    } finally {
      setLoadingMembers(false);
    }
  }, [token]);

  const loadInvites = useCallback(async () => {
    if (!isOwner) { setLoadingInvites(false); return; }
    try {
      const { invites } = await api.listInvites(token);
      setInvites(invites);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load invites');
    } finally {
      setLoadingInvites(false);
    }
  }, [token, isOwner]);

  useEffect(() => { loadMembers(); }, [loadMembers]);
  useEffect(() => { loadInvites(); }, [loadInvites]);

  async function handleRoleChange(memberId: string, newRole: string) {
    setRoleChanging(s => ({ ...s, [memberId]: true }));
    try {
      await api.updateMemberRole(token, memberId, { role: newRole });
      await loadMembers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update role');
    } finally {
      setRoleChanging(s => ({ ...s, [memberId]: false }));
    }
  }

  async function handleRemove(memberId: string) {
    setRemoving(s => ({ ...s, [memberId]: true }));
    try {
      await api.removeMember(token, memberId);
      await loadMembers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove member');
    } finally {
      setRemoving(s => ({ ...s, [memberId]: false }));
      setConfirmRemove(null);
    }
  }

  async function handleCreateInvite(e: React.FormEvent) {
    e.preventDefault();
    setCreatingInvite(true);
    try {
      const body: { maxUses?: number; expiresInHours?: number } = {
        expiresInHours: parseInt(expiresInHours, 10) || 168,
      };
      if (maxUses.trim()) body.maxUses = parseInt(maxUses, 10);
      const invite = await api.createInvite(token, body);
      setNewInviteUrl(invite.inviteUrl);
      await loadInvites();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create invite');
    } finally {
      setCreatingInvite(false);
    }
  }

  async function handleRevoke(inviteId: string) {
    setRevoking(s => ({ ...s, [inviteId]: true }));
    try {
      await api.revokeInvite(token, inviteId);
      await loadInvites();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke invite');
    } finally {
      setRevoking(s => ({ ...s, [inviteId]: false }));
    }
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for browsers that block clipboard
      const el = document.createElement('textarea');
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    setCopyFeedback(true);
    setTimeout(() => setCopyFeedback(false), 2000);
  }

  const ownerCount = members.filter(m => m.role === 'owner').length;
  const activeInvites = invites.filter(i => i.isActive);
  const revokedInvites = invites.filter(i => !i.isActive);

  if (!isOwner && currentRole !== null) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-bold text-white mb-2">Members</h1>
        <p className="text-gray-400">You don't have permission to manage members.</p>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-4xl space-y-10">
      <h1 className="text-2xl font-bold text-white">Members & Invites</h1>

      {error && (
        <div className="bg-red-950/30 border border-red-800 rounded-lg px-4 py-3 text-red-400 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-3 text-red-600 hover:text-red-400">✕</button>
        </div>
      )}

      {/* ── Members Section ── */}
      <section>
        <h2 className="text-lg font-semibold text-gray-100 mb-4">Members</h2>
        {loadingMembers ? (
          <p className="text-gray-500 animate-pulse">Loading…</p>
        ) : (
          <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-700 text-left">
                  <th className="px-4 py-3 text-left text-xs uppercase tracking-wide text-gray-500 font-medium">Email</th>
                  <th className="px-4 py-3 text-left text-xs uppercase tracking-wide text-gray-500 font-medium">Role</th>
                  <th className="px-4 py-3 text-left text-xs uppercase tracking-wide text-gray-500 font-medium">Joined</th>
                  {isOwner && <th className="px-4 py-3 text-left text-xs uppercase tracking-wide text-gray-500 font-medium">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {members.map(member => {
                  const isSelf = member.id === user?.id;
                  const isLastOwner = member.role === 'owner' && ownerCount === 1;
                  return (
                    <tr
                      key={member.id}
                      className={`border-b border-gray-800 last:border-0 ${isSelf ? 'bg-gray-800/40' : ''}`}
                    >
                      <td className="px-4 py-3 text-gray-100">
                        {member.email}
                        {isSelf && <span className="ml-2 text-xs text-gray-500">(you)</span>}
                      </td>
                      <td className="px-4 py-3">
                        {isOwner && !isSelf && !isLastOwner ? (
                          <select
                            value={member.role}
                            disabled={roleChanging[member.id]}
                            onChange={e => handleRoleChange(member.id, e.target.value)}
                            aria-label={`Role for ${member.email}`}
                            className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-gray-200 text-xs
                                       focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                          >
                            <option value="owner">Owner</option>
                            <option value="member">Member</option>
                          </select>
                        ) : (
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium
                            ${member.role === 'owner' ? 'bg-indigo-900/50 text-indigo-300' : 'bg-gray-700 text-gray-300'}`}>
                            {member.role}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-400">{formatDate(member.joinedAt)}</td>
                      {isOwner && (
                        <td className="px-4 py-3">
                          <button
                            onClick={() => setConfirmRemove(member.id)}
                            disabled={isSelf || isLastOwner || removing[member.id]}
                            title={isSelf ? "Can't remove yourself" : isLastOwner ? "Can't remove last owner" : 'Remove member'}
                            className="text-xs text-red-500 hover:text-red-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                          >
                            Remove
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </div>
        )}
      </section>

      {/* ── Invites Section (owner only) ── */}
      {isOwner && (
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-100">Invite Links</h2>
            {!showCreateInvite && (
              <button
                onClick={() => { setShowCreateInvite(true); setNewInviteUrl(''); }}
                className="text-sm bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-lg transition-colors"
              >
                + Create Invite
              </button>
            )}
          </div>

          {/* Create invite form */}
          {showCreateInvite && (
            <div className="bg-gray-900 border border-gray-700 rounded-xl p-5 mb-5 space-y-4">
              {newInviteUrl ? (
                <div className="space-y-3">
                  <p className="text-sm text-green-400 font-medium">✓ Invite link created</p>
                  <div className="flex gap-2 items-center">
                    <input
                      readOnly
                      value={newInviteUrl}
                      className="flex-1 bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-gray-300 text-sm font-mono"
                    />
                    <button
                      onClick={() => copyToClipboard(newInviteUrl)}
                      className="px-3 py-2 text-sm bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-lg transition-colors whitespace-nowrap"
                    >
                      {copyFeedback ? '✓ Copied' : 'Copy'}
                    </button>
                  </div>
                  <button
                    onClick={() => { setShowCreateInvite(false); setNewInviteUrl(''); }}
                    className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
                  >
                    Done
                  </button>
                </div>
              ) : (
                <form onSubmit={handleCreateInvite} className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm text-gray-400 mb-1">Max uses <span className="text-gray-600">(blank = unlimited)</span></label>
                      <input
                        type="number"
                        min="1"
                        value={maxUses}
                        onChange={e => setMaxUses(e.target.value)}
                        className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-gray-100 placeholder-gray-600 focus:outline-none focus:border-indigo-500"
                        placeholder="∞"
                      />
                    </div>
                    <div>
                      <label className="block text-sm text-gray-400 mb-1">Expires in</label>
                      <select
                        value={expiresInHours}
                        onChange={e => setExpiresInHours(e.target.value)}
                        className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-gray-100 focus:outline-none focus:border-indigo-500"
                      >
                        <option value="24">1 day</option>
                        <option value="168">7 days</option>
                        <option value="720">30 days</option>
                      </select>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <button
                      type="submit"
                      disabled={creatingInvite}
                      className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg transition-colors"
                    >
                      {creatingInvite ? 'Creating…' : 'Create link'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowCreateInvite(false)}
                      className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}

          {/* Active invites table */}
          {loadingInvites ? (
            <p className="text-gray-500 animate-pulse">Loading invites…</p>
          ) : activeInvites.length === 0 ? (
            <p className="text-gray-600 text-sm">No active invite links.</p>
          ) : (
            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden mb-4">
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-700 text-left">
                    <th className="px-4 py-3 text-left text-xs uppercase tracking-wide text-gray-500 font-medium">Link</th>
                    <th className="px-4 py-3 text-left text-xs uppercase tracking-wide text-gray-500 font-medium">Uses</th>
                    <th className="px-4 py-3 text-left text-xs uppercase tracking-wide text-gray-500 font-medium">Expires</th>
                    <th className="px-4 py-3 text-left text-xs uppercase tracking-wide text-gray-500 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {activeInvites.map(invite => (
                    <tr key={invite.id} className="border-b border-gray-800 last:border-0">
                      <td className="px-4 py-3 font-mono text-gray-400 text-xs">
                        <span title={invite.inviteUrl}>
                          …{invite.token.slice(-12)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-300">
                        {invite.useCount}/{invite.maxUses ?? '∞'}
                      </td>
                      <td className="px-4 py-3 text-gray-400">{formatDate(invite.expiresAt)}</td>
                      <td className="px-4 py-3 flex gap-3">
                        <button
                          onClick={() => copyToClipboard(invite.inviteUrl)}
                          className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                        >
                          Copy
                        </button>
                        <button
                          onClick={() => handleRevoke(invite.id)}
                          disabled={revoking[invite.id]}
                          className="text-xs text-red-500 hover:text-red-400 disabled:opacity-50 transition-colors"
                        >
                          {revoking[invite.id] ? 'Revoking…' : 'Revoke'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
          )}

          {/* Revoked invites (collapsed) */}
          {revokedInvites.length > 0 && (
            <details className="text-sm">
              <summary className="text-gray-600 cursor-pointer hover:text-gray-400 transition-colors">
                {revokedInvites.length} revoked / expired invite{revokedInvites.length !== 1 ? 's' : ''}
              </summary>
              <div className="mt-3 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden opacity-60">
                <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-800 text-left">
                      <th className="px-4 py-3 text-left text-xs uppercase tracking-wide text-gray-500 font-medium">Link</th>
                      <th className="px-4 py-3 text-left text-xs uppercase tracking-wide text-gray-500 font-medium">Uses</th>
                      <th className="px-4 py-3 text-left text-xs uppercase tracking-wide text-gray-500 font-medium">Expired/Revoked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {revokedInvites.map(invite => (
                      <tr key={invite.id} className="border-b border-gray-800 last:border-0">
                        <td className="px-4 py-3 font-mono text-gray-500 text-xs">…{invite.token.slice(-12)}</td>
                        <td className="px-4 py-3 text-gray-500">{invite.useCount}/{invite.maxUses ?? '∞'}</td>
                        <td className="px-4 py-3 text-gray-500">
                          {invite.revokedAt ? `Revoked ${formatDate(invite.revokedAt)}` : `Expired ${formatDate(invite.expiresAt)}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            </details>
          )}
        </section>
      )}

      <ConfirmDialog
        open={confirmRemove !== null}
        onClose={() => setConfirmRemove(null)}
        onConfirm={() => { if (confirmRemove) handleRemove(confirmRemove); }}
        title="Remove member"
        description="Remove this member from the organization? They will lose access immediately."
        confirmLabel="Remove"
        confirmVariant="danger"
        loading={confirmRemove !== null && !!removing[confirmRemove]}
      />
    </div>
  );
}
