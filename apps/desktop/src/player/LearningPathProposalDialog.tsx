import type { LearningPathProposal } from '../agent/types';
import { formatDuration } from './format';
import { CloseIcon } from './icons';
import { thumbnailUrl } from './video-links';

export default function LearningPathProposalDialog({
  proposal,
  sourceLabel = 'ai',
  busy = false,
  error = '',
  onConfirm,
  onCancel,
}: {
  proposal: LearningPathProposal;
  sourceLabel?: 'cli' | 'ai';
  busy?: boolean;
  error?: string;
  onConfirm(): void;
  onCancel(): void;
}) {
  const videoMetaById = new Map(
    (proposal.input.videos ?? []).map((video) => [video.videoId, video]),
  );

  const modeBadge =
    proposal.mode === 'create'
      ? '新建学习路径'
      : proposal.mode === 'replace'
        ? '整体替换学习路径'
        : `追加 ${proposal.addedNodeCount} 个节点`;

  return (
    <div
      className="lp-proposal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="学习路径预览确认"
    >
      <div className="lp-proposal-modal">
        <header className="lp-proposal-head">
          <div>
            <span className="lp-proposal-badge">
              {sourceLabel === 'cli' ? 'CLI 终端提案' : 'AI 路径提案'} ·{' '}
              {modeBadge}
            </span>
            <h3>{proposal.input.title}</h3>
            {proposal.input.description && (
              <p
                style={{
                  margin: '4px 0 0',
                  fontSize: 12,
                  opacity: 0.78,
                }}
              >
                {proposal.input.description}
              </p>
            )}
          </div>
          <button
            type="button"
            className="lp-icon-btn"
            aria-label="拒绝并关闭预览"
            disabled={busy}
            onClick={onCancel}
          >
            <CloseIcon />
          </button>
        </header>

        <div className="lp-proposal-body">
          {error && (
            <div
              role="alert"
              style={{
                padding: '8px 12px',
                borderRadius: 6,
                background: 'rgba(179, 54, 43, 0.12)',
                color: '#b3362b',
                fontSize: 12,
              }}
            >
              {error}
            </div>
          )}
          {proposal.rationale && (
            <div className="lp-proposal-rationale">
              <strong>规划说明：</strong>
              {proposal.rationale}
            </div>
          )}

          <div
            style={{
              display: 'flex',
              gap: 14,
              fontSize: 12,
              opacity: 0.82,
            }}
          >
            <span>总节点：{proposal.input.nodes.length}</span>
            <span>阶段分组：{proposal.stageCount}</span>
            <span>视频课程：{proposal.videoCount}</span>
          </div>

          <div className="lp-proposal-list">
            {proposal.input.nodes.map((node, index) => {
              const video = node.videoId
                ? videoMetaById.get(node.videoId)
                : undefined;
              const isStageOnly = node.kind === 'stage' && !node.videoId;
              return (
                <div
                  key={node.nodeId}
                  className={`lp-proposal-item${isStageOnly ? ' is-stage' : ''}`}
                >
                  {node.videoId ? (
                    <img
                      src={
                        video?.thumbnailUrl ?? thumbnailUrl(node.videoId, 'mq')
                      }
                      alt=""
                      loading="lazy"
                    />
                  ) : (
                    <span className="lp-step-num">阶段</span>
                  )}
                  <div className="lp-proposal-item-info">
                    <strong>
                      {index + 1}. {node.title}
                      {node.optional ? '（选修）' : ''}
                      {node.kind === 'checkpoint' ? ' · 里程碑' : ''}
                    </strong>
                    <span>
                      {[
                        video?.channelName,
                        video?.durationSeconds
                          ? formatDuration(video.durationSeconds)
                          : null,
                        node.parentId ? `上级: ${node.parentId}` : '顶层主干',
                        node.prerequisiteIds?.length
                          ? `前置: ${node.prerequisiteIds.join(', ')}`
                          : null,
                        node.note,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <footer className="lp-proposal-foot">
          <span style={{ fontSize: 12, opacity: 0.72 }}>
            确认后将写入本地播放器数据库并自动打开该学习路径视图。
          </span>
          <div className="lp-proposal-foot-actions">
            <button
              type="button"
              className="lp-btn"
              disabled={busy}
              onClick={onCancel}
            >
              拒绝提案
            </button>
            <button
              type="button"
              className="lp-btn is-primary"
              disabled={busy}
              onClick={onConfirm}
            >
              {busy ? '正在保存…' : '确认保存并打开路径'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
