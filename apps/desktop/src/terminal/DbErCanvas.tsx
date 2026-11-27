import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import {
  calcErEdgePath,
  computeDragSnapFast,
  computeFitViewport,
  precomputeSnapBoxes,
} from './db-er-layout';
import {
  ER_CARD_WIDTH,
  ER_GRID_SIZE,
  ER_LOD_TABLE_THRESHOLD,
  ER_LOD_ZOOM_THRESHOLD,
  ER_NOTE_COLORS,
  estimateTableCardHeight,
  getColumnAnchorY,
  type ErCanvasNote,
  type ErCardinality,
  type ErDiagramState,
  type ErRelation,
  type ErSubjectArea,
  type ErViewport,
} from './db-er-model';
import { DbErEdgeLayer, renderActiveDragOverlaySvg } from './DbErEdgeLayer';
import { DbErTableCard } from './DbErTableCard';

export interface DbErCanvasProps {
  diagram: ErDiagramState;
  viewport: ErViewport;
  selectedTableId: string | null;
  selectedRelationId: string | null;
  presentationMode: boolean;
  onSelectTable: (tableId: string | null) => void;
  onSelectRelation: (relationId: string | null) => void;
  onViewportChange: (viewport: ErViewport) => void;
  onCommitTablePosition: (tableId: string, x: number, y: number) => void;
  onToggleCollapseTable: (tableId: string) => void;
  onOpenProfiler: (tableId: string) => void;
  onQuickSql: (tableId: string) => void;
  onCreateLogicalRelation: (
    sourceTableId: string,
    sourceColumn: string,
    targetTableId: string,
    targetColumn: string,
  ) => void;
  onAcceptInferredRelation: (rel: ErRelation) => void;
  onDismissInferredRelation: (relId: string) => void;
  onUpdateLogicalRelation: (
    relId: string,
    patch: Partial<Pick<ErRelation, 'cardinality' | 'note'>>,
  ) => void;
  onDeleteLogicalRelation: (relId: string) => void;
  onGenerateRelationCode: (
    rel: ErRelation,
    kind: 'sql' | 'python' | 'r' | 'duckdb',
  ) => void;
  onUpdateArea: (areaId: string, patch: Partial<ErSubjectArea>) => void;
  onUpdateNote: (noteId: string, patch: Partial<ErCanvasNote>) => void;
  onDeleteNote: (noteId: string) => void;
  onAutoLayout: () => void;
  onTogglePresentation: () => void;
}

const CARDINALITY_OPTIONS: readonly ErCardinality[] = [
  'N:1',
  '1:N',
  '1:1',
  'N:M',
  '0:1',
  '0:N',
];

const EMPTY_STRING_SET: ReadonlySet<string> = new Set<string>();

interface ErMinimapProps {
  tables: ErDiagramState['tables'];
  subjectAreas: ErDiagramState['subjectAreas'];
  selectedTableId: string | null;
  bounds: { minX: number; minY: number; width: number; height: number };
  vpRect: { x: number; y: number; w: number; h: number };
  vpRectRef: RefObject<SVGRectElement | null>;
  onJumpToWorld: (worldX: number, worldY: number) => void;
}

const ErMinimap = memo(function ErMinimap({
  tables,
  subjectAreas,
  selectedTableId,
  bounds,
  vpRect,
  vpRectRef,
  onJumpToWorld,
}: ErMinimapProps) {
  return (
    <div
      className="er-minimap"
      title="点击小地图快速平移视角"
      onClick={(e) => {
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        const rx = (e.clientX - rect.left) / rect.width;
        const ry = (e.clientY - rect.top) / rect.height;
        onJumpToWorld(
          bounds.minX + rx * bounds.width,
          bounds.minY + ry * bounds.height,
        );
      }}
    >
      <svg
        viewBox={`${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`}
        preserveAspectRatio="xMidYMid meet"
      >
        {subjectAreas.map((a) => (
          <rect
            key={a.id}
            x={a.x}
            y={a.y}
            width={a.width}
            height={a.height}
            fill={a.color}
            fillOpacity={0.14}
            stroke={a.color}
            strokeOpacity={0.45}
            strokeWidth={12}
          />
        ))}
        {tables.map((t) => (
          <rect
            key={t.id}
            data-minimap-table={t.id}
            x={t.x}
            y={t.y}
            width={t.width}
            height={estimateTableCardHeight(t, false)}
            fill={
              t.id === selectedTableId ? 'var(--term-accent, #467b5e)' : t.color
            }
            fillOpacity={t.id === selectedTableId ? 0.95 : 0.65}
            rx={14}
          />
        ))}
        <rect
          ref={vpRectRef}
          x={vpRect.x}
          y={vpRect.y}
          width={vpRect.w}
          height={vpRect.h}
          className="er-minimap-vp"
        />
      </svg>
    </div>
  );
});

export function DbErCanvas({
  diagram,
  viewport,
  selectedTableId,
  selectedRelationId,
  presentationMode,
  onSelectTable,
  onSelectRelation,
  onViewportChange,
  onCommitTablePosition,
  onToggleCollapseTable,
  onOpenProfiler,
  onQuickSql,
  onCreateLogicalRelation,
  onAcceptInferredRelation,
  onDismissInferredRelation,
  onUpdateLogicalRelation,
  onDeleteLogicalRelation,
  onGenerateRelationCode,
  onUpdateArea,
  onUpdateNote,
  onDeleteNote,
  onAutoLayout,
  onTogglePresentation,
}: DbErCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const gridLayerRef = useRef<HTMLDivElement | null>(null);
  const worldLayerRef = useRef<HTMLDivElement | null>(null);
  const edgeLayerSvgRef = useRef<SVGSVGElement | null>(null);
  const dragOverlaySvgRef = useRef<SVGSVGElement | null>(null);
  const minimapVpRef = useRef<SVGRectElement | null>(null);
  const zoomLabelRef = useRef<HTMLSpanElement | null>(null);

  const [canvasSize, setCanvasSize] = useState({ width: 960, height: 640 });
  const [hoveredRelationId, setHoveredRelationId] = useState<string | null>(
    null,
  );
  const [isLinking, setIsLinking] = useState(false);

  // Live refs so pointer/wheel handlers NEVER stale-close or force React re-renders
  const viewportRef = useRef<ErViewport>(viewport);
  const canvasSizeRef = useRef(canvasSize);
  canvasSizeRef.current = canvasSize;
  const showGridRef = useRef(diagram.showGrid);
  showGridRef.current = diagram.showGrid;
  const snapToGridRef = useRef(diagram.snapToGrid);
  snapToGridRef.current = diagram.snapToGrid;
  const routingRef = useRef(diagram.routing);
  routingRef.current = diagram.routing;
  const diagramRef = useRef(diagram);
  diagramRef.current = diagram;
  const draftLinkRef = useRef<{
    sourceTableId: string;
    sourceColumn: string;
    startX: number;
    startY: number;
  } | null>(null);
  const wheelCommitTimerRef = useRef<number | null>(null);
  const wheelRafRef = useRef<number>(0);

  /**
   * Direct GPU DOM viewport sync — ZERO React reconciliations during pan/zoom!
   */
  const applyViewportToDom = useCallback((vp: ErViewport) => {
    viewportRef.current = vp;
    const world = worldLayerRef.current;
    if (world) {
      world.style.transform = `translate3d(${vp.x}px, ${vp.y}px, 0) scale(${vp.zoom})`;
    }
    const gridEl = gridLayerRef.current;
    if (gridEl && showGridRef.current) {
      const step = Math.max(10, Math.min(56, ER_GRID_SIZE * vp.zoom));
      const modX = ((vp.x % step) + step) % step;
      const modY = ((vp.y % step) + step) % step;
      gridEl.style.backgroundSize = `${step}px ${step}px`;
      gridEl.style.transform = `translate3d(${modX}px, ${modY}px, 0)`;
    }
    const zoomLbl = zoomLabelRef.current;
    if (zoomLbl) {
      zoomLbl.textContent = `${Math.round(vp.zoom * 100)}%`;
    }
    const vpRectEl = minimapVpRef.current;
    if (vpRectEl) {
      const sz = canvasSizeRef.current;
      vpRectEl.setAttribute('x', String(-vp.x / vp.zoom));
      vpRectEl.setAttribute('y', String(-vp.y / vp.zoom));
      vpRectEl.setAttribute('width', String(sz.width / vp.zoom));
      vpRectEl.setAttribute('height', String(sz.height / vp.zoom));
    }
  }, []);

  // Keep DOM synced whenever external viewport prop updates (fit, sidebar jump, undo, DB switch)
  useEffect(() => {
    applyViewportToDom(viewport);
  }, [applyViewportToDom, viewport]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setCanvasSize({ width: rect.width, height: rect.height });
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Native non-passive wheel listener for locked 120fps DOM zoom with debounced React commit
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onWheel = (event: WheelEvent) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('.er-edge-popover, textarea, input')
      ) {
        return;
      }
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const vp = viewportRef.current;
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;

      let nextVp: ErViewport;
      if (event.deltaY !== 0 || event.deltaX !== 0) {
        const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
        const nextZoom = Math.max(
          0.18,
          Math.min(2.2, Math.round(vp.zoom * factor * 1000) / 1000),
        );
        const worldX = (mouseX - vp.x) / vp.zoom;
        const worldY = (mouseY - vp.y) / vp.zoom;
        nextVp = {
          x: Math.round(mouseX - worldX * nextZoom),
          y: Math.round(mouseY - worldY * nextZoom),
          zoom: nextZoom,
        };
      } else {
        return;
      }

      viewportRef.current = nextVp;
      if (!wheelRafRef.current) {
        wheelRafRef.current = requestAnimationFrame(() => {
          wheelRafRef.current = 0;
          applyViewportToDom(viewportRef.current);
        });
      }

      if (wheelCommitTimerRef.current !== null) {
        window.clearTimeout(wheelCommitTimerRef.current);
      }
      wheelCommitTimerRef.current = window.setTimeout(() => {
        wheelCommitTimerRef.current = null;
        onViewportChange(viewportRef.current);
      }, 160);
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      if (wheelRafRef.current) cancelAnimationFrame(wheelRafRef.current);
      if (wheelCommitTimerRef.current !== null) {
        window.clearTimeout(wheelCommitTimerRef.current);
      }
    };
  }, [applyViewportToDom, onViewportChange]);

  const tablesById = useMemo(
    () => new Map(diagram.tables.map((t) => [t.id, t])),
    [diagram.tables],
  );
  const tablesByIdRef = useRef(tablesById);
  tablesByIdRef.current = tablesById;

  const lodCompact =
    diagram.tables.length > ER_LOD_TABLE_THRESHOLD &&
    viewport.zoom < ER_LOD_ZOOM_THRESHOLD;
  const lodCompactRef = useRef(lodCompact);
  lodCompactRef.current = lodCompact;

  // Viewport culling when diagram has > 60 tables
  const visibleTables = useMemo(() => {
    if (diagram.tables.length <= ER_LOD_TABLE_THRESHOLD) {
      return diagram.tables;
    }
    const { x: vx, y: vy, zoom } = viewport;
    const overscan = 420;
    const minWorldX = (-vx - overscan) / zoom;
    const minWorldY = (-vy - overscan) / zoom;
    const maxWorldX = (canvasSize.width - vx + overscan) / zoom;
    const maxWorldY = (canvasSize.height - vy + overscan) / zoom;

    return diagram.tables.filter((t) => {
      if (t.id === selectedTableId) return true;
      const h = estimateTableCardHeight(t, lodCompact);
      return (
        t.x + t.width >= minWorldX &&
        t.x <= maxWorldX &&
        t.y + h >= minWorldY &&
        t.y <= maxWorldY
      );
    });
  }, [
    canvasSize.height,
    canvasSize.width,
    diagram.tables,
    lodCompact,
    selectedTableId,
    viewport,
  ]);

  // Precompute FK column sets and issue counts per table (stable refs for React.memo)
  const fkColsByTable = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const r of diagram.relations) {
      if (r.kind === 'inferred') continue;
      const set = map.get(r.sourceTableId) ?? new Set<string>();
      set.add(r.sourceColumn.toLowerCase());
      map.set(r.sourceTableId, set);
    }
    return map;
  }, [diagram.relations]);

  const issueCountByTable = useMemo(() => {
    const map = new Map<string, number>();
    for (const iss of diagram.issues) {
      if (!iss.tableId || iss.severity === 'info') continue;
      map.set(iss.tableId, (map.get(iss.tableId) ?? 0) + 1);
    }
    return map;
  }, [diagram.issues]);

  const connectedTableIds = useMemo(() => {
    const set = new Set<string>();
    if (selectedTableId) {
      set.add(selectedTableId);
      for (const r of diagram.relations) {
        if (r.sourceTableId === selectedTableId) set.add(r.targetTableId);
        if (r.targetTableId === selectedTableId) set.add(r.sourceTableId);
      }
    } else if (selectedRelationId) {
      const rel = diagram.relations.find((r) => r.id === selectedRelationId);
      if (rel) {
        set.add(rel.sourceTableId);
        set.add(rel.targetTableId);
      }
    }
    return set;
  }, [diagram.relations, selectedRelationId, selectedTableId]);

  const screenToWorld = useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    const vp = viewportRef.current;
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left - vp.x) / vp.zoom,
      y: (clientY - rect.top - vp.y) / vp.zoom,
    };
  }, []);

  // Stable callbacks so React.memo on EVERY DbErTableCard stays 100% effective!
  const handleSelectTableCard = useCallback(
    (tableId: string) => {
      onSelectTable(tableId);
      onSelectRelation(null);
    },
    [onSelectRelation, onSelectTable],
  );

  const handleSelectEdge = useCallback(
    (relId: string) => {
      onSelectRelation(relId);
      onSelectTable(null);
    },
    [onSelectRelation, onSelectTable],
  );

  // Zero-React-Render Pan on blank canvas drag
  const handleBackgroundPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 && event.button !== 1) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest(
          '.er-table-card, .er-note-card, .er-area-header, .er-area-resize, .er-edge-popover, .er-canvas-controls, .er-minimap, .er-edge-hit, .er-edge-badge',
        )
      ) {
        return;
      }
      onSelectTable(null);
      onSelectRelation(null);

      const stageEl = containerRef.current;
      stageEl?.classList.add('is-panning', 'is-interacting');

      const startX = event.clientX;
      const startY = event.clientY;
      const originVp = { ...viewportRef.current };
      let latestClientX = startX;
      let latestClientY = startY;
      let rafId = 0;
      let moved = false;

      const onMove = (ev: PointerEvent) => {
        latestClientX = ev.clientX;
        latestClientY = ev.clientY;
        moved = true;
        if (!rafId) {
          rafId = requestAnimationFrame(() => {
            rafId = 0;
            applyViewportToDom({
              ...originVp,
              x: Math.round(originVp.x + (latestClientX - startX)),
              y: Math.round(originVp.y + (latestClientY - startY)),
            });
          });
        }
      };

      const onUp = () => {
        if (rafId) {
          cancelAnimationFrame(rafId);
          applyViewportToDom({
            ...originVp,
            x: Math.round(originVp.x + (latestClientX - startX)),
            y: Math.round(originVp.y + (latestClientY - startY)),
          });
        }
        stageEl?.classList.remove('is-panning', 'is-interacting');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (moved) {
          onViewportChange(viewportRef.current);
        }
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp, { once: true });
    },
    [applyViewportToDom, onSelectRelation, onSelectTable, onViewportChange],
  );

  // Zero-React-Render Table Card Drag (direct DOM transform + isolated drag SVG overlay)
  const handleStartTableDrag = useCallback(
    (tableId: string, event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.stopPropagation();

      const tbl = tablesByIdRef.current.get(tableId);
      if (!tbl) return;

      const stageEl = containerRef.current;
      const cardEl = event.currentTarget.closest(
        '.er-table-card',
      ) as HTMLElement | null;
      const dragSvg = dragOverlaySvgRef.current;
      const staticEdgeSvg = edgeLayerSvgRef.current;
      const minimapRectEl = stageEl?.querySelector(
        `[data-minimap-table="${CSS.escape(tableId)}"]`,
      ) as SVGRectElement | null;

      const curDiagram = diagramRef.current;
      const curLod = lodCompactRef.current;
      const tblWidth = tbl.width || ER_CARD_WIDTH;
      const tblHeight = estimateTableCardHeight(tbl, curLod);

      // Precompute snap boxes & attached edges ONCE on pointerdown
      const snapBoxes = precomputeSnapBoxes(curDiagram.tables, tableId, curLod);
      const pairCounters = new Map<string, number>();
      const attachedRels: Array<{ rel: ErRelation; laneOffset: number }> = [];
      for (let i = 0; i < curDiagram.relations.length; i += 1) {
        const rel = curDiagram.relations[i];
        const pairKey =
          rel.sourceTableId < rel.targetTableId
            ? `${rel.sourceTableId}||${rel.targetTableId}`
            : `${rel.targetTableId}||${rel.sourceTableId}`;
        const lane = pairCounters.get(pairKey) ?? 0;
        pairCounters.set(pairKey, lane + 1);
        if (rel.sourceTableId === tableId || rel.targetTableId === tableId) {
          const laneOffset =
            lane === 0 ? 0 : (lane % 2 === 1 ? 1 : -1) * Math.ceil(lane / 2);
          attachedRels.push({ rel, laneOffset });
        }
      }

      // Collect static SVG edge groups connected to this table so we can hide only them during drag
      const hiddenEdgeGroups: Element[] = [];
      if (staticEdgeSvg && attachedRels.length > 0) {
        const escaped = CSS.escape(tableId);
        const matched = staticEdgeSvg.querySelectorAll(
          `[data-er-src="${escaped}"], [data-er-tgt="${escaped}"]`,
        );
        matched.forEach((node) => hiddenEdgeGroups.push(node));
      }

      const startClientX = event.clientX;
      const startClientY = event.clientY;
      const originX = tbl.x;
      const originY = tbl.y;
      let latestClientX = startClientX;
      let latestClientY = startClientY;
      let latestX = originX;
      let latestY = originY;
      let rafId = 0;
      let dragActivated = false;

      const activateDragVisuals = () => {
        if (dragActivated) return;
        dragActivated = true;
        stageEl?.classList.add('is-interacting');
        cardEl?.classList.add('is-dragging');
        for (let i = 0; i < hiddenEdgeGroups.length; i += 1) {
          hiddenEdgeGroups[i].classList.add('is-hidden-for-drag');
        }
      };

      const paintFrame = () => {
        const zoom = viewportRef.current.zoom;
        const rawX = originX + (latestClientX - startClientX) / zoom;
        const rawY = originY + (latestClientY - startClientY) / zoom;
        const snapped = computeDragSnapFast(
          rawX,
          rawY,
          tblWidth,
          tblHeight,
          snapBoxes,
          snapToGridRef.current,
          ER_GRID_SIZE,
        );
        latestX = Math.round(snapped.x);
        latestY = Math.round(snapped.y);

        if (cardEl) {
          cardEl.style.transform = `translate3d(${latestX}px, ${latestY}px, 0)`;
        }
        if (minimapRectEl) {
          minimapRectEl.setAttribute('x', String(latestX));
          minimapRectEl.setAttribute('y', String(latestY));
        }
        if (dragSvg) {
          const movedTable = { ...tbl, x: latestX, y: latestY };
          renderActiveDragOverlaySvg(
            dragSvg,
            movedTable,
            attachedRels,
            tablesByIdRef.current,
            routingRef.current,
            curLod,
            snapped.guides,
          );
        }
      };

      const onMove = (ev: PointerEvent) => {
        latestClientX = ev.clientX;
        latestClientY = ev.clientY;
        if (
          !dragActivated &&
          Math.abs(latestClientX - startClientX) < 3 &&
          Math.abs(latestClientY - startClientY) < 3
        ) {
          return;
        }
        activateDragVisuals();
        if (!rafId) {
          rafId = requestAnimationFrame(() => {
            rafId = 0;
            paintFrame();
          });
        }
      };

      const onUp = () => {
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
          if (dragActivated) paintFrame();
        }
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);

        stageEl?.classList.remove('is-interacting');
        cardEl?.classList.remove('is-dragging');
        for (let i = 0; i < hiddenEdgeGroups.length; i += 1) {
          hiddenEdgeGroups[i].classList.remove('is-hidden-for-drag');
        }
        if (dragSvg) {
          dragSvg.innerHTML = '';
        }

        onSelectTable(tableId);
        onSelectRelation(null);
        if (dragActivated && (latestX !== originX || latestY !== originY)) {
          onCommitTablePosition(tableId, latestX, latestY);
        }
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp, { once: true });
    },
    [onCommitTablePosition, onSelectRelation, onSelectTable],
  );

  // Zero-React-Render Drag-to-Connect Column Wire
  const handleStartColumnLink = useCallback(
    (
      sourceTableId: string,
      sourceColumn: string,
      side: 'left' | 'right',
      event: ReactPointerEvent<HTMLButtonElement>,
    ) => {
      event.stopPropagation();
      event.preventDefault();
      const srcTbl = tablesByIdRef.current.get(sourceTableId);
      if (!srcTbl) return;
      const startX = side === 'right' ? srcTbl.x + srcTbl.width : srcTbl.x;
      const startY = getColumnAnchorY(
        srcTbl,
        sourceColumn,
        lodCompactRef.current,
      );

      draftLinkRef.current = { sourceTableId, sourceColumn, startX, startY };
      setIsLinking(true);

      const dragSvg = dragOverlaySvgRef.current;
      let latestClientX = event.clientX;
      let latestClientY = event.clientY;
      let rafId = 0;

      const drawWire = () => {
        if (!dragSvg) return;
        const pt = screenToWorld(latestClientX, latestClientY);
        const dir = pt.x >= startX ? 64 : -64;
        const d = `M ${startX} ${startY} C ${startX + dir} ${startY}, ${pt.x - dir} ${pt.y}, ${pt.x} ${pt.y}`;
        dragSvg.innerHTML = `<path class="er-draft-wire" d="${d}" />`;
      };
      drawWire();

      const onMove = (ev: PointerEvent) => {
        latestClientX = ev.clientX;
        latestClientY = ev.clientY;
        if (!rafId) {
          rafId = requestAnimationFrame(() => {
            rafId = 0;
            drawWire();
          });
        }
      };

      const onUp = () => {
        if (rafId) cancelAnimationFrame(rafId);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (dragSvg) dragSvg.innerHTML = '';
        window.setTimeout(() => {
          draftLinkRef.current = null;
          setIsLinking(false);
        }, 0);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp, { once: true });
    },
    [screenToWorld],
  );

  const handleCompleteColumnLink = useCallback(
    (targetTableId: string, targetColumn: string) => {
      const link = draftLinkRef.current;
      if (!link) return;
      draftLinkRef.current = null;
      setIsLinking(false);
      if (dragOverlaySvgRef.current) dragOverlaySvgRef.current.innerHTML = '';
      if (
        link.sourceTableId === targetTableId &&
        link.sourceColumn.toLowerCase() === targetColumn.toLowerCase()
      ) {
        return;
      }
      onCreateLogicalRelation(
        link.sourceTableId,
        link.sourceColumn,
        targetTableId,
        targetColumn,
      );
    },
    [onCreateLogicalRelation],
  );

  // Zero-React-Render Subject Area Move & Resize
  const startAreaDrag = (
    area: ErSubjectArea,
    mode: 'move' | 'resize',
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    event.stopPropagation();
    const areaEl = event.currentTarget.closest(
      '.er-subject-area',
    ) as HTMLElement | null;
    const stageEl = containerRef.current;
    stageEl?.classList.add('is-interacting');

    const startX = event.clientX;
    const startY = event.clientY;
    const origX = area.x;
    const origY = area.y;
    const origW = area.width;
    const origH = area.height;
    let curX = origX;
    let curY = origY;
    let curW = origW;
    let curH = origH;
    let latestClientX = startX;
    let latestClientY = startY;
    let rafId = 0;

    const applyFrame = () => {
      const z = viewportRef.current.zoom;
      const dx = (latestClientX - startX) / z;
      const dy = (latestClientY - startY) / z;
      if (mode === 'move') {
        curX = Math.round(origX + dx);
        curY = Math.round(origY + dy);
        if (areaEl) {
          areaEl.style.transform = `translate3d(${curX}px, ${curY}px, 0)`;
        }
      } else {
        curW = Math.max(220, Math.round(origW + dx));
        curH = Math.max(140, Math.round(origH + dy));
        if (areaEl) {
          areaEl.style.width = `${curW}px`;
          areaEl.style.height = `${curH}px`;
        }
      }
    };

    const onMove = (ev: PointerEvent) => {
      latestClientX = ev.clientX;
      latestClientY = ev.clientY;
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          applyFrame();
        });
      }
    };
    const onUp = () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
        applyFrame();
      }
      stageEl?.classList.remove('is-interacting');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (mode === 'move' && (curX !== origX || curY !== origY)) {
        onUpdateArea(area.id, { x: curX, y: curY });
      } else if (mode === 'resize' && (curW !== origW || curH !== origH)) {
        onUpdateArea(area.id, { width: curW, height: curH });
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  };

  // Zero-React-Render Canvas Note Move
  const startNoteDrag = (
    note: ErCanvasNote,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    event.stopPropagation();
    const noteEl = event.currentTarget.closest(
      '.er-note-card',
    ) as HTMLElement | null;
    const stageEl = containerRef.current;
    stageEl?.classList.add('is-interacting');

    const startX = event.clientX;
    const startY = event.clientY;
    const origX = note.x;
    const origY = note.y;
    let curX = origX;
    let curY = origY;
    let latestClientX = startX;
    let latestClientY = startY;
    let rafId = 0;

    const applyFrame = () => {
      const z = viewportRef.current.zoom;
      curX = Math.round(origX + (latestClientX - startX) / z);
      curY = Math.round(origY + (latestClientY - startY) / z);
      if (noteEl) {
        noteEl.style.transform = `translate3d(${curX}px, ${curY}px, 0)`;
      }
    };

    const onMove = (ev: PointerEvent) => {
      latestClientX = ev.clientX;
      latestClientY = ev.clientY;
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          applyFrame();
        });
      }
    };
    const onUp = () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
        applyFrame();
      }
      stageEl?.classList.remove('is-interacting');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (curX !== origX || curY !== origY) {
        onUpdateNote(note.id, { x: curX, y: curY });
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  };

  const handleFitView = useCallback(() => {
    const next = computeFitViewport(
      diagram.tables,
      diagram.subjectAreas,
      diagram.notes,
      canvasSize.width,
      canvasSize.height,
    );
    applyViewportToDom(next);
    onViewportChange(next);
  }, [
    applyViewportToDom,
    canvasSize.height,
    canvasSize.width,
    diagram.notes,
    diagram.subjectAreas,
    diagram.tables,
    onViewportChange,
  ]);

  const zoomBy = useCallback(
    (factor: number) => {
      const vp = viewportRef.current;
      const nextZoom = Math.max(
        0.18,
        Math.min(2.2, Math.round(vp.zoom * factor * 100) / 100),
      );
      const cx = canvasSizeRef.current.width / 2;
      const cy = canvasSizeRef.current.height / 2;
      const wx = (cx - vp.x) / vp.zoom;
      const wy = (cy - vp.y) / vp.zoom;
      const next = {
        x: Math.round(cx - wx * nextZoom),
        y: Math.round(cy - wy * nextZoom),
        zoom: nextZoom,
      };
      applyViewportToDom(next);
      onViewportChange(next);
    },
    [applyViewportToDom, onViewportChange],
  );

  const handleMinimapJump = useCallback(
    (targetWorldX: number, targetWorldY: number) => {
      const vp = viewportRef.current;
      const sz = canvasSizeRef.current;
      const next: ErViewport = {
        ...vp,
        x: Math.round(sz.width / 2 - targetWorldX * vp.zoom),
        y: Math.round(sz.height / 2 - targetWorldY * vp.zoom),
      };
      applyViewportToDom(next);
      onViewportChange(next);
    },
    [applyViewportToDom, onViewportChange],
  );

  // Selected relation popover anchor in screen coordinates
  const selectedRelationInfo = useMemo(() => {
    if (!selectedRelationId) return null;
    const rel = diagram.relations.find((r) => r.id === selectedRelationId);
    if (!rel) return null;
    const src = tablesById.get(rel.sourceTableId);
    const tgt = tablesById.get(rel.targetTableId);
    if (!src || !tgt) return null;
    const edge = calcErEdgePath(
      src,
      rel.sourceColumn,
      tgt,
      rel.targetColumn,
      diagram.routing,
      lodCompact,
    );
    const screenX = edge.labelPoint.x * viewport.zoom + viewport.x;
    const screenY = edge.labelPoint.y * viewport.zoom + viewport.y;
    const left = Math.max(16, Math.min(canvasSize.width - 336, screenX - 160));
    const top = Math.max(16, Math.min(canvasSize.height - 220, screenY + 18));
    return { rel, src, tgt, left, top };
  }, [
    canvasSize.height,
    canvasSize.width,
    diagram.relations,
    diagram.routing,
    lodCompact,
    selectedRelationId,
    tablesById,
    viewport.x,
    viewport.y,
    viewport.zoom,
  ]);

  // Minimap bounds (only recomputed when tables/areas commit, never during pan/zoom/drag!)
  const minimapBounds = useMemo(() => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const t of diagram.tables) {
      const h = estimateTableCardHeight(t, false);
      minX = Math.min(minX, t.x);
      minY = Math.min(minY, t.y);
      maxX = Math.max(maxX, t.x + t.width);
      maxY = Math.max(maxY, t.y + h);
    }
    for (const a of diagram.subjectAreas) {
      minX = Math.min(minX, a.x);
      minY = Math.min(minY, a.y);
      maxX = Math.max(maxX, a.x + a.width);
      maxY = Math.max(maxY, a.y + a.height);
    }
    if (!Number.isFinite(minX)) {
      return { minX: 0, minY: 0, width: 1200, height: 800 };
    }
    const pad = 120;
    return {
      minX: minX - pad,
      minY: minY - pad,
      width: Math.max(400, maxX - minX + pad * 2),
      height: Math.max(300, maxY - minY + pad * 2),
    };
  }, [diagram.subjectAreas, diagram.tables]);

  const gridStep = Math.max(10, Math.min(56, ER_GRID_SIZE * viewport.zoom));
  const gridModX = ((viewport.x % gridStep) + gridStep) % gridStep;
  const gridModY = ((viewport.y % gridStep) + gridStep) % gridStep;
  const vpRectWorld = useMemo(
    () => ({
      x: -viewport.x / viewport.zoom,
      y: -viewport.y / viewport.zoom,
      w: canvasSize.width / viewport.zoom,
      h: canvasSize.height / viewport.zoom,
    }),
    [
      canvasSize.height,
      canvasSize.width,
      viewport.x,
      viewport.y,
      viewport.zoom,
    ],
  );

  return (
    <div
      ref={containerRef}
      className={`er-canvas-stage${isLinking ? ' is-linking' : ''}`}
      onPointerDown={handleBackgroundPointerDown}
    >
      {diagram.showGrid && (
        <div
          ref={gridLayerRef}
          className="er-grid-layer"
          aria-hidden="true"
          style={{
            backgroundSize: `${gridStep}px ${gridStep}px`,
            transform: `translate3d(${gridModX}px, ${gridModY}px, 0)`,
          }}
        />
      )}
      {/* Unified GPU-accelerated world container */}
      <div
        ref={worldLayerRef}
        className="er-world-layer"
        style={{
          transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.zoom})`,
        }}
      >
        {/* Layer 1: Subject Areas */}
        {diagram.subjectAreas.map((area) => (
          <div
            key={area.id}
            className="er-subject-area"
            style={{
              transform: `translate3d(${area.x}px, ${area.y}px, 0)`,
              width: `${area.width}px`,
              height: `${area.height}px`,
              borderColor: area.color,
              backgroundColor: `${area.color}12`,
            }}
          >
            <div
              className="er-area-header"
              style={{ color: area.color }}
              onPointerDown={(e) => startAreaDrag(area, 'move', e)}
            >
              <span
                className="er-area-dot"
                style={{ backgroundColor: area.color }}
              />
              <strong>{area.name}</strong>
              {area.note && <span className="er-area-note">{area.note}</span>}
            </div>
            <div
              className="er-area-resize"
              onPointerDown={(e) => startAreaDrag(area, 'resize', e)}
              title="拖动调整分区大小"
            />
          </div>
        ))}

        {/* Layer 2: Cached Static Vector Edge Layer */}
        <DbErEdgeLayer
          svgRef={edgeLayerSvgRef}
          tablesById={tablesById}
          relations={diagram.relations}
          routing={diagram.routing}
          lodCompact={lodCompact}
          selectedRelationId={selectedRelationId}
          hoveredRelationId={hoveredRelationId}
          selectedTableId={selectedTableId}
          onSelectRelation={handleSelectEdge}
          onHoverRelation={setHoveredRelationId}
        />

        {/* Layer 2b: Zero-React-Render Active Drag Overlay SVG (1..N attached edges + guides + draft wire) */}
        <svg
          ref={dragOverlaySvgRef}
          className="er-drag-edge-svg"
          aria-hidden="true"
        />

        {/* Layer 3: Memoized HTML Table Cards (100% stable props -> 0 re-renders on drag/pan) */}
        {visibleTables.map((table) => (
          <DbErTableCard
            key={table.id}
            table={table}
            selected={selectedTableId === table.id}
            connectedHighlight={
              connectedTableIds.has(table.id) && selectedTableId !== table.id
            }
            dimmed={
              Boolean(selectedTableId || selectedRelationId) &&
              !connectedTableIds.has(table.id)
            }
            lodCompact={lodCompact}
            fkColumnNames={fkColsByTable.get(table.id) ?? EMPTY_STRING_SET}
            issueCount={issueCountByTable.get(table.id) ?? 0}
            isLinkingTarget={isLinking}
            onStartDrag={handleStartTableDrag}
            onSelect={handleSelectTableCard}
            onToggleCollapse={onToggleCollapseTable}
            onOpenProfiler={onOpenProfiler}
            onQuickSql={onQuickSql}
            onStartColumnLink={handleStartColumnLink}
            onCompleteColumnLink={handleCompleteColumnLink}
          />
        ))}

        {/* Layer 4: Research Canvas Notes */}
        {diagram.notes.map((note) => (
          <div
            key={note.id}
            className="er-note-card"
            style={{
              transform: `translate3d(${note.x}px, ${note.y}px, 0)`,
              width: `${note.width}px`,
              minHeight: `${note.height}px`,
              backgroundColor: note.color,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="er-note-header"
              onPointerDown={(e) => startNoteDrag(note, e)}
            >
              <input
                type="text"
                className="er-note-title-input"
                value={note.title}
                onPointerDown={(e) => e.stopPropagation()}
                onChange={(e) =>
                  onUpdateNote(note.id, { title: e.target.value })
                }
                placeholder="研究便签标题"
                aria-label="研究便签标题"
              />
              <div
                className="er-note-head-btns"
                onPointerDown={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  className="er-note-color-btn"
                  title="切换便签底色"
                  onClick={() => {
                    const idx = ER_NOTE_COLORS.indexOf(note.color);
                    const next =
                      ER_NOTE_COLORS[(idx + 1) % ER_NOTE_COLORS.length];
                    onUpdateNote(note.id, { color: next });
                  }}
                >
                  ●
                </button>
                <button
                  type="button"
                  className="er-note-del-btn"
                  title="删除便签"
                  onClick={() => onDeleteNote(note.id)}
                >
                  ×
                </button>
              </div>
            </div>
            <textarea
              className="er-note-textarea"
              value={note.content}
              onChange={(e) =>
                onUpdateNote(note.id, { content: e.target.value })
              }
              placeholder="记录表关联假设、样本口径或异常值说明…"
              rows={4}
            />
          </div>
        ))}
      </div>

      {/* Empty canvas guide */}
      {diagram.tables.length === 0 && (
        <div className="er-canvas-empty">
          <strong>当前画布暂无表结构</strong>
          <p>
            点击顶部「同步实库结构」拉取真实数据库表，或点击「导入
            SQL/DBML」离线建模。
          </p>
        </div>
      )}

      {/* Floating Relation Action Bar */}
      {selectedRelationInfo && (
        <div
          className="er-edge-popover"
          style={{
            left: `${selectedRelationInfo.left}px`,
            top: `${selectedRelationInfo.top}px`,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="er-edge-popover-head">
            <span
              className={`er-rel-kind-badge is-${selectedRelationInfo.rel.kind}`}
            >
              {selectedRelationInfo.rel.kind === 'physical'
                ? '物理外键'
                : selectedRelationInfo.rel.kind === 'logical'
                  ? '逻辑关联'
                  : '智能推断'}
            </span>
            <span className="er-edge-popover-route">
              {selectedRelationInfo.src.name}.
              {selectedRelationInfo.rel.sourceColumn} →{' '}
              {selectedRelationInfo.tgt.name}.
              {selectedRelationInfo.rel.targetColumn}
            </span>
            <button
              type="button"
              className="er-edge-popover-close"
              onClick={() => onSelectRelation(null)}
              aria-label="关闭关系面板"
            >
              ×
            </button>
          </div>

          {selectedRelationInfo.rel.reason && (
            <div className="er-edge-popover-reason">
              {selectedRelationInfo.rel.reason}
            </div>
          )}

          {selectedRelationInfo.rel.kind === 'physical' && (
            <div className="er-edge-popover-meta">
              <span>基数: {selectedRelationInfo.rel.cardinality}</span>
              {selectedRelationInfo.rel.onUpdate && (
                <span>ON UPDATE {selectedRelationInfo.rel.onUpdate}</span>
              )}
              {selectedRelationInfo.rel.onDelete && (
                <span>ON DELETE {selectedRelationInfo.rel.onDelete}</span>
              )}
            </div>
          )}

          {selectedRelationInfo.rel.kind === 'logical' && (
            <div className="er-edge-popover-edit">
              <select
                value={selectedRelationInfo.rel.cardinality}
                onChange={(e) =>
                  onUpdateLogicalRelation(selectedRelationInfo.rel.id, {
                    cardinality: e.target.value as ErCardinality,
                  })
                }
                aria-label="关系基数"
              >
                {CARDINALITY_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    基数 {opt}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={selectedRelationInfo.rel.note || ''}
                onChange={(e) =>
                  onUpdateLogicalRelation(selectedRelationInfo.rel.id, {
                    note: e.target.value,
                  })
                }
                placeholder="关联业务说明…"
              />
            </div>
          )}

          {selectedRelationInfo.rel.kind === 'inferred' && (
            <div className="er-edge-popover-infer-bar">
              <button
                type="button"
                className="er-pop-btn is-primary"
                onClick={() =>
                  onAcceptInferredRelation(selectedRelationInfo.rel)
                }
              >
                ✓ 采纳为逻辑关联
              </button>
              <button
                type="button"
                className="er-pop-btn"
                onClick={() => {
                  onDismissInferredRelation(selectedRelationInfo.rel.id);
                  onSelectRelation(null);
                }}
              >
                忽略此推断
              </button>
            </div>
          )}

          <div className="er-edge-popover-actions">
            <button
              type="button"
              className="er-pop-btn is-accent"
              onClick={() =>
                onGenerateRelationCode(selectedRelationInfo.rel, 'sql')
              }
              title="将可执行 JOIN SQL 推入 Notebook 实验本"
            >
              JOIN SQL 格
            </button>
            <button
              type="button"
              className="er-pop-btn"
              onClick={() =>
                onGenerateRelationCode(selectedRelationInfo.rel, 'python')
              }
              title="生成 Python sm_db_query / sm_sql 关联取数格"
            >
              Python 取数
            </button>
            <button
              type="button"
              className="er-pop-btn"
              onClick={() =>
                onGenerateRelationCode(selectedRelationInfo.rel, 'duckdb')
              }
              title="生成 DuckDB 联邦只读 JOIN 查询格"
            >
              DuckDB 联邦
            </button>
            {selectedRelationInfo.rel.kind === 'logical' && (
              <button
                type="button"
                className="er-pop-btn is-danger"
                onClick={() => {
                  onDeleteLogicalRelation(selectedRelationInfo.rel.id);
                  onSelectRelation(null);
                }}
              >
                删除
              </button>
            )}
          </div>
        </div>
      )}

      {/* Bottom-left Floating Zoom & Layout Controls */}
      <div className="er-canvas-controls">
        <button
          type="button"
          className="er-ctrl-btn"
          onClick={() => zoomBy(1 / 1.18)}
          title="缩小"
        >
          −
        </button>
        <span ref={zoomLabelRef} className="er-ctrl-zoom">
          {Math.round(viewport.zoom * 100)}%
        </span>
        <button
          type="button"
          className="er-ctrl-btn"
          onClick={() => zoomBy(1.18)}
          title="放大"
        >
          +
        </button>
        <span className="er-ctrl-sep" />
        <button
          type="button"
          className="er-ctrl-btn"
          onClick={handleFitView}
          title="缩放以完整显示所有表"
        >
          适应画布
        </button>
        <button
          type="button"
          className="er-ctrl-btn"
          onClick={onAutoLayout}
          title="按 Schema 自动重新排版"
        >
          自动排版
        </button>
        <button
          type="button"
          className={`er-ctrl-btn${presentationMode ? ' is-active' : ''}`}
          onClick={onTogglePresentation}
          title="隐藏侧栏进入纯净演示模式"
        >
          {presentationMode ? '退出演示' : '演示模式'}
        </button>
      </div>

      {/* Bottom-right Memoized Interactive Minimap */}
      {diagram.tables.length > 0 && !presentationMode && (
        <ErMinimap
          tables={diagram.tables}
          subjectAreas={diagram.subjectAreas}
          selectedTableId={selectedTableId}
          bounds={minimapBounds}
          vpRect={vpRectWorld}
          vpRectRef={minimapVpRef}
          onJumpToWorld={handleMinimapJump}
        />
      )}
    </div>
  );
}
