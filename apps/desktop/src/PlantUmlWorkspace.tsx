import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { sanitizeDiagramSvg } from './code-blocks';
import {
  addPlantUmlElement,
  addPlantUmlFlowBlock,
  addPlantUmlGroup,
  addPlantUmlMember,
  addPlantUmlNote,
  addPlantUmlRelationship,
  deletePlantUmlElement,
  deletePlantUmlRelationship,
  diagramTypeLabel,
  parsePlantUmlDocument,
  setPlantUmlDirection,
  updatePlantUmlElementLabel,
  updatePlantUmlRelationship,
} from './plantuml-model';
import type { PlantUmlDiagramType } from './plantuml-model';
import { plantUmlDiagramNames, splitSvgDocuments } from './plantuml-svg';

export interface PlantUmlEditorRequest {
  source: string;
  language: 'plantuml' | 'puml';
  saveTarget?: 'markdown' | 'file';
  cacheKey?: string;
  documentTitle?: string;
  onSave: (nextSource: string) => void | Promise<void>;
}

interface PlantUmlWorkspaceProps {
  request: PlantUmlEditorRequest;
  source: string;
  theme: 'light' | 'dark';
  onSourceChange: (nextSource: string) => void;
  onSourceSaved: (savedSource: string) => void;
  onClose: () => void;
}

interface PlantUmlRenderResult {
  svg: string;
  diagnostics: string[];
}

const workspaceEventName = 'seamind:open-plantuml-editor';
type PlantUmlDirection =
  | 'left to right'
  | 'right to left'
  | 'top to bottom'
  | 'bottom to top';
type PlantUmlPanel = 'elements' | 'relationships' | 'notes' | 'layout' | 'more';
interface CanvasView {
  scale: number;
  x: number;
  y: number;
}

export function openPlantUmlWorkspace(request: PlantUmlEditorRequest): void {
  window.dispatchEvent(
    new CustomEvent<PlantUmlEditorRequest>(workspaceEventName, {
      detail: request,
    }),
  );
}

export function plantUmlWorkspaceEventName(): string {
  return workspaceEventName;
}

function plantUmlArrows(type: PlantUmlDiagramType): string[] {
  if (type === 'sequence') return ['->', '-->', '->>', '-->>', '<-', '<--'];
  if (type === 'class')
    return ['-->', '..>', '<|--', '--|>', '*--', 'o--', '..|>'];
  if (type === 'er') return ['||--o{', '||--||', 'o|--||', '}|--|{'];
  return ['-->', '..>', '<|--', '--|>', '*--', 'o--'];
}

function defaultNodeKind(type: PlantUmlDiagramType): string {
  if (type === 'sequence') return 'participant';
  if (type === 'class') return 'class';
  if (type === 'usecase') return 'usecase';
  if (type === 'component') return 'component';
  if (type === 'deployment') return 'node';
  if (type === 'state') return 'state';
  if (type === 'er') return 'entity';
  return 'activity';
}

function nodeKindOptions(type: PlantUmlDiagramType): string[] {
  if (type === 'sequence')
    return [
      'participant',
      'actor',
      'boundary',
      'control',
      'entity',
      'database',
    ];
  if (type === 'class') return ['class', 'interface', 'enum', 'object'];
  if (type === 'activity') return ['activity'];
  if (type === 'usecase') return ['actor', 'usecase', 'rectangle'];
  if (type === 'component')
    return ['component', 'interface', 'package', 'rectangle'];
  if (type === 'deployment') return ['node', 'artifact', 'cloud', 'database'];
  if (type === 'state') return ['state'];
  if (type === 'er') return ['entity'];
  return [];
}

function colorContrast(color: string, dark: boolean): number | null {
  const channels = color.match(
    /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)%?)?\s*\)/i,
  );
  if (!channels) return null;
  const alpha = channels[4] ? Number(channels[4]) : 1;
  if (alpha < 0.72) return 0;
  const linear = [1, 2, 3].map((index) => {
    const channel = Math.min(255, Math.max(0, Number(channels[index]))) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance =
    0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
  const background = dark ? 0.018 : 0.94;
  const lighter = Math.max(luminance, background);
  const darker = Math.min(luminance, background);
  return (lighter + 0.05) / (darker + 0.05);
}

function strengthenFineStrokes(svg: SVGSVGElement, dark: boolean): void {
  const geometry = svg.querySelectorAll<SVGElement>(
    'path, line, polyline, polygon, rect, circle, ellipse',
  );
  const visibleStroke = dark ? '#b8cad7' : '#526d82';
  geometry.forEach((element) => {
    const style = window.getComputedStyle(element);
    if (!style.stroke || style.stroke === 'none') {
      const isConnector =
        ['line', 'polyline'].includes(element.localName) ||
        (element.localName === 'path' && style.fill === 'none');
      if (!isConnector) return;
      element.style.setProperty('stroke', visibleStroke);
      element.style.setProperty('stroke-width', '1.4px');
      element.style.setProperty('vector-effect', 'non-scaling-stroke');
      return;
    }
    const strokeWidth = Number.parseFloat(style.strokeWidth);
    if (Number.isFinite(strokeWidth) && strokeWidth > 0 && strokeWidth < 1.4) {
      element.style.setProperty('stroke-width', '1.4px');
      element.style.setProperty('vector-effect', 'non-scaling-stroke');
    }
    if ((colorContrast(style.stroke, dark) ?? 4) < 2.8) {
      element.style.setProperty('stroke', visibleStroke);
      element.style.setProperty('vector-effect', 'non-scaling-stroke');
    }
  });
}

export default function PlantUmlWorkspace({
  request,
  source,
  theme,
  onSourceChange,
  onSourceSaved,
  onClose,
}: PlantUmlWorkspaceProps) {
  const [panel, setPanel] = useState<PlantUmlPanel | null>(null);
  const [elementLabel, setElementLabel] = useState('');
  const [elementKind, setElementKind] = useState('');
  const [selectedElementId, setSelectedElementId] = useState('');
  const [relationFrom, setRelationFrom] = useState('');
  const [relationTo, setRelationTo] = useState('');
  const [relationLabel, setRelationLabel] = useState('');
  const [relationArrow, setRelationArrow] = useState('');
  const [selectedRelationId, setSelectedRelationId] = useState('');
  const [memberText, setMemberText] = useState('');
  const [memberVisibility, setMemberVisibility] = useState('+');
  const [noteText, setNoteText] = useState('');
  const [groupText, setGroupText] = useState('');
  const [flowText, setFlowText] = useState('');
  const [direction, setDirection] = useState<PlantUmlDirection>(() => {
    const match = request.source.match(
      /^\s*(left to right|right to left|top to bottom|bottom to top) direction\s*$/im,
    );
    return (match?.[1] as PlantUmlDirection) ?? 'left to right';
  });
  const [authorizedDirectory, setAuthorizedDirectory] = useState('');
  const [renderError, setRenderError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [renderDiagnostics, setRenderDiagnostics] = useState<string[]>([]);
  const [rendering, setRendering] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [svgSnapshot, setSvgSnapshot] = useState('');
  const [diagramIndex, setDiagramIndex] = useState(0);
  const [appliedSource, setAppliedSource] = useState(request.source);
  const [view, setView] = useState<CanvasView>({ scale: 1, x: 0, y: 0 });
  const previewRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const renderRevisionRef = useRef(0);
  const diagramIndexRef = useRef(0);
  diagramIndexRef.current = diagramIndex;
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startView: CanvasView;
  } | null>(null);
  const document = useMemo(() => parsePlantUmlDocument(source), [source]);
  // A source with several @startuml blocks comes back as several SVG documents.
  const diagramDocuments = useMemo(
    () => splitSvgDocuments(svgSnapshot),
    [svgSnapshot],
  );
  const diagramNames = useMemo(() => plantUmlDiagramNames(source), [source]);
  const activeDiagram = Math.min(
    diagramIndex,
    Math.max(0, diagramDocuments.length - 1),
  );
  const selectedElement = document.elements.find(
    (element) => element.id === selectedElementId,
  );
  const selectedRelation = document.relationships.find(
    (relation) => relation.id === selectedRelationId,
  );
  const arrows = plantUmlArrows(document.diagramType);
  const nodeKinds = nodeKindOptions(document.diagramType);
  const dirty = source !== appliedSource;
  const saveLabel =
    request.saveTarget === 'file' ? '保存 PUML' : '同步 Markdown';
  const showMemberEditor = ['class', 'er'].includes(document.diagramType);
  const showRelationshipEditor = document.diagramType !== 'activity';

  useEffect(() => {
    if (document.elements.length === 0) {
      setSelectedElementId('');
      setRelationFrom('');
      setRelationTo('');
      return;
    }
    if (
      !document.elements.some((element) => element.id === selectedElementId)
    ) {
      const first = document.elements[0]!;
      setSelectedElementId(first.id);
      setElementLabel(first.label);
    }
    if (!document.elements.some((element) => element.id === relationFrom))
      setRelationFrom(document.elements[0]!.id);
    if (!document.elements.some((element) => element.id === relationTo))
      setRelationTo(document.elements[1]?.id ?? document.elements[0]!.id);
  }, [document, relationFrom, relationTo, selectedElementId]);

  useEffect(() => {
    if (nodeKinds.length && !nodeKinds.includes(elementKind))
      setElementKind(defaultNodeKind(document.diagramType));
  }, [document.diagramType, elementKind, nodeKinds]);

  useEffect(() => {
    const revision = ++renderRevisionRef.current;
    const timer = window.setTimeout(() => {
      setRendering(true);
      setRenderError('');
      void invoke<PlantUmlRenderResult>('render_plantuml', {
        source,
        dark: theme === 'dark',
        authorizedIncludeDirectory: authorizedDirectory || null,
        cacheKey: request.cacheKey ?? null,
      })
        .then((result) => {
          if (revision !== renderRevisionRef.current) return;
          setSvgSnapshot(result.svg);
          const documents = splitSvgDocuments(result.svg);
          const svg = sanitizeDiagramSvg(
            documents[
              Math.min(diagramIndexRef.current, documents.length - 1)
            ] ?? '',
          );
          const host = previewRef.current;
          if (!svg || !host) {
            setRenderError('PlantUML SVG 无法解析或未通过应用安全检查。');
            return;
          }
          svg.classList.add('seamind-diagram-svg');
          svg.setAttribute('role', 'img');
          svg.setAttribute(
            'aria-label',
            `${diagramTypeLabel(document.diagramType)}预览`,
          );
          svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
          svg.style.width = '100%';
          svg.style.height = '100%';
          host.replaceChildren(svg);
          strengthenFineStrokes(svg, theme === 'dark');
          svg.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
          setRenderDiagnostics(result.diagnostics);
        })
        .catch((error: unknown) => {
          if (revision !== renderRevisionRef.current) return;
          setSvgSnapshot('');
          setRenderError(
            error instanceof Error ? error.message : String(error),
          );
          previewRef.current?.replaceChildren();
          setRenderDiagnostics([]);
        })
        .finally(() => {
          if (revision === renderRevisionRef.current) setRendering(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      renderRevisionRef.current += 1;
    };
  }, [
    authorizedDirectory,
    document.diagramType,
    request.cacheKey,
    source,
    theme,
  ]);

  useEffect(() => {
    const host = previewRef.current;
    if (!host) return;
    host.replaceChildren();
    if (!svgSnapshot) return;

    const svg = sanitizeDiagramSvg(diagramDocuments[activeDiagram] ?? '');
    if (!svg) return;
    svg.classList.add('seamind-diagram-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute(
      'aria-label',
      `${diagramTypeLabel(document.diagramType)}预览`,
    );
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.style.width = '100%';
    svg.style.height = '100%';
    host.replaceChildren(svg);
    strengthenFineStrokes(svg, theme === 'dark');
  }, [
    activeDiagram,
    diagramDocuments,
    document.diagramType,
    fullscreen,
    svgSnapshot,
    theme,
  ]);

  useEffect(() => {
    const svg = previewRef.current?.querySelector('svg');
    if (svg)
      svg.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  }, [activeDiagram, fullscreen, svgSnapshot, view]);

  const changeSource = (nextSource: string) => onSourceChange(nextSource);
  const closeWorkspace = () => {
    if (saving) return;
    if (
      dirty &&
      !window.confirm(
        request.saveTarget === 'file'
          ? 'PUML 文件有未保存的修改，仍要返回导图吗？'
          : 'PUML 修改尚未同步到 Markdown，仍要返回导图吗？',
      )
    )
      return;
    onClose();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (panel) setPanel(null);
      else if (fullscreen) setFullscreen(false);
      else closeWorkspace();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [fullscreen, panel, source, appliedSource, saving, request, onClose]);

  const applyChanges = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    setSaveError('');
    try {
      await request.onSave(source);
      setAppliedSource(source);
      onSourceSaved(source);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const chooseIncludeDirectory = async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: '授权 PlantUML 本地 include 文件夹',
    });
    if (typeof selected === 'string') setAuthorizedDirectory(selected);
  };

  const addElement = () => {
    if (!elementLabel.trim()) return;
    changeSource(
      addPlantUmlElement(
        document,
        elementLabel,
        elementKind || defaultNodeKind(document.diagramType),
      ),
    );
    setElementLabel('');
  };

  const updateElement = () => {
    if (!selectedElement || !elementLabel.trim()) return;
    changeSource(
      updatePlantUmlElementLabel(document, selectedElement.id, elementLabel),
    );
  };

  const addRelationship = () => {
    if (!relationFrom || !relationTo) return;
    changeSource(
      addPlantUmlRelationship(
        document,
        relationFrom,
        relationTo,
        relationLabel,
        relationArrow,
      ),
    );
    setRelationLabel('');
  };

  const updateRelationship = () => {
    if (!selectedRelation) return;
    changeSource(
      updatePlantUmlRelationship(
        document,
        selectedRelation.id,
        relationLabel,
        relationArrow,
      ),
    );
  };

  const setActivePanel = (next: PlantUmlPanel) =>
    setPanel((current) => (current === next ? null : next));

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const offsetX = event.clientX - rect.left - rect.width / 2;
    const offsetY = event.clientY - rect.top - rect.height / 2;
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    setView((current) => {
      const scale = Math.min(4, Math.max(0.2, current.scale * factor));
      const ratio = scale / current.scale;
      return {
        scale,
        x: offsetX - (offsetX - current.x) * ratio,
        y: offsetY - (offsetY - current.y) * ratio,
      };
    });
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 2) return;
    event.preventDefault();
    setPanel(null);
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startView: view,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setView({
      ...drag.startView,
      x: drag.startView.x + event.clientX - drag.startX,
      y: drag.startView.y + event.clientY - drag.startY,
    });
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  const zoomBy = (factor: number) =>
    setView((current) => ({
      ...current,
      scale: Math.min(4, Math.max(0.2, current.scale * factor)),
    }));

  const workspace = (
    <div
      className={`plantuml-canvas-mode${fullscreen ? ' is-fullscreen' : ''}`}
      data-theme={theme}
    >
      <div className="plantuml-toolbar" role="toolbar" aria-label="PUML 操作">
        <span className="plantuml-toolbar-type">
          {diagramTypeLabel(document.diagramType)}
        </span>
        {diagramDocuments.length > 1 && (
          <select
            className="plantuml-diagram-select"
            value={activeDiagram}
            aria-label="选择要预览的图表"
            title="源码里有多个图，选择要预览的一个"
            onChange={(event) => {
              setDiagramIndex(Number(event.target.value));
              setView({ scale: 1, x: 0, y: 0 });
            }}
          >
            {diagramDocuments.map((_, index) => (
              <option key={index} value={index}>
                {diagramNames.length === diagramDocuments.length &&
                diagramNames[index]
                  ? `${index + 1}/${diagramDocuments.length} · ${diagramNames[index]}`
                  : `图 ${index + 1}/${diagramDocuments.length}`}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          disabled={!document.supportsGui}
          aria-expanded={panel === 'elements'}
          onClick={() => setActivePanel('elements')}
        >
          图元
        </button>
        <button
          type="button"
          className="plantuml-toolbar-secondary"
          disabled={!document.supportsGui || !showRelationshipEditor}
          aria-expanded={panel === 'relationships'}
          onClick={() => setActivePanel('relationships')}
        >
          关系
        </button>
        <button
          type="button"
          className="plantuml-toolbar-secondary"
          disabled={!document.supportsGui}
          aria-expanded={panel === 'notes'}
          onClick={() => setActivePanel('notes')}
        >
          注释 / 分组
        </button>
        <button
          type="button"
          className="plantuml-toolbar-secondary"
          disabled={!document.supportsGui}
          aria-expanded={panel === 'layout'}
          onClick={() => setActivePanel('layout')}
        >
          布局
        </button>
        <span className="plantuml-toolbar-spacer" />
        <button
          type="button"
          title="缩小"
          aria-label="缩小"
          onClick={() => zoomBy(1 / 1.2)}
        >
          −
        </button>
        <span className="plantuml-zoom-label">
          {Math.round(view.scale * 100)}%
        </span>
        <button
          type="button"
          title="放大"
          aria-label="放大"
          onClick={() => zoomBy(1.2)}
        >
          ＋
        </button>
        <button type="button" onClick={() => setView({ scale: 1, x: 0, y: 0 })}>
          适配
        </button>
        <button
          type="button"
          aria-pressed={fullscreen}
          onClick={() => setFullscreen((current) => !current)}
        >
          {fullscreen ? '退出全屏' : '全屏'}
        </button>
        <button
          type="button"
          aria-expanded={panel === 'more'}
          onClick={() => setActivePanel('more')}
        >
          更多
        </button>
        <details className="plantuml-toolbar-overflow">
          <summary>操作</summary>
          <div>
            <button
              type="button"
              disabled={!document.supportsGui || !showRelationshipEditor}
              onClick={() => setActivePanel('relationships')}
            >
              关系
            </button>
            <button
              type="button"
              disabled={!document.supportsGui}
              onClick={() => setActivePanel('notes')}
            >
              注释 / 分组
            </button>
            <button
              type="button"
              disabled={!document.supportsGui}
              onClick={() => setActivePanel('layout')}
            >
              布局
            </button>
          </div>
        </details>
        <span className={`plantuml-save-state${dirty ? ' is-dirty' : ''}`}>
          {saving ? '保存中…' : dirty ? '未保存' : '已保存'}
        </span>
        <button
          type="button"
          className="is-primary"
          onClick={() => void applyChanges()}
          disabled={saving || !dirty}
        >
          {saving ? '保存中…' : saveLabel}
        </button>
        <button type="button" onClick={closeWorkspace}>
          返回导图
        </button>
      </div>

      <div className="plantuml-canvas-stage">
        {panel && (
          <div
            className={`plantuml-tool-popover is-${panel}`}
            role="dialog"
            aria-label={
              {
                elements: '编辑图元',
                relationships: '编辑关系',
                notes: '注释与分组',
                layout: '布局设置',
                more: '更多 PUML 操作',
              }[panel]
            }
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
          >
            <div className="plantuml-popover-heading">
              <strong>
                {
                  {
                    elements: '图元',
                    relationships: '关系 / 消息',
                    notes: '注释与分组',
                    layout: '布局方向',
                    more: 'PUML 资源与诊断',
                  }[panel]
                }
              </strong>
              <button
                type="button"
                className="plantuml-popover-close"
                aria-label="关闭"
                onClick={() => setPanel(null)}
              >
                ×
              </button>
            </div>

            {panel === 'elements' &&
              (document.supportsGui ? (
                <div className="plantuml-popover-content">
                  <div className="plantuml-element-list">
                    {document.elements.map((element) => (
                      <button
                        type="button"
                        key={`${element.id}-${element.lineIndex}`}
                        className={
                          element.id === selectedElementId ? 'is-selected' : ''
                        }
                        onClick={() => {
                          setSelectedElementId(element.id);
                          setElementLabel(element.label);
                        }}
                      >
                        <span>{element.label}</span>
                        <small>{element.kind}</small>
                      </button>
                    ))}
                    {document.elements.length === 0 && (
                      <p className="plantuml-empty-list">
                        尚未识别图元，可以从下方添加。
                      </p>
                    )}
                  </div>
                  <div className="plantuml-inline-form">
                    <select
                      value={
                        elementKind || defaultNodeKind(document.diagramType)
                      }
                      onChange={(event) => setElementKind(event.target.value)}
                      aria-label="图元类型"
                    >
                      {nodeKinds.map((kind) => (
                        <option key={kind} value={kind}>
                          {kind}
                        </option>
                      ))}
                    </select>
                    <input
                      value={elementLabel}
                      onChange={(event) => setElementLabel(event.target.value)}
                      placeholder="图元名称"
                      maxLength={160}
                      aria-label="图元名称"
                    />
                    {selectedElement && (
                      <button type="button" onClick={updateElement}>
                        更新名称
                      </button>
                    )}
                    <button
                      type="button"
                      className="is-primary"
                      onClick={addElement}
                    >
                      添加图元
                    </button>
                    {selectedElement && selectedElement.lineIndex >= 0 && (
                      <button
                        type="button"
                        className="is-danger"
                        onClick={() => {
                          changeSource(
                            deletePlantUmlElement(document, selectedElement.id),
                          );
                          setSelectedElementId('');
                          setElementLabel('');
                        }}
                      >
                        删除所选
                      </button>
                    )}
                  </div>
                  {showMemberEditor &&
                    selectedElement?.lineIndex !== undefined &&
                    selectedElement.lineIndex >= 0 && (
                      <div className="plantuml-inline-form">
                        <select
                          value={memberVisibility}
                          onChange={(event) =>
                            setMemberVisibility(event.target.value)
                          }
                          aria-label="成员可见性"
                        >
                          <option value="+">公开 +</option>
                          <option value="#">保护 #</option>
                          <option value="-">私有 −</option>
                          <option value="~">包内 ~</option>
                        </select>
                        <input
                          value={memberText}
                          onChange={(event) =>
                            setMemberText(event.target.value)
                          }
                          placeholder="类属性或方法，例如 id: int"
                          maxLength={120}
                          aria-label="类成员"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            changeSource(
                              addPlantUmlMember(
                                document,
                                selectedElement.id,
                                memberText,
                                memberVisibility,
                              ),
                            );
                            setMemberText('');
                          }}
                        >
                          添加成员
                        </button>
                      </div>
                    )}
                </div>
              ) : (
                <p className="plantuml-editor-notice">
                  当前语法不支持结构化编辑；源码和渲染仍可继续使用。
                </p>
              ))}

            {panel === 'relationships' && showRelationshipEditor && (
              <div className="plantuml-popover-content">
                <div className="plantuml-relation-list">
                  {document.relationships.map((relation) => (
                    <button
                      type="button"
                      key={relation.id}
                      className={
                        relation.id === selectedRelationId ? 'is-selected' : ''
                      }
                      onClick={() => {
                        setSelectedRelationId(relation.id);
                        setRelationFrom(relation.from);
                        setRelationTo(relation.to);
                        setRelationLabel(relation.label);
                        setRelationArrow(relation.arrow);
                      }}
                    >
                      <span>
                        {relation.from} {relation.arrow} {relation.to}
                      </span>
                      <small>{relation.label || '无说明'}</small>
                    </button>
                  ))}
                  {document.relationships.length === 0 && (
                    <p className="plantuml-empty-list">尚未识别关系。</p>
                  )}
                </div>
                <div className="plantuml-inline-form plantuml-relation-form">
                  <select
                    value={relationFrom}
                    onChange={(event) => setRelationFrom(event.target.value)}
                    aria-label="关系起点"
                  >
                    {document.elements.map((element) => (
                      <option key={element.id} value={element.id}>
                        {element.label}
                      </option>
                    ))}
                  </select>
                  <select
                    value={relationArrow || arrows[0]}
                    onChange={(event) => setRelationArrow(event.target.value)}
                    aria-label="关系类型"
                  >
                    {arrows.map((arrow) => (
                      <option key={arrow} value={arrow}>
                        {arrow}
                      </option>
                    ))}
                  </select>
                  <select
                    value={relationTo}
                    onChange={(event) => setRelationTo(event.target.value)}
                    aria-label="关系终点"
                  >
                    {document.elements.map((element) => (
                      <option key={element.id} value={element.id}>
                        {element.label}
                      </option>
                    ))}
                  </select>
                  <input
                    value={relationLabel}
                    onChange={(event) => setRelationLabel(event.target.value)}
                    placeholder="关系说明"
                    maxLength={160}
                    aria-label="关系说明"
                  />
                  {selectedRelation && (
                    <button type="button" onClick={updateRelationship}>
                      更新
                    </button>
                  )}
                  <button
                    type="button"
                    className="is-primary"
                    disabled={!document.elements.length}
                    onClick={addRelationship}
                  >
                    添加关系
                  </button>
                  {selectedRelation && (
                    <button
                      type="button"
                      className="is-danger"
                      onClick={() => {
                        changeSource(
                          deletePlantUmlRelationship(
                            document,
                            selectedRelation.id,
                          ),
                        );
                        setSelectedRelationId('');
                      }}
                    >
                      删除关系
                    </button>
                  )}
                </div>
              </div>
            )}

            {panel === 'notes' && (
              <div className="plantuml-popover-content">
                <div className="plantuml-inline-form">
                  <select
                    value={selectedElementId}
                    onChange={(event) =>
                      setSelectedElementId(event.target.value)
                    }
                    aria-label="注释目标"
                  >
                    {document.elements.map((element) => (
                      <option key={element.id} value={element.id}>
                        {element.label}
                      </option>
                    ))}
                  </select>
                  <input
                    value={noteText}
                    onChange={(event) => setNoteText(event.target.value)}
                    placeholder="注释内容"
                    maxLength={160}
                    aria-label="注释内容"
                  />
                  <button
                    type="button"
                    disabled={!selectedElementId}
                    onClick={() => {
                      changeSource(
                        addPlantUmlNote(document, selectedElementId, noteText),
                      );
                      setNoteText('');
                    }}
                  >
                    添加注释
                  </button>
                </div>
                <div className="plantuml-inline-form">
                  <input
                    value={groupText}
                    onChange={(event) => setGroupText(event.target.value)}
                    placeholder="分组名称"
                    maxLength={100}
                    aria-label="分组名称"
                  />
                  <button
                    type="button"
                    disabled={!groupText.trim()}
                    onClick={() => {
                      changeSource(
                        addPlantUmlGroup(
                          document,
                          groupText,
                          selectedElementId,
                        ),
                      );
                      setGroupText('');
                    }}
                  >
                    添加分组
                  </button>
                </div>
                {document.diagramType === 'sequence' && (
                  <div className="plantuml-inline-form">
                    <input
                      value={flowText}
                      onChange={(event) => setFlowText(event.target.value)}
                      placeholder="alt / opt / loop 条件"
                      maxLength={120}
                      aria-label="序列片段条件"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        changeSource(
                          addPlantUmlFlowBlock(document, 'alt', flowText),
                        );
                        setFlowText('');
                      }}
                    >
                      alt
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        changeSource(
                          addPlantUmlFlowBlock(document, 'opt', flowText),
                        );
                        setFlowText('');
                      }}
                    >
                      opt
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        changeSource(
                          addPlantUmlFlowBlock(document, 'loop', flowText),
                        );
                        setFlowText('');
                      }}
                    >
                      loop
                    </button>
                    {selectedElement && (
                      <button
                        type="button"
                        onClick={() =>
                          changeSource(
                            addPlantUmlFlowBlock(
                              document,
                              'activate',
                              '',
                              selectedElement.id,
                            ),
                          )
                        }
                      >
                        activate
                      </button>
                    )}
                    {selectedElement && (
                      <button
                        type="button"
                        onClick={() =>
                          changeSource(
                            addPlantUmlFlowBlock(
                              document,
                              'deactivate',
                              '',
                              selectedElement.id,
                            ),
                          )
                        }
                      >
                        deactivate
                      </button>
                    )}
                  </div>
                )}
                {document.diagramType === 'activity' && (
                  <div className="plantuml-inline-form">
                    <input
                      value={flowText}
                      onChange={(event) => setFlowText(event.target.value)}
                      placeholder="判断条件或泳道名称"
                      maxLength={120}
                      aria-label="活动图条件"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        changeSource(
                          addPlantUmlFlowBlock(document, 'decision', flowText),
                        );
                        setFlowText('');
                      }}
                    >
                      添加判断
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        changeSource(
                          addPlantUmlFlowBlock(document, 'partition', flowText),
                        );
                        setFlowText('');
                      }}
                    >
                      添加泳道
                    </button>
                  </div>
                )}
                <p className="plantuml-preservation-note">
                  {document.rawParts.length}{' '}
                  行注释、预处理器或未识别语法会保留在原位置。
                </p>
              </div>
            )}

            {panel === 'layout' && (
              <div className="plantuml-popover-content">
                <div className="plantuml-inline-form">
                  <select
                    value={direction}
                    onChange={(event) =>
                      setDirection(event.target.value as PlantUmlDirection)
                    }
                    aria-label="图表方向"
                  >
                    <option value="left to right">从左到右</option>
                    <option value="right to left">从右到左</option>
                    <option value="top to bottom">从上到下</option>
                    <option value="bottom to top">从下到上</option>
                  </select>
                  <button
                    type="button"
                    className="is-primary"
                    onClick={() =>
                      changeSource(setPlantUmlDirection(document, direction))
                    }
                  >
                    应用布局
                  </button>
                </div>
                <small>PlantUML 会自动布局；方向设置保存在 PUML 源码中。</small>
              </div>
            )}

            {panel === 'more' && (
              <div className="plantuml-popover-content">
                <div className="plantuml-inline-form">
                  <button
                    type="button"
                    onClick={() => void chooseIncludeDirectory()}
                  >
                    授权本地 include 文件夹
                  </button>
                  {authorizedDirectory && (
                    <button
                      type="button"
                      onClick={() => setAuthorizedDirectory('')}
                    >
                      撤销授权
                    </button>
                  )}
                </div>
                <small className="plantuml-include-path">
                  {authorizedDirectory ||
                    '尚未授权本地 include；远程 include 不开放'}
                </small>
                {document.diagnostics.length > 0 && (
                  <p className="plantuml-editor-notice">
                    {document.diagnostics.join(' ')}
                  </p>
                )}
                {renderDiagnostics.length > 0 && (
                  <details className="plantuml-diagnostics">
                    <summary>渲染信息</summary>
                    {renderDiagnostics.map((diagnostic, index) => (
                      <p key={`${index}-${diagnostic}`}>{diagnostic}</p>
                    ))}
                  </details>
                )}
              </div>
            )}
          </div>
        )}

        <div
          ref={viewportRef}
          className="plantuml-canvas-viewport"
          onWheel={handleWheel}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <div ref={previewRef} className="plantuml-canvas-svg" />
          {renderError && (
            <p className="plantuml-canvas-error" role="alert">
              {renderError}
            </p>
          )}
          {saveError && (
            <p className="plantuml-canvas-error is-save-error" role="alert">
              {saveError}
            </p>
          )}
          {!renderError && rendering && (
            <span className="plantuml-canvas-status">正在生成 SVG…</span>
          )}
          {!document.supportsGui && !renderError && (
            <span className="plantuml-canvas-status">
              当前语法使用源码模式，可在左侧源码中继续编辑。
            </span>
          )}
        </div>
        <div className="plantuml-canvas-footer">
          <span>
            {request.documentTitle ?? diagramTypeLabel(document.diagramType)}
          </span>
          <span>
            {document.supportsGui
              ? `${document.elements.length} 个图元 · ${document.relationships.length} 个关系`
              : '源码模式'}
          </span>
        </div>
      </div>
    </div>
  );
  const fullscreenHost = window.document.querySelector('.app-shell');
  return fullscreen && fullscreenHost
    ? createPortal(workspace, fullscreenHost)
    : workspace;
}
