import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  BookOpen,
  ChevronRight,
  FolderPlus,
  Folders,
  Library,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { Button, Card, EmptyState, Input, Modal, Textarea } from '@/components/ui';
import {
  createKnowledgeBase,
  createKnowledgeFolder,
  deleteKnowledgeBase,
  deleteKnowledgeFolder,
  getKnowledgeConfig,
  listKnowledgeBases,
  listKnowledgeFolders,
  updateKnowledgeBase,
  updateKnowledgeFolder,
} from '@cc/core-sdk/knowledge';
import { cn, formatTime } from '@/lib/utils';
import { KnowledgeNotice, type NoticeTone } from './KnowledgeNotice';
import type { KnowledgeBase, KnowledgeFolder } from '@cc/superai-contracts';

interface NoticeState {
  tone: NoticeTone;
  message: string;
}

function iconGlyph(icon: string) {
  switch (icon) {
    case 'file':
      return 'bg-blue-500';
    case 'spark':
      return 'bg-amber-500';
    case 'screen':
      return 'bg-fuchsia-500';
    default:
      return 'bg-indigo-500';
  }
}

function folderDepth(path: string) {
  return path.split('/').length - 1;
}

export default function KnowledgeHome() {
  const [loading, setLoading] = useState(true);
  const [folders, setFolders] = useState<KnowledgeFolder[]>([]);
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [configReady, setConfigReady] = useState(false);
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [baseModalOpen, setBaseModalOpen] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [baseName, setBaseName] = useState('');
  const [baseDescription, setBaseDescription] = useState('');
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [submitting, setSubmitting] = useState<'folder' | 'base' | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [config, folderPayload, basePayload] = await Promise.all([
        getKnowledgeConfig(),
        listKnowledgeFolders(),
        listKnowledgeBases(),
      ]);
      setConfigReady(Boolean(config.baseUrl));
      setFolders(folderPayload.folders || []);
      setBases(basePayload.bases || []);
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const folderIdSet = useMemo(() => {
    if (!selectedFolderId) {
      return null;
    }
    const selected = folders.find((folder) => folder.id === selectedFolderId);
    if (!selected) {
      return null;
    }
    const ids = new Set<string>([selected.id]);
    folders.forEach((folder) => {
      if (folder.path.startsWith(`${selected.path}/`)) {
        ids.add(folder.id);
      }
    });
    return ids;
  }, [folders, selectedFolderId]);

  const filteredBases = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    return bases.filter((base) => {
      const inFolder = !folderIdSet ? true : folderIdSet.has(base.folderId || '');
      if (!inFolder) {
        return false;
      }
      if (!trimmed) {
        return true;
      }
      return [base.name, base.description, base.creatorName].join(' ').toLowerCase().includes(trimmed);
    });
  }, [bases, folderIdSet, query]);

  const handleCreateFolder = useCallback(async () => {
    if (!folderName.trim()) {
      setNotice({ tone: 'warning', message: 'Folder name is required.' });
      return;
    }
    setSubmitting('folder');
    try {
      await createKnowledgeFolder({
        name: folderName.trim(),
        parentId: selectedFolderId,
      });
      setFolderName('');
      setFolderModalOpen(false);
      setNotice({ tone: 'success', message: 'Folder created.' });
      await refresh();
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSubmitting(null);
    }
  }, [folderName, refresh, selectedFolderId]);

  const handleCreateBase = useCallback(async () => {
    if (!baseName.trim()) {
      setNotice({ tone: 'warning', message: 'Knowledge base name is required.' });
      return;
    }
    setSubmitting('base');
    try {
      await createKnowledgeBase({
        name: baseName.trim(),
        description: baseDescription.trim(),
        folderId: selectedFolderId,
      });
      setBaseName('');
      setBaseDescription('');
      setBaseModalOpen(false);
      setNotice({ tone: 'success', message: 'Knowledge base created.' });
      await refresh();
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSubmitting(null);
    }
  }, [baseDescription, baseName, refresh, selectedFolderId]);

  const handleRenameFolder = useCallback(async (folder: KnowledgeFolder) => {
    const nextName = window.prompt('Rename folder', folder.name)?.trim();
    if (!nextName || nextName === folder.name) {
      return;
    }
    try {
      await updateKnowledgeFolder(folder.id, { name: nextName });
      setNotice({ tone: 'success', message: 'Folder updated.' });
      await refresh();
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [refresh]);

  const handleDeleteFolder = useCallback(async (folder: KnowledgeFolder) => {
    if (!window.confirm(`Delete folder "${folder.name}"?`)) {
      return;
    }
    try {
      await deleteKnowledgeFolder(folder.id);
      if (selectedFolderId === folder.id) {
        setSelectedFolderId(null);
      }
      setNotice({ tone: 'success', message: 'Folder deleted.' });
      await refresh();
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [refresh, selectedFolderId]);

  const handleEditBase = useCallback(async (base: KnowledgeBase) => {
    const nextName = window.prompt('Knowledge base name', base.name)?.trim();
    if (!nextName) {
      return;
    }
    const nextDescription = window.prompt('Description', base.description)?.trim() ?? base.description;
    try {
      await updateKnowledgeBase(base.id, {
        name: nextName,
        description: nextDescription,
      });
      setNotice({ tone: 'success', message: 'Knowledge base updated.' });
      await refresh();
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [refresh]);

  const handleDeleteBase = useCallback(async (base: KnowledgeBase) => {
    if (!window.confirm(`Delete knowledge base "${base.name}"?`)) {
      return;
    }
    try {
      await deleteKnowledgeBase(base.id);
      setNotice({ tone: 'success', message: 'Knowledge base deleted.' });
      await refresh();
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [refresh]);

  return (
    <div className="space-y-6 animate-fade-in">
      <KnowledgeNotice
        notice={notice}
        configReady={configReady}
        loading={loading}
        unconfiguredTitle="Knowledge search is not configured yet."
        unconfiguredHint="Knowledge base functionality is currently disabled."
        successClass="border-primary/20 bg-primary/10 text-primary dark:border-primary/25 dark:bg-primary/10 dark:text-blue-200"
      />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[300px_minmax(0,1fr)]">
        <Card className="app-panel p-0 overflow-hidden">
          <div className="border-b border-gray-200/80 px-5 py-4 dark:border-white/[0.08]">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold text-gray-900 dark:text-white">知识库</h2>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">创建目录并管理知识库分类。</p>
              </div>
              <Button size="sm" variant="secondary" onClick={() => setFolderModalOpen(true)}>
                <FolderPlus size={14} /> 文件夹
              </Button>
            </div>
          </div>

          <div className="px-5 py-4">
            <button
              type="button"
              onClick={() => setSelectedFolderId(null)}
              className={cn(
                'flex w-full items-center justify-between rounded-[16px] px-3 py-2.5 text-left text-sm transition-colors',
                !selectedFolderId
                  ? 'bg-primary/10 text-gray-900 ring-1 ring-primary/25 dark:text-white'
                  : 'hover:bg-gray-100/80 text-gray-600 dark:text-gray-300 dark:hover:bg-white/[0.06]',
              )}
            >
              <span className="flex items-center gap-2">
                <Folders size={16} />
                全部知识库
              </span>
              <span className="text-xs opacity-70">{bases.length}</span>
            </button>
          </div>

          <div className="max-h-[70vh] overflow-y-auto px-3 pb-4">
            {folders.length === 0 ? (
              <EmptyState message="还没有目录，先创建一个文件夹吧。" icon={Folders} />
            ) : (
              <div className="space-y-1">
                {folders.map((folder) => {
                  const isActive = folder.id === selectedFolderId;
                  return (
                    <div
                      key={folder.id}
                      className={cn(
                        'group rounded-[16px] px-2 py-1',
                        isActive ? 'bg-primary/10 ring-1 ring-primary/25' : 'hover:bg-gray-100/80 dark:hover:bg-white/[0.04]',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setSelectedFolderId(folder.id)}
                          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left"
                          style={{ paddingLeft: `${8 + folderDepth(folder.path) * 18}px` }}
                        >
                          <ChevronRight size={14} className="text-gray-400" />
                          <Folders size={15} className="text-amber-500" />
                          <span className="truncate text-sm text-gray-800 dark:text-gray-100">{folder.name}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleRenameFolder(folder)}
                          className="rounded-md p-1 text-gray-400 transition hover:bg-gray-200/70 hover:text-gray-700 dark:hover:bg-white/[0.08] dark:hover:text-white"
                          aria-label={`Rename ${folder.name}`}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteFolder(folder)}
                          className="rounded-md p-1 text-gray-400 transition hover:bg-red-500/10 hover:text-red-500"
                          aria-label={`Delete ${folder.name}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Card>

        <div className="space-y-5">
          <Card className="app-toolbar">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h2 className="text-xl font-semibold text-gray-900 dark:text-white">知识库列表</h2>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  目录筛选、本地搜索，以及知识库卡片概览都在这里。
                </p>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row">
                <div className="relative min-w-[260px]">
                  <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索名称、描述或创建者"
                    aria-label="搜索名称、描述或创建者"
                    className="pl-9"
                  />
                </div>
                <Button variant="secondary" onClick={() => setBaseModalOpen(true)}>
                  <Plus size={14} /> 创建知识库
                </Button>
              </div>
            </div>
          </Card>

          {loading ? (
            <Card className="app-panel">
              <div className="py-16 text-center text-sm text-gray-400">正在加载知识库…</div>
            </Card>
          ) : filteredBases.length === 0 ? (
            <Card className="app-panel">
              <EmptyState
                message={query ? '没有匹配的知识库。' : '还没有知识库，先创建一个开始上传文档。'}
                icon={Library}
              />
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2 2xl:grid-cols-3">
              {filteredBases.map((base) => (
                <Card
                  key={base.id}
                  className="group app-panel relative overflow-hidden p-5 hover:border-primary/25"
                >
                  <div className="absolute right-4 top-4 flex gap-1">
                    <button
                      type="button"
                      onClick={() => void handleEditBase(base)}
                      aria-label={`编辑 ${base.name}`}
                      className="rounded-lg p-2 text-gray-400 hover:bg-gray-100/90 hover:text-gray-700 dark:hover:bg-white/[0.08] dark:hover:text-white"
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDeleteBase(base)}
                      aria-label={`删除 ${base.name}`}
                      className="rounded-lg p-2 text-gray-400 hover:bg-red-500/10 hover:text-red-500"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>

                  <Link to={`/knowledge/${encodeURIComponent(base.id)}`} className="block space-y-5">
                    <div className="flex items-start gap-4">
                      <div className={`mt-1 flex h-11 w-11 items-center justify-center rounded-full text-white ${iconGlyph(base.icon)}`}>
                        <BookOpen size={22} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate pr-8 text-xl font-semibold text-gray-900 dark:text-white">{base.name}</h3>
                        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">创建者: {base.creatorName || '系统管理员'}</p>
                      </div>
                    </div>

                    <div className="min-h-[60px] text-sm leading-6 text-gray-600 dark:text-gray-300">
                      {base.description || '这个知识库还没有描述，点击进入后可以上传文件并开始检索。'}
                    </div>

                    <div className="grid grid-cols-2 gap-3 rounded-[16px] bg-black/[0.035] px-3 py-2 text-sm font-medium text-gray-700 dark:bg-white/[0.05] dark:text-gray-200">
                      <span>{base.fileCount} 文档数</span>
                      <span>{(base.wordCount / 1000).toFixed(base.wordCount > 0 ? 1 : 0)}k 字符</span>
                    </div>

                    <div className="text-xs text-gray-400 dark:text-gray-500">
                      更新于 {formatTime(base.updatedAt)}
                    </div>
                  </Link>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>

      <Modal open={folderModalOpen} onClose={() => setFolderModalOpen(false)} title="创建文件夹">
        <div className="space-y-4">
          <Input
            label="文件夹名称"
            value={folderName}
            onChange={(event) => setFolderName(event.target.value)}
            placeholder="例如：产品文档"
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setFolderModalOpen(false)}>取消</Button>
            <Button onClick={() => void handleCreateFolder()} loading={submitting === 'folder'}>创建</Button>
          </div>
        </div>
      </Modal>

      <Modal open={baseModalOpen} onClose={() => setBaseModalOpen(false)} title="创建知识库">
        <div className="space-y-4">
          <Input
            label="名称"
            value={baseName}
            onChange={(event) => setBaseName(event.target.value)}
            placeholder="例如：运营文档库"
          />
          <Textarea
            label="描述"
            rows={4}
            value={baseDescription}
            onChange={(event) => setBaseDescription(event.target.value)}
            placeholder="一句话说明这个知识库主要收录什么内容"
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setBaseModalOpen(false)}>取消</Button>
            <Button onClick={() => void handleCreateBase()} loading={submitting === 'base'}>创建</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
