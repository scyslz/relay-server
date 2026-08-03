import React from 'react';
import { AlertTriangle, Trash2, X } from 'lucide-react';

interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  type?: 'danger' | 'warning' | 'info';
  onConfirm: () => void;
  onClose: () => void;
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  isOpen,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  type = 'danger',
  onConfirm,
  onClose
}) => {
  if (!isOpen) return null;

  const isDanger = type === 'danger';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        <div className="p-5 sm:p-6 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center space-x-3">
              <div
                className={`p-2.5 rounded-xl border shrink-0 ${
                  isDanger
                    ? 'bg-rose-500/20 text-rose-400 border-rose-500/30'
                    : 'bg-amber-500/20 text-amber-400 border-amber-500/30'
                }`}
              >
                {isDanger ? (
                  <Trash2 className="w-5 h-5" />
                ) : (
                  <AlertTriangle className="w-5 h-5" />
                )}
              </div>
              <div>
                <h3 className="text-base sm:text-lg font-semibold text-slate-100">
                  {title}
                </h3>
              </div>
            </div>

            <button
              onClick={onClose}
              className="p-1 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <p className="text-xs sm:text-sm text-slate-300 leading-relaxed">
            {message}
          </p>

          <div className="flex items-center justify-end space-x-2.5 pt-2 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700/80 rounded-lg transition-colors"
            >
              {cancelText}
            </button>

            <button
              type="button"
              onClick={() => {
                onConfirm();
                onClose();
              }}
              className={`px-4 py-1.5 text-xs font-medium text-white rounded-lg shadow-sm transition-colors ${
                isDanger
                  ? 'bg-rose-600 hover:bg-rose-500'
                  : 'bg-amber-600 hover:bg-amber-500'
              }`}
            >
              {confirmText}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
