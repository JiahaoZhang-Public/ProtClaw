/**
 * Science Cache for ProtClaw
 *
 * Provides deterministic caching for science tool executions.
 * Cache keys are computed from tool identity, input params, and file checksums.
 * Cached results include both the result JSON and output files.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface CacheKeyParams {
  /** Tool name (e.g., "rfdiffusion") */
  toolName: string;
  /** Tool version (e.g., "1.1.0") */
  toolVersion: string;
  /** Docker image digest for reproducibility */
  imageDigest: string;
  /** Model checkpoint identifier (optional) */
  modelCheckpoint?: string;
  /** Input parameters to the tool (excluding internal keys) */
  inputParams: Record<string, unknown>;
  /** SHA256 hashes of input files (sorted) */
  inputFilesHashes: string[];
}

interface CacheEntry {
  /** The tool result JSON */
  result: Record<string, unknown>;
  /** Relative paths of cached output files */
  outputFiles: string[];
  /** When this entry was created */
  createdAt: string;
  /** The cache key for verification */
  cacheKey: string;
}

export class ScienceCache {
  private cacheDir: string;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  /**
   * Compute a deterministic SHA256 cache key from tool identity,
   * parameters, and input file hashes.
   */
  computeCacheKey(params: CacheKeyParams): string {
    const hasher = crypto.createHash('sha256');

    // Tool identity
    hasher.update(`${params.toolName}:${params.toolVersion}`);

    // Image digest
    hasher.update(params.imageDigest);

    // Model checkpoint (if provided)
    if (params.modelCheckpoint) {
      hasher.update(params.modelCheckpoint);
    }

    // Sorted input params (deterministic JSON serialization)
    const sortedParams = JSON.stringify(params.inputParams, Object.keys(params.inputParams).sort());
    hasher.update(sortedParams);

    // Sorted input file hashes
    for (const hash of [...params.inputFilesHashes].sort()) {
      hasher.update(hash);
    }

    return hasher.digest('hex');
  }

  /**
   * Look up a cached result by cache key.
   * Returns the cached result object if found, null otherwise.
   */
  async get(cacheKey: string): Promise<Record<string, unknown> | null> {
    const entryDir = path.join(this.cacheDir, cacheKey);
    const metadataPath = path.join(entryDir, 'metadata.json');

    if (!fs.existsSync(metadataPath)) {
      return null;
    }

    try {
      const metadata: CacheEntry = JSON.parse(
        fs.readFileSync(metadataPath, 'utf-8'),
      );
      return metadata.result;
    } catch {
      return null;
    }
  }

  /**
   * Retrieve cached output files by copying them to a destination directory.
   * Returns true if all files were restored, false otherwise.
   */
  async restoreOutputFiles(
    cacheKey: string,
    destDir: string,
  ): Promise<boolean> {
    const entryDir = path.join(this.cacheDir, cacheKey);
    const filesDir = path.join(entryDir, 'files');
    const metadataPath = path.join(entryDir, 'metadata.json');

    if (!fs.existsSync(metadataPath) || !fs.existsSync(filesDir)) {
      return false;
    }

    try {
      const metadata: CacheEntry = JSON.parse(
        fs.readFileSync(metadataPath, 'utf-8'),
      );

      fs.mkdirSync(destDir, { recursive: true });

      for (const relPath of metadata.outputFiles) {
        const srcPath = path.join(filesDir, relPath);
        const dstPath = path.join(destDir, relPath);

        if (!fs.existsSync(srcPath)) {
          return false;
        }

        fs.mkdirSync(path.dirname(dstPath), { recursive: true });
        fs.copyFileSync(srcPath, dstPath);
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Store a result and its output files in the cache.
   */
  async set(
    cacheKey: string,
    result: Record<string, unknown>,
    outputFiles: string[],
  ): Promise<void> {
    const entryDir = path.join(this.cacheDir, cacheKey);
    const filesDir = path.join(entryDir, 'files');

    fs.mkdirSync(filesDir, { recursive: true });

    // Copy output files to cache
    const relativePaths: string[] = [];
    for (const filePath of outputFiles) {
      if (fs.existsSync(filePath)) {
        const fileName = path.basename(filePath);
        const destPath = path.join(filesDir, fileName);
        fs.copyFileSync(filePath, destPath);
        relativePaths.push(fileName);
      }
    }

    // Write metadata
    const entry: CacheEntry = {
      result,
      outputFiles: relativePaths,
      createdAt: new Date().toISOString(),
      cacheKey,
    };

    const metadataPath = path.join(entryDir, 'metadata.json');
    fs.writeFileSync(metadataPath, JSON.stringify(entry, null, 2));
  }

  /**
   * Check if a cache entry exists for the given key.
   */
  has(cacheKey: string): boolean {
    const metadataPath = path.join(this.cacheDir, cacheKey, 'metadata.json');
    return fs.existsSync(metadataPath);
  }

  /**
   * Remove a cache entry.
   */
  async delete(cacheKey: string): Promise<void> {
    const entryDir = path.join(this.cacheDir, cacheKey);
    if (fs.existsSync(entryDir)) {
      fs.rmSync(entryDir, { recursive: true, force: true });
    }
  }

  /**
   * Compute SHA256 hash of a file (for inputFilesHashes).
   */
  static hashFile(filePath: string): string {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  }
}
