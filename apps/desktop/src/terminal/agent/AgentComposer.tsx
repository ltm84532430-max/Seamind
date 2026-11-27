import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  TERMINAL_API_PRESETS,
  TERMINAL_ENGINE_SPECS,
  type TerminalAutocompleteCandidate,
  type TerminalAutocompleteMatch,
} from '../terminal-agent-protocol';
import type { CliEngineStatus, CliModelsCatalog } from '../terminal-api';
import type { TerminalAgentEngineMode } from '../terminal-types';
import {
  AlertTriangleIcon,
  BookIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  DatabaseIcon,
  FileTextIcon,
  PlusIcon,
  RefreshIcon,
  SendIcon,
  SlidersIcon,
  StopSquareIcon,
  TerminalIcon,
} from './AgentIcons';
import type {
  ActiveModelDisplay,
  CliEngineId,
  ContextSourceAvailability,
  LocalEngineConfig,
  ModelFamilyGroup,
} from './agent-workbench-types';
import {
  extractContextTagsFromInput,
  matchModelOption,
} from './agent-workbench-utils';

export interface AgentComposerProps {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  inputText: string;
  isBusy: boolean;
  canCancelActive?: boolean;
  canShowFlyout: boolean;
  compact?: boolean;
  engineConfig: LocalEngineConfig;
  defaultBaseUrl: string;
  defaultModel: string;
  activeCliEngine: CliEngineId | null;
  activeCliCatalog?: CliModelsCatalog;
  cliFamilyGroups: ModelFamilyGroup[];
  activeEffectiveModelId: string;
  activeModelDisplay: ActiveModelDisplay;
  engineShortBadge: string;
  cliEngines: CliEngineStatus[];
  cliModelsLoading: boolean;
  modelPopoverOpen: boolean;
  autocomplete: TerminalAutocompleteMatch | null;
  selectedAutoIdx: number;
  sentHistory: string[];
  historyCursor: number;
  contextSources: ContextSourceAvailability[];
  onInputChange: (value: string, caret: number) => void;
  onCaretChange: (caret: number) => void;
  onSelectAutoIdx: (updater: (prev: number) => number) => void;
  onApplyCompletion: (candidate: TerminalAutocompleteCandidate) => void;
  onHistoryNavigate: (nextCursor: number, nextValue: string) => void;
  onAttachToken: (token: string) => void;
  onRemoveContextTag: (token: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onToggleModelPopover: (open: boolean) => void;
  onRefreshCliModels: (engine: CliEngineId) => void;
  onSelectCliModel: (engine: CliEngineId, modelId: string) => void;
  onSelectApiPreset: (presetId: string, baseUrl: string, model: string) => void;
  onSelectEngineMode: (mode: TerminalAgentEngineMode) => void;
  onOpenModelModal: () => void;
  onCloseModelModalIfOpen: () => boolean;
}

const CONTEXT_GROUP_ORDER: ReadonlyArray<{
  id: 'lab' | 'reading' | 'knowledge' | 'terminal';
  label: string;
  tokens: string[];
}> = [
  { id: 'lab', label: '数据与实验', tokens: ['#data', '#lab', '#env'] },
  { id: 'reading', label: '书库与阅读', tokens: ['#chapter', '#book'] },
  { id: 'knowledge', label: '知识库与导图', tokens: ['#doc', '#kb', '#map'] },
  {
    id: 'terminal',
    label: '分屏终端与报错',
    tokens: ['#last-error', '#pane:2', '#pane:1'],
  },
];

function groupIcon(id: 'lab' | 'reading' | 'knowledge' | 'terminal') {
  if (id === 'lab') return <DatabaseIcon size={13} />;
  if (id === 'reading') return <BookIcon size={13} />;
  if (id === 'knowledge') return <FileTextIcon size={13} />;
  return <TerminalIcon size={13} />;
}

export const AgentComposer = memo(function AgentComposer({
  inputRef,
  inputText,
  isBusy,
  canCancelActive = true,
  canShowFlyout,
  compact = false,
  engineConfig,
  defaultBaseUrl,
  defaultModel,
  activeCliEngine,
  activeCliCatalog,
  cliFamilyGroups,
  activeEffectiveModelId,
  activeModelDisplay,
  engineShortBadge,
  cliEngines,
  cliModelsLoading,
  modelPopoverOpen,
  autocomplete,
  selectedAutoIdx,
  sentHistory,
  historyCursor,
  contextSources,
  onInputChange,
  onCaretChange,
  onSelectAutoIdx,
  onApplyCompletion,
  onHistoryNavigate,
  onAttachToken,
  onRemoveContextTag,
  onSubmit,
  onCancel,
  onToggleModelPopover,
  onRefreshCliModels,
  onSelectCliModel,
  onSelectApiPreset,
  onSelectEngineMode,
  onOpenModelModal,
  onCloseModelModalIfOpen,
}: AgentComposerProps) {
  const modelPopoverRef = useRef<HTMLDivElement>(null);
  const contextPickerRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const [hoveredFamily, setHoveredFamily] = useState<string | null>(null);
  const [hoveredFooterPanel, setHoveredFooterPanel] = useState(false);
  const [contextPickerOpen, setContextPickerOpen] = useState(false);

  const mountedTags = useMemo(
    () => extractContextTagsFromInput(inputText),
    [inputText],
  );
  const mountedSet = useMemo(
    () => new Set(mountedTags.map((t) => t.toLowerCase())),
    [mountedTags],
  );

  const alertSources = useMemo(
    () => contextSources.filter((s) => s.alert),
    [contextSources],
  );

  const groupedContextSources = useMemo(() => {
    const byToken = new Map(
      contextSources.map((src) => [src.token.toLowerCase(), src]),
    );
    return CONTEXT_GROUP_ORDER.map((group) => ({
      ...group,
      items: group.tokens
        .map((tk) => byToken.get(tk.toLowerCase()))
        .filter((item): item is ContextSourceAvailability => Boolean(item)),
    })).filter((g) => g.items.length > 0);
  }, [contextSources]);

  useEffect(() => {
    if (!modelPopoverOpen) {
      setHoveredFamily(null);
      setHoveredFooterPanel(false);
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (
        modelPopoverRef.current &&
        !modelPopoverRef.current.contains(event.target as Node)
      ) {
        onToggleModelPopover(false);
      }
    };
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onToggleModelPopover(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [modelPopoverOpen, onToggleModelPopover]);

  useEffect(() => {
    if (!contextPickerOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (
        contextPickerRef.current &&
        !contextPickerRef.current.contains(event.target as Node)
      ) {
        setContextPickerOpen(false);
      }
    };
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [contextPickerOpen]);

  const textareaRows = Math.min(6, Math.max(2, inputText.split('\n').length));

  const handleInsertHashTrigger = () => {
    setContextPickerOpen(false);
    const spacer = inputText && !/\s$/.test(inputText) ? ' ' : '';
    const next = `${inputText}${spacer}#`;
    onInputChange(next, next.length);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(next.length, next.length);
      }
    });
  };

  return (
    <div className="ag-composer-region">
      {/* Floating / and # Autocomplete Menu */}
      {autocomplete && autocomplete.candidates.length > 0 && (
        <div
          className="ag-autocomplete"
          role="listbox"
          aria-label={
            autocomplete.kind === 'slash' ? '/ 命令补全' : '# 资源引用补全'
          }
        >
          <div className="ag-autocomplete-head">
            <span>
              {autocomplete.kind === 'slash'
                ? '斜杠命令 (/)'
                : '工作区上下文引用 (#)'}
            </span>
            <span>↑/↓ 选择 · Tab/Enter 确认 · Esc 关闭</span>
          </div>
          <div className="ag-autocomplete-list">
            {autocomplete.candidates.map((cand, idx) => (
              <button
                key={cand.key}
                type="button"
                role="option"
                aria-selected={idx === selectedAutoIdx}
                className={`ag-autocomplete-item${idx === selectedAutoIdx ? ' is-selected' : ''}`}
                onMouseEnter={() => onSelectAutoIdx(() => idx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onApplyCompletion(cand);
                }}
              >
                <span className="ag-autocomplete-badge">{cand.badge}</span>
                <strong className="ag-autocomplete-title">{cand.title}</strong>
                <span className="ag-autocomplete-sub">{cand.subtitle}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Removable Mounted Context Tags & Live Error Alert */}
      {(mountedTags.length > 0 || alertSources.length > 0) && (
        <div className="ag-mounted-strip" aria-label="已挂载上下文标签">
          {mountedTags.map((tag) => (
            <span key={tag} className="ag-mounted-tag">
              <span className="ag-mounted-tag-text">{tag}</span>
              <button
                type="button"
                className="ag-mounted-tag-remove"
                onClick={() => onRemoveContextTag(tag)}
                aria-label={`移除上下文 ${tag}`}
                title={`移除 ${tag}`}
              >
                <CloseIcon size={11} />
              </button>
            </span>
          ))}
          {alertSources
            .filter((s) => !mountedSet.has(s.token.toLowerCase()))
            .map((source) => (
              <button
                key={source.token}
                type="button"
                className="ag-context-pill is-alert"
                onClick={() => onAttachToken(source.token)}
                title={source.hint}
              >
                <AlertTriangleIcon size={12} />
                <span className="ag-context-pill-token">{source.token}</span>
                <span>{source.label}</span>
              </button>
            ))}
        </div>
      )}

      {/* Quick Context Attach Strip (non-compact mode) */}
      {!compact && (
        <div className="ag-context-strip" aria-label="快捷挂载上下文">
          {contextSources
            .filter((s) => !s.alert)
            .map((source) => {
              const attached = mountedSet.has(source.token.toLowerCase());
              return (
                <button
                  key={source.token}
                  type="button"
                  className={`ag-context-pill${attached ? ' is-attached' : ''}${source.primary ? ' is-primary' : ''}`}
                  onClick={() =>
                    attached
                      ? onRemoveContextTag(source.token)
                      : onAttachToken(source.token)
                  }
                  title={source.hint}
                  aria-pressed={attached}
                >
                  {attached ? <CheckIcon size={11} /> : <PlusIcon size={11} />}
                  <span className="ag-context-pill-token">{source.token}</span>
                  <span className="ag-context-pill-label">{source.label}</span>
                  {source.badge && (
                    <span className="ag-context-pill-badge">
                      {source.badge}
                    </span>
                  )}
                </button>
              );
            })}
        </div>
      )}

      {/* Unified Workbench Composer Card */}
      <div className="ag-composer-shell">
        <div className="ag-composer-input-row">
          <span className="ag-composer-prompt" aria-hidden="true">
            &gt;
          </span>
          <textarea
            ref={inputRef}
            className="ag-composer-textarea"
            rows={textareaRows}
            value={inputText}
            aria-label="输入研究指令或问题"
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              composingRef.current = false;
              onCaretChange(
                e.currentTarget.selectionStart ?? e.currentTarget.value.length,
              );
            }}
            onChange={(e) => {
              onInputChange(
                e.target.value,
                e.target.selectionStart ?? e.target.value.length,
              );
            }}
            onClick={(e) => {
              onCaretChange(e.currentTarget.selectionStart ?? inputText.length);
            }}
            onKeyUp={(e) => {
              onCaretChange(e.currentTarget.selectionStart ?? inputText.length);
            }}
            onKeyDown={(e) => {
              // Strictly protect Chinese/CJK IME composition Enter & arrow keys
              if (
                composingRef.current ||
                e.nativeEvent.isComposing ||
                e.keyCode === 229
              ) {
                return;
              }

              if (autocomplete && autocomplete.candidates.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  onSelectAutoIdx(
                    (i) => (i + 1) % autocomplete.candidates.length,
                  );
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  onSelectAutoIdx(
                    (i) =>
                      (i - 1 + autocomplete.candidates.length) %
                      autocomplete.candidates.length,
                  );
                  return;
                }
                if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                  e.preventDefault();
                  const chosen = autocomplete.candidates[selectedAutoIdx];
                  if (chosen) onApplyCompletion(chosen);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  onCaretChange(-1);
                  return;
                }
              } else {
                if (
                  e.key === 'ArrowUp' &&
                  !inputText.includes('\n') &&
                  sentHistory.length > 0
                ) {
                  const nextCursor = Math.min(
                    sentHistory.length - 1,
                    historyCursor + 1,
                  );
                  if (nextCursor !== historyCursor) {
                    e.preventDefault();
                    onHistoryNavigate(nextCursor, sentHistory[nextCursor]);
                  }
                  return;
                }
                if (e.key === 'ArrowDown' && historyCursor >= 0) {
                  e.preventDefault();
                  const nextCursor = historyCursor - 1;
                  const nextVal =
                    nextCursor >= 0 ? sentHistory[nextCursor] : '';
                  onHistoryNavigate(nextCursor, nextVal);
                  return;
                }
              }

              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSubmit();
              } else if (e.key === 'Escape') {
                if (contextPickerOpen) {
                  e.preventDefault();
                  setContextPickerOpen(false);
                } else if (onCloseModelModalIfOpen()) {
                  e.preventDefault();
                }
              }
            }}
            placeholder="输入研究问题、/ 调度命令或 # 挂载上下文（Enter 发送，Shift+Enter 换行）"
          />
        </div>

        <div className="ag-composer-toolbar">
          <div className="ag-composer-toolbar-left">
            {/* Grouped ContextPicker Popover */}
            <div className="ag-picker-anchor" ref={contextPickerRef}>
              <button
                type="button"
                className={`ag-composer-icon-btn${contextPickerOpen ? ' is-open' : ''}`}
                title="选择并挂载上下文资源"
                aria-label="打开上下文挂载选择器"
                aria-haspopup="menu"
                aria-expanded={contextPickerOpen}
                onClick={() => {
                  onToggleModelPopover(false);
                  setContextPickerOpen((open) => !open);
                }}
              >
                <PlusIcon size={14} />
              </button>

              {contextPickerOpen && (
                <div
                  className="ag-context-picker"
                  role="menu"
                  aria-label="挂载上下文资源"
                >
                  <div className="ag-context-picker-head">
                    <span>挂载上下文资源</span>
                    <button
                      type="button"
                      className="ag-insp-link"
                      onClick={handleInsertHashTrigger}
                    >
                      输入 # 搜索…
                    </button>
                  </div>
                  <div className="ag-context-picker-body">
                    {groupedContextSources.map((group) => (
                      <div key={group.id} className="ag-context-picker-group">
                        <div className="ag-context-picker-group-title">
                          {groupIcon(group.id)}
                          <span>{group.label}</span>
                        </div>
                        {group.items.map((item) => {
                          const attached = mountedSet.has(
                            item.token.toLowerCase(),
                          );
                          return (
                            <button
                              key={item.token}
                              type="button"
                              role="menuitemcheckbox"
                              aria-checked={attached}
                              className={`ag-context-picker-item${attached ? ' is-attached' : ''}`}
                              onClick={() => {
                                if (attached) onRemoveContextTag(item.token);
                                else onAttachToken(item.token);
                              }}
                            >
                              <span className="ag-context-picker-token">
                                {item.token}
                              </span>
                              <span className="ag-context-picker-label">
                                {item.label}
                              </span>
                              <span className="ag-context-picker-state">
                                {attached ? (
                                  <CheckIcon size={12} />
                                ) : (
                                  item.badge || ''
                                )}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="ag-model-anchor" ref={modelPopoverRef}>
              <button
                type="button"
                className={`ag-model-trigger${modelPopoverOpen ? ' is-open' : ''}`}
                aria-haspopup="menu"
                aria-expanded={modelPopoverOpen}
                onClick={() => {
                  setContextPickerOpen(false);
                  const next = !modelPopoverOpen;
                  if (next && activeCliEngine && !activeCliCatalog) {
                    onRefreshCliModels(activeCliEngine);
                  }
                  onToggleModelPopover(next);
                }}
                title="切换当前模型、推理档位或运行内核 (Ctrl+M)"
              >
                <span className="ag-model-trigger-engine">
                  {engineShortBadge}
                </span>
                <span className="ag-model-trigger-name">
                  {activeModelDisplay.family}
                </span>
                {activeModelDisplay.tier && (
                  <span className="ag-model-trigger-tier">
                    {activeModelDisplay.tier}
                  </span>
                )}
                <ChevronDownIcon size={12} className="ag-model-trigger-caret" />
              </button>

              {modelPopoverOpen && (
                <div
                  className="t-agent-model-popover"
                  role="menu"
                  aria-label="模型与内核快速切换"
                  onMouseLeave={() => {
                    setHoveredFamily(null);
                    setHoveredFooterPanel(false);
                  }}
                >
                  <div className="t-agent-model-popover-head">
                    <span className="t-agent-model-popover-title">Model</span>
                    <div className="t-agent-model-popover-tools">
                      <span className="t-agent-model-engine-pill">
                        {engineShortBadge}
                      </span>
                      {activeCliEngine && (
                        <button
                          type="button"
                          className={`t-agent-model-refresh-btn${cliModelsLoading ? ' is-spinning' : ''}`}
                          disabled={cliModelsLoading}
                          onClick={() => onRefreshCliModels(activeCliEngine)}
                          title={`重新拉取 ${activeCliEngine.toUpperCase()} 可用模型`}
                          aria-label="刷新模型列表"
                        >
                          <RefreshIcon size={12} />
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="t-agent-model-list">
                    {activeCliEngine ? (
                      cliFamilyGroups.length === 0 ? (
                        <div className="t-agent-model-empty">
                          {cliModelsLoading
                            ? '正在扫描可用模型…'
                            : '未扫描到可用模型，请点击右上角刷新'}
                        </div>
                      ) : (
                        cliFamilyGroups.map((group) => {
                          const activeVariant = group.variants.find((v) =>
                            matchModelOption(v, activeEffectiveModelId),
                          );
                          const isActiveGroup = Boolean(activeVariant);
                          const isCliDefaultGroup = group.variants.some((v) =>
                            matchModelOption(
                              v,
                              activeCliCatalog?.currentDefault,
                            ),
                          );
                          const displayTier =
                            activeVariant?.tier ??
                            group.defaultVariant.tier ??
                            '';
                          const hasMultiTiers = group.variants.length > 1;
                          const isHovered = hoveredFamily === group.family;

                          return (
                            <div
                              key={group.family}
                              className="t-agent-model-row-wrap"
                              onMouseEnter={() => {
                                setHoveredFamily(
                                  hasMultiTiers ? group.family : null,
                                );
                                setHoveredFooterPanel(false);
                              }}
                            >
                              <button
                                type="button"
                                role="menuitemradio"
                                aria-checked={isActiveGroup}
                                className={`t-agent-model-row${isActiveGroup ? ' is-active' : ''}${isHovered ? ' is-hovered' : ''}`}
                                onClick={() => {
                                  const target =
                                    activeVariant ?? group.defaultVariant;
                                  onSelectCliModel(activeCliEngine, target.id);
                                  onToggleModelPopover(false);
                                }}
                              >
                                <span className="t-agent-model-row-main">
                                  <span className="t-agent-model-row-name">
                                    {group.family}
                                  </span>
                                  {displayTier && (
                                    <span className="t-agent-model-row-tier">
                                      {displayTier}
                                    </span>
                                  )}
                                  {isCliDefaultGroup && (
                                    <span className="t-agent-model-tag">
                                      Default
                                    </span>
                                  )}
                                </span>
                                <span className="t-agent-model-row-right">
                                  {isActiveGroup && (
                                    <CheckIcon
                                      size={14}
                                      className="t-agent-model-check"
                                    />
                                  )}
                                  {hasMultiTiers && (
                                    <ChevronRightIcon
                                      size={12}
                                      className="t-agent-model-chevron"
                                    />
                                  )}
                                </span>
                              </button>

                              {!canShowFlyout &&
                                hasMultiTiers &&
                                (isActiveGroup || isHovered) && (
                                  <div className="t-agent-model-inline-tiers">
                                    {group.variants.map((variant) => {
                                      const isVarActive = matchModelOption(
                                        variant,
                                        activeEffectiveModelId,
                                      );
                                      return (
                                        <button
                                          key={variant.id}
                                          type="button"
                                          className={`t-agent-model-tier-chip${isVarActive ? ' is-active' : ''}`}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            onSelectCliModel(
                                              activeCliEngine,
                                              variant.id,
                                            );
                                            onToggleModelPopover(false);
                                          }}
                                        >
                                          {variant.tier ?? variant.label}
                                        </button>
                                      );
                                    })}
                                  </div>
                                )}
                            </div>
                          );
                        })
                      )
                    ) : (
                      TERMINAL_API_PRESETS.map((preset) => {
                        const isSelectedPreset =
                          engineConfig.presetId === preset.id;
                        const presetModelLabel =
                          preset.id === 'custom'
                            ? defaultModel
                            : preset.defaultModel;
                        return (
                          <button
                            key={preset.id}
                            type="button"
                            role="menuitemradio"
                            aria-checked={isSelectedPreset}
                            className={`t-agent-model-row${isSelectedPreset ? ' is-active' : ''}`}
                            onMouseEnter={() => {
                              setHoveredFamily(null);
                              setHoveredFooterPanel(false);
                            }}
                            onClick={() => {
                              if (preset.id === 'custom') {
                                onSelectApiPreset(
                                  'custom',
                                  defaultBaseUrl,
                                  defaultModel,
                                );
                              } else {
                                onSelectApiPreset(
                                  preset.id,
                                  preset.baseUrl,
                                  preset.defaultModel,
                                );
                              }
                              onToggleModelPopover(false);
                            }}
                          >
                            <span className="t-agent-model-row-main">
                              <span className="t-agent-model-row-name">
                                {preset.label}
                              </span>
                              <span className="t-agent-model-row-tier">
                                {presetModelLabel}
                              </span>
                            </span>
                            <span className="t-agent-model-row-right">
                              {isSelectedPreset && (
                                <CheckIcon
                                  size={14}
                                  className="t-agent-model-check"
                                />
                              )}
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>

                  <div className="t-agent-model-divider" />

                  <button
                    type="button"
                    className={`t-agent-model-footer-row${hoveredFooterPanel ? ' is-hovered' : ''}`}
                    onMouseEnter={() => {
                      setHoveredFooterPanel(true);
                      setHoveredFamily(null);
                    }}
                    onClick={() => {
                      if (!canShowFlyout) {
                        setHoveredFooterPanel((v) => !v);
                      } else {
                        onToggleModelPopover(false);
                        onOpenModelModal();
                      }
                    }}
                  >
                    <span className="t-agent-model-footer-left">
                      <SlidersIcon size={14} />
                      <span>切换内核 / 引擎</span>
                    </span>
                    <span className="t-agent-model-row-right">
                      <ChevronRightIcon
                        size={12}
                        className="t-agent-model-chevron"
                      />
                    </span>
                  </button>

                  {!canShowFlyout && hoveredFooterPanel && (
                    <div className="t-agent-model-inline-engines">
                      {TERMINAL_ENGINE_SPECS.map((spec) => {
                        const isSelected = engineConfig.mode === spec.id;
                        return (
                          <button
                            key={spec.id}
                            type="button"
                            className={`t-agent-model-tier-chip${isSelected ? ' is-active' : ''}`}
                            onClick={() => {
                              onSelectEngineMode(spec.id);
                              setHoveredFooterPanel(false);
                            }}
                          >
                            {spec.badge}
                          </button>
                        );
                      })}
                      <button
                        type="button"
                        className="t-agent-model-tier-chip"
                        onClick={() => {
                          onToggleModelPopover(false);
                          onOpenModelModal();
                        }}
                      >
                        高级配置…
                      </button>
                    </div>
                  )}

                  {canShowFlyout &&
                    activeCliEngine &&
                    hoveredFamily &&
                    (() => {
                      const targetGroup = cliFamilyGroups.find(
                        (g) => g.family === hoveredFamily,
                      );
                      if (!targetGroup || targetGroup.variants.length <= 1) {
                        return null;
                      }
                      return (
                        <div
                          className="t-agent-model-flyout"
                          role="menu"
                          aria-label={`${targetGroup.family} 档位选择`}
                        >
                          <div className="t-agent-model-flyout-head">
                            <span>{targetGroup.family}</span>
                            <span className="t-agent-model-flyout-sub">
                              Reasoning / Tier
                            </span>
                          </div>
                          <div className="t-agent-model-flyout-list">
                            {targetGroup.variants.map((variant) => {
                              const isVarActive = matchModelOption(
                                variant,
                                activeEffectiveModelId,
                              );
                              const isDef = matchModelOption(
                                variant,
                                activeCliCatalog?.currentDefault,
                              );
                              return (
                                <button
                                  key={variant.id}
                                  type="button"
                                  role="menuitemradio"
                                  aria-checked={isVarActive}
                                  className={`t-agent-model-flyout-row${isVarActive ? ' is-active' : ''}`}
                                  onClick={() => {
                                    onSelectCliModel(
                                      activeCliEngine,
                                      variant.id,
                                    );
                                    onToggleModelPopover(false);
                                  }}
                                  title={variant.id}
                                >
                                  <span className="t-agent-model-row-main">
                                    <span className="t-agent-model-row-name">
                                      {variant.tier ?? variant.label}
                                    </span>
                                    {isDef && (
                                      <span className="t-agent-model-tag">
                                        Default
                                      </span>
                                    )}
                                  </span>
                                  {isVarActive && (
                                    <CheckIcon
                                      size={14}
                                      className="t-agent-model-check"
                                    />
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}

                  {canShowFlyout && hoveredFooterPanel && (
                    <div
                      className="t-agent-model-flyout is-engines"
                      role="menu"
                      aria-label="运行内核切换"
                    >
                      <div className="t-agent-model-flyout-head">
                        <span>运行内核</span>
                        <span className="t-agent-model-flyout-sub">
                          CLI / API / Hybrid
                        </span>
                      </div>
                      <div className="t-agent-model-flyout-list">
                        {TERMINAL_ENGINE_SPECS.map((spec) => {
                          const cliId = spec.id.startsWith('cli:')
                            ? spec.id.slice(4)
                            : null;
                          const cliStatus = cliId
                            ? cliEngines.find((c) => c.id === cliId)
                            : null;
                          const isSelected = engineConfig.mode === spec.id;
                          return (
                            <button
                              key={spec.id}
                              type="button"
                              role="menuitemradio"
                              aria-checked={isSelected}
                              className={`t-agent-model-flyout-row${isSelected ? ' is-active' : ''}`}
                              onClick={() => {
                                onSelectEngineMode(spec.id);
                                setHoveredFooterPanel(false);
                              }}
                            >
                              <span className="t-agent-model-row-main">
                                {cliStatus && (
                                  <span
                                    className={`t-agent-model-status-dot${cliStatus.available ? ' is-ok' : ''}`}
                                  />
                                )}
                                <span className="t-agent-model-row-name">
                                  {spec.label}
                                </span>
                              </span>
                              {isSelected && (
                                <CheckIcon
                                  size={14}
                                  className="t-agent-model-check"
                                />
                              )}
                            </button>
                          );
                        })}
                      </div>
                      <div className="t-agent-model-divider" />
                      <button
                        type="button"
                        className="t-agent-model-flyout-row"
                        onClick={() => {
                          onToggleModelPopover(false);
                          onOpenModelModal();
                        }}
                      >
                        <span className="t-agent-model-row-tier">
                          高级配置 / 自定义模型 (Ctrl+M)
                        </span>
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="ag-composer-toolbar-right">
            {isBusy ? (
              canCancelActive ? (
                <button
                  type="button"
                  className="ag-stop-btn"
                  onClick={onCancel}
                  title="中断当前执行"
                >
                  <StopSquareIcon size={11} />
                  <span>停止</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="ag-send-btn"
                  disabled
                  title="请求处理中"
                >
                  <span>执行中…</span>
                </button>
              )
            ) : (
              <button
                type="button"
                className="ag-send-btn"
                disabled={!inputText.trim()}
                onClick={onSubmit}
                title="发送指令 (Enter)"
              >
                <span>发送</span>
                <SendIcon size={12} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
