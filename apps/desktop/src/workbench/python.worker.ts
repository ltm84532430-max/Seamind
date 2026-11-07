interface PythonRuntime {
  setStdout(options: { batched: (text: string) => void }): void;
  setStderr(options: { batched: (text: string) => void }): void;
  runPythonAsync(source: string): Promise<unknown>;
}

interface PythonWorkerRequest {
  source: string;
  indexURL: string;
  moduleURL: string;
}

const workerScope = globalThis as unknown as {
  addEventListener: (
    type: 'message',
    listener: (event: MessageEvent<PythonWorkerRequest>) => void,
  ) => void;
  postMessage: (message: unknown) => void;
};
let pyodidePromise: Promise<PythonRuntime> | null = null;

workerScope.addEventListener(
  'message',
  async (event: MessageEvent<PythonWorkerRequest>) => {
    const { source, indexURL, moduleURL } = event.data;
    const output: string[] = [];
    let outputLength = 0;
    const appendOutput = (text: string) => {
      if (outputLength >= 60_000) return;
      const available = 60_000 - outputLength;
      output.push(text.slice(0, available));
      outputLength += Math.min(text.length, available);
    };

    try {
      if (!pyodidePromise) {
        pyodidePromise = (async () => {
          const pyodideModule = (await import(
            /* @vite-ignore */ moduleURL
          )) as {
            loadPyodide: (options: {
              indexURL: string;
            }) => Promise<PythonRuntime>;
          };
          return pyodideModule.loadPyodide({ indexURL });
        })();
      }
      const pyodide = await pyodidePromise;
      pyodide.setStdout({ batched: (text) => appendOutput(`${text}\n`) });
      pyodide.setStderr({ batched: (text) => appendOutput(`${text}\n`) });

      const result = await pyodide.runPythonAsync(source);
      let resultText = '';
      if (result !== undefined && result !== null) {
        const proxy = result as {
          toJs?: (options?: unknown) => unknown;
          destroy?: () => void;
        };
        try {
          const converted =
            typeof proxy.toJs === 'function' ? proxy.toJs() : result;
          resultText =
            typeof converted === 'string'
              ? converted
              : (JSON.stringify(converted) ?? String(converted));
        } catch {
          resultText = String(result);
        } finally {
          proxy.destroy?.();
        }
      }
      if (resultText) appendOutput(`${resultText}\n`);
      if (outputLength >= 60_000) appendOutput('\n[输出已截断]');
      let outputText = output.join('');
      if (outputLength >= 60_000)
        outputText = `${outputText.slice(0, 59_970)}\n[输出已截断]`;
      workerScope.postMessage({ type: 'result', output: outputText });
    } catch (error) {
      workerScope.postMessage({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);
