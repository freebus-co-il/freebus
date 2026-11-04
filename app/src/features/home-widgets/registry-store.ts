/**
 * The registry's storage, free of React Native and the design system so it is
 * tested under node. `registry.ts` puts the home widget types on top.
 */

export type Registry<T extends { id: string }> = {
  /** Registration order is catalogue order. An id registered twice is a
   *  mistake, not a silent replacement. */
  register: (item: T) => void;
  list: () => T[];
  get: (id: string) => T | null;
  /** For tests only. */
  clear: () => void;
};

export function createRegistry<T extends { id: string }>(what: string): Registry<T> {
  const items = new Map<string, T>();
  return {
    register(item) {
      if (items.has(item.id)) throw new Error(`${what} "${item.id}" is registered twice`);
      items.set(item.id, item);
    },
    list: () => [...items.values()],
    get: (id) => items.get(id) ?? null,
    clear: () => items.clear(),
  };
}

/** An item's options as stored under its id, read through its own `parse`
 *  (defaults for anything unusable); undefined for an item with no options. */
export function resolveOptions<O>(
  item: { id: string; options?: { parse: (raw: unknown) => O } },
  stored: Readonly<Record<string, unknown>>,
): O {
  return (item.options ? item.options.parse(stored[item.id]) : undefined) as O;
}
