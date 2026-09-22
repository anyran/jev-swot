export function isSelectionShortcut(event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "isComposing">): boolean {
  if (event.isComposing) return false;
  const isY = event.key.toLowerCase() === "y" || event.code === "KeyY";
  const isU = event.key.toLowerCase() === "u" || event.code === "KeyU";
  const primary = isY && event.shiftKey && !event.altKey && (event.ctrlKey || event.metaKey);
  const windowsFallback = isY && event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey;
  const macFallback = isU && event.metaKey && event.shiftKey && !event.altKey && !event.ctrlKey;
  return primary || windowsFallback || macFallback;
}
