import type { GalaxyLink, GalaxyPhysicsNode } from '../graph/galaxy-physics';
import type { EpubExamSummary } from './epub-exams';
import type { ExamReviewSchedule, ReviewUrgency } from './review-schedule';

export interface ExamGraphPosition {
  id: string;
  x: number;
  y: number;
  ring: number;
  order: number;
}

export interface ExamGraphLayout {
  nodes: ExamGraphPosition[];
  radius: number;
  extent: number;
}

const FIRST_RING_CAPACITY = 8;
const RING_CAPACITY_STEP = 6;
const NODE_HALF_WIDTH = 90;

export function layoutExamGraph(ids: readonly string[]): ExamGraphLayout {
  const nodes: ExamGraphPosition[] = [];
  let offset = 0;
  let ring = 0;

  // 根据首环节点数量自适应半径，当只有1~3份试卷时紧凑聚合，避免极端空旷；节点充裕时保持标准轨道步进
  const baseRadius =
    ids.length <= 1 ? 165 : ids.length <= 3 ? 185 : ids.length <= 5 ? 210 : 230;
  const ringStep = 170;

  while (offset < ids.length) {
    const capacity = FIRST_RING_CAPACITY + ring * RING_CAPACITY_STEP;
    const count = Math.min(capacity, ids.length - offset);
    const radius = baseRadius + ring * ringStep;
    for (let index = 0; index < count; index += 1) {
      // 首个节点始终在正上方；稳定排序保证刷新后节点不会无故跳位。
      const angle = (2 * Math.PI * index) / count - Math.PI / 2;
      nodes.push({
        id: ids[offset + index],
        x: Math.round(radius * Math.cos(angle)),
        y: Math.round(radius * Math.sin(angle)),
        ring: ring + 1,
        order: offset + index + 1,
      });
    }
    offset += count;
    ring += 1;
  }
  const radius = nodes.length ? baseRadius + (ring - 1) * ringStep : 0;
  return {
    nodes,
    radius,
    extent: Math.max(160, radius + NODE_HALF_WIDTH + 16),
  };
}

/* ==========================================================================
   Force-Directed Exam Galaxy Model (aligned with graph/galaxy-physics.ts)
   ========================================================================== */

export type ExamGalaxyMode = 'book' | 'library';

export interface ExamGalaxyInputItem {
  exam: EpubExamSummary;
  schedule: ExamReviewSchedule;
}

export interface ExamGalaxyStarNode extends GalaxyPhysicsNode {
  label: string;
  shortCode: string;
  subtitle: string;
  color: string;
  degree: number;
  urgency?: ReviewUrgency;
  bookKey?: string;
  bookTitle?: string;
  exam?: EpubExamSummary;
  schedule?: ExamReviewSchedule;
  examCount: number;
  dueCount: number;
  isFocus: boolean;
  isHighlighted: boolean;
}

export interface ExamGalaxyGraph {
  mode: ExamGalaxyMode;
  nodes: ExamGalaxyStarNode[];
  links: GalaxyLink[];
  clusterOrbits: number[];
}

export interface BuildExamGalaxyOptions {
  mode: ExamGalaxyMode;
  bookKey?: string;
  bookTitle?: string;
  selectedId?: string | null;
}

export const EXAM_ROOT_ID = 'sun-root';

const URGENCY_COLOR: Record<ReviewUrgency, string> = {
  overdue: '#e04332',
  today: '#f97316',
  upcoming: '#f59e0b',
  inProgress: '#38bdf8',
  notStarted: '#94a3b8',
  later: '#34d399',
};

const BUCKET_META = {
  due: { label: '逾期 / 今日待交', short: '待交', color: '#e05638' },
  upcoming: { label: '三日内待复习', short: '即将', color: '#f59e0b' },
  inProgress: { label: '重做进行中', short: '重做', color: '#38bdf8' },
  steady: { label: '稳固 / 待初练', short: '稳固', color: '#34d399' },
} as const;

type BucketKey = keyof typeof BUCKET_META;

function urgencyBucket(urgency: ReviewUrgency): BucketKey {
  if (urgency === 'overdue' || urgency === 'today') return 'due';
  if (urgency === 'upcoming') return 'upcoming';
  if (urgency === 'inProgress') return 'inProgress';
  return 'steady';
}

function clusterOrbitRadius(index: number, total: number): number {
  if (total <= 4) return 310;
  if (total <= 8) return 340;
  if (total <= 16) return index % 2 === 0 ? 330 : 490;
  const tier = index % 3;
  return tier === 0 ? 330 : tier === 1 ? 480 : 630;
}

function placeInFan(
  cx: number,
  cy: number,
  baseAngle: number,
  idx: number,
  count: number,
  baseRadius: number,
  radialStep: number,
): { x: number; y: number } {
  const perRing = Math.max(6, Math.min(12, Math.ceil(count / 2)));
  const ring = Math.floor(idx / perRing);
  const slot = idx % perRing;
  const inRing = Math.min(perRing, count - ring * perRing);
  const span = Math.min(Math.PI * 1.15, Math.max(0.45, inRing * 0.34));
  const offsetAngle = inRing <= 1 ? 0 : (slot / (inRing - 1) - 0.5) * span;
  const angle = baseAngle + offsetAngle;
  const radius = baseRadius + ring * radialStep;
  return {
    x: cx + Math.cos(angle) * radius,
    y: cy + Math.sin(angle) * radius,
  };
}

function truncateLabel(text: string, limit: number): string {
  const chars = Array.from(text.trim());
  if (chars.length <= limit) return text.trim();
  return `${chars.slice(0, limit).join('')}…`;
}

function planetRadiusOf(exam: EpubExamSummary): number {
  return Math.max(
    13,
    Math.min(24, 11 + Math.sqrt(Math.max(1, exam.questionCount || 1)) * 2.1),
  );
}

export function buildExamGalaxyGraph(
  items: readonly ExamGalaxyInputItem[],
  options: BuildExamGalaxyOptions,
): ExamGalaxyGraph {
  const mode = options.mode;
  const nodes: ExamGalaxyStarNode[] = [];
  const links: GalaxyLink[] = [];
  const clusterOrbits = new Set<number>();

  const totalDue = items.filter(
    ({ schedule }) =>
      schedule.urgency === 'overdue' || schedule.urgency === 'today',
  ).length;

  const sunLabel =
    mode === 'book'
      ? options.bookTitle?.trim() || items[0]?.exam.bookTitle || '本书试卷'
      : '全部试卷星系';

  nodes.push({
    id: EXAM_ROOT_ID,
    kind: 'sun',
    x: 0,
    y: 0,
    radius: 38,
    label: sunLabel,
    shortCode: mode === 'book' ? '当前书籍' : '试卷总览',
    subtitle: `${items.length} 套试卷 · 待交 ${totalDue}`,
    color: '#e05638',
    degree: 0,
    bookKey: options.bookKey,
    bookTitle: sunLabel,
    examCount: items.length,
    dueCount: totalDue,
    isFocus: false,
    isHighlighted: totalDue > 0,
  });

  if (items.length === 0) {
    return { mode, nodes, links, clusterOrbits: [] };
  }

  // Only one exam can receive the focus pulse ring
  const explicitSelected =
    options.selectedId &&
    items.some(({ exam }) => exam.id === options.selectedId)
      ? options.selectedId
      : null;
  const fallbackDue =
    items.find(
      ({ schedule }) =>
        schedule.urgency === 'overdue' || schedule.urgency === 'today',
    )?.exam.id ??
    items[0]?.exam.id ??
    null;
  const focusExamId = explicitSelected ?? fallbackDue;

  interface ClusterGroup {
    id: string;
    label: string;
    shortCode: string;
    subtitle: string;
    color: string;
    bookKey?: string;
    bookTitle?: string;
    items: ExamGalaxyInputItem[];
    dueCount: number;
  }

  const groups: ClusterGroup[] = [];

  if (mode === 'library') {
    const byBook = new Map<string, ExamGalaxyInputItem[]>();
    for (const item of items) {
      const key = item.exam.bookKey || 'unknown';
      const bucket = byBook.get(key) ?? [];
      bucket.push(item);
      byBook.set(key, bucket);
    }
    for (const [bKey, bookItems] of byBook.entries()) {
      const due = bookItems.filter(
        ({ schedule }) =>
          schedule.urgency === 'overdue' || schedule.urgency === 'today',
      ).length;
      const title = bookItems[0]?.exam.bookTitle || bKey;
      groups.push({
        id: `cluster:book:${bKey}`,
        label: title,
        shortCode: `${bookItems.length} 卷`,
        subtitle: due > 0 ? `${due} 份待交` : '已稳固',
        color: due > 0 ? '#e05638' : '#38bdf8',
        bookKey: bKey,
        bookTitle: title,
        items: bookItems,
        dueCount: due,
      });
    }
    groups.sort(
      (a, b) =>
        b.dueCount - a.dueCount ||
        b.items.length - a.items.length ||
        a.label.localeCompare(b.label, 'zh-CN'),
    );
  } else {
    const order: BucketKey[] = ['due', 'upcoming', 'inProgress', 'steady'];
    const byBucket = new Map<BucketKey, ExamGalaxyInputItem[]>();
    for (const item of items) {
      const key = urgencyBucket(item.schedule.urgency);
      const list = byBucket.get(key) ?? [];
      list.push(item);
      byBucket.set(key, list);
    }
    for (const key of order) {
      const list = byBucket.get(key);
      if (!list?.length) continue;
      const meta = BUCKET_META[key];
      groups.push({
        id: `cluster:status:${key}`,
        label: meta.label,
        shortCode: `${list.length} 卷`,
        subtitle: `${list.length} 份试卷`,
        color: meta.color,
        bookKey: options.bookKey,
        items: list,
        dueCount: key === 'due' ? list.length : 0,
      });
    }
  }

  const totalClusters = groups.length;
  groups.forEach((group, cIdx) => {
    const orbit = clusterOrbitRadius(cIdx, totalClusters);
    clusterOrbits.add(orbit);
    const angle =
      -Math.PI / 2 + (cIdx / Math.max(1, totalClusters)) * Math.PI * 2;
    const cx = Math.cos(angle) * orbit;
    const cy = Math.sin(angle) * orbit;

    const clusterRadius = Math.max(
      18,
      Math.min(30, 15 + Math.sqrt(group.items.length) * 3.8),
    );

    nodes.push({
      id: group.id,
      kind: 'cluster',
      parentId: EXAM_ROOT_ID,
      x: cx,
      y: cy,
      orbitRadius: orbit,
      orbitAngle: angle,
      radius: clusterRadius,
      label: group.label,
      shortCode: group.shortCode,
      subtitle: group.subtitle,
      color: group.color,
      degree: group.items.length + 1,
      bookKey: group.bookKey,
      bookTitle: group.bookTitle,
      examCount: group.items.length,
      dueCount: group.dueCount,
      isFocus: false,
      isHighlighted: group.dueCount > 0,
    });

    links.push({
      source: EXAM_ROOT_ID,
      target: group.id,
      kind: 'orbit',
      color: group.color,
    });

    const sortedExams = [...group.items].sort(
      (a, b) =>
        (a.exam.sourceSectionIndex ?? 999999) -
          (b.exam.sourceSectionIndex ?? 999999) ||
        a.exam.createdAt - b.exam.createdAt,
    );

    sortedExams.forEach((item, eIdx) => {
      const pos = placeInFan(cx, cy, angle, eIdx, sortedExams.length, 142, 52);
      const color = URGENCY_COLOR[item.schedule.urgency];
      const title =
        item.exam.sourceSectionLabel || item.exam.bookTitle || '未命名试卷';
      const isDue =
        item.schedule.urgency === 'overdue' ||
        item.schedule.urgency === 'today';

      nodes.push({
        id: item.exam.id,
        kind: 'planet',
        parentId: group.id,
        x: pos.x,
        y: pos.y,
        orbitRadius: 142,
        orbitAngle: angle,
        radius: planetRadiusOf(item.exam),
        label: title,
        shortCode: `第${(item.exam.sourceSectionIndex ?? eIdx) + 1}章 · ${item.exam.questionCount}题`,
        subtitle: item.exam.bookTitle,
        color,
        degree: 1,
        urgency: item.schedule.urgency,
        bookKey: item.exam.bookKey,
        bookTitle: item.exam.bookTitle,
        exam: item.exam,
        schedule: item.schedule,
        examCount: 1,
        dueCount: isDue ? 1 : 0,
        isFocus: item.exam.id === focusExamId,
        isHighlighted: isDue || item.exam.id === focusExamId,
      });

      links.push({
        source: group.id,
        target: item.exam.id,
        kind: 'orbit',
        color,
      });

      if (eIdx > 0) {
        links.push({
          source: sortedExams[eIdx - 1].exam.id,
          target: item.exam.id,
          kind: 'sequence',
          color: group.color,
        });
      }
    });
  });

  const root = nodes[0];
  if (root) {
    root.degree = groups.length;
  }

  return {
    mode,
    nodes,
    links,
    clusterOrbits: [...clusterOrbits].sort((a, b) => a - b),
  };
}

export { truncateLabel };
