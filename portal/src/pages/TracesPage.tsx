import { useState, useEffect, useCallback } from 'react';
import { getToken } from '../lib/auth';

interface Trace {
  id: string;
  model: string;
  provider: string;
  status_code: number | null;
  latency_ms: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  created_at: string;
  request_body?: unknown;
  response_body?: unknown;
}

function statusBadge(code: number | null) {
  if (code == null) return 'bg-gray-700 text-gray-300';
  if (code >= 200 && code < 300) return 'bg-green-900 text-green-300';
  if (code >= 400 && code < 500) return 'bg-yellow-900 text-yellow-300';
  if (code >= 500) return 'bg-red-900 text-red-300';
  return 'bg-gray-700 text-gray-300';
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export default function TracesPage() {
  const [traces, setTraces] = useState<Trace[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Trace | null>(null);
  const [error, setError] = useState('');

  const fetchTraces = useCallback(async (cursor?: string) => {
    const token = getToken();
    if (!token) { setLoading(false); return; }
    const isInitial = !cursor;
    if (isInitial) setLoading(true); else setLoadingMore(true);
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (cursor) params.set('cursor', cursor);
      const res = await fetch(`/v1/portal/traces?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { traces: Trace[]; nextCursor: string | null };
      setTraces(prev => isInitial ? data.traces : [...prev, ...data.traces]);
      setNextCursor(data.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load traces');
    } finally {
      if (isInitial) setLoading(false); else setLoadingMore(false);
    }
  }, []);

  useEffect(() => { fetchTraces(); }, [fetchTraces]);

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Traces</h1>
        <p className="text-gray-400 text-sm mt-1">Your tenant's API request history</p>
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-700 text-left">
                <th className="px-4 py-3 text-xs uppercase tracking-wide text-gray-500 font-medium">Time</th>
                <th className="px-4 py-3 text-xs uppercase tracking-wide text-gray-500 font-medium">Model</th>
                <th className="px-4 py-3 text-xs uppercase tracking-wide text-gray-500 font-medium">Provider</th>
                <th className="px-4 py-3 text-xs uppercase tracking-wide text-gray-500 font-medium">Status</th>
                <th className="px-4 py-3 text-xs uppercase tracking-wide text-gray-500 font-medium text-right">Latency</th>
                <th className="px-4 py-3 text-xs uppercase tracking-wide text-gray-500 font-medium text-right">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 8 }, (_, i) => (
                  <tr key={i} className="border-b border-gray-800 animate-pulse">
                    {Array.from({ length: 6 }, (_, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-4 bg-gray-800 rounded w-3/4" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : traces.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-gray-500">
                    No traces yet. Make your first API call through Arachne.
                  </td>
                </tr>
              ) : (
                traces.map(trace => (
                  <tr
                    key={trace.id}
                    className="border-b border-gray-800 hover:bg-gray-800 cursor-pointer transition-colors"
                    onClick={() => setSelected(trace)}
                    tabIndex={0}
                    onKeyDown={e => e.key === 'Enter' && setSelected(trace)}
                    role="button"
                    aria-label={`View trace ${trace.id}`}
                  >
                    <td className="px-4 py-3 text-gray-300 font-mono text-xs">{formatTime(trace.created_at)}</td>
                    <td className="px-4 py-3 text-gray-200 font-mono text-xs">{trace.model}</td>
                    <td className="px-4 py-3 text-gray-400 text-xs">{trace.provider}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${statusBadge(trace.status_code)}`}>
                        {trace.status_code ?? '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-300 text-right tabular-nums">
                      {trace.latency_ms.toLocaleString()} ms
                    </td>
                    <td className="px-4 py-3 text-gray-300 text-right tabular-nums">
                      {((trace.prompt_tokens ?? 0) + (trace.completion_tokens ?? 0)).toLocaleString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {nextCursor && (
          <div className="px-4 py-3 border-t border-gray-700 text-center">
            <button
              onClick={() => fetchTraces(nextCursor)}
              disabled={loadingMore}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 border border-gray-600 text-sm text-gray-300 rounded-lg transition-colors"
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>

      {/* Detail panel */}
      {selected && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex justify-end"
          onClick={() => setSelected(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Trace details"
        >
          <div
            className="w-full max-w-lg bg-gray-900 border-l border-gray-700 h-full overflow-y-auto p-6 space-y-5"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">Trace details</h2>
              <button
                onClick={() => setSelected(null)}
                className="text-gray-400 hover:text-white text-xl leading-none"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <dl className="space-y-3">
              {[
                ['ID', selected.id],
                ['Time', formatTime(selected.created_at)],
                ['Model', selected.model],
                ['Provider', selected.provider],
                ['Status', String(selected.status_code ?? '—')],
                ['Latency', `${selected.latency_ms.toLocaleString()} ms`],
                ['Prompt tokens', String(selected.prompt_tokens ?? 0)],
                ['Completion tokens', String(selected.completion_tokens ?? 0)],
                ['Total tokens', String((selected.prompt_tokens ?? 0) + (selected.completion_tokens ?? 0))],
              ].map(([label, value]) => (
                <div key={label} className="flex gap-4">
                  <dt className="text-xs uppercase tracking-wide text-gray-500 w-36 shrink-0 pt-0.5">{label}</dt>
                  <dd className="text-sm text-gray-200 font-mono break-all">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}
    </div>
  );
}
