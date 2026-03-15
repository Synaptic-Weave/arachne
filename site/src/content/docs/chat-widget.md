---
title: Chat Widget
description: Embed the @arachne/chat component in your app
order: 4
---


`@arachne/chat` is a drop-in React component that connects to any Arachne agent. Add a fully functional chat interface to your application in minutes.

## Installation

```bash
npm install @arachne/chat
```

## Basic Usage

```tsx
import { ArachneChat } from "@arachne/chat";

function App() {
  return (
    <ArachneChat
      apiKey="loom_sk_your_api_key"
      baseUrl="https://api.arachne-ai.com"
    />
  );
}
```

This renders a chat window that streams responses from the agent bound to the provided API key. Conversation memory, RAG, and all agent settings work automatically.

## Props Reference

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `apiKey` | `string` | *required* | Arachne API key bound to your target agent |
| `endpoint` | `string` | *required* | Base URL of your Arachne instance |
| `conversationId` | `string` | `undefined` | Resume or isolate a specific conversation thread |
| `placeholder` | `string` | `"Type a message..."` | Input field placeholder text |
| `title` | `string` | `undefined` | Header title displayed above the chat |
| `theme` | `"light" \| "dark" \| "auto"` | `"auto"` | Color scheme; `"auto"` follows system preference |
| `height` | `string` | `"500px"` | CSS height of the chat container |
| `width` | `string` | `"100%"` | CSS width of the chat container |
| `showTimestamps` | `boolean` | `false` | Display timestamps on messages |
| `onMessage` | `(msg: Message) => void` | `undefined` | Callback fired when a new message is received |
| `onError` | `(err: Error) => void` | `undefined` | Callback fired on request errors |
| `className` | `string` | `undefined` | Additional CSS class for the root container |
| `style` | `React.CSSProperties` | `undefined` | Inline styles for the root container |

## Conversation Continuity

Pass a `conversationId` to maintain context across page loads or components:

```tsx
<ArachneChat
  apiKey="loom_sk_your_api_key"
  baseUrl="https://api.arachne-ai.com"
  conversationId="session_abc123"
/>
```

If the agent has conversation memory enabled, all messages in the same conversation thread will be replayed as context.

## Styling Customization

### CSS Custom Properties

Override the default theme using CSS custom properties:

```css
.arachne-chat {
  --arachne-primary: #6366f1;
  --arachne-bg: #ffffff;
  --arachne-surface: #f9fafb;
  --arachne-text: #111827;
  --arachne-text-secondary: #6b7280;
  --arachne-border: #e5e7eb;
  --arachne-radius: 12px;
  --arachne-font: "Inter", system-ui, sans-serif;
}
```

### Custom Class Names

Apply your own styles by targeting the built-in class hierarchy:

```css
.arachne-chat-header { /* Header bar */ }
.arachne-chat-messages { /* Message list container */ }
.arachne-chat-message--user { /* User message bubble */ }
.arachne-chat-message--assistant { /* Assistant message bubble */ }
.arachne-chat-input { /* Input area */ }
.arachne-chat-send { /* Send button */ }
```

## Headless Client

If you need full control over the UI, use the headless client directly:

```typescript
import { ArachneClient } from "@arachne/chat/client";

const client = new ArachneClient({
  apiKey: "loom_sk_your_api_key",
  endpoint: "https://api.arachne-ai.com",
});

// Send a message and stream the response
const stream = await client.chat({
  messages: [{ role: "user", content: "Hello!" }],
  conversationId: "session_abc123",
});

for await (const chunk of stream) {
  process.stdout.write(chunk.content);
}
```

The headless client gives you streaming responses, conversation management, and error handling without any UI dependencies. Use it to build custom interfaces in any JavaScript framework.

## Framework Examples

### Next.js

```tsx
"use client";
import { ArachneChat } from "@arachne/chat";

export default function ChatPage() {
  return (
    <main className="max-w-2xl mx-auto py-8">
      <ArachneChat
        apiKey={process.env.NEXT_PUBLIC_ARACHNE_KEY!}
        baseUrl={process.env.NEXT_PUBLIC_ARACHNE_URL!}
        title="Ask our docs"
        theme="auto"
        height="600px"
      />
    </main>
  );
}
```

## Next Steps

- [Getting Started](/docs/getting-started) — Set up your Arachne instance and create an agent.
- [API Reference](/developers/api-reference) — Use the gateway API directly for advanced integrations.
- [Portal Guide](/docs/portal-guide) — Manage the agent your widget connects to.
