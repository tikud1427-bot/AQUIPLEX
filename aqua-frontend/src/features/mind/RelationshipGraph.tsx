import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { fetchGraph, type GraphNode, type GraphEdge } from '@/api/mind';
import { Panel } from '@/components/ui/panel';

/* ────────────────────────────────────────────────────────────────────────
   Relationship graph — radial constellation, no graph library.

   You sit at the center. Node types occupy concentric rings
   (organizations → projects → goals → technologies), so distance from
   the center encodes the kind of relationship. Edges are quiet quadratic
   curves; weight = opacity. Wheel zooms, drag pans, hover highlights the
   1-hop neighborhood.
   ──────────────────────────────────────────────────────────────────────── */

const RING: Record<string, number> = {
  person: 120, organization: 120, project: 200, goal: 275, technology: 275, episode: 340, artifact: 340,
};
const TYPE_LABEL: Record<string, string> = {
  person: 'People', organization: 'Organizations', project: 'Projects',
  goal: 'Goals', technology: 'Technologies', episode: 'Episodes', artifact: 'Artifacts',
};
const W = 760, H = 560, CX = W / 2, CY = H / 2;

interface Positioned extends GraphNode { x: number; y: number; self: boolean }

/** An uploaded file (memory/engine.js rememberFile → an `artifact` node). */
export function isFileNode(n: GraphNode): boolean {
  return n.type === 'artifact';
}

function layout(nodes: GraphNode[]): Positioned[] {
  const self = nodes.find((n) => n.key === 'person:__self__');
  const others = nodes.filter((n) => n.key !== 'person:__self__');
  const byRing = new Map<number, GraphNode[]>();
  for (const n of others) {
    const r = RING[n.type] ?? 340;
    if (!byRing.has(r)) byRing.set(r, []);
    byRing.get(r)!.push(n);
  }
  const out: Positioned[] = [];
  if (self) out.push({ ...self, x: CX, y: CY, self: true });
  for (const [r, list] of byRing) {
    const sorted = [...list].sort((a, b) => b.weight - a.weight);
    sorted.forEach((n, i) => {
      const angle = (i / sorted.length) * Math.PI * 2 - Math.PI / 2 + (r % 97) * 0.01;
      out.push({ ...n, x: CX + r * Math.cos(angle), y: CY + r * Math.sin(angle), self: false });
    });
  }
  return out;
}

export function RelationshipGraph() {
  const reduce = useReducedMotion();
  const [nodes, setNodes] = useState<GraphNode[] | null>(null);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [error, setError] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  // Uploaded files are `artifact` nodes labelled with their raw filenames
  // (IMG-20260817-WA00…, Screenshot_2026-…). Hidden unless asked for: the map
  // is about the person's world — people, goals, projects, tech.
  const [showFiles, setShowFiles] = useState(false);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    fetchGraph().then((g) => { setNodes(g.nodes); setEdges(g.edges); }).catch(() => setError(true));
  }, []);

  const fileCount = useMemo(() => (nodes ?? []).filter((n) => isFileNode(n)).length, [nodes]);
  const shown = useMemo(() => (nodes ?? []).filter((n) => showFiles || !isFileNode(n)), [nodes, showFiles]);
  const positioned = useMemo(() => (nodes ? layout(shown) : []), [nodes, shown]);
  const posByKey = useMemo(() => new Map(positioned.map((n) => [n.key, n])), [positioned]);
  const neighborhood = useMemo(() => {
    if (!hover) return null;
    const set = new Set([hover]);
    for (const e of edges) {
      if (e.from === hover) set.add(e.to);
      if (e.to === hover) set.add(e.from);
    }
    return set;
  }, [hover, edges]);

  // Wheel zoom (non-passive so preventDefault works)
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      setView((v) => ({ ...v, k: Math.min(2.5, Math.max(0.5, v.k * (ev.deltaY < 0 ? 1.1 : 0.9))) }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  if (error) return <p className="text-sm text-foreground-secondary">The graph couldn’t load — it will return with the next update.</p>;
  if (!nodes) return <Panel className="flex h-72 items-center justify-center text-sm text-foreground-secondary">Mapping relationships…</Panel>;
  const filesToggle = fileCount > 0 && (
    <button
      type="button"
      onClick={() => setShowFiles((v) => !v)}
      aria-pressed={showFiles}
      className="rounded-md border border-border px-2 py-0.5 text-micro text-foreground-secondary hover:bg-surface-secondary hover:text-foreground"
    >
      {showFiles ? 'Hide files' : `Show files (${fileCount})`}
    </button>
  );
  if (positioned.length <= 1) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-foreground-secondary">Mention people, projects and tools — the map draws itself.</p>
        {filesToggle}
      </div>
    );
  }

  return (
    <Panel className="p-2">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="h-[420px] w-full cursor-grab touch-none select-none active:cursor-grabbing"
        role="img"
        aria-label="Relationship graph: you at the center, connected to organizations, projects, goals and technologies"
        onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY }; (e.target as Element).setPointerCapture?.(e.pointerId); }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y;
          drag.current = { x: e.clientX, y: e.clientY };
          setView((v) => ({ ...v, x: v.x + dx / v.k, y: v.y + dy / v.k }));
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerLeave={() => (drag.current = null)}
      >
        <g transform={`translate(${CX},${CY}) scale(${view.k}) translate(${-CX + view.x},${-CY + view.y})`}>
          {/* Ring guides */}
          {[...new Set(Object.values(RING))].map((r) => (
            <circle key={r} cx={CX} cy={CY} r={r} fill="none" stroke="var(--border)" strokeWidth={1} opacity={0.35} strokeDasharray="2 5" />
          ))}
          {/* Edges */}
          {edges.map((e) => {
            const a = posByKey.get(e.from), b = posByKey.get(e.to);
            if (!a || !b) return null;
            const mx = (a.x + b.x) / 2 + (a.y - b.y) * 0.12;
            const my = (a.y + b.y) / 2 + (b.x - a.x) * 0.12;
            const active = !neighborhood || (neighborhood.has(e.from) && neighborhood.has(e.to));
            return (
              <path
                key={e.key}
                d={`M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`}
                fill="none"
                stroke="var(--primary)"
                strokeWidth={Math.min(2.5, 0.75 + e.weight * 0.25)}
                opacity={active ? Math.min(0.55, 0.18 + e.weight * 0.08) : 0.05}
              />
            );
          })}
          {/* Nodes */}
          {positioned.map((n, i) => {
            const dim = neighborhood ? !neighborhood.has(n.key) : false;
            const r = n.self ? 22 : Math.min(16, 7 + n.weight * 1.2);
            return (
              <motion.g
                key={n.key}
                initial={reduce ? false : { opacity: 0, scale: 0.6 }}
                animate={{ opacity: dim ? 0.15 : 1, scale: 1 }}
                transition={{ delay: reduce ? 0 : Math.min(0.6, i * 0.03), type: 'spring', stiffness: 260, damping: 22 }}
                onPointerEnter={() => setHover(n.key)}
                onPointerLeave={() => setHover(null)}
                style={{ cursor: 'pointer' }}
              >
                <circle cx={n.x} cy={n.y} r={r} fill={n.self ? 'var(--primary)' : 'var(--surface)'}
                        stroke="var(--primary)" strokeWidth={n.self ? 0 : 1.5} />
                <text
                  x={n.x} y={n.y + r + 13} textAnchor="middle"
                  className="fill-[var(--text-secondary)]"
                  style={{ fontSize: 11, fontFamily: 'var(--font-sans)' }}
                >
                  {n.self ? 'You' : n.label.length > 18 ? n.label.slice(0, 17) + '…' : n.label}
                </text>
              </motion.g>
            );
          })}
        </g>
      </svg>
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-2 pt-1">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-micro text-foreground-secondary">
          {[...new Set(shown.filter((n) => n.key !== 'person:__self__').map((n) => n.type))].map((t) => (
            <span key={t}>{TYPE_LABEL[t] ?? t}</span>
          ))}
        </div>
        <div className="flex items-center gap-3">
          {filesToggle}
          <span className="text-micro text-foreground-secondary">Scroll to zoom · drag to pan</span>
        </div>
      </div>
    </Panel>
  );
}
