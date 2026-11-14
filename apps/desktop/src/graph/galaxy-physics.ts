/**
 * 为电子书和 RSS 星图共享的图形结构与布局物理计算。
 */
export type GalaxyNodeKind =
  | 'sun'
  | 'cluster'
  | 'planet'
  | 'satellite'
  | 'footnote';
export type GalaxyLinkKind = 'orbit' | 'sequence' | 'cross_link';

export interface GalaxyLink {
  source: string;
  target: string;
  kind: GalaxyLinkKind;
  label?: string;
  color?: string;
}

export interface GalaxyPhysicsNode {
  id: string;
  kind: GalaxyNodeKind;
  parentId?: string;
  x: number;
  y: number;
  radius: number;
  orbitRadius?: number;
  orbitAngle?: number;
}

export interface GalaxyPhysicsConfig {
  repelStrength: number;
  linkDistanceScale: number;
  linkTension: number;
  centerGravity: number;
}

export const DEFAULT_GALAXY_PHYSICS_CONFIG: GalaxyPhysicsConfig = {
  repelStrength: 1,
  linkDistanceScale: 1,
  linkTension: 1,
  centerGravity: 1,
};

export interface GalaxySimBody {
  id: string;
  kind: GalaxyNodeKind;
  parentId?: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  anchorX: number;
  anchorY: number;
  fx: number | null;
  fy: number | null;
  radius: number;
  orbitRadius: number;
  orbitAngle: number;
}

export interface GalaxyPhysicsState {
  bodies: Map<string, GalaxySimBody>;
  bodyList: GalaxySimBody[];
  links: GalaxyLink[];
  alpha: number;
}

export function buildGalaxyAdjacencyMap<
  TNode extends Pick<GalaxyPhysicsNode, 'id' | 'kind' | 'parentId'>,
>(
  nodes: readonly TNode[],
  links: readonly GalaxyLink[],
  options?: { includeSequence?: boolean; includeCrossLinks?: boolean },
): Map<string, Set<string>> {
  const includeSequence = options?.includeSequence ?? false;
  const includeCrossLinks = options?.includeCrossLinks ?? true;
  const map = new Map<string, Set<string>>();
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  for (const node of nodes) map.set(node.id, new Set([node.id]));
  for (const link of links) {
    if (link.kind === 'sequence' && !includeSequence) continue;
    if (link.kind === 'cross_link' && !includeCrossLinks) continue;
    map.get(link.source)?.add(link.target);
    map.get(link.target)?.add(link.source);
  }

  // 聚类或小节高亮时，递归纳入旗下三级子节与脚注子节点。
  for (const node of nodes) {
    if (
      (node.kind !== 'satellite' && node.kind !== 'footnote') ||
      !node.parentId
    ) {
      continue;
    }
    let ancestor = nodeById.get(node.parentId);
    while (ancestor && ancestor.kind !== 'sun') {
      map.get(ancestor.id)?.add(node.id);
      if (node.kind === 'footnote') {
        map.get(node.id)?.add(ancestor.id);
      }
      ancestor = ancestor.parentId
        ? nodeById.get(ancestor.parentId)
        : undefined;
    }
  }
  return map;
}

export function createGalaxyPhysicsState<
  TNode extends GalaxyPhysicsNode,
>(graph: {
  nodes: readonly TNode[];
  links: readonly GalaxyLink[];
}): GalaxyPhysicsState {
  const bodies = new Map<string, GalaxySimBody>();
  const bodyList: GalaxySimBody[] = [];

  for (const node of graph.nodes) {
    const body: GalaxySimBody = {
      id: node.id,
      kind: node.kind,
      parentId: node.parentId,
      x: node.x,
      y: node.y,
      vx: 0,
      vy: 0,
      anchorX: node.x,
      anchorY: node.y,
      fx: null,
      fy: null,
      radius: node.radius,
      orbitRadius: node.orbitRadius ?? Math.hypot(node.x, node.y),
      orbitAngle: node.orbitAngle ?? Math.atan2(node.y, node.x),
    };
    bodies.set(node.id, body);
    bodyList.push(body);
  }

  return { bodies, bodyList, links: [...graph.links], alpha: 0.45 };
}

/** 推进一帧力导向布局；节点稳定后停止动画计算。 */
export function stepGalaxyPhysics(
  state: GalaxyPhysicsState,
  config: GalaxyPhysicsConfig = DEFAULT_GALAXY_PHYSICS_CONFIG,
  visibleIds?: Set<string>,
): boolean {
  const { bodies, bodyList, links } = state;
  const hasPinned = bodyList.some(
    (body) => body.fx !== null || body.fy !== null,
  );
  if (state.alpha < 0.002 && !hasPinned) return false;

  const activeAlpha = hasPinned ? Math.max(state.alpha, 0.28) : state.alpha;
  const distScale = config.linkDistanceScale;
  const tension = config.linkTension;
  const repel = config.repelStrength;
  const gravity = config.centerGravity;
  const activeBodies = visibleIds
    ? bodyList.filter((body) => visibleIds.has(body.id))
    : bodyList;
  const count = activeBodies.length;
  const maxRepelDistance = 210;
  const maxRepelDistanceSquared = maxRepelDistance * maxRepelDistance;

  for (let i = 0; i < count; i++) {
    const a = activeBodies[i];
    for (let j = i + 1; j < count; j++) {
      const b = activeBodies[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (Math.abs(dx) > maxRepelDistance || Math.abs(dy) > maxRepelDistance)
        continue;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared > maxRepelDistanceSquared) continue;

      const distance = Math.max(8, Math.sqrt(distanceSquared));
      const isFootnotePair = a.kind === 'footnote' || b.kind === 'footnote';
      const minGap =
        (a.radius + b.radius + (isFootnotePair ? 11 : 22)) * Math.sqrt(repel);
      const charge =
        a.kind === 'sun' || b.kind === 'sun'
          ? 2400 * repel
          : a.kind === 'cluster' && b.kind === 'cluster'
            ? 1450 * repel
            : isFootnotePair
              ? 210 * repel
              : 460 * repel;
      let force = (charge / (distanceSquared + 120)) * activeAlpha;
      if (distance < minGap) force += (minGap - distance) * 0.22 * activeAlpha;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;

      if (a.fx === null && a.kind !== 'sun') {
        a.vx -= fx;
        a.vy -= fy;
      }
      if (b.fx === null && b.kind !== 'sun') {
        b.vx += fx;
        b.vy += fy;
      }
    }
  }

  for (const link of links) {
    if (
      visibleIds &&
      (!visibleIds.has(link.source) || !visibleIds.has(link.target))
    )
      continue;
    const source = bodies.get(link.source);
    const target = bodies.get(link.target);
    if (!source || !target) continue;
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const distance = Math.max(1, Math.hypot(dx, dy));

    if (link.kind === 'orbit') {
      const restLength = (target.orbitRadius || 100) * distScale;
      const spring =
        (target.kind === 'cluster'
          ? 0.065
          : target.kind === 'planet'
            ? 0.14
            : target.kind === 'footnote'
              ? 0.22
              : 0.18) *
        tension *
        activeAlpha;
      const delta = (distance - restLength) * spring;
      const fx = (dx / distance) * delta;
      const fy = (dy / distance) * delta;
      if (source.fx === null && source.kind !== 'sun') {
        const parentWeight = target.fx !== null ? 0.55 : 0.22;
        source.vx += fx * parentWeight;
        source.vy += fy * parentWeight;
      }
      if (target.fx === null) {
        const childWeight = source.fx !== null ? 0.92 : 0.78;
        target.vx -= fx * childWeight;
        target.vy -= fy * childWeight;
      }
    } else if (link.kind === 'cross_link') {
      const restLength = 240 * distScale;
      const spring = 0.015 * tension * activeAlpha;
      const delta = (distance - restLength) * spring;
      const fx = (dx / distance) * delta;
      const fy = (dy / distance) * delta;
      if (source.fx === null) {
        source.vx += fx;
        source.vy += fy;
      }
      if (target.fx === null) {
        target.vx -= fx;
        target.vy -= fy;
      }
    }
  }

  const sun = bodies.get('sun-root');
  if (sun && sun.fx === null) {
    sun.vx += (0 - sun.x) * 0.18 * gravity;
    sun.vy += (0 - sun.y) * 0.18 * gravity;
  }

  for (const body of activeBodies) {
    if (body.fx !== null && body.fy !== null) {
      body.x = body.fx;
      body.y = body.fy;
      body.vx = 0;
      body.vy = 0;
      continue;
    }

    if (body.kind === 'cluster' && sun) {
      const targetX = sun.x + body.anchorX * distScale;
      const targetY = sun.y + body.anchorY * distScale;
      body.vx += (targetX - body.x) * 0.042 * gravity * activeAlpha;
      body.vy += (targetY - body.y) * 0.042 * gravity * activeAlpha;
    } else if (
      (body.kind === 'planet' ||
        body.kind === 'satellite' ||
        body.kind === 'footnote') &&
      body.parentId
    ) {
      const parent = bodies.get(body.parentId);
      if (parent) {
        const relativeX =
          Math.cos(body.orbitAngle) * body.orbitRadius * distScale;
        const relativeY =
          Math.sin(body.orbitAngle) * body.orbitRadius * distScale;
        const targetX = parent.x + relativeX;
        const targetY = parent.y + relativeY;
        const pull =
          parent.fx !== null
            ? body.kind === 'planet'
              ? 0.16
              : body.kind === 'footnote'
                ? 0.24
                : 0.2
            : (body.kind === 'planet'
                ? 0.055
                : body.kind === 'footnote'
                  ? 0.095
                  : 0.075) *
              gravity *
              activeAlpha;
        body.vx += (targetX - body.x) * pull;
        body.vy += (targetY - body.y) * pull;
      }
    }

    body.vx *= 0.76;
    body.vy *= 0.76;
    const speed = Math.hypot(body.vx, body.vy);
    if (speed > 28) {
      body.vx = (body.vx / speed) * 28;
      body.vy = (body.vy / speed) * 28;
    }
    body.x += body.vx;
    body.y += body.vy;
  }

  // Keep collapsed/hidden footnote satellites anchored to their parent cluster's latest position.
  if (visibleIds) {
    for (const body of bodyList) {
      if (
        body.kind !== 'footnote' ||
        visibleIds.has(body.id) ||
        !body.parentId
      ) {
        continue;
      }
      const parent = bodies.get(body.parentId);
      if (!parent) continue;
      body.x =
        parent.x + Math.cos(body.orbitAngle) * body.orbitRadius * distScale;
      body.y =
        parent.y + Math.sin(body.orbitAngle) * body.orbitRadius * distScale;
      body.vx = 0;
      body.vy = 0;
    }
  }

  if (!hasPinned) state.alpha *= 0.965;
  return true;
}
