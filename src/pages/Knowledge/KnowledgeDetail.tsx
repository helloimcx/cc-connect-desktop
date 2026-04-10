import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  FileSearch,
  FolderTree,
  Search,
  Settings,
  Trash2,
  Upload,
} from 'lucide-react';
import { Button, Card, EmptyState, Input } from '@/components/ui';
import {
  deleteKnowledgeBaseFile,
  getKnowledgeBase,
  getKnowledgeConfig,
  listKnowledgeBaseFiles,
  listKnowledgeFolders,
  searchKnowledgeBase,
  uploadKnowledgeBaseFiles,
} from '@/api/knowledge';
import { cn, formatTime } from '@/lib/utils';
import type { KnowledgeBase, KnowledgeFile, KnowledgeFolder, KnowledgeSearchResult } from '../../../packages/contracts/src';

type NoticeTone = 'success' | 'error' | 'warning';

function noticeClassName(tone: NoticeTone) {
  if (tone === 'success') {
    return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/30 dark:bg-emerald-950/20 dark:text-emerald-300';
  }
  if (tone === 'warning') {
    return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/30 dark:bg-amber-950/20 dark:text-amber-300';
  }
  return 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/30 dark:bg-red-950/20 dark:text-red-300';
}

export default function KnowledgeDetail() {
  const { knowledgebaseId = '' } = useParams<{ knowledgebaseId: string }>();
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [configReady, setConfigReady] = useState(false);
  const [base, setBase] = useState<KnowledgeBase | null>(null);
  const [folders, setFolders] = useState<KnowledgeFolder[]>([]);
  const [files, setFiles] = useState<KnowledgeFile[]>([]);
  const [results, setResults] = useState<KnowledgeSearchResult[]>([]);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<{ tone: NoticeTone; message: string } | null>(null);

  const refresh = useCallback(async () => {
    if (!knowledgebaseId) {
      return;
    }
    setLoading(true);
    try {
      const [config, baseDetail, folderPayload, filePayload] = await Promise.all([
        getKnowledgeConfig(),
        getKnowledgeBase(knowledgebaseId),
        listKnowledgeFolders(),
        listKnowledgeBaseFiles(knowledgebaseId).catch(() => ({ files: [] })),
      ]);
      setConfigReady(Boolean(config.baseUrl));
      setBase(baseDetail);
      setFolders(folderPayload.folders || []);
      setFiles(filePayload.files || []);
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoading(false);
    }
  }, [knowledgebaseId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activeFolder = useMemo(
    () => folders.find((folder) => folder.id === base?.folderId) || null,
    [base?.folderId, folders],
  );

  const handleFileUpload = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const nextFiles = Array.from(event.target.files || []);
    if (!knowledgebaseId || nextFiles.length === 0) {
      return;
    }

    setUploading(true);
    try {
      const config = await getKnowledgeConfig();
      await uploadKnowledgeBaseFiles(knowledgebaseId, {
        files: nextFiles,
        collection: config.defaultCollection,
        folder: activeFolder?.path,
      });
      setNotice({ tone: 'success', message: 'Files uploaded and indexed.' });
      await refresh();
      event.target.value = '';
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setUploading(false);
    }
  }, [activeFolder?.path, knowledgebaseId, refresh]);

  const handleDeleteFile = useCallback(async (file: KnowledgeFile) => {
    if (!knowledgebaseId || !window.confirm(`Delete file "${file.fileName}"?`)) {
      return;
    }
    try {
      await deleteKnowledgeBaseFile(knowledgebaseId, file.fileId);
      setNotice({ tone: 'success', message: 'File deleted.' });
      await refresh();
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [knowledgebaseId, refresh]);

  const handleSearch = useCallback(async () => {
    if (!knowledgebaseId || !query.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      const payload = await searchKnowledgeBase(knowledgebaseId, {
        query: query.trim(),
        limit: 8,
      });
      setResults(payload.results || []);
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSearching(false);
    }
  }, [knowledgebaseId, query]);

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/knowledge">
          <Button variant="secondary">
            <ArrowLeft size={14} /> 返回知识库
          </Button>
        </Link>
        {base && (
          <div className="text-sm text-gray-500 dark:text-gray-400">
            <span className="text-gray-900 dark:text-white">{base.name}</span>
            {activeFolder ? (
              <>
                <span className="mx-2">/</span>
                <span>{activeFolder.path}</span>
              </>
            ) : null}
          </div>
        )}
      </div>

      {notice && (
        <div className={`rounded-xl border px-4 py-3 text-sm ${noticeClassName(notice.tone)}`}>
          {notice.message}
        </div>
      )}

      {!configReady && !loading && (
        <div className={`rounded-2xl border px-5 py-4 ${noticeClassName('warning')}`}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium">Knowledge retrieval is not configured.</p>
              <p className="mt-1 text-sm opacity-90">
                Add the ai_vector connection in Workspace settings to upload files and search this knowledge base.
              </p>
            </div>
            <Link to="/workspace">
              <Button variant="secondary">
                <Settings size={14} /> Open Workspace
              </Button>
            </Link>
          </div>
        </div>
      )}

      {loading ? (
        <Card>
          <div className="py-16 text-center text-sm text-gray-400">正在加载知识库详情…</div>
        </Card>
      ) : !base ? (
        <Card>
          <EmptyState message="没有找到这个知识库。" icon={FolderTree} />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
            <Card className="space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">{base.name}</h1>
                  <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                    {base.description || '上传文档后，这个知识库会变成你当前项目的专属 RAG 索引。'}
                  </p>
                </div>
                <label className={cn(
                  'inline-flex cursor-pointer items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium',
                  configReady
                    ? 'bg-accent text-black hover:bg-accent-dim'
                    : 'bg-gray-200 text-gray-500 dark:bg-white/[0.08] dark:text-gray-500',
                )}>
                  <Upload size={14} />
                  {uploading ? '上传中…' : '上传文件'}
                  <input
                    type="file"
                    multiple
                    className="hidden"
                    disabled={!configReady || uploading}
                    onChange={(event) => void handleFileUpload(event)}
                  />
                </label>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="rounded-2xl border border-gray-200/80 px-4 py-4 dark:border-white/[0.08]">
                  <p className="text-xs uppercase tracking-wide text-gray-400">文档数</p>
                  <p className="mt-2 text-2xl font-semibold text-gray-900 dark:text-white">{files.length}</p>
                </div>
                <div className="rounded-2xl border border-gray-200/80 px-4 py-4 dark:border-white/[0.08]">
                  <p className="text-xs uppercase tracking-wide text-gray-400">字符统计</p>
                  <p className="mt-2 text-2xl font-semibold text-gray-900 dark:text-white">
                    {files.reduce((sum, file) => sum + Number(file.wordCount || 0), 0)}
                  </p>
                </div>
                <div className="rounded-2xl border border-gray-200/80 px-4 py-4 dark:border-white/[0.08]">
                  <p className="text-xs uppercase tracking-wide text-gray-400">最近更新</p>
                  <p className="mt-2 text-sm font-medium text-gray-900 dark:text-white">{formatTime(base.updatedAt)}</p>
                </div>
              </div>
            </Card>

            <Card className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">内容搜索</h2>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  在当前知识库内检索已解析内容，快速确认切块与召回效果。
                </p>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row">
                <div className="relative flex-1">
                  <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="例如：升级流程、性能测试结论"
                    className="pl-9"
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        void handleSearch();
                      }
                    }}
                  />
                </div>
                <Button onClick={() => void handleSearch()} disabled={!configReady || !query.trim()} loading={searching}>
                  <FileSearch size={14} /> 搜索
                </Button>
              </div>
              {results.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-gray-200/80 px-4 py-8 text-center text-sm text-gray-400 dark:border-white/[0.08]">
                  {query ? '还没有搜索结果。' : '输入关键词后可以查看召回片段。'}
                </div>
              ) : (
                <div className="space-y-3">
                  {results.map((result) => (
                    <div key={result.id} className="rounded-2xl border border-gray-200/80 px-4 py-4 dark:border-white/[0.08]">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="font-medium text-gray-900 dark:text-white">{result.title}</p>
                          <p className="mt-1 text-xs text-gray-400">chunk #{result.chunkOffset} · score {result.score.toFixed(4)}</p>
                        </div>
                        <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-500 dark:bg-white/[0.06] dark:text-gray-400">
                          {result.fileName}
                        </span>
                      </div>
                      <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-gray-600 dark:text-gray-300">
                        {result.snippet}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          <Card className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">文件列表</h2>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  当前知识库内已完成解析并入库的文件。
                </p>
              </div>
            </div>

            {files.length === 0 ? (
              <EmptyState message="还没有文件，上传文档后会出现在这里。" icon={Upload} />
            ) : (
              <div className="overflow-hidden rounded-2xl border border-gray-200/80 dark:border-white/[0.08]">
                <div className="grid grid-cols-[minmax(0,1.8fr)_120px_120px_160px_60px] gap-3 border-b border-gray-200/80 bg-gray-50/80 px-4 py-3 text-xs font-medium uppercase tracking-wide text-gray-500 dark:border-white/[0.08] dark:bg-white/[0.03]">
                  <span>文件</span>
                  <span>类型</span>
                  <span>字符数</span>
                  <span>创建时间</span>
                  <span />
                </div>
                {files.map((file) => (
                  <div
                    key={file.fileId}
                    className="grid grid-cols-[minmax(0,1.8fr)_120px_120px_160px_60px] gap-3 border-b border-gray-200/70 px-4 py-3 text-sm last:border-b-0 dark:border-white/[0.06]"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium text-gray-900 dark:text-white">{file.fileName}</p>
                      <p className="mt-1 truncate text-xs text-gray-400">{file.fileId}</p>
                    </div>
                    <span className="text-gray-600 dark:text-gray-300">{file.fileType}</span>
                    <span className="text-gray-600 dark:text-gray-300">{file.wordCount || 0}</span>
                    <span className="text-gray-600 dark:text-gray-300">{formatTime(file.createTime)}</span>
                    <button
                      type="button"
                      onClick={() => void handleDeleteFile(file)}
                      className="rounded-lg p-2 text-gray-400 hover:bg-red-500/10 hover:text-red-500"
                      aria-label={`Delete ${file.fileName}`}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
