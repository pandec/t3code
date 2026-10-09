// Null prototype, like every record readCustomModelIcons returns: lookups by
// user-authored slugs (e.g. "constructor") must miss cleanly.
const EMPTY_ICON_RECORD: Readonly<Record<string, string>> = Object.freeze(Object.create(null));

/**
 * Fork: read a provider instance's per-custom-model icon overrides from its
 * `providerInstances[id].config.customModelIcons` blob (slug → model icon id:
 * a provider driver kind or an extra family id such as "zai"). Keys and values
 * are trimmed so hand-edited settings still match normalized model slugs.
 */
export function readCustomModelIcons(instanceConfig: unknown): Readonly<Record<string, string>> {
  if (instanceConfig === null || typeof instanceConfig !== "object") return EMPTY_ICON_RECORD;
  const value = (instanceConfig as Record<string, unknown>).customModelIcons;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return EMPTY_ICON_RECORD;
  }
  const icons: Record<string, string> = Object.create(null);
  for (const [slug, icon] of Object.entries(value)) {
    if (typeof icon !== "string") continue;
    const key = slug.trim();
    const trimmedIcon = icon.trim();
    if (key.length > 0 && trimmedIcon.length > 0) {
      icons[key] = trimmedIcon;
    }
  }
  return icons;
}

/** The icon override for one custom model, or `undefined`. */
export function customModelIcon(
  icons: Readonly<Record<string, string>>,
  slug: string,
): string | undefined {
  // hasOwn, not a bare index: slugs are user-authored, and "constructor"
  // must not resolve to an Object.prototype member.
  return Object.hasOwn(icons, slug) ? icons[slug] : undefined;
}
