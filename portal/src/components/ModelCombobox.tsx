import { useState, useRef, useEffect } from 'react';

interface ModelComboboxProps {
  value: string;
  onChange: (model: string) => void;
  options: string[];
  placeholder?: string;
  disabled?: boolean;
  /** When true, only allow selecting from the options list (no free-text). */
  strict?: boolean;
}

export default function ModelCombobox({ value, onChange, options, placeholder = 'e.g. gpt-4o', disabled, strict }: ModelComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = strict
    ? options.filter(o => o.toLowerCase().includes(search.toLowerCase()))
    : options.filter(o => o.toLowerCase().includes(value.toLowerCase()));

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch('');
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (strict) {
    return (
      <div ref={containerRef} className="relative">
        <button
          type="button"
          onClick={() => !disabled && setOpen(!open)}
          disabled={disabled}
          className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-indigo-500 w-48 disabled:opacity-50 text-left truncate"
        >
          {value || placeholder}
        </button>
        {open && (
          <div className="absolute z-50 top-full left-0 mt-1 w-48 bg-gray-800 border border-gray-700 rounded-lg shadow-lg overflow-hidden">
            {options.length > 5 && (
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Filter…"
                autoFocus
                className="w-full bg-gray-900 border-b border-gray-700 px-3 py-1.5 text-xs text-gray-200 focus:outline-none"
              />
            )}
            {filtered.map(opt => (
              <button
                key={opt}
                type="button"
                onMouseDown={e => {
                  e.preventDefault();
                  onChange(opt);
                  setOpen(false);
                  setSearch('');
                }}
                className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-700 transition-colors ${
                  opt === value ? 'text-indigo-400 bg-gray-700' : 'text-gray-200'
                }`}
              >
                {opt}
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-3 py-1.5 text-xs text-gray-500">No models match</div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        disabled={disabled}
        className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-indigo-500 w-48 disabled:opacity-50"
      />
      {open && filtered.length > 0 && (
        <div className="absolute z-50 top-full left-0 mt-1 w-48 bg-gray-800 border border-gray-700 rounded-lg shadow-lg overflow-hidden">
          {filtered.map(opt => (
            <button
              key={opt}
              type="button"
              onMouseDown={e => {
                e.preventDefault();
                onChange(opt);
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-700 transition-colors ${
                opt === value ? 'text-indigo-400 bg-gray-700' : 'text-gray-200'
              }`}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
