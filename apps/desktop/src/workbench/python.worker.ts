interface PythonRuntime {
  setStdout(options: { batched: (text: string) => void }): void;
  setStderr(options: { batched: (text: string) => void }): void;
  runPythonAsync(source: string): Promise<unknown>;
}

export interface PythonWorkerVarSummary {
  name: string;
  typeName: string;
  preview: string;
}

export interface PythonWorkerRequest {
  requestId?: string;
  action?: 'exec' | 'reset' | 'vars';
  source: string;
  indexURL: string;
  moduleURL: string;
}

export interface PythonWorkerResponse {
  type: 'result' | 'error';
  requestId?: string;
  output?: string;
  stderr?: string;
  resultText?: string;
  images?: string[];
  svgs?: string[];
  htmls?: string[];
  latexes?: string[];
  variables?: PythonWorkerVarSummary[];
  error?: string;
}

const workerScope = globalThis as unknown as {
  addEventListener: (
    type: 'message',
    listener: (event: MessageEvent<PythonWorkerRequest>) => void,
  ) => void;
  postMessage: (message: PythonWorkerResponse) => void;
};

let pyodidePromise: Promise<PythonRuntime> | null = null;
let helperInstalled = false;

const SEAMIND_PYODIDE_PRELUDE = `
import ast as _sm_ast
import base64 as _sm_base64
import io as _sm_io
import json as _sm_json
import sys as _sm_sys

_sm_ns = globals()

def _sm_collect_vars():
    items = []
    for k, v in list(_sm_ns.items()):
        if k.startswith('_'):
            continue
        tname = type(v).__name__
        if tname in ('module', 'function', 'builtin_function_or_method', 'type'):
            continue
        try:
            shape = getattr(v, 'shape', None)
            if shape is not None:
                preview = f"shape={shape} dtype={getattr(v, 'dtype', '?')}"
            else:
                r = repr(v)
                preview = r[:117] + '...' if len(r) > 120 else r
        except Exception:
            preview = '<unprintable>'
        items.append({'name': k, 'typeName': tname, 'preview': preview})
        if len(items) >= 64:
            break
    return items

def _sm_eval_cell(code_src):
    images, svgs, htmls, latexes = [], [], [], []
    result_text = ''
    tree = _sm_ast.parse(code_src, filename='<cell>', mode='exec')
    last_expr = None
    if tree.body and isinstance(tree.body[-1], _sm_ast.Expr):
        last_expr = tree.body.pop()
    if tree.body:
        exec(compile(tree, '<cell>', 'exec'), _sm_ns, _sm_ns)
    if last_expr is not None:
        val = eval(compile(_sm_ast.Expression(last_expr.value), '<cell>', 'eval'), _sm_ns, _sm_ns)
        if val is not None:
            _sm_ns['_'] = val
            for attr, target, limit in (
                ('_repr_html_', htmls, 24000),
                ('_repr_svg_', svgs, 40000),
                ('_repr_latex_', latexes, 4000),
            ):
                try:
                    fn = getattr(val, attr, None)
                    if callable(fn):
                        out = fn()
                        if isinstance(out, str) and out.strip():
                            target.append(out[:limit])
                except Exception:
                    pass
            try:
                fn_png = getattr(val, '_repr_png_', None)
                if callable(fn_png):
                    raw_png = fn_png()
                    if isinstance(raw_png, (bytes, bytearray)) and len(raw_png) > 0:
                        images.append('data:image/png;base64,' + _sm_base64.b64encode(bytes(raw_png)).decode('ascii'))
                    elif isinstance(raw_png, str) and raw_png.strip():
                        images.append(raw_png if raw_png.startswith('data:') else 'data:image/png;base64,' + raw_png.strip())
            except Exception:
                pass
            try:
                result_text = repr(val)[:8000]
            except Exception:
                result_text = '<unprintable>'
    plt = _sm_sys.modules.get('matplotlib.pyplot')
    if plt is not None:
        try:
            for num in list(plt.get_fignums())[:8]:
                fig = plt.figure(num)
                buf = _sm_io.BytesIO()
                fig.savefig(buf, format='png', dpi=130, bbox_inches='tight')
                buf.seek(0)
                images.append('data:image/png;base64,' + _sm_base64.b64encode(buf.read()).decode('ascii'))
            plt.close('all')
        except Exception:
            pass
    return _sm_json.dumps({
        'resultText': result_text,
        'images': images,
        'svgs': svgs,
        'htmls': htmls,
        'latexes': latexes,
        'variables': _sm_collect_vars(),
    }, ensure_ascii=False)

def _sm_reset_cell():
    keep = {
        '__name__', '__doc__', '__package__', '__loader__', '__spec__',
        '__annotations__', '__builtins__', '_sm_ast', '_sm_base64', '_sm_io',
        '_sm_json', '_sm_sys', '_sm_ns', '_sm_collect_vars', '_sm_eval_cell',
        '_sm_reset_cell'
    }
    for k in list(_sm_ns.keys()):
        if k not in keep:
            del _sm_ns[k]
    plt = _sm_sys.modules.get('matplotlib.pyplot')
    if plt is not None:
        try:
            plt.close('all')
        except Exception:
            pass
    return _sm_json.dumps({'variables': []}, ensure_ascii=False)
`;

async function ensurePyodide(
  indexURL: string,
  moduleURL: string,
): Promise<PythonRuntime> {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      const pyodideModule = (await import(/* @vite-ignore */ moduleURL)) as {
        loadPyodide: (options: { indexURL: string }) => Promise<PythonRuntime>;
      };
      return pyodideModule.loadPyodide({ indexURL });
    })();
  }
  const pyodide = await pyodidePromise;
  if (!helperInstalled) {
    await pyodide.runPythonAsync(SEAMIND_PYODIDE_PRELUDE);
    helperInstalled = true;
  }
  return pyodide;
}

workerScope.addEventListener(
  'message',
  async (event: MessageEvent<PythonWorkerRequest>) => {
    const {
      source,
      indexURL,
      moduleURL,
      requestId,
      action = 'exec',
    } = event.data;

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let outLen = 0;
    let errLen = 0;

    const appendOut = (text: string) => {
      if (outLen >= 60_000) return;
      const available = 60_000 - outLen;
      stdoutChunks.push(text.slice(0, available));
      outLen += Math.min(text.length, available);
    };
    const appendErr = (text: string) => {
      if (errLen >= 30_000) return;
      const available = 30_000 - errLen;
      stderrChunks.push(text.slice(0, available));
      errLen += Math.min(text.length, available);
    };

    try {
      const pyodide = await ensurePyodide(indexURL, moduleURL);
      pyodide.setStdout({ batched: (text) => appendOut(`${text}\n`) });
      pyodide.setStderr({ batched: (text) => appendErr(`${text}\n`) });

      if (action === 'reset') {
        await pyodide.runPythonAsync('_sm_reset_cell()');
        workerScope.postMessage({
          type: 'result',
          requestId,
          output: '',
          stderr: '',
          resultText: '',
          images: [],
          svgs: [],
          htmls: [],
          latexes: [],
          variables: [],
        });
        return;
      }

      if (action === 'vars') {
        const rawVars = await pyodide.runPythonAsync(
          '_sm_json.dumps(_sm_collect_vars(), ensure_ascii=False)',
        );
        const variables =
          typeof rawVars === 'string'
            ? (JSON.parse(rawVars) as PythonWorkerVarSummary[])
            : [];
        workerScope.postMessage({
          type: 'result',
          requestId,
          output: '',
          variables,
        });
        return;
      }

      const encodedSource = JSON.stringify(source);
      const rawJson = await pyodide.runPythonAsync(
        `_sm_eval_cell(${encodedSource})`,
      );
      const parsed =
        typeof rawJson === 'string'
          ? (JSON.parse(rawJson) as {
              resultText?: string;
              images?: string[];
              svgs?: string[];
              htmls?: string[];
              latexes?: string[];
              variables?: PythonWorkerVarSummary[];
            })
          : {};

      const stdoutText = stdoutChunks.join('');
      const stderrText = stderrChunks.join('');
      const resultText = parsed.resultText ?? '';

      let combinedOutput = stdoutText;
      if (stderrText) {
        combinedOutput += (combinedOutput ? '\n' : '') + stderrText;
      }
      if (resultText && !requestId) {
        // Legacy markdown code-block widget expects expression result inside output string
        combinedOutput += (combinedOutput ? '\n' : '') + `${resultText}\n`;
      }
      if (outLen >= 60_000) {
        combinedOutput = `${combinedOutput.slice(0, 59_970)}\n[输出已截断]`;
      }

      workerScope.postMessage({
        type: 'result',
        requestId,
        output: combinedOutput,
        stderr: stderrText,
        resultText,
        images: parsed.images ?? [],
        svgs: parsed.svgs ?? [],
        htmls: parsed.htmls ?? [],
        latexes: parsed.latexes ?? [],
        variables: parsed.variables ?? [],
      });
    } catch (error) {
      const stderrText = stderrChunks.join('');
      workerScope.postMessage({
        type: 'error',
        requestId,
        output: stdoutChunks.join(''),
        stderr: stderrText,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);
