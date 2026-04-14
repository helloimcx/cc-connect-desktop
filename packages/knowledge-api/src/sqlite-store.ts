import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { KnowledgeBase, KnowledgeFile, KnowledgeFolder } from '../../contracts/src/index.js';

const SCHEMA_VERSION = '1';

interface LegacyKnowledgeStore {
  folders?: KnowledgeFolder[];
  knowledgeBases?: KnowledgeBase[];
}

type KnowledgeBaseRow = {
  id: string;
  name: string;
  description: string;
  folder_id: string | null;
  creator_name: string;
  icon: string;
  created_at: string;
  updated_at: string;
  file_count: number;
  word_count: number;
};

type KnowledgeFolderRow = {
  id: string;
  name: string;
  parent_id: string | null;
  path: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

type KnowledgeFileRow = {
  knowledgebase_id: string | null;
  file_id: string;
  file_name: string;
  file_type: string;
  file_size: number;
  folder: string | null;
  create_time: string;
  word_count: number | null;
  metadata_json: string | null;
  abstract: string | null;
  full_content: string | null;
  updated_at: string;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function parseMetadata(raw: string | null) {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function cleanupDatabaseFiles(dbPath: string) {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
}

export class KnowledgeSqliteStore {
  private readonly dbPath: string;
  private readonly legacyStorePath: string;
  private readonly legacyBackupPath: string;
  private readonly db: DatabaseSync;

  constructor(options: { userDataPath: string }) {
    this.dbPath = join(options.userDataPath, 'runtime', 'knowledge.db');
    this.legacyStorePath = join(options.userDataPath, 'runtime', 'knowledge-store.json');
    this.legacyBackupPath = `${this.legacyStorePath}.bak`;

    mkdirSync(dirname(this.dbPath), { recursive: true });

    const shouldMigrate = !existsSync(this.dbPath) && existsSync(this.legacyStorePath);
    this.db = new DatabaseSync(this.dbPath);

    try {
      this.initializeSchema();
      if (shouldMigrate) {
        this.migrateLegacyJson();
      }
    } catch (error) {
      this.db.close();
      if (shouldMigrate) {
        cleanupDatabaseFiles(this.dbPath);
      }
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  listFolders(): KnowledgeFolder[] {
    const rows = this.db.prepare(`
      SELECT id, name, parent_id, path, sort_order, created_at, updated_at
      FROM knowledge_folders
      ORDER BY path ASC, sort_order ASC
    `).all() as KnowledgeFolderRow[];
    return rows.map((row) => this.mapFolder(row));
  }

  getFolder(id: string): KnowledgeFolder | null {
    const row = this.db.prepare(`
      SELECT id, name, parent_id, path, sort_order, created_at, updated_at
      FROM knowledge_folders
      WHERE id = ?
      LIMIT 1
    `).get(id) as KnowledgeFolderRow | undefined;
    return row ? this.mapFolder(row) : null;
  }

  insertFolder(folder: KnowledgeFolder): KnowledgeFolder {
    this.db.prepare(`
      INSERT INTO knowledge_folders (
        id, name, parent_id, path, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      folder.id,
      folder.name,
      folder.parentId,
      folder.path,
      folder.sortOrder,
      folder.createdAt,
      folder.updatedAt,
    );
    return clone(folder);
  }

  renameFolder(id: string, input: { name: string; previousPath: string; nextPath: string; updatedAt: string }) {
    this.transaction(() => {
      const updateResult = this.db.prepare(`
        UPDATE knowledge_folders
        SET name = ?, path = ?, updated_at = ?
        WHERE id = ?
      `).run(input.name, input.nextPath, input.updatedAt, id);
      if (Number(updateResult.changes || 0) === 0) {
        throw new Error('Folder does not exist.');
      }

      this.db.prepare(`
        UPDATE knowledge_folders
        SET path = replace(path, ?, ?), updated_at = ?
        WHERE id <> ? AND path LIKE ?
      `).run(input.previousPath, input.nextPath, input.updatedAt, id, `${input.previousPath}/%`);
    });

    const folder = this.getFolder(id);
    if (!folder) {
      throw new Error('Folder does not exist.');
    }
    return folder;
  }

  deleteFolder(id: string) {
    this.db.prepare('DELETE FROM knowledge_folders WHERE id = ?').run(id);
  }

  listKnowledgeBases(): KnowledgeBase[] {
    const rows = this.db.prepare(`
      SELECT
        bases.id,
        bases.name,
        bases.description,
        bases.folder_id,
        bases.creator_name,
        bases.icon,
        bases.created_at,
        bases.updated_at,
        COALESCE(stats.file_count, 0) AS file_count,
        COALESCE(stats.word_count, 0) AS word_count
      FROM knowledge_bases AS bases
      LEFT JOIN (
        SELECT
          knowledgebase_id,
          COUNT(*) AS file_count,
          COALESCE(SUM(COALESCE(word_count, 0)), 0) AS word_count
        FROM knowledge_files
        GROUP BY knowledgebase_id
      ) AS stats ON stats.knowledgebase_id = bases.id
      ORDER BY bases.updated_at DESC
    `).all() as KnowledgeBaseRow[];
    return rows.map((row) => this.mapKnowledgeBase(row));
  }

  getKnowledgeBase(id: string): KnowledgeBase | null {
    const row = this.db.prepare(`
      SELECT
        bases.id,
        bases.name,
        bases.description,
        bases.folder_id,
        bases.creator_name,
        bases.icon,
        bases.created_at,
        bases.updated_at,
        COALESCE(stats.file_count, 0) AS file_count,
        COALESCE(stats.word_count, 0) AS word_count
      FROM knowledge_bases AS bases
      LEFT JOIN (
        SELECT
          knowledgebase_id,
          COUNT(*) AS file_count,
          COALESCE(SUM(COALESCE(word_count, 0)), 0) AS word_count
        FROM knowledge_files
        GROUP BY knowledgebase_id
      ) AS stats ON stats.knowledgebase_id = bases.id
      WHERE bases.id = ?
      LIMIT 1
    `).get(id) as KnowledgeBaseRow | undefined;
    return row ? this.mapKnowledgeBase(row) : null;
  }

  insertKnowledgeBase(base: KnowledgeBase): KnowledgeBase {
    this.db.prepare(`
      INSERT INTO knowledge_bases (
        id, name, description, folder_id, creator_name, icon, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      base.id,
      base.name,
      base.description,
      base.folderId,
      base.creatorName,
      base.icon,
      base.createdAt,
      base.updatedAt,
    );
    return clone(base);
  }

  updateKnowledgeBase(base: KnowledgeBase): KnowledgeBase {
    const result = this.db.prepare(`
      UPDATE knowledge_bases
      SET name = ?, description = ?, folder_id = ?, creator_name = ?, icon = ?, updated_at = ?
      WHERE id = ?
    `).run(
      base.name,
      base.description,
      base.folderId,
      base.creatorName,
      base.icon,
      base.updatedAt,
      base.id,
    );
    if (Number(result.changes || 0) === 0) {
      throw new Error('Knowledge base does not exist.');
    }
    return this.getKnowledgeBase(base.id) || clone(base);
  }

  touchKnowledgeBase(id: string, updatedAt: string) {
    this.db.prepare('UPDATE knowledge_bases SET updated_at = ? WHERE id = ?').run(updatedAt, id);
  }

  deleteKnowledgeBase(id: string) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM knowledge_files WHERE knowledgebase_id = ?').run(id);
      this.db.prepare('DELETE FROM knowledge_bases WHERE id = ?').run(id);
    });
  }

  listKnowledgeBaseFiles(knowledgeBaseId: string): KnowledgeFile[] {
    const rows = this.db.prepare(`
      SELECT
        knowledgebase_id,
        file_id,
        file_name,
        file_type,
        file_size,
        folder,
        create_time,
        word_count,
        metadata_json,
        abstract,
        full_content,
        updated_at
      FROM knowledge_files
      WHERE knowledgebase_id = ?
      ORDER BY create_time DESC, file_name COLLATE NOCASE ASC
    `).all(knowledgeBaseId) as KnowledgeFileRow[];
    return rows.map((row) => this.mapKnowledgeFile(row));
  }

  upsertKnowledgeBaseFiles(files: KnowledgeFile[]) {
    if (files.length === 0) {
      return;
    }
    const statement = this.db.prepare(`
      INSERT INTO knowledge_files (
        knowledgebase_id,
        file_id,
        file_name,
        file_type,
        file_size,
        folder,
        create_time,
        word_count,
        metadata_json,
        abstract,
        full_content,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_id) DO UPDATE SET
        knowledgebase_id = excluded.knowledgebase_id,
        file_name = excluded.file_name,
        file_type = excluded.file_type,
        file_size = excluded.file_size,
        folder = excluded.folder,
        create_time = excluded.create_time,
        word_count = excluded.word_count,
        metadata_json = excluded.metadata_json,
        abstract = excluded.abstract,
        full_content = excluded.full_content,
        updated_at = excluded.updated_at
    `);

    this.transaction(() => {
      files.forEach((file) => {
        statement.run(
          file.knowledgebaseId || null,
          file.fileId,
          file.fileName,
          file.fileType,
          file.fileSize,
          file.folder || null,
          file.createTime,
          file.wordCount ?? null,
          file.metadata ? JSON.stringify(file.metadata) : null,
          file.abstract || null,
          file.fullContent || null,
          new Date().toISOString(),
        );
      });
    });
  }

  deleteKnowledgeBaseFile(fileId: string) {
    this.db.prepare('DELETE FROM knowledge_files WHERE file_id = ?').run(fileId);
  }

  hasFolderChildren(id: string) {
    const row = this.db.prepare(`
      SELECT 1 AS value
      FROM knowledge_folders
      WHERE parent_id = ?
      LIMIT 1
    `).get(id) as { value: number } | undefined;
    return Boolean(row?.value);
  }

  hasKnowledgeBasesInFolder(id: string) {
    const row = this.db.prepare(`
      SELECT 1 AS value
      FROM knowledge_bases
      WHERE folder_id = ?
      LIMIT 1
    `).get(id) as { value: number } | undefined;
    return Boolean(row?.value);
  }

  runInTransaction<T>(callback: () => T): T {
    return this.transaction(callback);
  }

  private initializeSchema() {
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS knowledge_folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_id TEXT,
        path TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS knowledge_bases (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        folder_id TEXT,
        creator_name TEXT NOT NULL,
        icon TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS knowledge_files (
        file_id TEXT PRIMARY KEY,
        knowledgebase_id TEXT,
        file_name TEXT NOT NULL,
        file_type TEXT NOT NULL,
        file_size INTEGER NOT NULL DEFAULT 0,
        folder TEXT,
        create_time TEXT NOT NULL,
        word_count INTEGER,
        metadata_json TEXT,
        abstract TEXT,
        full_content TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_folders_parent_id
        ON knowledge_folders (parent_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_bases_folder_id
        ON knowledge_bases (folder_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_files_knowledgebase_id
        ON knowledge_files (knowledgebase_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_files_create_time
        ON knowledge_files (create_time DESC);
    `);

    this.db.prepare(`
      INSERT INTO meta (key, value)
      VALUES ('schema_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(SCHEMA_VERSION);
  }

  private migrateLegacyJson() {
    if (!existsSync(this.legacyStorePath)) {
      return;
    }

    if (existsSync(this.legacyBackupPath)) {
      unlinkSync(this.legacyBackupPath);
    }
    renameSync(this.legacyStorePath, this.legacyBackupPath);

    try {
      const raw = JSON.parse(readFileSync(this.legacyBackupPath, 'utf8')) as LegacyKnowledgeStore;
      const folders = Array.isArray(raw.folders) ? raw.folders : [];
      const knowledgeBases = Array.isArray(raw.knowledgeBases) ? raw.knowledgeBases : [];

      this.transaction(() => {
        const insertFolder = this.db.prepare(`
          INSERT INTO knowledge_folders (
            id, name, parent_id, path, sort_order, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        const insertKnowledgeBase = this.db.prepare(`
          INSERT INTO knowledge_bases (
            id, name, description, folder_id, creator_name, icon, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        folders.forEach((folder) => {
          insertFolder.run(
            folder.id,
            folder.name,
            folder.parentId || null,
            folder.path,
            folder.sortOrder,
            folder.createdAt,
            folder.updatedAt,
          );
        });

        knowledgeBases.forEach((base) => {
          insertKnowledgeBase.run(
            base.id,
            base.name,
            base.description,
            base.folderId || null,
            base.creatorName,
            base.icon,
            base.createdAt,
            base.updatedAt,
          );
        });
      });
    } catch (error) {
      if (existsSync(this.legacyBackupPath) && !existsSync(this.legacyStorePath)) {
        renameSync(this.legacyBackupPath, this.legacyStorePath);
      }
      throw error;
    }
  }

  private transaction<T>(callback: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private mapFolder(row: KnowledgeFolderRow): KnowledgeFolder {
    return {
      id: row.id,
      name: row.name,
      parentId: row.parent_id,
      path: row.path,
      sortOrder: Number(row.sort_order || 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapKnowledgeBase(row: KnowledgeBaseRow): KnowledgeBase {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      folderId: row.folder_id,
      creatorName: row.creator_name,
      icon: row.icon,
      fileCount: Number(row.file_count || 0),
      wordCount: Number(row.word_count || 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapKnowledgeFile(row: KnowledgeFileRow): KnowledgeFile {
    return {
      knowledgebaseId: row.knowledgebase_id,
      fileId: row.file_id,
      fileName: row.file_name,
      fileType: row.file_type,
      fileSize: Number(row.file_size || 0),
      folder: row.folder,
      createTime: row.create_time,
      wordCount: typeof row.word_count === 'number' ? row.word_count : null,
      metadata: parseMetadata(row.metadata_json),
      abstract: row.abstract,
      fullContent: row.full_content,
    };
  }
}
