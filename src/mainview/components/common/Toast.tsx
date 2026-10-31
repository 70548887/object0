import {
  type Action,
  type ExternalToast,
  toast as sonnerToast,
  Toaster,
} from "sonner";
import { localize, useT } from "@/lib/i18n";
import { useThemeStore } from "@/stores";

function LocalizedMessage({ message }: { message: string }) {
  useT();
  return <>{localize(message)}</>;
}
function message(value: Parameters<typeof sonnerToast>[0]) {
  return typeof value === "string" ? (
    <LocalizedMessage message={value} />
  ) : (
    value
  );
}
function action(value: ExternalToast["action"]): ExternalToast["action"] {
  if (
    value &&
    typeof value === "object" &&
    "label" in value &&
    "onClick" in value
  ) {
    const original = value as Action;
    return {
      ...original,
      label:
        typeof original.label === "string" ? (
          <LocalizedMessage message={original.label} />
        ) : (
          original.label
        ),
    };
  }
  return value;
}
function options(value?: ExternalToast): ExternalToast | undefined {
  return value
    ? {
        ...value,
        description: message(value.description),
        action: action(value.action),
        cancel: action(value.cancel),
      }
    : undefined;
}
export const toast = {
  success: (...args: Parameters<typeof sonnerToast.success>) =>
    sonnerToast.success(message(args[0]), options(args[1])),
  error: (...args: Parameters<typeof sonnerToast.error>) =>
    sonnerToast.error(message(args[0]), options(args[1])),
  info: (...args: Parameters<typeof sonnerToast.info>) =>
    sonnerToast.info(message(args[0]), options(args[1])),
  warning: (...args: Parameters<typeof sonnerToast.warning>) =>
    sonnerToast.warning(message(args[0]), options(args[1])),
  loading: (...args: Parameters<typeof sonnerToast.loading>) =>
    sonnerToast.loading(message(args[0]), options(args[1])),
  dismiss: sonnerToast.dismiss,
};

/**
 * Sonner-powered Toast root component.
 * Mount once at the app root (e.g. in App.tsx).
 */
export function Toast() {
  const theme = useThemeStore((s) => s.theme);
  const sonnerTheme = theme === "dark" ? "dark" : "light";

  return (
    <Toaster
      theme={sonnerTheme}
      position="bottom-right"
      richColors
      closeButton
      toastOptions={{
        duration: 4000,
      }}
    />
  );
}
