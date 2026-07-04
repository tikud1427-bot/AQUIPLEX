import { useMemo } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  Blocks, Boxes, Globe, KeyRound, Database, FolderTree, Settings2,
  BarChart3, AlertTriangle, Lightbulb, MessageCircleQuestion, Sparkles,
  X, FileCode2, GitFork, Layers, ArrowRight,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useChatStore } from '@/stores/chatStore';
import { useUploadStore } from '@/stores/uploadStore';
import { cn } from '@/lib/utils';
import type { WorkspaceOverview } from '@/types';

// ── Helpers ────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const METHOD_STYLE: Record<string, string> = {
  GET: 'text-success border-success/25 bg-success/10',
  POST: 'text-primary border-primary/25 bg-primary/10',
  PUT: 'text-warning border-warning/25 bg-warning/10',
  PATCH: 'text-warning border-warning/25 bg-warning/10',
  DELETE: 'text-danger border-danger/25 bg-danger/10',
  MOUNT: 'text-accent border-accent/25 bg-accent/10',
};

// ── Card shell ─────────────────────────────────────────────────────────────

function Card({
  icon: Icon,
  title,
  children,
  className,
  span,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
  className?: string;
  span?: boolean;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.section
      variants={reduce ? undefined : { hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }}
      className={cn(
        'flex min-w-0 flex-col rounded-xl border border-border bg-surface p-4 transition-shadow hover:shadow-sm',
        span && 'md:col-span-2',
        className,
      )}
    >
      <header className="mb-3 flex items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <Icon className="h-3.5 w-3.5 text-primary" />
        </span>
        <h3 className="text-[13px] font-semibold tracking-tight text-foreground">{title}</h3>
      </header>
      <div className="min-w-0 flex-1 text-[13px] leading-relaxed text-foreground-secondary">{children}</div>
    </motion.section>
  );
}

function PillRow({ label, items }: { label?: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {label && <span className="mr-0.5 text-[11px] font-medium uppercase tracking-wide text-foreground-secondary/60">{label}</span>}
      {items.map((t) => (
        <Badge key={t} variant="default">{t}</Badge>
      ))}
    </div>
  );
}

function EmptyLine({ text }: { text: string }) {
  return <p className="text-[12px] text-foreground-secondary/60">{text}</p>;
}

// ── Dashboard ──────────────────────────────────────────────────────────────

export function WorkspaceDashboard({ overview }: { overview: WorkspaceOverview }) {
  const sendMessage = useChatStore((s) => s.sendMessage);
  const setShowDashboard = useUploadStore((s) => s.setShowDashboard);
  const reduce = useReducedMotion();

  const languages = useMemo(
    () => Object.entries(overview.languages ?? {}).slice(0, 6),
    [overview.languages],
  );
  const langTotal = useMemo(
    () => languages.reduce((n, [, c]) => n + c, 0) || 1,
    [languages],
  );

  function ask(question: string) {
    setShowDashboard(false);
    void sendMessage(question);
  }

  const stackPills = [
    ...(overview.frameworks ?? []),
    ...(overview.runtime ?? []).slice(0, 2),
  ].slice(0, 6);

  const statTiles = [
    { label: 'Files', value: overview.stats?.fileCount ?? 0 },
    { label: 'Functions', value: overview.stats?.functions ?? 0 },
    { label: 'Classes', value: overview.stats?.classes ?? 0 },
    { label: 'Endpoints', value: overview.apiRoutes?.length ?? 0 },
    { label: 'Dependencies', value: overview.dependencyCount ?? 0 },
    { label: 'Size', value: formatBytes(overview.stats?.totalBytes ?? 0), raw: true },
  ];

  return (
    <ScrollArea className="min-h-0 flex-1">
      <motion.div
        initial={reduce ? undefined : 'hidden'}
        animate="show"
        variants={{ show: { transition: { staggerChildren: 0.04 } } }}
        className="mx-auto w-full max-w-5xl px-4 pb-8 pt-6"
      >
        {/* ── Hero: workspace identity ─────────────────────────────── */}
        <motion.header
          variants={reduce ? undefined : { hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }}
          className="relative mb-5 overflow-hidden rounded-2xl border border-border bg-surface p-5"
        >
          <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-primary/5 blur-2xl" />
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="mb-1 flex items-center gap-2">
                <Sparkles className="h-4 w-4 shrink-0 text-primary" />
                <span className="text-[11px] font-medium uppercase tracking-wider text-foreground-secondary/70">
                  Workspace intelligence
                </span>
                {overview.partial && (
                  <Badge variant="warning">
                    <AlertTriangle className="h-3 w-3" /> Partial analysis
                  </Badge>
                )}
              </div>
              <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">{overview.name}</h1>
              <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-foreground-secondary">
                {overview.purpose}
              </p>
              <div className="mt-3">
                <PillRow items={stackPills} />
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Hide overview"
              onClick={() => setShowDashboard(false)}
              className="shrink-0"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </motion.header>

        {/* ── Signature: ask about this project ─────────────────────── */}
        {overview.suggestedQuestions?.length > 0 && (
          <motion.section
            variants={reduce ? undefined : { hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }}
            className="mb-5"
          >
            <div className="mb-2 flex items-center gap-2 px-0.5">
              <MessageCircleQuestion className="h-4 w-4 text-primary" />
              <h2 className="text-[13px] font-semibold text-foreground">Ask about this project</h2>
            </div>
            <div className="flex flex-wrap gap-2">
              {overview.suggestedQuestions.map((q) => (
                <button
                  key={q}
                  onClick={() => ask(q)}
                  className="group flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-[12.5px] text-foreground-secondary transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
                >
                  {q}
                  <ArrowRight className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-70" />
                </button>
              ))}
            </div>
          </motion.section>
        )}

        {/* ── Card grid ──────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Card icon={Blocks} title="Architecture" span>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
              {(
                [
                  ['Frontend', overview.architecture?.frontend],
                  ['Backend', overview.architecture?.backend],
                  ['API layer', overview.architecture?.apiLayer],
                  ['Data layer', overview.architecture?.dataLayer],
                  ['Auth flow', overview.architecture?.authFlow],
                  ['Storage', overview.architecture?.storage],
                  ['Background jobs', overview.architecture?.backgroundJobs],
                  ['Service relationships', overview.architecture?.serviceRelationships],
                  ['Dependency flow', overview.architecture?.dependencyFlow],
                ] as const
              )
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k} className="min-w-0">
                    <dt className="text-[11px] font-medium uppercase tracking-wide text-foreground-secondary/60">{k}</dt>
                    <dd className="mt-0.5 break-words">{v}</dd>
                  </div>
                ))}
            </dl>
          </Card>

          <Card icon={Boxes} title="Tech stack">
            <div className="space-y-2.5">
              <PillRow label="Frontend" items={overview.frontendTech ?? []} />
              <PillRow label="Backend" items={overview.backendTech ?? []} />
              <PillRow label="Build" items={overview.buildTools ?? []} />
              <PillRow label="Packages" items={overview.packageManagers ?? []} />
              {languages.length > 0 && (
                <div className="pt-1">
                  <div className="mb-1.5 flex h-1.5 w-full overflow-hidden rounded-full bg-surface-secondary">
                    {languages.map(([lang, count], i) => (
                      <div
                        key={lang}
                        title={`${lang}: ${count}`}
                        style={{ width: `${(count / langTotal) * 100}%`, opacity: 1 - i * 0.14 }}
                        className="h-full bg-primary first:rounded-l-full last:rounded-r-full"
                      />
                    ))}
                  </div>
                  <p className="text-[11px] text-foreground-secondary/70">
                    {languages.map(([l, c]) => `${l} (${c})`).join(' · ')}
                  </p>
                </div>
              )}
            </div>
          </Card>

          <Card icon={Globe} title={`API endpoints${overview.apiRoutes?.length ? ` · ${overview.apiRoutes.length}` : ''}`}>
            {overview.apiRoutes?.length ? (
              <ul className="max-h-52 space-y-1 overflow-y-auto pr-1 font-mono text-[11.5px]">
                {overview.apiRoutes.map((r) => (
                  <li key={`${r.method}-${r.path}-${r.file}`} className="flex items-center gap-2">
                    <span className={cn('w-14 shrink-0 rounded border px-1 py-px text-center text-[10px] font-semibold', METHOD_STYLE[r.method] ?? 'border-border text-foreground-secondary')}>
                      {r.method}
                    </span>
                    <span className="truncate text-foreground" title={`${r.path} — ${r.file}`}>{r.path}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyLine text="No HTTP endpoints detected in this project." />
            )}
          </Card>

          <Card icon={KeyRound} title="Authentication">
            {overview.authMethods?.length ? (
              <ul className="space-y-1.5">
                {overview.authMethods.map((m) => <li key={m}>{m}</li>)}
              </ul>
            ) : (
              <EmptyLine text="No authentication mechanism detected." />
            )}
            {overview.envVars?.length > 0 && (
              <div className="mt-3">
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-foreground-secondary/60">
                  Environment variables · {overview.envVars.length}
                </p>
                <p className="line-clamp-3 break-all font-mono text-[11px] text-foreground-secondary/80">
                  {overview.envVars.join(', ')}
                </p>
              </div>
            )}
          </Card>

          <Card icon={Database} title="Database & data">
            {overview.databaseTech?.length ? (
              <ul className="space-y-1.5">
                {overview.databaseTech.map((d) => <li key={d}>{d}</li>)}
              </ul>
            ) : (
              <EmptyLine text={overview.architecture?.dataLayer ?? 'No data layer detected.'} />
            )}
            {overview.externalIntegrations?.length > 0 && (
              <div className="mt-3">
                <PillRow label="Integrations" items={overview.externalIntegrations} />
              </div>
            )}
          </Card>

          <Card icon={FolderTree} title="Folder structure">
            {overview.folderStructure?.length ? (
              <ul className="max-h-52 space-y-1 overflow-y-auto pr-1">
                {overview.folderStructure.map((f) => (
                  <li key={f.dir} className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-mono text-[12px] text-foreground">{f.dir}/</span>
                    <span className="shrink-0 text-[11px] text-foreground-secondary/70">
                      {f.files} files · {formatBytes(f.bytes)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyLine text="Flat project — no nested folders." />
            )}
          </Card>

          <Card icon={Layers} title="Entry points & core modules">
            {overview.entryPoints?.length > 0 && (
              <div className="mb-2.5">
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-foreground-secondary/60">Entry points</p>
                {overview.entryPoints.map((e) => (
                  <p key={e} className="truncate font-mono text-[12px] text-foreground">{e}</p>
                ))}
              </div>
            )}
            {overview.coreModules?.length ? (
              <div>
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-foreground-secondary/60">Most depended upon</p>
                <ul className="space-y-1">
                  {overview.coreModules.slice(0, 6).map((m) => (
                    <li key={m.file} className="flex items-baseline justify-between gap-2">
                      <span className="truncate font-mono text-[12px] text-foreground">{m.file}</span>
                      {m.importedBy > 0 && (
                        <span className="flex shrink-0 items-center gap-1 text-[11px] text-foreground-secondary/70">
                          <GitFork className="h-3 w-3" /> {m.importedBy}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              !overview.entryPoints?.length && <EmptyLine text="Module relationships could not be derived." />
            )}
          </Card>

          <Card icon={Settings2} title="Configuration">
            {overview.configFiles?.length ? (
              <ul className="max-h-40 space-y-1 overflow-y-auto pr-1">
                {overview.configFiles.map((c) => (
                  <li key={c} className="flex items-center gap-1.5">
                    <FileCode2 className="h-3 w-3 shrink-0 text-foreground-secondary/60" />
                    <span className="truncate font-mono text-[12px]">{c}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyLine text="No configuration files detected." />
            )}
          </Card>

          <Card icon={BarChart3} title="Project statistics">
            <div className="grid grid-cols-3 gap-2">
              {statTiles.map((t) => (
                <div key={t.label} className="rounded-lg bg-surface-secondary px-2 py-2 text-center">
                  <p className="text-[15px] font-semibold tabular-nums text-foreground">
                    {t.raw ? t.value : Number(t.value).toLocaleString()}
                  </p>
                  <p className="text-[10.5px] text-foreground-secondary/70">{t.label}</p>
                </div>
              ))}
            </div>
          </Card>

          <Card icon={AlertTriangle} title={`TODO / FIXME${overview.todoCount ? ` · ${overview.todoCount}` : ''}`}>
            {overview.todos?.length ? (
              <ul className="max-h-44 space-y-1.5 overflow-y-auto pr-1">
                {overview.todos.map((t, i) => (
                  <li key={i} className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <Badge variant={t.tag === 'FIXME' ? 'danger' : 'warning'}>{t.tag}</Badge>
                      <span className="truncate font-mono text-[11px] text-foreground-secondary/70">{t.file}</span>
                    </div>
                    {t.text && <p className="mt-0.5 truncate pl-0.5 text-[12px]">{t.text}</p>}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyLine text="No TODO or FIXME markers — clean." />
            )}
            {overview.potentialTechDebt?.length > 0 && (
              <div className="mt-3 space-y-1.5 border-t border-border pt-2.5">
                <p className="text-[11px] font-medium uppercase tracking-wide text-foreground-secondary/60">Potential debt</p>
                {overview.potentialTechDebt.map((d) => (
                  <p key={d} className="text-[12px]">{d}</p>
                ))}
              </div>
            )}
          </Card>

          <Card icon={Lightbulb} title="Suggested improvements" span>
            {overview.suggestedImprovements?.length ? (
              <ul className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
                {overview.suggestedImprovements.map((s) => (
                  <li key={s} className="flex items-start gap-2">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary" />
                    {s}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyLine text="Nothing pressing — the project looks well maintained." />
            )}
          </Card>
        </div>

        {overview.warnings?.length > 0 && (
          <p className="mt-4 text-center text-[11px] text-foreground-secondary/60">
            Some analysis sections were skipped: {overview.warnings.join('; ')}
          </p>
        )}
      </motion.div>
    </ScrollArea>
  );
}
