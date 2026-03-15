export interface RagSource {
  rank: number;
  sourcePath?: string;
  similarityScore: number;
  contentPreview: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  latencyMs?: number;
  ragSources?: RagSource[];
}

export interface ArachneChatProps {
  /** Arachne gateway API key (Bearer token) */
  apiKey: string;
  /** Base URL of the Arachne gateway (default: '' for same origin) */
  baseUrl?: string;
  /** Model to use (default: 'gpt-4o-mini') */
  model?: string;
  /** List of models for the model picker dropdown */
  models?: string[];
  /** Title displayed in the header */
  title?: string;
  /** Enable conversation memory */
  memory?: boolean;
  /** Conversation ID to resume */
  conversationId?: string;
  /** Partition ID for multi-tenant conversations. If omitted with memory enabled, an ephemeral partition is created and stored in localStorage. */
  partitionId?: string;
  /** Show conversation history dropdown (default: true when memory is enabled) */
  showConversations?: boolean;
  /** localStorage key prefix for conversation history (default: 'arachne-chat') */
  storageKey?: string;
  /** Show the model picker (default: true) */
  showModelPicker?: boolean;
  /** Show token usage stats (default: true) */
  showUsage?: boolean;
  /** Show RAG source citations (default: true) */
  showSources?: boolean;
  /** Placeholder text for the input field */
  placeholder?: string;
  /** CSS class name for the outer container */
  className?: string;
  /** Callback when a message is sent */
  onMessage?: (message: ChatMessage) => void;
  /** Callback when an error occurs */
  onError?: (error: string) => void;
}
