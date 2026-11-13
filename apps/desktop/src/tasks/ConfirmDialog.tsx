import { useCallback, useEffect, useRef, useState } from 'react';

export interface ConfirmDialogOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}

export function ConfirmDialog({
  dialog,
  busy = false,
  onClose,
  onConfirm,
}: {
  dialog: ConfirmDialogOptions | null;
  busy?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    if (!dialog || busy) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, busy, onClose]);

  if (!dialog) return null;
  return (
    <div
      className="task-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="task-modal task-confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-label={dialog.title}
      >
        <header>
          <strong>{dialog.title}</strong>
          <button type="button" disabled={busy} onClick={onClose}>
            关闭
          </button>
        </header>
        <div className="task-modal-body">
          <p className="task-confirm-message">{dialog.message}</p>
        </div>
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className={dialog.danger ? 'task-danger' : 'task-primary'}
            disabled={busy}
            onClick={onConfirm}
          >
            {dialog.confirmLabel ?? '确定'}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Shared promise-based confirmation dialog hook replacing native window.confirm. */
export function useConfirmDialog() {
  const [dialog, setDialog] = useState<ConfirmDialogOptions | null>(null);
  const resolverRef = useRef<((confirmed: boolean) => void) | null>(null);

  const settle = useCallback((confirmed: boolean) => {
    setDialog(null);
    const resolve = resolverRef.current;
    resolverRef.current = null;
    resolve?.(confirmed);
  }, []);

  const askConfirm = useCallback((options: ConfirmDialogOptions) => {
    resolverRef.current?.(false);
    setDialog(options);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  return {
    askConfirm,
    confirmDialog: (
      <ConfirmDialog
        dialog={dialog}
        onClose={() => settle(false)}
        onConfirm={() => settle(true)}
      />
    ),
  };
}
