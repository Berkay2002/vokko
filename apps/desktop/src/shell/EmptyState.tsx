import type { ReactNode } from "react";

/** An empty list: our two-bubbles art, one line, and the action that fills it (Add Friend, Create a Server). */
export function EmptyState({ text, className, children }: { text: string; className?: string; children?: ReactNode }) {
  return (
    <div className={className ? `people-empty ${className}` : "people-empty"}>
      <svg width="96" height="72" viewBox="0 0 96 72" fill="none" aria-hidden="true">
        <rect x="6" y="10" width="54" height="36" rx="12" fill="var(--background-mod-subtle)" />
        <path d="M18 46l-6 12 16-12z" fill="var(--background-mod-subtle)" />
        <rect x="36" y="26" width="54" height="36" rx="12" fill="var(--background-mod-normal)" />
        <path d="M78 62l6 8-16-8z" fill="var(--background-mod-normal)" />
        <circle cx="52" cy="44" r="3" fill="var(--interactive-icon-default)" />
        <circle cx="63" cy="44" r="3" fill="var(--interactive-icon-default)" />
        <circle cx="74" cy="44" r="3" fill="var(--interactive-icon-default)" />
      </svg>
      <span>{text}</span>
      {children && <div className="people-empty-actions">{children}</div>}
    </div>
  );
}
