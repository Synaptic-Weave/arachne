# Session Log — Conversations + Example + Sandbox Memory

**Timestamp:** 2026-02-28T03:57:43Z  
**Topic:** conversations-example-sandbox-memory  
**Agents:** Fenster, McManus

## Summary

Implemented full conversation memory feature for Loom gateway and portal sandbox, including reference examples.

### Backend (Fenster)

- **Migration 1000000000014**: Four tables (partitions, conversations, conversation_messages, conversation_snapshots) with agent config fields
- **ConversationManager** (`src/conversations.ts`): Partition/conversation lifecycle, encrypted context loading, message storage, LLM snapshots
- **Portal Routes**: Six CRUD endpoints for partition and conversation management (`src/routes/portal.ts`)
- **Sandbox Integration**: Extended `POST /v1/portal/agents/:id/chat` to accept conversation_id/partition_id, with non-fatal error handling
- **Example HTML** (`examples/conversations/index.html`): Interactive reference showing both auto-generate and explicit conversation flows

### Frontend (McManus)

- **AgentSandbox Memory Toggle**: Toggles conversation memory on/off for agents with `conversations_enabled: true`
- **Conversation ID Tracking**: Displays truncated UUID (first 8 chars) when active
- **"New Conversation" Action**: Quick reset button for starting fresh threads
- **Visual Hierarchy**: Toggle in header between agent name and model selector, conversation ID in sub-header

## Key Decisions Recorded

1. **Partition Root Uniqueness**: Partial index `WHERE parent_id IS NULL` prevents duplicate root partitions (PostgreSQL NULL semantics)
2. **Messages Archive Semantics**: Messages never deleted; `snapshot_id` column marks archival, loadContext loads only post-snapshot messages
3. **Token Estimation**: Character-count method (`content.length / 4`) without tiktoken dependency
4. **Fire-and-Forget Storage**: Message storage async after response to minimize latency
5. **Sandbox Partition Default**: `__sandbox__` for namespace isolation from production
6. **Conversation ID Generation**: Sandbox requires explicit client provision (unlike gateway auto-generation) to encourage learning
7. **Encryption**: AES-256-GCM per-tenant key derivation for message content and snapshots
8. **Portal Routes**: JWT-scoped to tenant, no cross-tenant access, UUID-based detail routes to prevent enumeration

## Coordination

- Fenster delivered backend, examples, and sandbox route wiring
- McManus delivered memory toggle UI with state tracking
- Both implementations follow established patterns (fire-and-forget, non-fatal errors, encryption)
- No breaking changes; all new fields are optional
