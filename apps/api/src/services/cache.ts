const MAX_SIZE = 500;

interface CacheEntry<T> {
  value: T;
  timestamp: number;
}

/**
 * Simple LRU cache with TTL.
 * Used to cache embeddings so repeated/identical queries skip the API call entirely.
 */
export class LRUCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize = MAX_SIZE, ttlMs = 3600_000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { value, timestamp: Date.now() });
  }

  get size(): number {
    return this.cache.size;
  }
}

function normalize(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, " ");
}

const embeddingCache = new LRUCache<number[]>(500, 3600_000);

export function getCachedEmbedding(text: string): number[] | undefined {
  return embeddingCache.get(normalize(text));
}

export function setCachedEmbedding(text: string, embedding: number[]): void {
  embeddingCache.set(normalize(text), embedding);
}
