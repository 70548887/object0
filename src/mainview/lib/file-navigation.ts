/** S3 prefixes are opaque: preserve empty, percent and dot segments verbatim. */
export function directoryCrumbs(prefix: string) {
  const segments = prefix.endsWith("/")
    ? prefix.slice(0, -1).split("/")
    : prefix.split("/");
  if (!prefix) return [];
  return segments.map((label, index) => ({
    label,
    prefix: `${segments.slice(0, index + 1).join("/")}/`,
  }));
}

export function parentDirectory(prefix: string) {
  if (!prefix) return "";
  const parts = prefix.replace(/\/$/, "").split("/");
  parts.pop();
  return parts.length ? `${parts.join("/")}/` : "";
}
