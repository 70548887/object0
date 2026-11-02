import { t } from "@/lib/i18n";

export function physicalDropPoint(
  position: { x: number; y: number },
  scale: number,
): { x: number; y: number } | null {
  if (
    !Number.isFinite(scale) ||
    scale <= 0 ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y)
  )
    return null;
  return { x: position.x / scale, y: position.y / scale };
}

/** Native paths only; never manufacture a local path from File.name. */
export function droppedFileEntries(paths: readonly string[]) {
  if (!paths.length)
    throw new Error(t("未检测到拖入的文件", "No dropped files were detected"));
  const unique = new Set<string>();
  const names = new Set<string>();
  const result: Array<{ path: string; name: string }> = [];
  for (const path of paths) {
    if (
      typeof path !== "string" ||
      !path ||
      path.length > 32767 ||
      [...path].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      !(
        /^[A-Za-z]:[\\/]/.test(path) ||
        /^\\\\[^\\]+\\[^\\]+\\/.test(path) ||
        path.startsWith("/")
      )
    )
      throw new Error(
        t(
          "无法读取拖入文件的完整路径，请使用上传按钮。",
          "The dropped file's full path is unavailable. Use Upload instead.",
        ),
      );
    if (unique.has(path)) continue;
    unique.add(path);
    const windowsPath = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
    const name =
      (windowsPath ? path.split(/[\\/]/) : path.split("/")).pop() ?? "";
    if (!name || name === "." || name === "..")
      throw new Error(
        t(
          "请拖入文件；文件夹请使用“上传文件夹”。",
          "Drop files here; use Upload folder for folders.",
        ),
      );
    if (names.has(name))
      throw new Error(
        t(
          "本批次有相同文件名，未上传；请分批上传或先重命名，避免覆盖。",
          "This batch has duplicate filenames and was not uploaded. Rename them or upload separately to avoid overwriting.",
        ),
      );
    names.add(name);
    result.push({ path, name });
  }
  return result;
}

export function isFileDropPointInside(
  zone: HTMLElement | null,
  point: { x: number; y: number } | null,
  doc: Document,
): boolean {
  if (!zone || !point || zone.closest('[inert], [aria-hidden="true"]'))
    return false;
  const rect = zone.getBoundingClientRect();
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    point.x < rect.left ||
    point.x >= rect.right ||
    point.y < rect.top ||
    point.y >= rect.bottom
  )
    return false;
  const modal = [
    ...doc.querySelectorAll(
      '[role="dialog"], [role="alertdialog"], [data-slot="dialog-overlay"], [data-slot="sheet-overlay"]',
    ),
  ].some(
    (node) =>
      !node.hasAttribute("data-closed") && node.getClientRects().length > 0,
  );
  if (modal) return false;
  const hit = doc.elementFromPoint(point.x, point.y);
  return !!hit && zone.contains(hit);
}
