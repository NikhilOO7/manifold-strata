import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

/**
 * The Explorer is for understanding a body of work, not for browsing adjacency.
 *
 * Three designs got here, and the first two failed for the same reason. A
 * force-directed overview of the whole graph was unreadable — sixty boxes in one
 * simulation answers a question nobody asks. An ego view fixed the readability
 * and still only answered "what is next to this", which is a list of neighbours,
 * not an explanation: it showed `architecture` with a single edge and taught
 * nothing at all.
 *
 * What someone actually wants to know has shape:
 *
 *   Paper    What did this work contribute, what did it build on, how was it
 *            validated, what did it claim to beat?          ← within one paper
 *   Concept  Which work introduced this idea, and who uses it?
 *   Compare  What do two papers share, and where do they diverge?
 *                                                           ← between papers
 *
 * So the page is three lenses over one graph rather than one generic view, the
 * sections are ordered by the order the questions get asked, and every claim can
 * show the sentence it came from — a knowledge graph whose edges cannot be
 * checked is asking to be trusted rather than read.
 */

type Lens = 'paper' | 'concept' | 'compare';

const TYPE_COLORS: Record<string, string> = {
  paper: '#3b82f6',
  method: '#10b981',
  concept: '#f59e0b',
  dataset: '#8b5cf6',
  metric: '#ef4444',
  model: '#ec4899',
  task: '#06b6d4',
  technique: '#84cc16',
  hardware: '#6366f1',
};

function colorFor(type: string): string {
  if (TYPE_COLORS[type]) return TYPE_COLORS[type];
  const palette = ['#06b6d4', '#ec4899', '#84cc16', '#f97316', '#6366f1', '#14b8a6'];
  let h = 0;
  for (let i = 0; i < type.length; i++) h = (h * 31 + type.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

interface LensItem {
  id: string;
  name: string;
  type: string;
  relation: string;
  direction: 'out' | 'in';
  evidence: string | null;
}

/** One related entity, carrying its relation and — on demand — its evidence. */
function ItemCard({ item, onOpen }: { item: LensItem; onOpen: (id: string) => void }) {
  const [showEvidence, setShowEvidence] = useState(false);
  return (
    <div className="border border-gray-200 rounded-xl p-3 hover:border-gray-300 transition-colors bg-white">
      <div className="flex items-start gap-2">
        <span
          className="w-2.5 h-2.5 rounded-full mt-1.5 flex-shrink-0"
          style={{ background: colorFor(item.type) }}
        />
        <div className="min-w-0 flex-1">
          <button
            onClick={() => onOpen(item.id)}
            className="text-left text-sm font-semibold text-gray-900 hover:text-blue-600 transition-colors"
          >
            {item.name}
          </button>
          <div className="text-xs text-gray-500 mt-0.5">
            <span className="capitalize">{item.type}</span>
            <span className="mx-1.5 text-gray-300">·</span>
            <span className={item.direction === 'in' ? 'text-orange-600' : 'text-emerald-700'}>
              {item.relation}
            </span>
          </div>
        </div>
        {item.evidence && (
          <button
            onClick={() => setShowEvidence((v) => !v)}
            className="text-[11px] font-semibold text-blue-600 hover:text-blue-700 flex-shrink-0"
            title="The sentence this claim was extracted from"
          >
            {showEvidence ? 'hide' : 'why?'}
          </button>
        )}
      </div>
      {showEvidence && item.evidence && (
        <blockquote className="mt-2 pl-3 ml-3 border-l-2 border-blue-200 text-xs text-gray-600 leading-relaxed">
          “{item.evidence}”
        </blockquote>
      )}
    </div>
  );
}

export default function Explorer() {
  const [lens, setLens] = useState<Lens>('paper');
  const [domainFilter, setDomainFilter] = useState('');
  const [focusId, setFocusId] = useState<string | null>(null);
  const [compareA, setCompareA] = useState<string | null>(null);
  const [compareB, setCompareB] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [hubLimit, setHubLimit] = useState(25);

  const { data: domainsData } = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.domains.list(),
  });
  const { data: papersData } = useQuery({
    queryKey: ['lens-papers', domainFilter],
    queryFn: () => api.graph.papers(domainFilter || undefined),
  });
  const { data: typesData } = useQuery({
    queryKey: ['explorer-types', domainFilter],
    queryFn: () => api.graph.types(domainFilter || undefined),
  });
  const { data: hubsData } = useQuery({
    queryKey: ['explorer-hubs', domainFilter, typeFilter, hubLimit],
    queryFn: () =>
      api.graph.hubs({
        domain: domainFilter || undefined,
        type: typeFilter || undefined,
        limit: hubLimit,
      }),
    enabled: lens === 'concept',
  });
  const { data: searchData } = useQuery({
    queryKey: ['explorer-search', searchTerm, domainFilter],
    queryFn: () =>
      api.graph.nodes({ search: searchTerm, limit: 20, domain: domainFilter || undefined }),
    enabled: searchTerm.trim().length > 1,
  });

  const { data: lensData, isFetching: lensLoading } = useQuery({
    queryKey: ['lens', focusId],
    queryFn: () => api.graph.lens(focusId!),
    enabled: !!focusId,
  });

  const { data: comparison, isFetching: comparing } = useQuery({
    queryKey: ['compare', compareA, compareB],
    queryFn: () => api.graph.compare(compareA!, compareB!),
    enabled: !!compareA && !!compareB,
  });

  const papers = papersData?.papers ?? [];
  const sidebarItems = useMemo(() => {
    if (searchTerm.trim().length > 1) {
      return (searchData?.nodes ?? []).map((n) => ({
        id: n.id,
        name: n.name,
        type: n.type,
        meta: '',
      }));
    }
    if (lens === 'concept') {
      return (hubsData?.hubs ?? []).map((h) => ({
        id: h.id,
        name: h.name,
        type: h.type,
        meta: `${h.degree} link${h.degree === 1 ? '' : 's'}`,
      }));
    }
    return papers.map((p) => ({
      id: p.id,
      name: p.name,
      type: 'paper',
      meta: `${p.concepts} concepts · ${p.relationships} claims`,
    }));
  }, [lens, papers, hubsData, searchData, searchTerm]);

  const pickInSidebar = (id: string) => {
    if (lens === 'compare') {
      // First click sets the left side, second the right, third starts over.
      if (!compareA) setCompareA(id);
      else if (!compareB && id !== compareA) setCompareB(id);
      else {
        setCompareA(id);
        setCompareB(null);
      }
      return;
    }
    setFocusId(id);
  };

  const LENSES: Array<{ id: Lens; label: string; blurb: string }> = [
    { id: 'paper', label: 'Paper', blurb: 'What one paper contributes, builds on, and proves.' },
    { id: 'concept', label: 'Concept', blurb: 'One idea, and how the literature around it fits together.' },
    { id: 'compare', label: 'Compare', blurb: 'What two papers share, and where they diverge.' },
  ];
  const activeLens = LENSES.find((l) => l.id === lens)!;

  return (
    <div className="space-y-5 animate-fadeIn">
      <div>
        <h1 className="text-3xl font-bold bg-gradient-to-r from-gray-900 to-gray-700 bg-clip-text text-transparent">
          Knowledge Explorer
        </h1>
        <p className="text-sm text-gray-500 mt-2">{activeLens.blurb}</p>
      </div>

      {/* Three questions, not three visualisations of the same one. */}
      <div className="flex gap-2">
        {LENSES.map((l) => (
          <button
            key={l.id}
            onClick={() => {
              setLens(l.id);
              setFocusId(null);
              setSearchTerm('');
            }}
            className={`px-4 py-2 rounded-xl text-sm font-bold transition-all ${
              lens === l.id
                ? 'bg-slate-900 text-white shadow-md'
                : 'bg-white text-gray-600 border border-gray-200 hover:border-gray-300'
            }`}
          >
            {l.label}
          </button>
        ))}
      </div>

      <div className="flex gap-6 h-[calc(100vh-17rem)]">
        {/* Entry points */}
        <div className="w-80 flex flex-col bg-white rounded-2xl border border-gray-200/60 shadow-lg overflow-hidden">
          <div className="p-4 border-b border-gray-200/60 space-y-3">
            <select
              value={domainFilter}
              onChange={(e) => {
                setDomainFilter(e.target.value);
                setFocusId(null);
                setCompareA(null);
                setCompareB(null);
              }}
              className="w-full px-3 py-2 border-2 border-gray-200 rounded-lg text-sm text-gray-700 font-medium bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">All domains</option>
              {(domainsData?.domains ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <input
              type="text"
              placeholder={lens === 'paper' ? 'Search papers and entities…' : 'Search concepts…'}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full px-3 py-2 border-2 border-gray-200 rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />

            {lens === 'concept' && (typesData?.nodeTypes ?? []).length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={() => setTypeFilter('')}
                  className={`px-2 py-1 rounded-md text-[11px] font-semibold ${
                    typeFilter === '' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  All types
                </button>
                {(typesData?.nodeTypes ?? []).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTypeFilter(t === typeFilter ? '' : t)}
                    className={`px-2 py-1 rounded-md text-[11px] font-semibold ${
                      typeFilter === t ? 'text-white' : 'bg-gray-100 text-gray-600'
                    }`}
                    style={typeFilter === t ? { background: colorFor(t) } : undefined}
                  >
                    {t.replace(/_/g, ' ')}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="px-4 pt-3 pb-1 text-xs font-semibold text-gray-500 uppercase tracking-wide">
            {lens === 'compare'
              ? compareA && compareB
                ? 'Pick again to restart'
                : compareA
                  ? 'Now pick the second paper'
                  : 'Pick the first paper'
              : lens === 'concept'
                ? `Concepts (${sidebarItems.length})`
                : `Papers (${sidebarItems.length})`}
          </div>

          <div className="flex-1 overflow-y-auto px-2 pb-2">
            {sidebarItems.length === 0 && (
              <p className="text-sm text-gray-400 px-2 py-4">
                Nothing here yet — process a paper first.
              </p>
            )}
            {sidebarItems.map((item) => {
              const selected =
                lens === 'compare'
                  ? item.id === compareA || item.id === compareB
                  : item.id === focusId;
              return (
                <button
                  key={item.id}
                  onClick={() => pickInSidebar(item.id)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg mb-1 transition-colors ${
                    selected ? 'bg-blue-50 border border-blue-200' : 'hover:bg-gray-50'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <span
                      className="w-2.5 h-2.5 rounded-full mt-1 flex-shrink-0"
                      style={{ background: colorFor(item.type) }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-gray-800">{item.name}</div>
                      {item.meta && (
                        <div className="text-[11px] text-gray-400 mt-0.5">{item.meta}</div>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
            {lens === 'concept' && sidebarItems.length >= hubLimit && searchTerm.length <= 1 && (
              <button
                onClick={() => setHubLimit((n) => Math.min(n + 50, 200))}
                className="w-full mt-1 px-3 py-2 text-xs font-semibold text-blue-600 hover:bg-blue-50 rounded-lg"
              >
                Show more ({hubLimit} shown)
              </button>
            )}
          </div>
        </div>

        {/* The lens itself */}
        <div className="flex-1 bg-white rounded-2xl border border-gray-200/60 shadow-lg overflow-y-auto">
          {lens === 'compare' ? (
            <ComparePane
              a={compareA}
              b={compareB}
              comparison={comparison}
              loading={comparing}
              onOpen={(id) => {
                setLens('concept');
                setFocusId(id);
              }}
            />
          ) : !focusId ? (
            <EmptyState lens={lens} />
          ) : lensLoading && !lensData ? (
            <div className="h-full flex items-center justify-center">
              <div className="animate-spin rounded-full h-10 w-10 border-b-4 border-blue-600" />
            </div>
          ) : (
            <LensPane data={lensData} onOpen={setFocusId} />
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ lens }: { lens: Lens }) {
  return (
    <div className="h-full flex items-center justify-center p-10">
      <div className="text-center max-w-sm">
        <div className="w-14 h-14 mx-auto rounded-2xl bg-blue-50 flex items-center justify-center mb-4">
          <span className="text-2xl">{lens === 'paper' ? '📄' : '💡'}</span>
        </div>
        <p className="text-gray-700 font-semibold">
          {lens === 'paper' ? 'Choose a paper' : 'Choose a concept'}
        </p>
        <p className="text-gray-400 text-sm mt-1.5 leading-relaxed">
          {lens === 'paper'
            ? 'You will see what it introduces, what it builds on, how it was validated, and what it claims to beat — each with the sentence it came from.'
            : 'You will see what introduced it, what it builds on, and where it is used across the corpus.'}
        </p>
      </div>
    </div>
  );
}

type LensResponse = Awaited<ReturnType<typeof api.graph.lens>>;

function LensPane({ data, onOpen }: { data: LensResponse | undefined; onOpen: (id: string) => void }) {
  if (!data) return null;
  return (
    <div>
      <div className="px-6 py-5 border-b border-gray-200/60 sticky top-0 bg-white/95 backdrop-blur z-10">
        <div className="flex items-center gap-2">
          <span
            className="w-3 h-3 rounded-full flex-shrink-0"
            style={{ background: colorFor(data.node.type) }}
          />
          <h2 className="text-lg font-bold text-gray-900">{data.node.name}</h2>
        </div>
        <p className="text-xs text-gray-500 mt-1 capitalize">
          {data.node.type} · {data.total} relationship{data.total === 1 ? '' : 's'} · {data.domain}
        </p>
        {data.node.description && (
          <p className="text-sm text-gray-600 mt-3 leading-relaxed">{data.node.description}</p>
        )}
      </div>

      {data.sections.length === 0 ? (
        <p className="p-6 text-sm text-gray-400">
          Nothing is linked to this yet — it was named in the text, but no relationship was
          extracted from it.
        </p>
      ) : (
        <div className="p-6 space-y-7">
          {data.sections.map((section) => (
            <section key={section.role}>
              <div className="mb-3">
                <h3 className="text-sm font-bold text-gray-900">
                  {section.label}
                  <span className="ml-2 text-xs font-medium text-gray-400">
                    {section.items.length}
                  </span>
                </h3>
                {/* The hint is the teaching part: it says what the section means. */}
                <p className="text-xs text-gray-500 mt-0.5">{section.hint}</p>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                {section.items.map((item, i) => (
                  <ItemCard key={`${item.id}-${i}`} item={item} onOpen={onOpen} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

type CompareResponse = Awaited<ReturnType<typeof api.graph.compare>>;

function ComparePane({
  a,
  b,
  comparison,
  loading,
  onOpen,
}: {
  a: string | null;
  b: string | null;
  comparison: CompareResponse | undefined;
  loading: boolean;
  onOpen: (id: string) => void;
}) {
  if (!a || !b) {
    return (
      <div className="h-full flex items-center justify-center p-10">
        <div className="text-center max-w-sm">
          <div className="w-14 h-14 mx-auto rounded-2xl bg-purple-50 flex items-center justify-center mb-4">
            <span className="text-2xl">⇄</span>
          </div>
          <p className="text-gray-700 font-semibold">Pick two papers</p>
          <p className="text-gray-400 text-sm mt-1.5 leading-relaxed">
            The middle column is what they both engage with, the sides are where they diverge. Each
            shared concept is a two-hop path between the two papers in the graph.
          </p>
        </div>
      </div>
    );
  }
  if (loading || !comparison) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="animate-spin rounded-full h-10 w-10 border-b-4 border-purple-600" />
      </div>
    );
  }

  const Column = ({
    title,
    items,
    tone,
  }: {
    title: string;
    items: Array<{ id: string; name: string; type: string }>;
    tone: string;
  }) => (
    <div className="flex-1 min-w-0">
      <h3 className={`text-xs font-bold uppercase tracking-wide mb-2 ${tone}`}>
        {title} <span className="text-gray-400 font-medium">{items.length}</span>
      </h3>
      <div className="space-y-1.5">
        {items.length === 0 && <p className="text-xs text-gray-400">Nothing.</p>}
        {items.slice(0, 40).map((n) => (
          <button
            key={n.id}
            onClick={() => onOpen(n.id)}
            className="w-full text-left flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-gray-50"
          >
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ background: colorFor(n.type) }}
            />
            <span className="text-xs text-gray-700 truncate">{n.name}</span>
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="p-6">
      <div className="mb-5">
        <h2 className="text-base font-bold text-gray-900 leading-snug">
          {comparison.a.name} <span className="text-gray-300 mx-1">⇄</span> {comparison.b.name}
        </h2>
        <p className="text-xs text-gray-500 mt-1.5">
          {comparison.shared.length === 0
            ? 'These two share nothing — there is no path between them in the graph.'
            : `${comparison.shared.length} shared · each one is a two-hop path between these papers`}
        </p>
      </div>
      <div className="flex gap-6">
        <Column title="Only in the first" items={comparison.onlyA} tone="text-blue-700" />
        <div className="flex-1 min-w-0 border-x border-gray-200 px-6">
          <Column title="Shared" items={comparison.shared} tone="text-emerald-700" />
        </div>
        <Column title="Only in the second" items={comparison.onlyB} tone="text-orange-700" />
      </div>
    </div>
  );
}
