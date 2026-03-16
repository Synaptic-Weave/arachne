import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ApiKeysPage from '../ApiKeysPage';

vi.mock('../../lib/api', () => ({
  api: {
    listApiKeys: vi.fn(),
    listAgents: vi.fn(),
    createApiKey: vi.fn(),
    revokeApiKey: vi.fn(),
  },
}));

vi.mock('../../lib/auth', () => ({
  getToken: vi.fn(),
}));

vi.mock('../../components/ApiKeyReveal', () => ({
  default: ({ keyData, onDismiss }: any) => (
    <div data-testid="api-key-reveal">
      {keyData.key}
      <button onClick={onDismiss}>Dismiss</button>
    </div>
  ),
}));

import { api } from '../../lib/api';
import { getToken } from '../../lib/auth';

const mockKeys = [
  { id: 'k1', name: 'Production', agentId: 'a1', agentName: 'Alpha', keyPrefix: 'sk-abc', status: 'active' as const, createdAt: '2024-01-01T00:00:00Z', revokedAt: null },
  { id: 'k2', name: 'Staging', agentId: 'a2', agentName: 'Beta', keyPrefix: 'sk-def', status: 'revoked' as const, createdAt: '2024-01-02T00:00:00Z', revokedAt: '2024-01-03T00:00:00Z' },
];

const mockAgents = [
  { id: 'a1', name: 'Alpha', systemPrompt: '', skills: [], mcpEndpoints: [], availableModels: null, mergePolicies: { system_prompt: 'prepend' as const, skills: 'merge' as const, mcp_endpoints: 'merge' as const }, conversations_enabled: false, conversation_token_limit: 4000, conversation_summary_model: null, createdAt: '2024-01-01T00:00:00Z' },
];

function renderPage() {
  return render(
    <MemoryRouter>
      <ApiKeysPage />
    </MemoryRouter>
  );
}

describe('ApiKeysPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getToken).mockReturnValue('tok');
  });

  it('shows loading state initially', () => {
    vi.mocked(api.listApiKeys).mockImplementation(() => new Promise(() => {}));
    vi.mocked(api.listAgents).mockImplementation(() => new Promise(() => {}));
    renderPage();
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('renders API keys list on success', async () => {
    vi.mocked(api.listApiKeys).mockResolvedValue({ apiKeys: mockKeys });
    vi.mocked(api.listAgents).mockResolvedValue({ agents: mockAgents });
    renderPage();
    await waitFor(() => expect(screen.getByText('Production')).toBeInTheDocument());
    expect(screen.getByText('Staging')).toBeInTheDocument();
    expect(screen.getByText('sk-abc…')).toBeInTheDocument();
  });

  it('shows empty state when no keys', async () => {
    vi.mocked(api.listApiKeys).mockResolvedValue({ apiKeys: [] });
    vi.mocked(api.listAgents).mockResolvedValue({ agents: mockAgents });
    renderPage();
    await waitFor(() => expect(screen.getByText(/no api keys yet/i)).toBeInTheDocument());
  });

  it('shows error message on fetch failure', async () => {
    vi.mocked(api.listApiKeys).mockRejectedValue(new Error('Fetch failed'));
    vi.mocked(api.listAgents).mockResolvedValue({ agents: mockAgents });
    renderPage();
    await waitFor(() => expect(screen.getByText('Fetch failed')).toBeInTheDocument());
  });

  it('opens create form when + New key is clicked', async () => {
    vi.mocked(api.listApiKeys).mockResolvedValue({ apiKeys: mockKeys });
    vi.mocked(api.listAgents).mockResolvedValue({ agents: mockAgents });
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Production')).toBeInTheDocument());
    
    await user.click(screen.getByRole('button', { name: /\+ New key/i }));
    
    expect(screen.getByPlaceholderText(/key name/i)).toBeInTheDocument();
  });

  it('creates new API key when form is submitted', async () => {
    vi.mocked(api.listApiKeys).mockResolvedValue({ apiKeys: [] });
    vi.mocked(api.listAgents).mockResolvedValue({ agents: mockAgents });
    vi.mocked(api.createApiKey).mockResolvedValue({
      id: 'k3',
      name: 'NewKey',
      agentId: 'a1',
      agentName: 'Alpha',
      keyPrefix: 'sk-new',
      key: 'sk-new123456',
      status: 'active',
      createdAt: '2024-01-04T00:00:00Z',
      revokedAt: null,
    });
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /\+ New key/i })).toBeInTheDocument());
    
    await user.click(screen.getByRole('button', { name: /\+ New key/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /create/i })).toBeInTheDocument());
    
    await user.type(screen.getByPlaceholderText(/key name/i), 'NewKey');
    await user.click(screen.getByRole('button', { name: /^create$/i }));
    
    await waitFor(() => expect(api.createApiKey).toHaveBeenCalledWith('tok', { name: 'NewKey', agentId: 'a1' }));
    expect(screen.getByTestId('api-key-reveal')).toBeInTheDocument();
  });

  it('revokes API key when revoke button is clicked and confirmed', async () => {
    vi.mocked(api.listApiKeys).mockResolvedValue({ apiKeys: mockKeys });
    vi.mocked(api.listAgents).mockResolvedValue({ agents: mockAgents });
    vi.mocked(api.revokeApiKey).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Production')).toBeInTheDocument());

    const revokeButton = screen.getByRole('button', { name: /revoke/i });
    await user.click(revokeButton);

    // Confirm dialog should appear — find the confirm button inside the dialog
    const dialog = await waitFor(() => screen.getByRole('dialog'));
    const confirmButton = within(dialog).getByRole('button', { name: /^revoke$/i });
    await user.click(confirmButton);

    await waitFor(() => expect(api.revokeApiKey).toHaveBeenCalledWith('tok', 'k1'));
  });
});
