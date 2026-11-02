import { localize, useT } from "@/lib/i18n";
import type { QiniuCapability } from "./types";

export function QiniuCapabilityNote({
  capability,
  id,
}: {
  capability: QiniuCapability;
  id?: string;
}) {
  const t = useT();
  if (capability.state === "supported" && !capability.reason) return null;
  const fallback =
    capability.state === "forbidden"
      ? t(
          "当前凭据没有此操作权限。",
          "The current credentials do not permit this operation.",
        )
      : capability.state === "unsupported"
        ? t(
            "当前部署不支持此操作。",
            "This deployment does not support this operation.",
          )
        : t(
            "能力尚未确认，请先刷新空间信息或测试连接。",
            "This capability is not confirmed. Refresh bucket information or test the connection first.",
          );
  return (
    <p id={id} className="text-xs leading-relaxed text-muted-foreground">
      {capability.reason ? localize(capability.reason) : fallback}
    </p>
  );
}
