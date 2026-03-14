import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../lib/api';
import type { KnowledgeBase } from '../lib/api';
import { getToken } from '../lib/auth';

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

const ACCEPTED_EXTENSIONS = ['.txt', '.md', '.json', '.csv'];

export default function KnowledgeBasesPage() {
  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<Record<string, boolean>>({});

  // Creation panel state
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createFiles, setCreateFiles] = useState<File[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const token = getToken()!;

  const loadKbs = useCallback(async () => {
    try {
      const { knowledgeBases } = await api.listKnowledgeBases(token);
      setKbs(knowledgeBases);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load knowledge bases');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { loadKbs(); }, [loadKbs]);

  async function handleDelete(id: string) {
    if (!confirm('Delete this knowledge base? This cannot be undone.')) return;
    setDeleting(s => ({ ...s, [id]: true }));
    try {
      await api.deleteKnowledgeBase(token, id);
      setKbs(s => s.filter(kb => kb.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete knowledge base');
    } finally {
      setDeleting(s => ({ ...s, [id]: false }));
    }
  }

  function addFiles(files: FileList | File[]) {
    const valid = Array.from(files).filter((f) => {
      const ext = '.' + f.name.split('.').pop()?.toLowerCase();
      return ACCEPTED_EXTENSIONS.includes(ext);
    });
    if (valid.length === 0) {
      setCreateError(`Only ${ACCEPTED_EXTENSIONS.join(', ')} files are accepted`);
      return;
    }
    setCreateFiles((prev) => {
      const existing = new Set(prev.map((f) => f.name));
      return [...prev, ...valid.filter((f) => !existing.has(f.name))];
    });
    setCreateError('');
  }

  function removeFile(name: string) {
    setCreateFiles((prev) => prev.filter((f) => f.name !== name));
  }

  async function handleCreate() {
    if (!createName.trim() || createFiles.length === 0) return;
    setCreating(true);
    setCreateError('');
    try {
      await api.createKnowledgeBase(token, createName.trim(), createFiles);
      setShowCreate(false);
      setCreateName('');
      setCreateFiles([]);
      setLoading(true);
      await loadKbs();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create knowledge base');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="p-8 max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Knowledge Bases</h1>
          <p className="text-gray-400 text-sm mt-1">
            Vectorized document collections available for agent retrieval
          </p>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors"
        >
          {showCreate ? 'Cancel' : '+ New Knowledge Base'}
        </button>
      </div>

      {error && (
        <div className="bg-red-950/30 border border-red-800 rounded-lg px-4 py-3 text-red-400 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-3 text-red-600 hover:text-red-400">✕</button>
        </div>
      )}

      {/* Creation Panel */}
      {showCreate && (
        <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 space-y-4">
          <h2 className="text-lg font-semibold text-white">Create Knowledge Base</h2>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Name</label>
            <input
              type="text"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-gray-100 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="my-knowledge-base"
              disabled={creating}
            />
          </div>

          {/* Drop zone */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Files</label>
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
              }}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
                dragOver
                  ? 'border-blue-400 bg-blue-950/20'
                  : 'border-gray-600 hover:border-gray-500 bg-gray-800/50'
              }`}
            >
              <p className="text-gray-400 text-sm">
                {dragOver ? 'Drop files here' : 'Drag & drop files here, or click to browse'}
              </p>
              <p className="text-gray-500 text-xs mt-1">
                Accepted: {ACCEPTED_EXTENSIONS.join(', ')}
              </p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPTED_EXTENSIONS.join(',')}
              onChange={(e) => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = ''; }}
              className="hidden"
            />
          </div>

          {/* Selected files */}
          {createFiles.length > 0 && (
            <div className="space-y-1">
              {createFiles.map((f) => (
                <div key={f.name} className="flex items-center justify-between bg-gray-800 rounded-lg px-3 py-2 text-sm">
                  <span className="text-gray-300 font-mono truncate">{f.name}</span>
                  <button
                    onClick={() => removeFile(f.name)}
                    disabled={creating}
                    className="text-gray-500 hover:text-red-400 ml-2 disabled:opacity-40"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <p className="text-xs text-gray-500">{createFiles.length} file{createFiles.length !== 1 ? 's' : ''} selected</p>
            </div>
          )}

          {createError && (
            <p className="text-sm text-red-400">{createError}</p>
          )}

          <button
            onClick={handleCreate}
            disabled={creating || !createName.trim() || createFiles.length === 0}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:hover:bg-blue-600 text-white text-sm rounded-lg transition-colors"
          >
            {creating ? 'Creating... (chunking & embedding)' : 'Create'}
          </button>
        </div>
      )}

      <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-700 text-left">
              <th className="px-4 py-3 text-xs uppercase tracking-wide text-gray-500 font-medium">Name</th>
              <th className="px-4 py-3 text-xs uppercase tracking-wide text-gray-500 font-medium">Org</th>
              <th className="px-4 py-3 text-xs uppercase tracking-wide text-gray-500 font-medium">Version</th>
              <th className="px-4 py-3 text-xs uppercase tracking-wide text-gray-500 font-medium text-right">Chunks</th>
              <th className="px-4 py-3 text-xs uppercase tracking-wide text-gray-500 font-medium">Vector Space</th>
              <th className="px-4 py-3 text-xs uppercase tracking-wide text-gray-500 font-medium">Created</th>
              <th className="px-4 py-3 text-xs uppercase tracking-wide text-gray-500 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 4 }, (_, i) => (
                <tr key={i} className="border-b border-gray-800 animate-pulse">
                  {Array.from({ length: 7 }, (_, j) => (
                    <td key={j} className="px-4 py-3">
                      <div className="h-4 bg-gray-800 rounded w-3/4" />
                    </td>
                  ))}
                </tr>
              ))
            ) : kbs.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-gray-500">
                  No knowledge bases yet. Click "+ New Knowledge Base" above or use the Arachne CLI.
                </td>
              </tr>
            ) : (
              kbs.map(kb => (
                <tr key={kb.id} className="border-b border-gray-800 last:border-0 hover:bg-gray-800/50 transition-colors">
                  <td className="px-4 py-3 text-gray-100 font-medium">{kb.name}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs font-mono">{kb.org}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs font-mono">{kb.version}</td>
                  <td className="px-4 py-3 text-gray-300 text-right tabular-nums">{kb.chunkCount.toLocaleString()}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs font-mono">{kb.vectorSpace}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{formatDate(kb.createdAt)}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => handleDelete(kb.id)}
                      disabled={deleting[kb.id]}
                      className="text-xs text-red-500 hover:text-red-400 disabled:opacity-40 transition-colors"
                    >
                      {deleting[kb.id] ? 'Deleting…' : 'Delete'}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
