import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import LandingPage from '../LandingPage';

function renderPage() {
  return render(
    <MemoryRouter>
      <LandingPage />
    </MemoryRouter>
  );
}

describe('LandingPage', () => {
  it('renders the Arachne branding', () => {
    renderPage();
    // Multiple instances of "Arachne" expected
    expect(screen.getAllByText(/Arachne/i).length).toBeGreaterThan(0);
  });

  it('renders Sign in link to /login', () => {
    renderPage();
    const links = screen.getAllByRole('link', { name: /sign in/i });
    expect(links.length).toBeGreaterThan(0);
    expect(links[0]).toHaveAttribute('href', '/login');
  });

  it('renders Get started free link to beta signup', () => {
    renderPage();
    const links = screen.getAllByRole('link', { name: /get started free/i });
    expect(links.length).toBeGreaterThan(0);
    expect(links[0]).toHaveAttribute('href', '#beta-signup');
  });

  it('renders feature sections', () => {
    renderPage();
    expect(screen.getByText(/A Spec for Agents \+ Knowledge/i)).toBeInTheDocument();
    expect(screen.getByText(/Build AI Agents Like Containers/i)).toBeInTheDocument();
  });

  it('renders the hero tagline', () => {
    renderPage();
    expect(screen.getByText(/Docker for AI Agents/i)).toBeInTheDocument();
  });

  it('renders footer with current year', () => {
    renderPage();
    const year = new Date().getFullYear().toString();
    expect(screen.getByText(new RegExp(year))).toBeInTheDocument();
  });
});
