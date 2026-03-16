import { useEffect, useRef } from 'react';

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  confirmVariant?: 'danger' | 'primary';
  loading?: boolean;
}

export default function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'Confirm',
  confirmVariant = 'danger',
  loading = false,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      // Focus Cancel for danger dialogs (prevents accidental destructive action),
      // focus Confirm for primary dialogs
      if (confirmVariant === 'danger') {
        cancelRef.current?.focus();
      } else {
        confirmRef.current?.focus();
      }
    }
  }, [open, confirmVariant]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
      }
      // Focus trap: cycle between Cancel and Confirm
      if (e.key === 'Tab') {
        e.preventDefault();
        if (document.activeElement === confirmRef.current) {
          cancelRef.current?.focus();
        } else {
          confirmRef.current?.focus();
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const confirmBtnCls =
    confirmVariant === 'danger'
      ? 'bg-red-600 hover:bg-red-500 focus:ring-red-500'
      : 'bg-indigo-600 hover:bg-indigo-500 focus:ring-indigo-500';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        role="dialog"
        aria-label={title}
        className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-md mx-4 space-y-4"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-gray-100">{title}</h3>
        {description && <p className="text-sm text-gray-400">{description}</p>}
        <div className="flex justify-end gap-3 pt-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            disabled={loading}
            className="px-4 py-2 text-sm bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-lg transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className={`px-4 py-2 text-sm text-white rounded-lg transition-colors disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-900 ${confirmBtnCls}`}
          >
            {loading ? confirmLabel.replace(/e$/, '') + 'ing...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
