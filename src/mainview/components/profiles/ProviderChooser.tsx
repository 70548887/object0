import type { Provider } from "@shared/profile.types";
import { ChevronRightIcon, CloudIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PROVIDERS } from "@/lib/constants";
import { useT } from "@/lib/i18n";

export function ProviderChoices({
  onSelect,
}: {
  onSelect: (provider: Provider) => void;
}) {
  const t = useT();
  return (
    <fieldset
      aria-label={t("存储服务商", "Storage provider")}
      className="grid min-w-0 grid-cols-1 gap-2 border-0 p-0 sm:grid-cols-2"
    >
      {PROVIDERS.map((provider) => (
        <Button
          key={provider.value}
          type="button"
          variant="outline"
          data-provider={provider.value}
          className="h-auto min-h-14 min-w-0 justify-start gap-3 px-3 py-3 text-left whitespace-normal"
          onClick={() => onSelect(provider.value)}
        >
          <CloudIcon
            aria-hidden="true"
            className="size-4 text-muted-foreground"
          />
          <span className="min-w-0 flex-1 break-words leading-snug">
            {provider.label}
          </span>
          <ChevronRightIcon
            aria-hidden="true"
            className="size-4 text-muted-foreground"
          />
        </Button>
      ))}
    </fieldset>
  );
}

export function ProviderChooser({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (provider: Provider) => void;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader className="pr-6">
          <DialogTitle>{t("添加存储账号", "Add storage account")}</DialogTitle>
          <DialogDescription>
            {t(
              "先选择存储服务商，再填写对应的连接信息。",
              "Choose a storage provider, then enter its connection details.",
            )}
          </DialogDescription>
        </DialogHeader>
        <ProviderChoices onSelect={onSelect} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("取消", "Cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
