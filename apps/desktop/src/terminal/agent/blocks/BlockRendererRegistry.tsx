import { memo } from 'react';
import type { AgentToolArtifact } from '../../../agent/types';
import type { ExecutionBlock } from '../agent-workbench-types';
import { ArtifactBlock } from './ArtifactBlock';
import { ToolCallBlock } from './ToolCallBlock';

/**
 * Central block renderer registry (Spec §5 & §7).
 * Keeps turn rendering extensible and provides safe read-only fallback for unknown kinds.
 */
export const RegisteredExecutionBlock = memo(function RegisteredExecutionBlock({
  block,
}: {
  block: ExecutionBlock;
}) {
  if (
    block.kind === 'model' ||
    block.kind === 'tool' ||
    block.kind === 'cli-tool' ||
    block.kind === 'status'
  ) {
    return <ToolCallBlock block={block} />;
  }

  return (
    <div className="ag-step-card">
      <div className="ag-step-row">
        <strong className="ag-step-label">{block.label || '未知事件'}</strong>
        {block.summary && (
          <span className="ag-step-summary">{block.summary}</span>
        )}
      </div>
    </div>
  );
});

export const RegisteredArtifactBlock = memo(function RegisteredArtifactBlock({
  artifact,
}: {
  artifact: AgentToolArtifact;
}) {
  return <ArtifactBlock artifact={artifact} />;
});
