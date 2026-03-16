import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import ModelListEditor from '../ModelListEditor';

const defaultModels = ['gpt-4o', 'gpt-3.5-turbo'];

describe('ModelListEditor', () => {
  let onChange: Mock<(models: string[] | null) => void>;

  beforeEach(() => {
    onChange = vi.fn();
  });

  it('renders label', () => {
    render(<ModelListEditor models={null} onChange={onChange} defaultModels={defaultModels} />);
    expect(screen.getByText('Available Models')).toBeInTheDocument();
  });

  it('renders custom label when provided', () => {
    render(<ModelListEditor models={null} onChange={onChange} defaultModels={defaultModels} label="My Models" />);
    expect(screen.getByText('My Models')).toBeInTheDocument();
  });

  it('shows defaults text and unchecked checkbox when models is null', () => {
    render(<ModelListEditor models={null} onChange={onChange} defaultModels={defaultModels} />);
    expect(screen.getByText(/gpt-4o, gpt-3\.5-turbo/)).toBeInTheDocument();
    expect(screen.getByRole('switch')).not.toBeChecked();
  });

  it('enables custom list when checkbox is checked', async () => {
    const user = userEvent.setup();
    render(<ModelListEditor models={null} onChange={onChange} defaultModels={defaultModels} />);
    await user.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(defaultModels);
  });

  it('disables custom list when checkbox is unchecked', async () => {
    const user = userEvent.setup();
    render(<ModelListEditor models={['gpt-4o']} onChange={onChange} defaultModels={defaultModels} />);
    await user.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('shows existing models as tags when models is an array', () => {
    render(<ModelListEditor models={['gpt-4o', 'claude-3']} onChange={onChange} defaultModels={defaultModels} />);
    expect(screen.getByText('gpt-4o')).toBeInTheDocument();
    expect(screen.getByText('claude-3')).toBeInTheDocument();
  });

  it('adds a model via input and Add button', async () => {
    const user = userEvent.setup();
    render(<ModelListEditor models={['gpt-4o']} onChange={onChange} defaultModels={defaultModels} />);
    await user.type(screen.getByPlaceholderText(/gpt-4o/i), 'gpt-4-turbo');
    await user.click(screen.getByRole('button', { name: /^add$/i }));
    expect(onChange).toHaveBeenCalledWith(['gpt-4o', 'gpt-4-turbo']);
  });

  it('adds a model via Enter key', async () => {
    const user = userEvent.setup();
    render(<ModelListEditor models={[]} onChange={onChange} defaultModels={defaultModels} />);
    await user.type(screen.getByPlaceholderText(/gpt-4o/i), 'gpt-4o{Enter}');
    expect(onChange).toHaveBeenCalledWith(['gpt-4o']);
  });

  it('does not add duplicate model', async () => {
    const user = userEvent.setup();
    render(<ModelListEditor models={['gpt-4o']} onChange={onChange} defaultModels={defaultModels} />);
    await user.type(screen.getByPlaceholderText(/gpt-4o/i), 'gpt-4o');
    await user.click(screen.getByRole('button', { name: /^add$/i }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('removes a model when × button is clicked', async () => {
    const user = userEvent.setup();
    render(<ModelListEditor models={['gpt-4o', 'claude-3']} onChange={onChange} defaultModels={defaultModels} />);
    await user.click(screen.getByRole('button', { name: /remove gpt-4o/i }));
    expect(onChange).toHaveBeenCalledWith(['claude-3']);
  });

  it('shows "Reset to defaults" button when custom list is active', () => {
    render(<ModelListEditor models={['gpt-4o']} onChange={onChange} defaultModels={defaultModels} />);
    expect(screen.getByRole('button', { name: /reset to defaults/i })).toBeInTheDocument();
  });

  it('calls onChange(null) when Reset to defaults is clicked', async () => {
    const user = userEvent.setup();
    render(<ModelListEditor models={['gpt-4o']} onChange={onChange} defaultModels={defaultModels} />);
    await user.click(screen.getByRole('button', { name: /reset to defaults/i }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('shows empty state message when custom list is empty', () => {
    render(<ModelListEditor models={[]} onChange={onChange} defaultModels={defaultModels} />);
    expect(screen.getByText(/no models added yet/i)).toBeInTheDocument();
  });

  it('Add button is disabled when input is empty', () => {
    render(<ModelListEditor models={[]} onChange={onChange} defaultModels={defaultModels} />);
    expect(screen.getByRole('button', { name: /^add$/i })).toBeDisabled();
  });
});
