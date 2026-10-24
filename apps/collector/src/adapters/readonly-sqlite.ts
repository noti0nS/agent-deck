import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Opens any foreign SQLite database strictly read-only (`mode=ro&immutable=1`).
 * Never holds handles open across calls; falls back to copy-then-read if locked (§12 R5).
 */
export function withReadonlySqlite<T>(dbPath: string, fn: (db: Database.Database) => T): T {
  if (!existsSync(dbPath)) {
    throw new Error(`SQLite file not found: ${dbPath}`);
  }

  // Try URI with mode=ro&immutable=1 first, falling back to readonly Database option on Windows drive paths
  try {
    const uri = `${pathToFileURL(dbPath).href}?mode=ro&immutable=1`;
    const db = new Database(uri, { readonly: true, fileMustExist: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } catch {
    try {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        return fn(db);
      } finally {
        db.close();
      }
    } catch {
      // Copy-then-read fallback if foreign WAL lock contention ever occurs (§12 R5)
      const tempDir = join(tmpdir(), 'opencode-agent-deck-ro');
      mkdirSync(tempDir, { recursive: true });
      const tempFile = join(tempDir, `${Date.now()}-${Math.random().toString(36).slice(2)}-${basename(dbPath)}`);
      copyFileSync(dbPath, tempFile);
      const db = new Database(tempFile, { readonly: true, fileMustExist: true });
      try {
        return fn(db);
      } finally {
        db.close();
        try {
          unlinkSync(tempFile);
        } catch {
          // ignore
        }
      }
    }
  }
}
