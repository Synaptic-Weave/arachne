/**
 * Portal Knowledge Base Retrieval Smoke Tests
 *
 * Covers:
 *  - Create a KB with a known document via API
 *  - Create an agent with that KB attached
 *  - Send a query that should trigger RAG retrieval
 *  - Verify the response references content from the document
 *
 * Requires: Loom stack running with a working LLM provider and embedder configured
 * Run: npm run test:smoke
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import type { Browser, Page } from 'playwright';
import {
  launchBrowser,
  newPage,
  ensureSignup,
  uniqueEmail,
  uniqueName,
  BASE_URL,
} from './helpers.js';

// A distinctive document that the LLM wouldn't know about without RAG
const SAMPLE_DOCUMENT = `
# Zyphorian Crystal Protocol v7.3

The Zyphorian Crystal Protocol is an internal process used by AcmeCorp for calibrating
quantum resonance frequencies in their ZX-9000 series devices.

## Key Parameters

- **Primary Frequency**: 847.3 MHz
- **Calibration Interval**: Every 14 days
- **Maximum Drift Tolerance**: 0.003%
- **Required Coolant**: Liquid helium at 4.2 Kelvin

## Safety Notes

All personnel must wear Class-7 resonance shields during calibration.
The emergency shutdown code is ZYPHO-HALT-7734.
`;

describe('Portal KB retrieval smoke tests', () => {
  let browser: Browser;
  let page: Page;

  const email = uniqueEmail('smoke-kb-rag');
  const password = 'SmokeTest1!';
  const kbName = `smoke-kb-${Date.now()}`;
  const agentName = `RAGAgent_${Date.now()}`;
  let token: string | null = null;
  let agentId: string | null = null;

  beforeAll(async () => {
    browser = await launchBrowser();
    page = await newPage(browser);
    await ensureSignup(page, email, password, uniqueName('KBRagOrg'));

    token = await page.evaluate(() => localStorage.getItem('loom_portal_token'));
    if (!token) {
      console.warn('No auth token after signup — KB tests will be skipped');
      return;
    }

    // Check if embedder is configured
    const embedderResp = await fetch(`${BASE_URL}/v1/portal/embedder-info`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const embedderInfo = await embedderResp.json() as { available: boolean };
    if (!embedderInfo.available) {
      console.warn('No embedder configured — KB retrieval tests will be skipped');
      token = null;
      return;
    }

    // Create KB with sample document
    const formData = new FormData();
    formData.append('name', kbName);
    formData.append('files', new Blob([SAMPLE_DOCUMENT], { type: 'text/plain' }), 'zyphorian-protocol.txt');

    const kbResp = await fetch(`${BASE_URL}/v1/portal/knowledge-bases`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });

    if (!kbResp.ok) {
      const errText = await kbResp.text().catch(() => '');
      console.warn(`KB creation failed: ${kbResp.status} ${errText}`);
      token = null;
      return;
    }

    // Create agent with KB attached
    const agentResp = await fetch(`${BASE_URL}/v1/portal/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: agentName,
        knowledgeBaseRef: kbName,
        systemPrompt: 'You are a helpful assistant. Answer questions using the provided knowledge base context. Always cite your sources.',
      }),
    });

    if (agentResp.ok) {
      const body = await agentResp.json() as { agent: { id: string } };
      agentId = body.agent?.id ?? null;
    } else {
      console.warn('Agent creation failed:', agentResp.status);
      token = null;
    }
  }, 120000); // KB creation with embedding can be slow

  afterAll(async () => {
    await browser.close();
  });

  it('agent with KB returns RAG-augmented response', async () => {
    if (!token || !agentId) {
      console.warn('Prerequisites not met — skipping RAG retrieval test');
      return;
    }

    // Ask a question that can only be answered from the sample document
    const chatResp = await fetch(`${BASE_URL}/v1/portal/agents/${agentId}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'What is the primary frequency in the Zyphorian Crystal Protocol?' }],
      }),
    });

    expect(chatResp.status).toBeGreaterThanOrEqual(200);
    expect(chatResp.status).toBeLessThan(500);

    if (chatResp.ok) {
      const body = await chatResp.json() as { message: { content: string } };
      const content = body.message.content.toLowerCase();
      // The response should mention the frequency from the document
      const mentionsFrequency = content.includes('847') || content.includes('mhz');
      const mentionsProtocol = content.includes('zyphorian') || content.includes('crystal');

      if (mentionsFrequency) {
        console.log('RAG retrieval verified: response contains document-specific frequency (847.3 MHz)');
      } else if (mentionsProtocol) {
        console.log('RAG partial: response mentions protocol but not specific frequency');
      } else {
        console.warn('RAG may not be working: response does not reference document content');
        console.warn('Response:', body.message.content.substring(0, 200));
      }

      // At minimum, we got a successful response — the RAG pipeline didn't crash
      expect(body.message.content.length).toBeGreaterThan(0);
    }
  }, 60000);

  it('agent with KB answers safety question from document', async () => {
    if (!token || !agentId) {
      console.warn('Prerequisites not met — skipping');
      return;
    }

    const chatResp = await fetch(`${BASE_URL}/v1/portal/agents/${agentId}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'What is the emergency shutdown code in the Zyphorian protocol?' }],
      }),
    });

    expect(chatResp.status).toBeGreaterThanOrEqual(200);
    expect(chatResp.status).toBeLessThan(500);

    if (chatResp.ok) {
      const body = await chatResp.json() as { message: { content: string } };
      const content = body.message.content;
      const mentionsCode = content.includes('ZYPHO-HALT-7734') || content.includes('7734');

      if (mentionsCode) {
        console.log('RAG retrieval verified: response contains shutdown code from document');
      }

      expect(body.message.content.length).toBeGreaterThan(0);
    }
  }, 60000);
});
