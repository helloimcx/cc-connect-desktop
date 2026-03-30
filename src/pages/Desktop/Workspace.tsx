import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Save, Trash2, Wrench } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { Button, Card, Input, Textarea } from '@/components/ui';
import {
  getRuntimeStatus,
  onRuntimeEvent,
  readConfigFile,
  restartDesktopService,
  saveDesktopSettings,
  saveRawConfigFile,
  saveStructuredConfigFile,
  startDesktopService,
  stopDesktopService,
} from '@/api/desktop';
import { DEFAULT_DESKTOP_AGENT_TYPE, DEFAULT_DESKTOP_OPENCODE_MODEL } from '../../../shared/desktop';
import type {
  DesktopConnectConfig,
  DesktopProjectConfig,
  DesktopRuntimeStatus,
} from '../../../shared/desktop';

type EditorTab = 'visual' | 'raw';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function ensureProjects(config: DesktopConnectConfig) {
  if (!Array.isArray(config.projects)) {
    config.projects = [];
  }
  return config.projects;
}

export default function DesktopWorkspace() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [runtime, setRuntime] = useState<DesktopRuntimeStatus | null>(null);
  const [configDraft, setConfigDraft] = useState<DesktopConnectConfig | null>(null);
  const [rawDraft, setRawDraft] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<EditorTab>('visual');
  const [binaryPath, setBinaryPath] = useState('');
  const [configPath, setConfigPath] = useState('');
  const [autoStartService, setAutoStartService] = useState(false);
  const [defaultProject, setDefaultProject] = useState('');
  const requestedProject = searchParams.get('project') || '';

  const loadAll = useCallback(async () => {
    const [nextRuntime, nextConfig] = await Promise.all([getRuntimeStatus(), readConfigFile()]);
    setRuntime(nextRuntime);
    setRawDraft(nextConfig.raw);
    setConfigDraft(nextConfig.parsed ? clone(nextConfig.parsed) : { projects: [] });
    setBinaryPath(nextRuntime.settings.binaryPath);
    setConfigPath(nextRuntime.settings.configPath);
    setAutoStartService(nextRuntime.settings.autoStartService);
    setDefaultProject(nextRuntime.settings.defaultProject);
    setSelectedIndex((current) => {
      const projects = nextConfig.parsed?.projects || [];
      const total = projects.length;
      if (requestedProject) {
        const matchedIndex = projects.findIndex((project) => project.name === requestedProject);
        if (matchedIndex >= 0) {
          return matchedIndex;
        }
      }
      return total === 0 ? 0 : Math.min(current, total - 1);
    });
  }, [requestedProject]);

  useEffect(() => {
    void loadAll();
    const stop = onRuntimeEvent((nextRuntime) => {
      setRuntime(nextRuntime);
    });
    return () => stop();
  }, [loadAll]);

  const projects = configDraft?.projects || [];
  const selectedProject = projects[selectedIndex];

  const projectNames = useMemo(() => projects.map((project) => project.name), [projects]);

  useEffect(() => {
    if (!selectedProject?.name) {
      return;
    }
    if (searchParams.get('project') === selectedProject.name) {
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.set('project', selectedProject.name);
    setSearchParams(next, { replace: true });
  }, [searchParams, selectedProject?.name, setSearchParams]);

  const updateSelectedProject = useCallback((updater: (project: DesktopProjectConfig) => DesktopProjectConfig) => {
    setConfigDraft((current) => {
      if (!current) {
        return current;
      }
      const next = clone(current);
      const project = ensureProjects(next)[selectedIndex];
      if (!project) {
        return current;
      }
      ensureProjects(next)[selectedIndex] = updater(project);
      return next;
    });
  }, [selectedIndex]);

  const handleSaveSettings = useCallback(async () => {
    setSaving(true);
    try {
      await saveDesktopSettings({
        binaryPath,
        configPath,
        autoStartService,
        defaultProject,
      });
      await loadAll();
    } finally {
      setSaving(false);
    }
  }, [autoStartService, binaryPath, configPath, defaultProject, loadAll]);

  const handleSaveVisual = useCallback(async () => {
    if (!configDraft) {
      return;
    }
    setSaving(true);
    try {
      const saved = await saveStructuredConfigFile(configDraft);
      setRawDraft(saved.raw);
      setConfigDraft(saved.parsed ? clone(saved.parsed) : configDraft);
      await loadAll();
    } finally {
      setSaving(false);
    }
  }, [configDraft, loadAll]);

  const handleSaveRaw = useCallback(async () => {
    setSaving(true);
    try {
      const saved = await saveRawConfigFile(rawDraft);
      setRawDraft(saved.raw);
      setConfigDraft(saved.parsed ? clone(saved.parsed) : configDraft);
      await loadAll();
    } finally {
      setSaving(false);
    }
  }, [configDraft, loadAll, rawDraft]);

  const handleAddProject = useCallback(() => {
    setConfigDraft((current) => {
      const next = clone(current || {});
      const projects = ensureProjects(next);
      projects.push({
        name: `project-${projects.length + 1}`,
        agent: {
          type: DEFAULT_DESKTOP_AGENT_TYPE,
          options: {
            model: DEFAULT_DESKTOP_OPENCODE_MODEL,
            work_dir: '.',
          },
          providers: [],
        },
        platforms: [],
        admin_from: '',
        disabled_commands: [],
      });
      return next;
    });
    setSelectedIndex(projects.length);
  }, [projects.length]);

  const handleRemoveProject = useCallback((index: number) => {
    setConfigDraft((current) => {
      if (!current) {
        return current;
      }
      const next = clone(current);
      ensureProjects(next).splice(index, 1);
      return next;
    });
    setSelectedIndex((current) => Math.max(0, current - (current >= index ? 1 : 0)));
  }, []);

  const handleSaveAndRestart = useCallback(async () => {
    await handleSaveVisual();
    await restartDesktopService();
    await loadAll();
  }, [handleSaveVisual, loadAll]);

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="grid grid-cols-1 lg:grid-cols-[360px_minmax(0,1fr)] gap-6">
        <Card className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Desktop Runtime</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Manage the local `cc-connect` process and where this app stores its runtime files.
            </p>
          </div>

          <Input label="cc-connect binary" value={binaryPath} onChange={(event) => setBinaryPath(event.target.value)} />
          <Input label="Config file" value={configPath} onChange={(event) => setConfigPath(event.target.value)} />
          <Input label="Default chat project" value={defaultProject} onChange={(event) => setDefaultProject(event.target.value)} />

          <label className="flex items-center gap-3 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={autoStartService}
              onChange={(event) => setAutoStartService(event.target.checked)}
            />
            Auto-start `cc-connect` when the desktop app opens
          </label>

          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => void handleSaveSettings()} loading={saving}>
              <Save size={14} /> Save desktop settings
            </Button>
            <Button variant="secondary" onClick={() => void startDesktopService().then(loadAll)}>
              Start
            </Button>
            <Button variant="secondary" onClick={() => void stopDesktopService().then(loadAll)}>
              Stop
            </Button>
          </div>

          <div className="rounded-xl border border-gray-200/80 dark:border-white/[0.08] px-4 py-3 text-sm">
            <p className="font-medium text-gray-900 dark:text-white">
              Service status: <span className="text-accent">{runtime?.service.status || 'unknown'}</span>
            </p>
            <p className="text-gray-500 dark:text-gray-400 mt-1 break-all">
              Management API: {runtime?.managementBaseUrl || '-'}
            </p>
            {runtime?.service.lastError && (
              <p className="text-red-500 mt-2">{runtime.service.lastError}</p>
            )}
          </div>
        </Card>

        <Card className="space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Workspace Config</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Unified desktop configuration for runtime, projects, providers, and platforms. Keep advanced option maps in raw TOML.
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant={tab === 'visual' ? 'primary' : 'secondary'} size="sm" onClick={() => setTab('visual')}>
                Visual
              </Button>
              <Button variant={tab === 'raw' ? 'primary' : 'secondary'} size="sm" onClick={() => setTab('raw')}>
                Raw TOML
              </Button>
            </div>
          </div>

          {tab === 'visual' ? (
            <div className="grid grid-cols-[260px_minmax(0,1fr)] gap-5 min-h-[560px]">
              <div className="space-y-3 border-r border-gray-200/80 dark:border-white/[0.08] pr-5">
                <div className="flex items-center justify-between">
                  <h3 className="font-medium text-gray-900 dark:text-white">Projects</h3>
                  <Button size="sm" onClick={handleAddProject}>
                    <Plus size={14} /> Add
                  </Button>
                </div>
                <div className="space-y-2">
                  {projects.map((project, index) => (
                    <button
                      key={`${project.name}-${index}`}
                      onClick={() => setSelectedIndex(index)}
                      className={`w-full text-left rounded-xl px-4 py-3 border transition-colors ${
                        index === selectedIndex
                          ? 'border-accent/40 bg-accent/10'
                          : 'border-transparent bg-gray-100/70 dark:bg-white/[0.04] hover:bg-gray-100 dark:hover:bg-white/[0.08]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-gray-900 dark:text-white truncate">{project.name}</span>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleRemoveProject(index);
                          }}
                          className="text-gray-400 hover:text-red-500"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 truncate">
                        {project.agent?.type || 'unknown'} · {project.platforms?.length || 0} platforms
                      </p>
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-5">
                {!selectedProject ? (
                  <div className="h-full flex items-center justify-center text-sm text-gray-400">
                    Add a project to begin editing.
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-4">
                      <Input
                        label="Project name"
                        value={selectedProject.name}
                        onChange={(event) =>
                          updateSelectedProject((project) => ({ ...project, name: event.target.value }))
                        }
                      />
                      <Input
                        label="Agent type"
                        value={selectedProject.agent?.type || ''}
                        onChange={(event) =>
                          updateSelectedProject((project) => ({
                            ...project,
                            agent: { ...project.agent, type: event.target.value },
                          }))
                        }
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <Input
                        label="Work dir"
                        value={String(selectedProject.agent?.options?.work_dir || '')}
                        onChange={(event) =>
                          updateSelectedProject((project) => ({
                            ...project,
                            agent: {
                              ...project.agent,
                              options: {
                                ...(project.agent.options || {}),
                                work_dir: event.target.value,
                              },
                            },
                          }))
                        }
                      />
                      <Input
                        label="Admin from"
                        value={selectedProject.admin_from || ''}
                        onChange={(event) =>
                          updateSelectedProject((project) => ({ ...project, admin_from: event.target.value }))
                        }
                      />
                    </div>

                    <Input
                      label="Disabled commands"
                      value={(selectedProject.disabled_commands || []).join(', ')}
                      onChange={(event) =>
                        updateSelectedProject((project) => ({
                          ...project,
                          disabled_commands: event.target.value
                            .split(',')
                            .map((item) => item.trim())
                            .filter(Boolean),
                        }))
                      }
                    />

                    <section className="space-y-3">
                      <div className="flex items-center justify-between">
                        <h3 className="font-medium text-gray-900 dark:text-white">Providers</h3>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            updateSelectedProject((project) => ({
                              ...project,
                              agent: {
                                ...project.agent,
                                providers: [
                                  ...(project.agent.providers || []),
                                  { name: `provider-${(project.agent.providers || []).length + 1}` },
                                ],
                              },
                            }))
                          }
                        >
                          <Plus size={14} /> Provider
                        </Button>
                      </div>
                      {(selectedProject.agent.providers || []).map((provider, index) => (
                        <div key={`${provider.name}-${index}`} className="grid grid-cols-[repeat(4,minmax(0,1fr))_40px] gap-3">
                          <Input
                            label="Name"
                            value={provider.name}
                            onChange={(event) =>
                              updateSelectedProject((project) => {
                                const providers = [...(project.agent.providers || [])];
                                providers[index] = { ...providers[index], name: event.target.value };
                                return { ...project, agent: { ...project.agent, providers } };
                              })
                            }
                          />
                          <Input
                            label="API key"
                            value={provider.api_key || ''}
                            onChange={(event) =>
                              updateSelectedProject((project) => {
                                const providers = [...(project.agent.providers || [])];
                                providers[index] = { ...providers[index], api_key: event.target.value };
                                return { ...project, agent: { ...project.agent, providers } };
                              })
                            }
                          />
                          <Input
                            label="Base URL"
                            value={provider.base_url || ''}
                            onChange={(event) =>
                              updateSelectedProject((project) => {
                                const providers = [...(project.agent.providers || [])];
                                providers[index] = { ...providers[index], base_url: event.target.value };
                                return { ...project, agent: { ...project.agent, providers } };
                              })
                            }
                          />
                          <Input
                            label="Model"
                            value={provider.model || ''}
                            onChange={(event) =>
                              updateSelectedProject((project) => {
                                const providers = [...(project.agent.providers || [])];
                                providers[index] = { ...providers[index], model: event.target.value };
                                return { ...project, agent: { ...project.agent, providers } };
                              })
                            }
                          />
                          <div className="flex items-end">
                            <Button
                              variant="danger"
                              size="sm"
                              onClick={() =>
                                updateSelectedProject((project) => {
                                  const providers = [...(project.agent.providers || [])];
                                  providers.splice(index, 1);
                                  return { ...project, agent: { ...project.agent, providers } };
                                })
                              }
                            >
                              <Trash2 size={14} />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </section>

                    <section className="space-y-3">
                      <div className="flex items-center justify-between">
                        <h3 className="font-medium text-gray-900 dark:text-white">Platforms</h3>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            updateSelectedProject((project) => ({
                              ...project,
                              platforms: [...(project.platforms || []), { type: 'telegram', options: {} }],
                            }))
                          }
                        >
                          <Plus size={14} /> Platform
                        </Button>
                      </div>
                      {(selectedProject.platforms || []).map((platform, index) => (
                        <div key={`${platform.type}-${index}`} className="grid grid-cols-[240px_minmax(0,1fr)_40px] gap-3">
                          <Input
                            label="Type"
                            value={platform.type}
                            onChange={(event) =>
                              updateSelectedProject((project) => {
                                const platforms = [...(project.platforms || [])];
                                platforms[index] = { ...platforms[index], type: event.target.value };
                                return { ...project, platforms };
                              })
                            }
                          />
                          <Textarea
                            label="Options (edit advanced fields in Raw TOML when needed)"
                            value={JSON.stringify(platform.options || {}, null, 2)}
                            readOnly
                            rows={4}
                          />
                          <div className="flex items-end">
                            <Button
                              variant="danger"
                              size="sm"
                              onClick={() =>
                                updateSelectedProject((project) => {
                                  const platforms = [...(project.platforms || [])];
                                  platforms.splice(index, 1);
                                  return { ...project, platforms };
                                })
                              }
                            >
                              <Trash2 size={14} />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </section>

                    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:border-amber-900/30 dark:bg-amber-950/20 dark:text-amber-300">
                      Visual editing covers the stable fields for v1. Keep complex option maps, speech/TTS, webhook, and relay sections in the raw TOML editor.
                    </div>

                    <div className="flex gap-2">
                      <Button onClick={() => void handleSaveVisual()} loading={saving}>
                        <Save size={14} /> Save config
                      </Button>
                      <Button variant="secondary" onClick={() => void handleSaveAndRestart()}>
                        <Wrench size={14} /> Save and restart service
                      </Button>
                    </div>
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <Textarea
                label="config.toml"
                rows={28}
                value={rawDraft}
                onChange={(event) => setRawDraft(event.target.value)}
                className="font-mono text-[13px]"
              />
              <div className="flex gap-2">
                <Button onClick={() => void handleSaveRaw()} loading={saving}>
                  <Save size={14} /> Save raw config
                </Button>
                <Button variant="secondary" onClick={() => void restartDesktopService().then(loadAll)}>
                  Restart service
                </Button>
              </div>
            </div>
          )}
        </Card>
      </div>

      <Card>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Project summary</h3>
        <div className="flex flex-wrap gap-2">
          {projectNames.length === 0 ? (
            <span className="text-sm text-gray-400">No projects configured.</span>
          ) : (
            projectNames.map((name) => (
              <span
                key={name}
                className="px-3 py-1.5 rounded-full bg-gray-100 dark:bg-white/[0.06] text-sm text-gray-700 dark:text-gray-300"
              >
                {name}
              </span>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}
