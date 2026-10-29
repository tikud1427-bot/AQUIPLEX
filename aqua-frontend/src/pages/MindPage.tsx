import { useEffect, useState } from 'react';
import { MessageSquarePlus, RefreshCcw } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { CompactBelief } from '@/api/mind';
import { useMindStore } from '@/stores/mindStore';
import { SectionHeader } from '@/components/ui/section-header';
import { UnderstandingSections } from '@/features/understanding/UnderstandingSections';
import { UnderstandingRing } from '@/features/mind/UnderstandingRing';
import { IdentitySection } from '@/features/mind/IdentitySection';
import { GoalsSection, WorkingMemorySection } from '@/features/mind/NowSections';
import { KnowledgePanel, CommunicationSection } from '@/features/mind/ModelSections';
import { LearningFeed, MindTimeline, EvolutionHeatmap } from '@/features/mind/StorySections';
import { RelationshipGraph } from '@/features/mind/RelationshipGraph';
import { BeliefDrawer } from '@/features/mind/BeliefDrawer';
import { ReflectionOverlay, PrivacyPanel } from '@/features/mind/ReflectionAndPrivacy';

/* The Mind dashboard — the product view of AQUA's cognitive model.
   Data flows only through mindStore; refreshes are event-driven
   (mount, window focus, after each chat turn). No polling. */

export default function MindPage() {
  const navigate = useNavigate();
  const { model, loading, error, hasLoadedOnce, learnings, refresh } = useMindStore();
  const [selected, setSelected] = useState<CompactBelief | null>(null);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh({ silent: true });
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  // Keep the drawer's belief in sync with live updates
  useEffect(() => {
    if (!selected || !model) return;
    const fresh = (model[selected.dimension] ?? []).find((b) => b.key === selected.key);
    if (fresh && fresh !== selected) setSelected(fresh);
    if (!fresh) setSelected(null);
  }, [model, selected]);

  if (!hasLoadedOnce && loading) {
    return <CenterNote>Reading the model…</CenterNote>;
  }

  if (error && !model) {
    return (
      <CenterNote>
        <p className="text-foreground">The mind model couldn’t load.</p>
        <p className="mt-1 text-sm text-foreground-secondary [overflow-wrap:anywhere]">{error}</p>
        <button
          onClick={() => void refresh()}
          className="mt-4 inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:bg-surface-secondary"
        >
          <RefreshCcw className="h-4 w-4" /> Try again
        </button>
      </CenterNote>
    );
  }

  if (!model) {
    return (
      <CenterNote>
        <p className="text-lg font-semibold text-foreground">Nothing here yet — and that’s the point.</p>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-foreground-secondary">
          Aqua builds its understanding of you from real conversations, not a questionnaire.
          Start one, and watch this page come alive.
        </p>
        <button
          onClick={() => navigate('/')}
          className="mt-5 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          <MessageSquarePlus className="h-4 w-4" /> Start a conversation
        </button>
      </CenterNote>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <ReflectionOverlay />
      <div className="mx-auto w-full max-w-5xl px-4 py-10 md:px-8 md:py-14">

        {/* 01 — Hero */}
        <section aria-label="Overall understanding" className="mb-16 md:mb-20">
          <UnderstandingRing model={model} />
        </section>

        {/* 02 — What Aqua learned (the magic — kept high on the page) */}
        <section className="mb-14">
          <SectionHeader eyebrow="Live" title="What Aqua learned recently" />
          <LearningFeed learnings={learnings} model={model} />
        </section>

        <SectionIndex />

        {/* 03 — Identity */}
        <section id="identity" className="mb-14 scroll-mt-6">
          <SectionHeader eyebrow="Who you are" title="Identity" />
          <IdentitySection beliefs={model.identity} onSelect={setSelected} />
        </section>

        {/* 04 — Goals */}
        <section id="goals" className="mb-14 scroll-mt-6">
          <SectionHeader eyebrow="Direction" title="Current goals" />
          <GoalsSection goals={model.goals} />
        </section>

        {/* 05 — Working memory */}
        <section id="now" className="mb-14 scroll-mt-6">
          <SectionHeader eyebrow="Right now" title="Aqua’s attention" />
          <WorkingMemorySection model={model} />
        </section>

        {/* 06+07 — Knowledge / Communication */}
        <div className="mb-14 grid grid-cols-1 gap-10 lg:grid-cols-2">
          <KnowledgePanel beliefs={model.knowledge} onSelect={setSelected} />
          <section>
            <SectionHeader eyebrow="How to talk to you" title="Communication style" />
            <CommunicationSection beliefs={model.communication} decision={model.decision} onSelect={setSelected} />
          </section>
        </div>

        {/* 07b — UUS: projects, provenance, and what is still unknown. All three
            come from data the read model already returns; nothing new is
            tracked to render them. */}
        <div id="world" className="mb-14 flex scroll-mt-6 flex-col gap-14">
          <UnderstandingSections />
        </div>

        {/* 09 — Relationships */}
        <section id="map" className="mb-14 scroll-mt-6">
          <SectionHeader eyebrow="Connected knowledge" title="Your world, mapped" />
          <RelationshipGraph />
        </section>

        {/* 10+11 — Timeline / Evolution */}
        <div id="timeline" className="mb-14 grid scroll-mt-6 grid-cols-1 gap-10 lg:grid-cols-2">
          <section>
            <SectionHeader eyebrow="The story so far" title="Timeline" />
            <MindTimeline timeline={model.timeline} />
          </section>
          <section>
            <SectionHeader eyebrow="Growth" title="Mind evolution" />
            <EvolutionHeatmap model={model} />
          </section>
        </div>

        {/* 12 — Privacy */}
        <section id="privacy" className="mb-10 scroll-mt-6">
          <SectionHeader eyebrow="Yours" title="Privacy & control" />
          <PrivacyPanel model={model} />
        </section>

        <p className="pb-6 text-center text-xs text-foreground-secondary">
          Tap any belief to see the evidence behind it — or to change it.
        </p>
      </div>

      <BeliefDrawer belief={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

/* The page's index (2026-10-28). One destination in the sidebar, and every
   part of it one tap away — /mind#goals, /mind#timeline etc. are deep links,
   so nothing that used to be reachable moved. */
const SECTIONS = [
  { id: 'identity', label: 'Identity' },
  { id: 'goals', label: 'Goals' },
  { id: 'now', label: 'Right now' },
  { id: 'world', label: 'Projects & sources' },
  { id: 'map', label: 'Map' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'privacy', label: 'Privacy' },
] as const;

function goTo(id: string, smooth = true) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView?.({ behavior: smooth && !reduce ? 'smooth' : 'auto', block: 'start' });
  history.replaceState(history.state, '', `#${id}`);
}

function SectionIndex() {
  const { hash } = useLocation();
  // Arriving on a deep link: jump once the sections exist.
  useEffect(() => {
    const id = hash.replace(/^#/, '');
    if (SECTIONS.some((s) => s.id === id)) requestAnimationFrame(() => goTo(id, false));
  }, [hash]);
  return (
    <nav aria-label="Sections" className="-mx-4 mb-12 overflow-x-auto px-4 md:mx-0 md:px-0">
      <ul className="flex w-max gap-1.5">
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              onClick={(e) => { e.preventDefault(); goTo(s.id); }}
              className="tap inline-block whitespace-nowrap rounded-full border border-border px-3 py-1 text-caption text-foreground-secondary transition-colors hover:bg-surface-secondary hover:text-foreground"
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function CenterNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-8 text-center text-sm text-foreground-secondary">
      <div>{children}</div>
    </div>
  );
}
