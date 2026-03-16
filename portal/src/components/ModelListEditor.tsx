import { useState } from 'react';
import ToggleSwitch from './ToggleSwitch';

interface ModelListEditorProps {
  models: string[] | null;
  onChange: (models: string[] | null) => void;
  defaultModels: string[];
  label?: string;
}

export default function ModelListEditor({ models, onChange, defaultModels, label = 'Available Models' }: ModelListEditorProps) {
  const [newModel, setNewModel] = useState('');

  const isCustom = models !== null;

  function handleToggle(checked: boolean) {
    onChange(checked ? [...defaultModels] : null);
  }

  function handleAdd() {
    const trimmed = newModel.trim();
    if (!trimmed || (models ?? []).includes(trimmed)) return;
    onChange([...(models ?? []), trimmed]);
    setNewModel('');
  }

  function handleRemove(model: string) {
    onChange((models ?? []).filter(m => m !== model));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAdd();
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">{label}</h3>
        {isCustom && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            Reset to defaults
          </button>
        )}
      </div>

      <ToggleSwitch checked={isCustom} onChange={handleToggle} label="Use custom model list" />

      {!isCustom && (
        <p className="text-xs text-gray-600">
          Defaults: {defaultModels.join(', ')}
        </p>
      )}

      {isCustom && (
        <div className="space-y-3">
          {models!.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {models!.map(m => (
                <span
                  key={m}
                  className="flex items-center gap-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
                >
                  {m}
                  <button
                    type="button"
                    onClick={() => handleRemove(m)}
                    className="text-gray-500 hover:text-red-400 transition-colors ml-1"
                    aria-label={`Remove ${m}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-gray-600 italic">No models added yet.</p>
          )}
          <div className="flex gap-2">
            <input
              type="text"
              value={newModel}
              onChange={e => setNewModel(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g. gpt-4o"
              className="flex-1 bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-indigo-500"
            />
            <button
              type="button"
              onClick={handleAdd}
              disabled={!newModel.trim()}
              className="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded transition-colors"
            >
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
