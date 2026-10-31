import type React from "react";
import { localize, useT } from "@/lib/i18n";
import { IconLightbulb } from "@/lib/icons";

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  hint?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  hint,
}: EmptyStateProps) {
  useT();
  return (
    <div className="flex flex-col items-center justify-center py-16 text-foreground/50">
      {icon && <div className="mb-4 text-4xl opacity-40">{icon}</div>}
      <h3 className="font-semibold text-lg">{localize(title)}</h3>
      {description && (
        <p className="mx-4 mt-1 max-w-xl break-words text-center text-sm leading-relaxed">
          {localize(description)}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
      {hint && (
        <p className="mt-6 text-[10px] text-foreground/30">
          <IconLightbulb className="mr-1 inline size-3" />
          {localize(hint)}
        </p>
      )}
    </div>
  );
}
