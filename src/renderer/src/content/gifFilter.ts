// Pure filter logic for the GIF picker's bundled pack (GifPicker.tsx) —
// the category chips and the search box both funnel through this so their
// behavior stays consistent. Kept dependency-free and pure so it's testable
// without React (gifFilter.test.ts).

export interface GifItem {
  url: string
  w: number
  h: number
  packId?: string
  /** Pack-only — `window.bridge.gifs.packList()`'s manifest category (e.g. "Ship it"). Absent for online search results. */
  category?: string
}

/**
 * Lowercased categories actually present in `pack`. A chip whose label has
 * no match here has nothing to show and should be hidden rather than open
 * onto an empty grid.
 */
export function packCategories(pack: readonly GifItem[]): Set<string> {
  const out = new Set<string>()
  for (const item of pack) {
    if (item.category) out.add(item.category.toLowerCase())
  }
  return out
}

/**
 * Filters the bundled pack for the picker's grid.
 *
 * - A selected `category` (a pressed chip) wins outright: every pack item
 *   whose `category` matches it case-insensitively, regardless of `query`.
 * - Otherwise, a typed `query` matches (case-insensitively) the item's
 *   `packId`, its `url`, or its `category` name.
 * - With neither, the whole pack passes through.
 */
export function filterPack(pack: readonly GifItem[], query: string, category: string | null): GifItem[] {
  if (category) {
    const c = category.toLowerCase()
    return pack.filter((p) => p.category?.toLowerCase() === c)
  }
  const q = query.trim().toLowerCase()
  if (!q) return pack.slice()
  return pack.filter(
    (p) =>
      p.packId?.toLowerCase().includes(q) ||
      p.url.toLowerCase().includes(q) ||
      p.category?.toLowerCase().includes(q),
  )
}
