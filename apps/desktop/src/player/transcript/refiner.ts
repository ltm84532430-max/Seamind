import { invoke } from '@tauri-apps/api/core';
import type { AgentProviderSettings } from '../../agent/runtime';
import {
  applyRefinedStageOutput,
  formatPaddedCueTime,
  type RefinedTranscriptStageCandidate,
  type TranscriptStageChunk,
} from './export';
import type { TranscriptViewMode } from './types';

export interface TranscriptStageProgress {
  phase: 'running' | 'completed' | 'cancelled' | 'fallback';
  currentStageIndex: number;
  completedStages: number;
  totalStages: number;
  stageTimeRange: string;
  refinedStages: number;
  fallbackStages: number;
  errorMessage?: string;
}

interface RustRefineStageResponse {
  stageTitle: string;
  paragraphs: Array<{
    anchorId: number;
    text: string;
    translation?: string;
  }>;
}

function buildPreviousContextTail(stage: TranscriptStageChunk): string {
  const joined = stage.paragraphs
    .map((para) => para.text || para.translation || '')
    .filter(Boolean)
    .join(' ')
    .trim();
  if (!joined) return '';
  return joined.length <= 240 ? joined : joined.slice(joined.length - 240);
}

function extractErrorReason(reason: unknown): string {
  if (typeof reason === 'string' && reason.trim()) return reason.trim();
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message.trim();
  }
  return 'AI 服务调用失败';
}

function isFatalProviderConfigError(message: string): boolean {
  return (
    message.includes('API 密钥') ||
    message.includes('模型名称') ||
    message.includes('API 地址') ||
    message.includes('HTTP 401') ||
    message.includes('HTTP 403') ||
    message.includes('HTTP 404')
  );
}

export interface ProgressiveRefinementOptions {
  provider: AgentProviderSettings;
  videoTitle?: string | null;
  channelName?: string | null;
  viewMode: TranscriptViewMode;
  stages: readonly TranscriptStageChunk[];
  isCancelled?(): boolean;
  onProgress?(progress: TranscriptStageProgress): void;
  onStageUpdated?(args: {
    stages: TranscriptStageChunk[];
    completedStages: number;
    totalStages: number;
    refinedStages: number;
    fallbackStages: number;
  }): Promise<void> | void;
}

export interface ProgressiveRefinementOutcome {
  status: 'completed' | 'cancelled' | 'failed';
  stages: TranscriptStageChunk[];
  completedStages: number;
  refinedStages: number;
  fallbackStages: number;
  errorMessage?: string;
}

/**
 * Refines `TranscriptStageChunk[]` sequentially through Seamind's built-in LLM provider,
 * streaming updated `stages` after each completed window so the Knowledge Base file updates live.
 */
export async function refineTranscriptStagesProgressively(
  options: ProgressiveRefinementOptions,
): Promise<ProgressiveRefinementOutcome> {
  const totalStages = options.stages.length;
  const workingStages = options.stages.map((stage) => ({
    ...stage,
    paragraphs: [...stage.paragraphs],
  }));

  if (totalStages === 0) {
    return {
      status: 'completed',
      stages: workingStages,
      completedStages: 0,
      refinedStages: 0,
      fallbackStages: 0,
    };
  }

  let refinedStages = 0;
  let fallbackStages = 0;
  let completedStages = 0;
  let previousContextTail = '';

  for (let i = 0; i < totalStages; i += 1) {
    if (options.isCancelled?.()) {
      options.onProgress?.({
        phase: 'cancelled',
        currentStageIndex: i,
        completedStages,
        totalStages,
        stageTimeRange: workingStages[i].heading,
        refinedStages,
        fallbackStages,
      });
      return {
        status: 'cancelled',
        stages: workingStages,
        completedStages,
        refinedStages,
        fallbackStages,
      };
    }

    const stage = workingStages[i];
    const timeRange = `${formatPaddedCueTime(stage.start)} - ${formatPaddedCueTime(stage.end)}`;

    options.onProgress?.({
      phase: 'running',
      currentStageIndex: i,
      completedStages,
      totalStages,
      stageTimeRange: timeRange,
      refinedStages,
      fallbackStages,
    });

    const items = stage.paragraphs.map((para, idx) => {
      if (options.viewMode === 'translation') {
        return {
          id: idx,
          time: formatPaddedCueTime(para.start),
          text: para.translation || para.text,
        };
      }
      if (options.viewMode === 'original') {
        return {
          id: idx,
          time: formatPaddedCueTime(para.start),
          text: para.text || para.translation || '',
        };
      }
      return {
        id: idx,
        time: formatPaddedCueTime(para.start),
        text: para.text || para.translation || '',
        ...(para.translation ? { translation: para.translation } : {}),
      };
    });

    try {
      const response = await invoke<RustRefineStageResponse>(
        'refine_transcript_stage',
        {
          request: {
            baseUrl: options.provider.baseUrl,
            model: options.provider.model,
            videoTitle: options.videoTitle?.trim() ?? '',
            channelName: options.channelName?.trim() ?? '',
            stageIndex: i,
            totalStages,
            timeRange,
            mode: options.viewMode,
            previousContextTail,
            items,
          },
        },
      );

      const candidate: RefinedTranscriptStageCandidate = {
        stageTitle: response.stageTitle,
        paragraphs: response.paragraphs,
      };
      const applied = applyRefinedStageOutput(
        stage,
        candidate,
        options.viewMode,
      );
      workingStages[i] = applied.stage;
      if (applied.usedFallback) {
        fallbackStages += 1;
      } else {
        refinedStages += 1;
      }
      previousContextTail = buildPreviousContextTail(workingStages[i]);
    } catch (reason) {
      const errMsg = extractErrorReason(reason);
      if (i === 0 || isFatalProviderConfigError(errMsg)) {
        options.onProgress?.({
          phase: 'fallback',
          currentStageIndex: i,
          completedStages,
          totalStages,
          stageTimeRange: timeRange,
          refinedStages,
          fallbackStages,
          errorMessage: errMsg,
        });
        return {
          status: 'failed',
          stages: workingStages,
          completedStages,
          refinedStages,
          fallbackStages,
          errorMessage: errMsg,
        };
      }
      // Single-stage transient timeout/format hiccup: keep Step-2 clean stage and continue!
      fallbackStages += 1;
      previousContextTail = buildPreviousContextTail(workingStages[i]);
    }

    completedStages = i + 1;
    await options.onStageUpdated?.({
      stages: [...workingStages],
      completedStages,
      totalStages,
      refinedStages,
      fallbackStages,
    });
  }

  options.onProgress?.({
    phase: 'completed',
    currentStageIndex: totalStages - 1,
    completedStages: totalStages,
    totalStages,
    stageTimeRange: workingStages[totalStages - 1]?.heading ?? '',
    refinedStages,
    fallbackStages,
  });

  return {
    status: 'completed',
    stages: workingStages,
    completedStages: totalStages,
    refinedStages,
    fallbackStages,
  };
}
