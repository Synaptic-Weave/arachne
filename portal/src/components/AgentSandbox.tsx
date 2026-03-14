import { useState, useRef, useEffect, useCallback } from 'react';
import Markdown from 'react-markdown';
import { api } from '../lib/api';
import type { Agent, KnowledgeBase } from '../lib/api';
import { getToken } from '../lib/auth';
import { COMMON_MODELS } from '../lib/models';
import ModelCombobox from './ModelCombobox';

interface RagSource {
  rank: number;
  sourcePath?: string;
  similarityScore: number;
  contentPreview: string;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  latencyMs?: number;
  ragSources?: RagSource[];
}

interface AgentSandboxProps {
  agent: Agent;
  onClose?: () => void;
}

export default function AgentSandbox({ agent, onClose }: AgentSandboxProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [model, setModel] = useState('gpt-4o-mini');
  const [memoryEnabled, setMemoryEnabled] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const token = getToken()!;

  // KB info
  const [kbInfo, setKbInfo] = useState<{ name: string; chunkCount: number; sources: Array<{ sourcePath: string; chunkCount: number }> } | null>(null);
  const [showKbDetail, setShowKbDetail] = useState(false);

  const modelOptions = (agent.availableModels && agent.availableModels.length > 0)
    ? agent.availableModels
    : COMMON_MODELS;

  const activeModel = model || 'gpt-4o-mini';

  // Load KB info if agent has a knowledge base
  const loadKbInfo = useCallback(async () => {
    if (!agent.knowledgeBaseRef) return;
    try {
      const { knowledgeBases } = await api.listKnowledgeBases(token);
      const kb = knowledgeBases.find((k: KnowledgeBase) => k.name === agent.knowledgeBaseRef);
      if (!kb) return;

      const API_BASE = '';
      const sourcesResp = await fetch(`${API_BASE}/v1/portal/knowledge-bases/${kb.id}/sources`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const sourcesData = sourcesResp.ok ? await sourcesResp.json() as { sources: Array<{ sourcePath: string; chunkCount: number }> } : { sources: [] };

      setKbInfo({
        name: kb.name,
        chunkCount: kb.chunkCount,
        sources: sourcesData.sources,
      });
    } catch {
      // non-fatal
    }
  }, [agent.knowledgeBaseRef, token]);

  useEffect(() => { loadKbInfo(); }, [loadKbInfo]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  async function handleSend() {
    const content = input.trim();
    if (!content || loading) return;

    const userMessage: Message = { role: 'user', content };
    const next = [...messages, userMessage];
    setMessages(next);
    setInput('');
    setLoading(true);
    setError('');

    try {
      const startMs = Date.now();
      const res = await api.sandboxChat(
        token,
        agent.id,
        next.map(m => ({ role: m.role, content: m.content })),
        activeModel,
        memoryEnabled ? conversationId : null,
      );
      const latencyMs = Date.now() - startMs;
      const reasoning = (res.message as any).reasoning_content ?? (res.message as any).reasoning ?? undefined;
      const ragSources = (res as any).rag_sources as RagSource[] | undefined;
      setMessages(prev => [
        ...prev,
        { role: 'assistant', content: res.message.content, usage: res.usage, latencyMs, reasoning, ragSources },
      ]);
      // Capture conversation_id from response
      if (memoryEnabled && res.conversation_id && !conversationId) {
        setConversationId(res.conversation_id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleMemoryToggle() {
    if (memoryEnabled) {
      setConversationId(null);
    }
    setMemoryEnabled(!memoryEnabled);
  }

  function handleNewConversation() {
    setConversationId(null);
    setMessages([]);
  }

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="border-b border-gray-700">
        <div className="flex items-center justify-between px-4 py-3 gap-3 flex-wrap">
          <span className="text-sm font-semibold text-gray-100 shrink-0">
            Sandbox — <span className="text-indigo-400">{agent.name}</span>
          </span>
          <div className="flex items-center gap-2 flex-1 min-w-0 justify-end">
            {agent.conversations_enabled && (
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={handleMemoryToggle}
                  disabled={loading}
                  className={`text-xs px-2 py-1 rounded transition-colors ${
                    memoryEnabled
                      ? 'bg-indigo-600 text-white'
                      : 'bg-gray-800 text-gray-400 hover:text-gray-200'
                  } disabled:opacity-50`}
                >
                  {memoryEnabled ? '💾 Memory ON' : '💾 Memory'}
                </button>
                {memoryEnabled && conversationId && (
                  <button
                    onClick={handleNewConversation}
                    disabled={loading}
                    className="text-xs text-gray-400 hover:text-gray-200 px-1 disabled:opacity-50"
                    title="Start new conversation"
                  >
                    ↺ New
                  </button>
                )}
              </div>
            )}
            <ModelCombobox
              value={model}
              onChange={setModel}
              options={modelOptions}
              placeholder="e.g. gpt-4o"
              disabled={loading}
            />
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-gray-300 text-sm transition-colors shrink-0"
              aria-label="Close sandbox"
            >
              ✕
            </button>
          )}
        </div>
        {memoryEnabled && conversationId && (
          <div className="text-xs text-gray-500 font-mono px-4 py-1 border-t border-gray-700/50">
            💬 {conversationId.substring(0, 8)}...
          </div>
        )}
      </div>

      {/* KB info bar */}
      {kbInfo && (
        <div className="border-b border-gray-700/50 px-4 py-2 bg-gray-800/30">
          <button
            onClick={() => setShowKbDetail(v => !v)}
            className="flex items-center gap-2 text-xs text-gray-400 hover:text-gray-200 w-full"
          >
            <span className="text-blue-400">{showKbDetail ? '▾' : '▸'}</span>
            <span>KB: <span className="text-gray-200 font-medium">{kbInfo.name}</span></span>
            <span className="text-gray-500">{kbInfo.chunkCount} chunks</span>
            <span className="text-gray-500">{kbInfo.sources.length} source{kbInfo.sources.length !== 1 ? 's' : ''}</span>
          </button>
          {showKbDetail && (
            <div className="mt-2 space-y-1 text-xs">
              {kbInfo.sources.map(src => (
                <div key={src.sourcePath} className="flex items-center gap-2 text-gray-400">
                  <span className="text-gray-500 font-mono truncate">{src.sourcePath}</span>
                  <span className="text-gray-600">{src.chunkCount} chunk{src.chunkCount !== 1 ? 's' : ''}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Message list */}
      <div
        ref={scrollRef}
        className="max-h-80 overflow-y-auto px-4 py-4 space-y-3"
      >
        {messages.length === 0 && !loading ? (
          <p className="text-gray-500 text-sm italic text-center py-6">
            Say something to test this agent…
          </p>
        ) : (
          messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[75%] ${msg.role === 'user' ? 'items-end' : 'items-start'} flex flex-col gap-1`}>
                <div
                  className={`px-3 py-2 rounded-xl text-sm leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-indigo-600 text-white'
                      : 'bg-gray-800 text-gray-100'
                  }`}
                >
                  {msg.reasoning && (
                    <details className="mb-2 text-xs text-gray-400">
                      <summary className="cursor-pointer select-none text-indigo-400 hover:text-indigo-300">
                        Reasoning
                      </summary>
                      <p className="mt-1 whitespace-pre-wrap leading-relaxed">{msg.reasoning}</p>
                    </details>
                  )}
                  {msg.role === 'assistant' ? (
                    <div className="prose prose-invert prose-sm max-w-none prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-pre:bg-gray-900 prose-pre:border prose-pre:border-gray-700 prose-code:text-indigo-300 prose-headings:text-gray-100 prose-a:text-indigo-400">
                      <Markdown>{msg.content}</Markdown>
                    </div>
                  ) : (
                    msg.content
                  )}
                </div>
                {msg.ragSources && msg.ragSources.length > 0 && (
                  <div className="mt-2 border-t border-gray-700 pt-2">
                    <details className="text-xs text-gray-400">
                      <summary className="cursor-pointer select-none text-blue-400 hover:text-blue-300">
                        Sources ({msg.ragSources.length})
                      </summary>
                      <div className="mt-1 space-y-1">
                        {msg.ragSources.map(src => (
                          <div key={src.rank} className="bg-gray-900 rounded px-2 py-1">
                            <span className="text-blue-300 font-mono">[{src.rank}]</span>
                            {src.sourcePath && (
                              <span className="text-gray-300 ml-1">{src.sourcePath}</span>
                            )}
                            <span className="text-gray-500 ml-1">
                              ({(src.similarityScore * 100).toFixed(1)}% match)
                            </span>
                            <p className="text-gray-500 mt-0.5 line-clamp-2">{src.contentPreview}</p>
                          </div>
                        ))}
                      </div>
                    </details>
                  </div>
                )}
                {msg.usage && (
                  <span className="text-xs text-gray-500 px-1 flex gap-2 flex-wrap">
                    <span title="Prompt tokens">↑{msg.usage.prompt_tokens}</span>
                    <span title="Completion tokens">↓{msg.usage.completion_tokens}</span>
                    <span title="Total tokens">∑{msg.usage.total_tokens}</span>
                    {msg.latencyMs !== undefined && (
                      <span title="Response latency">{msg.latencyMs}ms</span>
                    )}
                  </span>
                )}
              </div>
            </div>
          ))
        )}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-gray-800 text-gray-400 text-sm px-3 py-2 rounded-xl animate-pulse">
              thinking…
            </div>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="mx-4 mb-2 bg-red-950/30 border border-red-800 rounded-lg px-3 py-2 text-red-400 text-xs flex items-center justify-between">
          {error}
          <button onClick={() => setError('')} className="ml-2 text-red-600 hover:text-red-400">✕</button>
        </div>
      )}

      {/* Input row */}
      <div className="px-4 pb-4 flex gap-2">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={loading}
          placeholder="Type a message…"
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-indigo-500 disabled:opacity-50"
        />
        <button
          onClick={handleSend}
          disabled={loading || !input.trim()}
          className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm px-4 py-2 rounded-lg transition-colors"
        >
          Send
        </button>
      </div>
    </div>
  );
}
