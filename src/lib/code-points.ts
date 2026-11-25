/** Take the first code points without changing the text within that bound. */
export function truncateCodePoints(text: string, limit: number): string {
  return Array.from(text).slice(0, limit).join("");
}
