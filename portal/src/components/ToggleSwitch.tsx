interface ToggleSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  description?: string;
}

export default function ToggleSwitch({
  checked,
  onChange,
  disabled = false,
  label,
  description,
}: ToggleSwitchProps) {
  const toggle = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-gray-950 disabled:opacity-50 ${checked ? 'bg-indigo-600' : 'bg-gray-700'}`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`}
      />
    </button>
  );

  if (!label) return toggle;

  return (
    <div className="flex items-center justify-between">
      <div>
        <span className="text-sm text-gray-200">{label}</span>
        {description && <p className="text-xs text-gray-500 mt-0.5">{description}</p>}
      </div>
      {toggle}
    </div>
  );
}
