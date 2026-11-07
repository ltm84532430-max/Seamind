import {
  evaluateMathVisualization,
  type MathVisualizationWorkerRequest,
  type MathVisualizationWorkerResponse,
} from './math-visualization';

const workerScope = globalThis as unknown as {
  addEventListener: (
    type: 'message',
    listener: (event: MessageEvent<MathVisualizationWorkerRequest>) => void,
  ) => void;
  postMessage: (message: MathVisualizationWorkerResponse) => void;
};

workerScope.addEventListener('message', (event) => {
  const { id, spec } = event.data;
  try {
    workerScope.postMessage({ id, result: evaluateMathVisualization(spec) });
  } catch (error) {
    workerScope.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
