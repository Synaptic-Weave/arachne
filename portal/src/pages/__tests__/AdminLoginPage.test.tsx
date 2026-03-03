import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import AdminLoginPage from '../AdminLoginPage';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// jsdom localStorage mock
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();
Object.defineProperty(window, 'localStorage', { value: localStorageMock });

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminLoginPage />
    </MemoryRouter>
  );
}

describe('AdminLoginPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
  });

  it('renders username and password fields', () => {
    renderPage();
    expect(screen.getByPlaceholderText('admin')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('••••••••')).toBeInTheDocument();
  });

  it('renders sign in button', () => {
    renderPage();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('stores token and navigates on successful login', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'admin-jwt-token' }),
    });
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByPlaceholderText('admin'), 'admin');
    await user.type(screen.getByPlaceholderText('••••••••'), 'changeme');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByRole('button', { name: /sign in/i })).toBeEnabled();
    expect(localStorage.getItem('loom_admin_token')).toBe('admin-jwt-token');
    expect(mockNavigate).toHaveBeenCalledWith('/admin/tenants');
  });

  it('shows error message on 401', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: 'Invalid credentials' }),
    });
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByPlaceholderText('admin'), 'admin');
    await user.type(screen.getByPlaceholderText('••••••••'), 'wrongpassword');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByText('Invalid credentials')).toBeInTheDocument();
    expect(localStorage.getItem('loom_admin_token')).toBeNull();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('shows generic error when response has no message', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByPlaceholderText('admin'), 'admin');
    await user.type(screen.getByPlaceholderText('••••••••'), 'anything');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByText(/login failed/i)).toBeInTheDocument();
  });

  it('shows loading state while submitting', async () => {
    let resolveFetch!: (val: unknown) => void;
    mockFetch.mockReturnValue(new Promise(r => { resolveFetch = r; }));
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByPlaceholderText('admin'), 'admin');
    await user.type(screen.getByPlaceholderText('••••••••'), 'changeme');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    expect(screen.getByRole('button', { name: /signing in/i })).toBeDisabled();
    resolveFetch({ ok: true, json: async () => ({ token: 't' }) });
  });
});
