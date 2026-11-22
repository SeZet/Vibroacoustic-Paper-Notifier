"use client";

import { useFormStatus } from "react-dom";

export function SubmitButton({
  children,
  pendingText,
  className,
  title,
}: {
  children: React.ReactNode;
  pendingText?: string;
  className?: string;
  title?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending} title={title} aria-busy={pending}>
      {pending ? (pendingText ?? "Saving…") : children}
    </button>
  );
}
