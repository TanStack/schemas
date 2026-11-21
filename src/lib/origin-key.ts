/**
 * Bedrock's own version on a model id: `-v1:0`, `-v1`, `-1:0`, then any
 * remaining `:N`. Only version 1 is read as Bedrock's: a maker's own
 * `-v4` (`cohere.embed-v4:0`) or `-v2` (`luma.ray-v2:0`) stays in the id.
 */
export const BEDROCK_VERSION = /(?:-v1(?::\d+)?|-1:\d+|:\d+)$/

/**
 * The key the name tier of `reconcileSameAs` (issue #719) matches rows by:
 * lowercase, a leading `maker/` dropped when `maker` is a provider id or a
 * claimed namespace (`prefixes`, lowercased), a Bedrock-form `maker.model`
 * id dropped to its model with Bedrock's version taken off, then dots read
 * as hyphens. Nothing here names a maker: the prefixes come from the
 * providers and `provider_model_namespaces` tables.
 */
export function originNameKey(
  rawId: string,
  prefixes: ReadonlySet<string>,
): string {
  let id = rawId.toLowerCase()
  const slash = id.indexOf('/')
  const dotted = /^([a-z0-9-]+)\.(.+)$/.exec(id)
  if (slash > 0 && prefixes.has(id.slice(0, slash))) {
    id = id.slice(slash + 1)
  } else if (dotted?.[1] && dotted[2] && prefixes.has(dotted[1])) {
    id = dotted[2].replace(BEDROCK_VERSION, '')
  }
  return id.replaceAll('.', '-')
}
