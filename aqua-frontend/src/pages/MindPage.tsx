import { useEffect, useState } from 'react';
import { MessageSquarePlus, RefreshCcw } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { CompactBelief } from '@/api/mind';
import { useMindStore } from '@/stores/mindStore';
import { SectionHeader } from '@/features/mind/primitives';
import { UnderstandingRing } from '@/features/mind/UnderstandingRing';
import { IdentitySection } from '@/features/mind/IdentitySection';
import { GoalsSection, WorkingMemorySection, PredictionsSection } from '@/features/mind/NowSections';
import { KnowledgeSection, CommunicationSection } from '@/features/mind/ModelSections';
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
        <p className="mt-1 text-sm text-foreground-secondary">{error}</p>
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
          <LearningFeed learnings={learnings} reflections={model.reflections} />
        </section>

        {/* 03 — Identity */}
        <section className="mb-14">
          <SectionHeader eyebrow="Who you are" title="Identity" />
          <IdentitySection beliefs={model.identity} onSelect={setSelected} />
        </section>

        {/* 04 — Goals */}
        <section className="mb-14">
          <SectionHeader eyebrow="Direction" title="Current goals" />
          <GoalsSection goals={model.goals} />
        </section>

        {/* 05 — Working memory */}
        <section className="mb-14">
          <SectionHeader eyebrow="Right now" title="Aqua’s attention" />
          <WorkingMemorySection model={model} />
        </section>

        {/* 06+07 — Knowledge / Communication */}
        <div className="mb-14 grid grid-cols-1 gap-10 lg:grid-cols-2">
          <section>
            <SectionHeader eyebrow="What you know" title="Knowledge" />
            <KnowledgeSection beliefs={model.knowledge} onSelect={setSelected} />
          </section>
          <section>
            <SectionHeader eyebrow="How to talk to you" title="Communication style" />
            <CommunicationSection beliefs={model.communication} decision={model.decision} onSelect={setSelected} />
          </section>
        </div>

        {/* 08 — Predictions */}
        <section className="mb-14">
          <SectionHeader eyebrow="Forecast" title="What Aqua expects next" />
          <PredictionsSection predictions={model.predictions} />
        </section>

        {/* 09 — Relationships */}
        <section className="mb-14">
          <SectionHeader eyebrow="Connected knowledge" title="Your world, mapped" />
          <RelationshipGraph />
        </section>

        {/* 10+11 — Timeline / Evolution */}
        <div className="mb-14 grid grid-cols-1 gap-10 lg:grid-cols-2">
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
        <section className="mb-10">
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

function CenterNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-8 text-center text-sm text-foreground-secondary">
      <div>{children}</div>
    </div>
  );
}
