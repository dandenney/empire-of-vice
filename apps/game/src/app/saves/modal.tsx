// A modal <dialog> driven by React state: shown with showModal() (focus moves
// in and stays there; Escape closes it), and its native close reported back.

import { useEffect, useRef, type ReactNode } from "react";

export function Modal({
  open,
  onClose,
  labelledBy,
  testId,
  className,
  children,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly labelledBy: string;
  readonly testId: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} className={`modal ${className ?? ""}`} aria-labelledby={labelledBy} data-testid={testId} onClose={onClose}>
      {open && children}
    </dialog>
  );
}
