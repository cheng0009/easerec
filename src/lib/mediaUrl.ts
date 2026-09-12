/** Build a dcmedia:// URL for a local file path (review playback). */
export function dcMediaUrl(p: string): string {
  const norm = (p || "").replace(/\\/g, "/");
  return "dcmedia:///" + norm.split("/").map(encodeURIComponent).join("/");
}
