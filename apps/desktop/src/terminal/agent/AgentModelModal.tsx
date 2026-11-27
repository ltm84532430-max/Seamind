import { memo } from 'react';
import { agentApi } from '../../agent/agent-api';
import {
  TERMINAL_API_PRESETS,
  TERMINAL_ENGINE_SPECS,
} from '../terminal-agent-protocol';
import type { CliEngineStatus, CliModelsCatalog } from '../terminal-api';
import type { TerminalAgentEngineMode } from '../terminal-types';
import type {
  CliEngineId,
  LocalEngineConfig,
  ModelFamilyGroup,
} from './agent-workbench-types';
import { matchModelOption } from './agent-workbench-utils';

export interface AgentModelModalProps {
  open: boolean;
  engineConfig: LocalEngineConfig;
  defaultBaseUrl: string;
  defaultModel: string;
  cliEngines: CliEngineStatus[];
  activeCliEngine: CliEngineId | null;
  activeCliCatalog?: CliModelsCatalog;
  cliFamilyGroups: ModelFamilyGroup[];
  cliModelsByEngine: Record<CliEngineId, string>;
  activeEffectiveModelId: string;
  cliModelsLoading: boolean;
  providerApiKeyDraft: string;
  hasCustomProviderKey: boolean;
  keyStatusMsg: string;
  onClose: () => void;
  onUpdateEngineConfig: (
    updater: (prev: LocalEngineConfig) => LocalEngineConfig,
  ) => void;
  onSelectCliModel: (engine: CliEngineId, model: string) => void;
  onRefreshCliModels: (engine: CliEngineId) => void;
  onProviderApiKeyDraftChange: (value: string) => void;
  onCustomProviderKeySaved: (saved: boolean, msg: string) => void;
  onClearKeyStatusMsg: () => void;
}

export const AgentModelModal = memo(function AgentModelModal({
  open,
  engineConfig,
  defaultBaseUrl,
  defaultModel,
  cliEngines,
  activeCliEngine,
  activeCliCatalog,
  cliFamilyGroups,
  cliModelsByEngine,
  activeEffectiveModelId,
  cliModelsLoading,
  providerApiKeyDraft,
  hasCustomProviderKey,
  keyStatusMsg,
  onClose,
  onUpdateEngineConfig,
  onSelectCliModel,
  onRefreshCliModels,
  onProviderApiKeyDraftChange,
  onCustomProviderKeySaved,
  onClearKeyStatusMsg,
}: AgentModelModalProps) {
  if (!open) return null;

  return (
    <div
      className="t-agent-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className="t-agent-model-modal ag-modal"
        role="dialog"
        aria-modal="true"
        aria-label="模型与协同内核配置"
      >
        <div className="t-agent-model-head">
          <span>模型与协同内核配置（API 直连 / 无头 CLI / Hybrid 协同）</span>
          <button type="button" className="ag-quiet-btn" onClick={onClose}>
            Esc 关闭
          </button>
        </div>

        <div className="t-agent-engine-grid">
          {TERMINAL_ENGINE_SPECS.map((spec) => {
            const cliId = spec.id.startsWith('cli:') ? spec.id.slice(4) : null;
            const cliStatus = cliId
              ? cliEngines.find((c) => c.id === cliId)
              : null;
            const unavailable = cliStatus ? !cliStatus.available : false;
            const isSelected = engineConfig.mode === spec.id;

            return (
              <button
                key={spec.id}
                type="button"
                className={`t-agent-engine-card${isSelected ? ' is-selected' : ''}${unavailable ? ' is-warn' : ''}`}
                onClick={() =>
                  onUpdateEngineConfig((prev) => ({
                    ...prev,
                    mode: spec.id as TerminalAgentEngineMode,
                  }))
                }
              >
                <div className="t-agent-engine-card-top">
                  <span className="t-agent-engine-badge">{spec.badge}</span>
                  {cliStatus && (
                    <span
                      className={`t-agent-cli-flag${cliStatus.available ? ' is-ok' : ''}`}
                    >
                      {cliStatus.available ? 'CLI 就绪' : '未检测到'}
                    </span>
                  )}
                </div>
                <strong>{spec.label}</strong>
                <p>
                  {cliStatus && !cliStatus.available
                    ? cliStatus.hint
                    : spec.description}
                </p>
              </button>
            );
          })}
        </div>

        {activeCliEngine && (
          <div className="t-agent-api-config">
            <div className="t-agent-preset-row">
              <span>
                {activeCliEngine.toUpperCase()}{' '}
                模型家族与档位（输入框左下角亦可切换）：
              </span>
              <button
                type="button"
                className={`filter-chip${!cliModelsByEngine[activeCliEngine] ? ' is-active' : ''}`}
                onClick={() => onSelectCliModel(activeCliEngine, '')}
              >
                跟随 CLI 默认
                {activeCliCatalog?.currentDefault
                  ? ` (${activeCliCatalog.currentDefault})`
                  : ''}
              </button>
              <button
                type="button"
                className="filter-chip"
                disabled={cliModelsLoading}
                onClick={() => onRefreshCliModels(activeCliEngine)}
              >
                {cliModelsLoading ? '扫描中…' : '刷新模型列表'}
              </button>
            </div>

            {cliFamilyGroups.length > 0 && (
              <div className="t-agent-modal-family-list">
                {cliFamilyGroups.map((group) => {
                  const isActiveGroup = group.variants.some((v) =>
                    matchModelOption(v, activeEffectiveModelId),
                  );
                  return (
                    <div
                      key={group.family}
                      className={`t-agent-modal-family-row${isActiveGroup ? ' is-active' : ''}`}
                    >
                      <span className="t-agent-modal-family-name">
                        {group.family}
                      </span>
                      <div className="t-agent-modal-family-tiers">
                        {group.variants.map((variant) => {
                          const isVarActive = matchModelOption(
                            variant,
                            activeEffectiveModelId,
                          );
                          return (
                            <button
                              key={variant.id}
                              type="button"
                              className={`filter-chip${isVarActive ? ' is-active' : ''}`}
                              onClick={() =>
                                onSelectCliModel(activeCliEngine, variant.id)
                              }
                              title={variant.id}
                            >
                              {variant.tier ?? 'Standard'}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="t-agent-api-inputs">
              <input
                type="text"
                value={cliModelsByEngine[activeCliEngine] ?? ''}
                onChange={(e) =>
                  onSelectCliModel(activeCliEngine, e.target.value)
                }
                placeholder={`自定义 ${activeCliEngine.toUpperCase()} 模型 ID（留空则使用 CLI 默认模型）`}
                aria-label={`${activeCliEngine} 模型名称`}
              />
            </div>
          </div>
        )}

        {(engineConfig.mode === 'api' || engineConfig.mode === 'hybrid') && (
          <div className="t-agent-api-config">
            <div className="t-agent-preset-row">
              <span>接口预设：</span>
              {TERMINAL_API_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`filter-chip${engineConfig.presetId === preset.id ? ' is-active' : ''}`}
                  onClick={() => {
                    if (preset.id === 'custom') {
                      onUpdateEngineConfig((prev) => ({
                        ...prev,
                        presetId: 'custom',
                        baseUrl: defaultBaseUrl,
                        model: defaultModel,
                      }));
                    } else {
                      onUpdateEngineConfig((prev) => ({
                        ...prev,
                        presetId: preset.id,
                        baseUrl: preset.baseUrl,
                        model: preset.defaultModel,
                      }));
                    }
                    onClearKeyStatusMsg();
                  }}
                >
                  {preset.label}
                </button>
              ))}
              <label className="t-agent-notools-check">
                <input
                  type="checkbox"
                  checked={engineConfig.noToolsMode}
                  onChange={(e) =>
                    onUpdateEngineConfig((prev) => ({
                      ...prev,
                      noToolsMode: e.target.checked,
                    }))
                  }
                />
                <span>纯对话（无 tools 兼容本地模型）</span>
              </label>
            </div>

            <div className="t-agent-api-inputs">
              <input
                type="text"
                value={engineConfig.baseUrl}
                onChange={(e) =>
                  onUpdateEngineConfig((prev) => ({
                    ...prev,
                    baseUrl: e.target.value,
                  }))
                }
                placeholder="API Base URL (e.g. https://api.openai.com/v1)"
                aria-label="API Base URL"
              />
              <input
                type="text"
                value={engineConfig.model}
                onChange={(e) =>
                  onUpdateEngineConfig((prev) => ({
                    ...prev,
                    model: e.target.value,
                  }))
                }
                placeholder="Model ID (e.g. deepseek-chat / gpt-4o-mini)"
                aria-label="Model ID"
              />
              {engineConfig.presetId !== 'custom' &&
                engineConfig.presetId !== 'ollama' && (
                  <div className="t-agent-key-save-row">
                    <input
                      type="password"
                      value={providerApiKeyDraft}
                      onChange={(e) =>
                        onProviderApiKeyDraftChange(e.target.value)
                      }
                      placeholder={
                        hasCustomProviderKey
                          ? `已存 ${engineConfig.presetId} 密钥（留空沿用）`
                          : `输入 ${engineConfig.presetId} 独立密钥…`
                      }
                    />
                    <button
                      type="button"
                      className="codelab-tool-btn is-primary"
                      disabled={!providerApiKeyDraft.trim()}
                      onClick={() => {
                        void agentApi
                          .saveProviderApiKey({
                            providerId: engineConfig.presetId,
                            apiKey: providerApiKeyDraft.trim(),
                          })
                          .then(() => {
                            onCustomProviderKeySaved(
                              true,
                              '已存入系统凭据管理器',
                            );
                          })
                          .catch((err: unknown) => {
                            onCustomProviderKeySaved(
                              hasCustomProviderKey,
                              err instanceof Error ? err.message : '保存失败',
                            );
                          });
                      }}
                    >
                      保存密钥
                    </button>
                    {keyStatusMsg && (
                      <span className="t-agent-key-msg">{keyStatusMsg}</span>
                    )}
                  </div>
                )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
});
