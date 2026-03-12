import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ScienceCache } from './science-cache.js';

describe('ScienceCache', () => {
  let cacheDir: string;
  let cache: ScienceCache;

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protclaw-cache-test-'));
    cache = new ScienceCache(cacheDir);
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  describe('computeCacheKey', () => {
    it('produces deterministic keys', () => {
      const params = {
        toolName: 'rfdiffusion',
        toolVersion: '1.1.0',
        imageDigest: 'sha256:abc123',
        inputParams: { contigs: '100-100', num_designs: 5 },
        inputFilesHashes: ['hash1', 'hash2'],
      };

      const key1 = cache.computeCacheKey(params);
      const key2 = cache.computeCacheKey(params);
      expect(key1).toBe(key2);
    });

    it('produces 64-char hex strings (SHA256)', () => {
      const key = cache.computeCacheKey({
        toolName: 'test',
        toolVersion: '1.0.0',
        imageDigest: 'sha256:xyz',
        inputParams: {},
        inputFilesHashes: [],
      });
      expect(key).toHaveLength(64);
      expect(key).toMatch(/^[0-9a-f]+$/);
    });

    it('changes when toolName changes', () => {
      const base = {
        toolVersion: '1.0.0',
        imageDigest: 'sha256:abc',
        inputParams: { x: 1 },
        inputFilesHashes: [],
      };

      const key1 = cache.computeCacheKey({ ...base, toolName: 'tool_a' });
      const key2 = cache.computeCacheKey({ ...base, toolName: 'tool_b' });
      expect(key1).not.toBe(key2);
    });

    it('changes when inputParams change', () => {
      const base = {
        toolName: 'test',
        toolVersion: '1.0.0',
        imageDigest: 'sha256:abc',
        inputFilesHashes: [],
      };

      const key1 = cache.computeCacheKey({ ...base, inputParams: { x: 1 } });
      const key2 = cache.computeCacheKey({ ...base, inputParams: { x: 2 } });
      expect(key1).not.toBe(key2);
    });

    it('changes when file hashes change', () => {
      const base = {
        toolName: 'test',
        toolVersion: '1.0.0',
        imageDigest: 'sha256:abc',
        inputParams: {},
      };

      const key1 = cache.computeCacheKey({
        ...base,
        inputFilesHashes: ['aaa'],
      });
      const key2 = cache.computeCacheKey({
        ...base,
        inputFilesHashes: ['bbb'],
      });
      expect(key1).not.toBe(key2);
    });

    it('handles optional modelCheckpoint', () => {
      const base = {
        toolName: 'test',
        toolVersion: '1.0.0',
        imageDigest: 'sha256:abc',
        inputParams: {},
        inputFilesHashes: [],
      };

      const key1 = cache.computeCacheKey(base);
      const key2 = cache.computeCacheKey({
        ...base,
        modelCheckpoint: 'checkpoint_v2',
      });
      expect(key1).not.toBe(key2);
    });
  });

  describe('get/set', () => {
    it('returns null for missing cache entry', async () => {
      const result = await cache.get('nonexistent-key');
      expect(result).toBeNull();
    });

    it('stores and retrieves a result', async () => {
      const key = 'test-cache-key-123';
      const result = { status: 'success', metrics: { rmsd: 1.5 } };

      await cache.set(key, result, []);
      const cached = await cache.get(key);
      expect(cached).toEqual(result);
    });

    it('stores result with output files', async () => {
      const key = 'test-key-with-files';
      const result = { status: 'success', output_files: ['out.pdb'] };

      // Create a temp file to cache
      const tempFile = path.join(cacheDir, 'temp_output.pdb');
      fs.writeFileSync(tempFile, 'ATOM data');

      await cache.set(key, result, [tempFile]);

      const cached = await cache.get(key);
      expect(cached).toEqual(result);

      // Verify file was copied to cache
      const cachedFile = path.join(cacheDir, key, 'files', 'temp_output.pdb');
      expect(fs.existsSync(cachedFile)).toBe(true);
    });
  });

  describe('has', () => {
    it('returns false for missing entry', () => {
      expect(cache.has('no-such-key')).toBe(false);
    });

    it('returns true for existing entry', async () => {
      await cache.set('my-key', { status: 'ok' }, []);
      expect(cache.has('my-key')).toBe(true);
    });
  });

  describe('delete', () => {
    it('removes a cache entry', async () => {
      await cache.set('del-key', { status: 'ok' }, []);
      expect(cache.has('del-key')).toBe(true);

      await cache.delete('del-key');
      expect(cache.has('del-key')).toBe(false);
    });

    it('does not throw when deleting non-existent entry', async () => {
      await expect(cache.delete('nope')).resolves.toBeUndefined();
    });
  });

  describe('restoreOutputFiles', () => {
    it('restores cached files to destination directory', async () => {
      const key = 'restore-test';
      const result = { status: 'success' };

      // Create a temp file and cache it
      const tempFile = path.join(cacheDir, 'data.pdb');
      fs.writeFileSync(tempFile, 'PDB content here');
      await cache.set(key, result, [tempFile]);

      // Restore to a new directory
      const destDir = path.join(cacheDir, 'restored');
      const restored = await cache.restoreOutputFiles(key, destDir);

      expect(restored).toBe(true);
      expect(fs.existsSync(path.join(destDir, 'data.pdb'))).toBe(true);
      expect(fs.readFileSync(path.join(destDir, 'data.pdb'), 'utf-8')).toBe(
        'PDB content here',
      );
    });

    it('returns false for non-existent cache key', async () => {
      const destDir = path.join(cacheDir, 'dest');
      const restored = await cache.restoreOutputFiles('nope', destDir);
      expect(restored).toBe(false);
    });
  });

  describe('hashFile', () => {
    it('produces deterministic file hashes', () => {
      const tempFile = path.join(cacheDir, 'hashtest.txt');
      fs.writeFileSync(tempFile, 'hello world');

      const hash1 = ScienceCache.hashFile(tempFile);
      const hash2 = ScienceCache.hashFile(tempFile);
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
    });

    it('changes when file content changes', () => {
      const tempFile = path.join(cacheDir, 'hashtest2.txt');
      fs.writeFileSync(tempFile, 'content A');
      const hash1 = ScienceCache.hashFile(tempFile);

      fs.writeFileSync(tempFile, 'content B');
      const hash2 = ScienceCache.hashFile(tempFile);

      expect(hash1).not.toBe(hash2);
    });
  });
});
