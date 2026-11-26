use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use uuid::Uuid;

const MAX_CODE_BYTES: usize = 120_000;
const EXEC_TIMEOUT_SECS: u64 = 60;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonEnvInfo {
    pub id: String,
    pub label: String,
    pub python_path: String,
    pub env_type: String,
    pub conda_env_name: Option<String>,
    pub version: Option<String>,
    pub has_numpy: bool,
    pub has_matplotlib: bool,
    pub has_pandas: bool,
    pub has_pyarrow: bool,
    pub has_duckdb: bool,
    pub has_polars: bool,
    pub has_sqlalchemy: bool,
    pub has_scipy: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonVarSummary {
    pub name: String,
    pub type_name: String,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonEvalResult {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
    pub result_text: String,
    pub images: Vec<String>,
    pub saved_images: Vec<String>,
    pub svgs: Vec<String>,
    pub htmls: Vec<String>,
    pub latexes: Vec<String>,
    pub variables: Vec<PythonVarSummary>,
    pub error: Option<String>,
    pub duration_ms: u64,
}

struct KernelProcess {
    pid: Option<u32>,
    child: Child,
    stdin: ChildStdin,
    stdout_lines: Lines<BufReader<ChildStdout>>,
    python_path: String,
    cwd: Option<String>,
    session_id: Option<String>,
}

type SharedKernel = Arc<tokio::sync::Mutex<KernelProcess>>;

#[derive(Clone)]
struct KernelEntry {
    pid: Option<u32>,
    kernel: SharedKernel,
}

#[derive(Default)]
pub struct PythonKernelState(Mutex<HashMap<String, KernelEntry>>);

impl PythonKernelState {
    pub fn close_all(&self) {
        let entries: Vec<KernelEntry> = match self.0.lock() {
            Ok(mut guard) => guard.drain().map(|(_, entry)| entry).collect(),
            Err(_) => return,
        };
        for entry in entries {
            if let Some(pid_val) = entry.pid {
                kill_pid_only(pid_val);
            }
            if let Ok(mut guard) = entry.kernel.try_lock() {
                kill_process_tree(guard.pid, &mut guard.child);
            }
        }
    }
}

fn kill_pid_only(pid_val: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid_val.to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .output();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &pid_val.to_string()])
            .output();
    }
}

fn kill_process_tree(pid: Option<u32>, child: &mut Child) {
    if let Some(pid_val) = pid {
        kill_pid_only(pid_val);
    }
    let _ = child.start_kill();
}

const EMBEDDED_KERNEL_DRIVER: &str = r#"
import ast, base64, contextlib, gc, hashlib, io, json, os, sys, time, traceback

try:
    sys.stdin.reconfigure(encoding='utf-8', errors='replace')
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

try:
    import matplotlib
    matplotlib.use('Agg')
    matplotlib.rcParams['font.sans-serif'] = [
        'Microsoft YaHei',
        'SimHei',
        'PingFang SC',
        'Noto Sans CJK SC',
        'WenQuanYi Micro Hei',
        'DejaVu Sans',
    ]
    matplotlib.rcParams['axes.unicode_minus'] = False
except Exception:
    pass

SEAMIND_BUS_DIR = os.environ.get('SEAMIND_BUS_DIR', '')
SEAMIND_TABLES_DIR = os.environ.get('SEAMIND_TABLES_DIR', '')
SEAMIND_ARTIFACTS_DIR = os.environ.get('SEAMIND_ARTIFACTS_DIR', '')

def _sm_safe_name(raw):
    out = ''.join(ch if (ch.isalnum() or ch == '_') else '_' for ch in str(raw or 'table')).strip('_')
    if not out:
        return 'table'
    return ('t_' + out) if out[0].isdigit() else out

def sm_context():
    if not SEAMIND_BUS_DIR:
        return {}
    ctx_path = os.path.join(SEAMIND_BUS_DIR, 'context.json')
    if not os.path.isfile(ctx_path):
        return {}
    try:
        with open(ctx_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}

def sm_files():
    ctx = sm_context()
    res = {}
    for item in ctx.get('mountedFiles') or []:
        alias = str(item.get('alias') or '').strip()
        path = str(item.get('path') or '').strip()
        if alias and path:
            res[alias] = path
    return res

def sm_dbs():
    ctx = sm_context()
    res = {}
    for item in ctx.get('dbConnections') or []:
        name = str(item.get('name') or item.get('id') or '').strip()
        if name:
            res[name] = item
    return res

def sm_tables():
    names = []
    if SEAMIND_TABLES_DIR and os.path.isdir(SEAMIND_TABLES_DIR):
        for fn in sorted(os.listdir(SEAMIND_TABLES_DIR)):
            low = fn.lower()
            if low.endswith('.parquet') or low.endswith('.csv'):
                stem = os.path.splitext(fn)[0]
                if stem not in names:
                    names.append(stem)
    for alias in sm_files().keys():
        if alias not in names:
            names.append(alias)
    return names

def sm_save(name, df):
    if not SEAMIND_TABLES_DIR:
        raise RuntimeError('SEAMIND_TABLES_DIR 未初始化')
    os.makedirs(SEAMIND_TABLES_DIR, exist_ok=True)
    safe = _sm_safe_name(name)
    pq_path = os.path.join(SEAMIND_TABLES_DIR, f'{safe}.parquet')
    csv_path = os.path.join(SEAMIND_TABLES_DIR, f'{safe}.csv')
    # Polars DataFrame support
    if hasattr(df, 'write_parquet') and callable(df.write_parquet):
        df.write_parquet(pq_path)
        if os.path.exists(csv_path):
            try:
                os.remove(csv_path)
            except Exception:
                pass
        return pq_path
    # Convert plain list/dict to pandas if available
    if not hasattr(df, 'to_parquet') and not hasattr(df, 'to_csv'):
        try:
            import pandas as _pd
            df = _pd.DataFrame(df)
        except Exception as exc:
            raise RuntimeError(f'sm_save 需要 DataFrame 或可转为 DataFrame 的结构：{exc}')
    try:
        df.to_parquet(pq_path, index=False)
        if os.path.exists(csv_path):
            try:
                os.remove(csv_path)
            except Exception:
                pass
        return pq_path
    except Exception:
        df.to_csv(csv_path, index=False)
        if os.path.exists(pq_path):
            try:
                os.remove(pq_path)
            except Exception:
                pass
        return csv_path

def sm_load(name):
    import pandas as _pd
    safe = _sm_safe_name(name)
    if SEAMIND_TABLES_DIR and os.path.isdir(SEAMIND_TABLES_DIR):
        pq_path = os.path.join(SEAMIND_TABLES_DIR, f'{safe}.parquet')
        csv_path = os.path.join(SEAMIND_TABLES_DIR, f'{safe}.csv')
        if os.path.isfile(pq_path):
            try:
                return _pd.read_parquet(pq_path)
            except Exception:
                import duckdb as _ddb
                return _ddb.sql(f"SELECT * FROM read_parquet('{pq_path.replace(chr(39), chr(39)*2)}')").df()
        if os.path.isfile(csv_path):
            return _pd.read_csv(csv_path)
    files = sm_files()
    target = files.get(name) or files.get(safe) or (name if os.path.isfile(str(name)) else None)
    if not target or not os.path.isfile(target):
        raise FileNotFoundError(f"在共享数据总线和已挂载文件中未找到 '{name}'。当前可用：{sm_tables()}")
    low = target.lower()
    if low.endswith('.parquet') or low.endswith('.pq'):
        try:
            return _pd.read_parquet(target)
        except Exception:
            import duckdb as _ddb
            return _ddb.sql(f"SELECT * FROM read_parquet('{target.replace(chr(39), chr(39)*2)}')").df()
    if low.endswith('.tsv'):
        return _pd.read_csv(target, sep='\t')
    if low.endswith('.jsonl') or low.endswith('.ndjson'):
        return _pd.read_json(target, lines=True)
    if low.endswith('.json'):
        return _pd.read_json(target)
    if low.endswith('.xlsx') or low.endswith('.xls'):
        return _pd.read_excel(target)
    return _pd.read_csv(target)

def sm_sql(query):
    import duckdb as _ddb
    con = _ddb.connect(':memory:')
    try:
        registered = set()
        if SEAMIND_TABLES_DIR and os.path.isdir(SEAMIND_TABLES_DIR):
            for fn in sorted(os.listdir(SEAMIND_TABLES_DIR)):
                full = os.path.join(SEAMIND_TABLES_DIR, fn)
                if not os.path.isfile(full):
                    continue
                low = fn.lower()
                alias = _sm_safe_name(os.path.splitext(fn)[0])
                p_sql = "'" + full.replace("'", "''") + "'"
                if low.endswith('.parquet'):
                    con.execute(f'CREATE OR REPLACE TEMP VIEW "{alias}" AS SELECT * FROM read_parquet({p_sql})')
                    registered.add(alias.lower())
                elif low.endswith('.csv') and alias.lower() not in registered:
                    con.execute(f'CREATE OR REPLACE TEMP VIEW "{alias}" AS SELECT * FROM read_csv_auto({p_sql})')
                    registered.add(alias.lower())
        for alias, full in sm_files().items():
            if not os.path.isfile(full):
                continue
            safe = _sm_safe_name(alias)
            if safe.lower() in registered:
                continue
            p_sql = "'" + full.replace("'", "''") + "'"
            low = full.lower()
            if low.endswith('.parquet') or low.endswith('.pq'):
                con.execute(f'CREATE OR REPLACE TEMP VIEW "{safe}" AS SELECT * FROM read_parquet({p_sql})')
            elif low.endswith('.tsv'):
                con.execute(f"CREATE OR REPLACE TEMP VIEW \"{safe}\" AS SELECT * FROM read_csv_auto({p_sql}, delim='\\t')")
            elif low.endswith('.json') or low.endswith('.jsonl'):
                con.execute(f'CREATE OR REPLACE TEMP VIEW "{safe}" AS SELECT * FROM read_json_auto({p_sql})')
            else:
                con.execute(f'CREATE OR REPLACE TEMP VIEW "{safe}" AS SELECT * FROM read_csv_auto({p_sql})')
        return con.execute(query).df()
    finally:
        con.close()

_ACTIVE_COLLECTOR = None
_MAX_IMAGES_PER_CELL = 12
_MAX_IMAGE_BYTES = 8 * 1024 * 1024

def _mime_for_ext(path_str):
    low = str(path_str or '').lower()
    if low.endswith('.jpg') or low.endswith('.jpeg'):
        return 'image/jpeg'
    if low.endswith('.webp'):
        return 'image/webp'
    if low.endswith('.gif'):
        return 'image/gif'
    if low.endswith('.svg'):
        return 'image/svg+xml'
    return 'image/png'

def _archive_image_bytes(raw_bytes, ext='png', collector=None, source_path=None):
    if collector is None:
        return
    if source_path and os.path.isfile(source_path):
        if source_path not in collector['saved_images']:
            collector['saved_images'].append(source_path)
        return
    if SEAMIND_ARTIFACTS_DIR:
        try:
            os.makedirs(SEAMIND_ARTIFACTS_DIR, exist_ok=True)
            ts = int(time.time() * 1000)
            idx = len(collector['saved_images']) + 1
            out_file = os.path.join(SEAMIND_ARTIFACTS_DIR, f'py_plot_{ts}_{idx}.{ext}')
            with open(out_file, 'wb') as f:
                f.write(raw_bytes)
            collector['saved_images'].append(out_file)
        except Exception:
            pass

def _append_image_bytes(raw_bytes, mime='image/png', collector=None, source_path=None):
    if collector is None or not raw_bytes or len(raw_bytes) > _MAX_IMAGE_BYTES:
        return False
    if len(collector['images']) >= _MAX_IMAGES_PER_CELL:
        return False
    digest = hashlib.md5(raw_bytes).hexdigest()
    if digest in collector['seen_hashes']:
        if source_path and source_path not in collector['saved_images']:
            collector['saved_images'].append(source_path)
        return True
    collector['seen_hashes'].add(digest)
    b64 = base64.b64encode(raw_bytes).decode('ascii')
    collector['images'].append(f'data:{mime};base64,{b64}')
    ext = 'jpg' if mime == 'image/jpeg' else ('webp' if mime == 'image/webp' else ('gif' if mime == 'image/gif' else 'png'))
    _archive_image_bytes(raw_bytes, ext=ext, collector=collector, source_path=source_path)
    return True

def _append_svg_text(svg_text, collector=None):
    if collector is None or not isinstance(svg_text, str) or not svg_text.strip():
        return False
    cleaned = svg_text.strip()[:120000]
    digest = hashlib.md5(cleaned.encode('utf-8', errors='ignore')).hexdigest()
    if digest in collector['seen_hashes']:
        return True
    collector['seen_hashes'].add(digest)
    collector['svgs'].append(cleaned)
    return True

def _load_image_file_into_collector(path_str, collector):
    if collector is None or not path_str:
        return False
    try:
        full = os.path.abspath(os.fspath(path_str))
    except Exception:
        return False
    if not os.path.isfile(full):
        return False
    mime = _mime_for_ext(full)
    try:
        if mime == 'image/svg+xml':
            with open(full, 'r', encoding='utf-8', errors='replace') as f:
                return _append_svg_text(f.read(), collector)
        with open(full, 'rb') as f:
            raw = f.read(_MAX_IMAGE_BYTES + 1)
        if not raw or len(raw) > _MAX_IMAGE_BYTES:
            return False
        return _append_image_bytes(raw, mime=mime, collector=collector, source_path=full)
    except Exception:
        return False

def _render_mpl_figure_into_collector(fig, collector):
    if collector is None or fig is None:
        return False
    try:
        buf = io.BytesIO()
        facecolor = None
        try:
            facecolor = fig.get_facecolor()
        except Exception:
            facecolor = 'white'
        fig.savefig(buf, format='png', dpi=140, bbox_inches='tight', facecolor=facecolor)
        return _append_image_bytes(buf.getvalue(), mime='image/png', collector=collector)
    except Exception:
        return False

def _extract_rich(val, collector):
    if val is None or collector is None:
        return ''
    captured = False

    # 1. IPython.display.Image (supports filename=... and data=...)
    cls_mod = getattr(type(val), '__module__', '') or ''
    cls_name = getattr(type(val), '__name__', '') or ''
    if cls_name == 'Image' and ('IPython' in cls_mod):
        fmt = str(getattr(val, 'format', 'png') or 'png').lower()
        mime = 'image/jpeg' if fmt in ('jpg', 'jpeg') else ('image/webp' if fmt == 'webp' else ('image/gif' if fmt == 'gif' else 'image/png'))
        fname = getattr(val, 'filename', None)
        data = getattr(val, 'data', None)
        if isinstance(data, (bytes, bytearray)) and len(data) > 0:
            captured = _append_image_bytes(bytes(data), mime=mime, collector=collector, source_path=fname) or captured
        elif fname and os.path.isfile(str(fname)):
            captured = _load_image_file_into_collector(fname, collector) or captured
        if captured:
            return ''

    # 2. Matplotlib Figure object directly
    if 'matplotlib.figure' in cls_mod and hasattr(val, 'savefig'):
        if _render_mpl_figure_into_collector(val, collector):
            return ''

    # 3. PIL.Image.Image directly
    if cls_mod.startswith('PIL.') and hasattr(val, 'save') and hasattr(val, 'size'):
        try:
            buf = io.BytesIO()
            val.save(buf, format='PNG')
            if _append_image_bytes(buf.getvalue(), mime='image/png', collector=collector):
                return ''
        except Exception:
            pass

    # 4. Standard IPython rich representation hooks
    try:
        if hasattr(val, '_repr_html_') and callable(val._repr_html_):
            h = val._repr_html_()
            if isinstance(h, str) and h.strip():
                collector['htmls'].append(h[:24000])
                captured = True
    except Exception:
        pass
    try:
        if hasattr(val, '_repr_svg_') and callable(val._repr_svg_):
            s = val._repr_svg_()
            if isinstance(s, str) and s.strip():
                captured = _append_svg_text(s, collector) or captured
    except Exception:
        pass
    try:
        if hasattr(val, '_repr_png_') and callable(val._repr_png_):
            p = val._repr_png_()
            if isinstance(p, tuple) and len(p) > 0:
                p = p[0]
            if isinstance(p, (bytes, bytearray)) and len(p) > 0:
                captured = _append_image_bytes(bytes(p), mime='image/png', collector=collector) or captured
            elif isinstance(p, str) and p.strip():
                raw = p.strip()
                if raw.startswith('data:'):
                    collector['images'].append(raw)
                    captured = True
                else:
                    captured = _append_image_bytes(base64.b64decode(raw), mime='image/png', collector=collector) or captured
    except Exception:
        pass
    try:
        if hasattr(val, '_repr_jpeg_') and callable(val._repr_jpeg_):
            j = val._repr_jpeg_()
            if isinstance(j, tuple) and len(j) > 0:
                j = j[0]
            if isinstance(j, (bytes, bytearray)) and len(j) > 0:
                captured = _append_image_bytes(bytes(j), mime='image/jpeg', collector=collector) or captured
            elif isinstance(j, str) and j.strip():
                raw = j.strip()
                if raw.startswith('data:'):
                    collector['images'].append(raw)
                    captured = True
                else:
                    captured = _append_image_bytes(base64.b64decode(raw), mime='image/jpeg', collector=collector) or captured
    except Exception:
        pass
    try:
        if hasattr(val, '_repr_latex_') and callable(val._repr_latex_):
            l = val._repr_latex_()
            if isinstance(l, str) and l.strip():
                collector['latexes'].append(l[:4000])
                captured = True
    except Exception:
        pass
    if captured:
        return ''
    try:
        return repr(val)[:8000]
    except Exception:
        return '<unprintable>'

def sm_show_image(target):
    collector = _ACTIVE_COLLECTOR
    if collector is None or target is None:
        return None
    if isinstance(target, (str, os.PathLike)):
        if not _load_image_file_into_collector(target, collector):
            raise FileNotFoundError(f'无法读取图片文件：{target}')
        return None
    if isinstance(target, (bytes, bytearray)):
        _append_image_bytes(bytes(target), mime='image/png', collector=collector)
        return None
    _extract_rich(target, collector)
    return None

def display(*objs, **kwargs):
    collector = _ACTIVE_COLLECTOR
    if collector is None:
        for obj in objs:
            print(repr(obj))
        return None
    for obj in objs:
        text_fallback = _extract_rich(obj, collector)
        if text_fallback:
            print(text_fallback)
    return None

def _collect_plt_figures(collector):
    plt = sys.modules.get('matplotlib.pyplot')
    if plt is None or collector is None:
        return
    try:
        fignums = list(plt.get_fignums())
        for num in fignums[:_MAX_IMAGES_PER_CELL]:
            fig = plt.figure(num)
            _render_mpl_figure_into_collector(fig, collector)
        if fignums:
            plt.close('all')
    except Exception:
        pass

def _install_runtime_hooks():
    # Hook IPython.display.display so `from IPython.display import display, Image` works natively
    for mod_name in ('IPython.display', 'IPython.core.display'):
        mod = sys.modules.get(mod_name)
        if mod is not None and not getattr(mod, '_seamind_display_hooked', False):
            try:
                setattr(mod, 'display', display)
                setattr(mod, '_seamind_display_hooked', True)
            except Exception:
                pass
    # Hook matplotlib.pyplot.show to capture figures immediately when plt.show() is called
    plt = sys.modules.get('matplotlib.pyplot')
    if plt is not None and not getattr(plt, '_seamind_show_hooked', False):
        try:
            def _seamind_plt_show(*args, **kwargs):
                if _ACTIVE_COLLECTOR is not None:
                    _collect_plt_figures(_ACTIVE_COLLECTOR)
            plt.show = _seamind_plt_show
            plt._seamind_show_hooked = True
        except Exception:
            pass
    # Hook matplotlib.figure.Figure.savefig so fig.savefig(out) + plt.close(fig) still displays automatically
    fig_mod = sys.modules.get('matplotlib.figure')
    if fig_mod is not None and hasattr(fig_mod, 'Figure'):
        fig_cls = fig_mod.Figure
        if not getattr(fig_cls, '_seamind_savefig_hooked', False):
            try:
                _orig_savefig = fig_cls.savefig
                def _seamind_savefig(self, fname, *args, **kwargs):
                    res = _orig_savefig(self, fname, *args, **kwargs)
                    if _ACTIVE_COLLECTOR is not None and isinstance(fname, (str, os.PathLike)):
                        try:
                            full = os.path.abspath(os.fspath(fname))
                            low = full.lower()
                            if low.endswith(('.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg')):
                                if full not in _ACTIVE_COLLECTOR['savefig_paths']:
                                    _ACTIVE_COLLECTOR['savefig_paths'].append(full)
                        except Exception:
                            pass
                    return res
                fig_cls.savefig = _seamind_savefig
                fig_cls._seamind_savefig_hooked = True
            except Exception:
                pass

try:
    import IPython.display  # noqa: F401
except Exception:
    pass
try:
    import matplotlib.figure  # noqa: F401
    import matplotlib.pyplot  # noqa: F401
except Exception:
    pass
_install_runtime_hooks()

def _make_base_ns():
    return {
        '__name__': '__main__',
        'SEAMIND_BUS_DIR': SEAMIND_BUS_DIR,
        'SEAMIND_TABLES_DIR': SEAMIND_TABLES_DIR,
        'SEAMIND_ARTIFACTS_DIR': SEAMIND_ARTIFACTS_DIR,
        'SEAMIND_FILES': sm_files(),
        'SEAMIND_DBS': sm_dbs(),
        'sm_context': sm_context,
        'sm_files': sm_files,
        'sm_dbs': sm_dbs,
        'sm_tables': sm_tables,
        'sm_save': sm_save,
        'sm_load': sm_load,
        'sm_sql': sm_sql,
        'sm_show_image': sm_show_image,
        'display': display,
    }

ns = _make_base_ns()
_RESERVED_VAR_NAMES = set(ns.keys())

def _collect_vars(env):
    items = []
    for k, v in list(env.items()):
        if k.startswith('_') or k in _RESERVED_VAR_NAMES:
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

def _run_code(code):
    global _ACTIVE_COLLECTOR
    ns['SEAMIND_FILES'] = sm_files()
    ns['SEAMIND_DBS'] = sm_dbs()
    _install_runtime_hooks()
    out_buf = io.StringIO()
    err_buf = io.StringIO()
    collector = {
        'images': [],
        'saved_images': [],
        'svgs': [],
        'htmls': [],
        'latexes': [],
        'seen_hashes': set(),
        'savefig_paths': [],
    }
    result_text = ''
    err_text = None
    ok = True
    _ACTIVE_COLLECTOR = collector
    try:
        tree = ast.parse(code, filename='<cell>', mode='exec')
        last_expr = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last_expr = tree.body.pop()
        with contextlib.redirect_stdout(out_buf), contextlib.redirect_stderr(err_buf):
            if tree.body:
                exec(compile(tree, '<cell>', 'exec'), ns, ns)
                _install_runtime_hooks()
            if last_expr is not None:
                val = eval(compile(ast.Expression(last_expr.value), '<cell>', 'eval'), ns, ns)
                if val is not None:
                    ns['_'] = val
                    result_text = _extract_rich(val, collector)
        _install_runtime_hooks()
        _collect_plt_figures(collector)
        for saved_path in collector['savefig_paths']:
            _load_image_file_into_collector(saved_path, collector)
    except Exception:
        ok = False
        err_text = traceback.format_exc(limit=12)[-8000:]
    finally:
        _ACTIVE_COLLECTOR = None
    return {
        'ok': ok,
        'stdout': out_buf.getvalue()[:60000],
        'stderr': err_buf.getvalue()[:30000],
        'resultText': result_text,
        'images': collector['images'],
        'savedImages': collector['saved_images'],
        'svgs': collector['svgs'],
        'htmls': collector['htmls'],
        'latexes': collector['latexes'],
        'variables': _collect_vars(ns),
        'error': err_text,
    }

for raw in sys.stdin:
    line = raw.strip()
    if not line:
        continue
    req_id = ''
    try:
        req = json.loads(line)
        req_id = str(req.get('id', ''))
        op = req.get('op', 'exec')
        if op == 'shutdown':
            break
        elif op == 'reset':
            ns = _make_base_ns()
            plt = sys.modules.get('matplotlib.pyplot')
            if plt is not None:
                try:
                    plt.close('all')
                except Exception:
                    pass
            gc.collect()
            payload = {
                'id': req_id, 'ok': True, 'stdout': '', 'stderr': '',
                'resultText': '', 'images': [], 'savedImages': [], 'svgs': [], 'htmls': [],
                'latexes': [], 'variables': [], 'error': None
            }
        elif op == 'vars':
            payload = {
                'id': req_id, 'ok': True, 'stdout': '', 'stderr': '',
                'resultText': '', 'images': [], 'savedImages': [], 'svgs': [], 'htmls': [],
                'latexes': [], 'variables': _collect_vars(ns), 'error': None
            }
        else:
            res = _run_code(str(req.get('code', '')))
            res['id'] = req_id
            payload = res
    except Exception as exc:
        payload = {
            'id': req_id, 'ok': False, 'stdout': '', 'stderr': '',
            'resultText': '', 'images': [], 'savedImages': [], 'svgs': [], 'htmls': [],
            'latexes': [], 'variables': [], 'error': str(exc)
        }
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + '\n')
    sys.stdout.flush()
"#;

fn normalize_path_key(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let trimmed = raw.trim_start_matches("\\\\?\\");
    if cfg!(windows) {
        trimmed.to_lowercase()
    } else {
        trimmed.to_string()
    }
}

fn clean_display_path(path: &Path) -> String {
    path.to_string_lossy()
        .trim_start_matches("\\\\?\\")
        .to_string()
}

struct PythonPkgFlags {
    has_numpy: bool,
    has_matplotlib: bool,
    has_pandas: bool,
    has_pyarrow: bool,
    has_duckdb: bool,
    has_polars: bool,
    has_sqlalchemy: bool,
    has_scipy: bool,
    version: Option<String>,
}

fn inspect_python_site_packages(python_path: &Path) -> PythonPkgFlags {
    let mut flags = PythonPkgFlags {
        has_numpy: false,
        has_matplotlib: false,
        has_pandas: false,
        has_pyarrow: false,
        has_duckdb: false,
        has_polars: false,
        has_sqlalchemy: false,
        has_scipy: false,
        version: None,
    };
    let Some(parent) = python_path.parent() else {
        return flags;
    };
    let root = if parent
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.eq_ignore_ascii_case("Scripts") || n.eq_ignore_ascii_case("bin"))
        .unwrap_or(false)
    {
        parent.parent().unwrap_or(parent)
    } else {
        parent
    };

    let site_dirs = if cfg!(windows) {
        vec![root.join("Lib").join("site-packages")]
    } else {
        let lib = root.join("lib");
        let mut found = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&lib) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("python") {
                    found.push(entry.path().join("site-packages"));
                }
            }
        }
        found
    };

    for dir in site_dirs {
        if dir.join("numpy").exists() {
            flags.has_numpy = true;
        }
        if dir.join("matplotlib").exists() {
            flags.has_matplotlib = true;
        }
        if dir.join("pandas").exists() {
            flags.has_pandas = true;
        }
        if dir.join("pyarrow").exists() {
            flags.has_pyarrow = true;
        }
        if dir.join("duckdb").exists()
            || dir.join("duckdb.pyd").exists()
            || std::fs::read_dir(&dir)
                .ok()
                .map(|entries| {
                    entries
                        .flatten()
                        .any(|e| e.file_name().to_string_lossy().starts_with("duckdb"))
                })
                .unwrap_or(false)
        {
            flags.has_duckdb = true;
        }
        if dir.join("polars").exists() {
            flags.has_polars = true;
        }
        if dir.join("sqlalchemy").exists() {
            flags.has_sqlalchemy = true;
        }
        if dir.join("scipy").exists() {
            flags.has_scipy = true;
        }
    }

    let conda_meta = root.join("conda-meta");
    if let Ok(entries) = std::fs::read_dir(&conda_meta) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(rest) = name.strip_prefix("python-") {
                if let Some(ver) = rest.split('-').next() {
                    flags.version = Some(ver.to_string());
                    break;
                }
            }
        }
    }
    if flags.version.is_none() {
        if let Ok(cfg) = std::fs::read_to_string(root.join("pyvenv.cfg")) {
            for line in cfg.lines() {
                if let Some(ver) = line.strip_prefix("version =") {
                    flags.version = Some(ver.trim().to_string());
                    break;
                }
            }
        }
    }

    flags
}

pub(crate) fn discover_conda_env_dirs() -> Vec<(PathBuf, String)> {
    let mut seen = HashSet::<String>::new();
    let mut dirs = Vec::<(PathBuf, String)>::new();
    let mut push_dir = |dir: PathBuf, name: String| {
        if !dir.is_dir() {
            return;
        }
        let key = normalize_path_key(&dir);
        if seen.insert(key) {
            dirs.push((dir, name));
        }
    };

    if let Some(prefix) = std::env::var_os("CONDA_PREFIX") {
        let root = PathBuf::from(prefix);
        let name = std::env::var("CONDA_DEFAULT_ENV").unwrap_or_else(|_| {
            root.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("base")
                .to_string()
        });
        push_dir(root, name);
    }

    // 1. Read ~/.conda/environments.txt (authoritative registry maintained by Conda/Anaconda/Mamba)
    let home_dir = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);
    if let Some(home) = &home_dir {
        let env_txt = home.join(".conda").join("environments.txt");
        if let Ok(content) = std::fs::read_to_string(env_txt) {
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    continue;
                }
                let env_dir = PathBuf::from(trimmed);
                let is_envs_child = env_dir
                    .parent()
                    .and_then(|p| p.file_name())
                    .and_then(|n| n.to_str())
                    .map(|n| n.eq_ignore_ascii_case("envs"))
                    .unwrap_or(false);
                let env_name = if is_envs_child {
                    env_dir
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("conda")
                        .to_string()
                } else {
                    "base".to_string()
                };
                push_dir(env_dir, env_name);
            }
        }
    }

    // 2. Scan standard Anaconda / Miniconda / Miniforge / Mambaforge roots
    let mut conda_roots: Vec<PathBuf> = Vec::new();
    #[cfg(windows)]
    {
        for env_key in ["USERPROFILE", "LOCALAPPDATA", "PROGRAMDATA"] {
            if let Some(base) = std::env::var_os(env_key) {
                let b = PathBuf::from(base);
                for dist in [
                    "anaconda3",
                    "Anaconda3",
                    "miniconda3",
                    "Miniconda3",
                    "miniforge3",
                    "mambaforge",
                ] {
                    conda_roots.push(b.join(dist));
                }
            }
        }
        for drive in ["C:\\", "D:\\", "E:\\", "F:\\"] {
            for dist in ["anaconda3", "Anaconda3", "miniconda3", "Miniconda3", "miniforge3"] {
                conda_roots.push(PathBuf::from(drive).join(dist));
            }
        }
    }
    #[cfg(not(windows))]
    {
        if let Some(home) = &home_dir {
            for dist in ["anaconda3", "miniconda3", "miniforge3", "mambaforge"] {
                conda_roots.push(home.join(dist));
            }
        }
        for root in ["/opt/anaconda3", "/opt/miniconda3", "/opt/homebrew/Caskroom/miniconda/base"] {
            conda_roots.push(PathBuf::from(root));
        }
    }

    for root in conda_roots {
        if !root.is_dir() {
            continue;
        }
        push_dir(root.clone(), "base".to_string());
        let envs_dir = root.join("envs");
        if let Ok(entries) = std::fs::read_dir(envs_dir) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    let env_name = entry.file_name().to_string_lossy().to_string();
                    push_dir(entry.path(), env_name);
                }
            }
        }
    }

    dirs
}

pub(crate) fn resolve_python_executable(raw: &str) -> Option<PathBuf> {
    let trimmed = raw
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim_start_matches("\\\\?\\")
        .trim();
    if trimmed.is_empty() {
        return None;
    }
    let p = PathBuf::from(trimmed);
    if p.is_file() {
        return Some(p);
    }
    if p.is_dir() {
        let candidates = [
            p.join("python.exe"),
            p.join("Scripts").join("python.exe"),
            p.join("bin").join("python3"),
            p.join("bin").join("python"),
            p.join("python"),
        ];
        for cand in candidates {
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

pub(crate) fn infer_python_env_root(exe_path: &Path) -> PathBuf {
    let Some(parent) = exe_path.parent() else {
        return exe_path.to_path_buf();
    };
    let parent_name = parent
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_lowercase();
    if (parent_name == "scripts" || parent_name == "bin") && parent.parent().is_some() {
        let grand = parent.parent().unwrap();
        if grand.join("conda-meta").is_dir() || grand.join("pyvenv.cfg").is_file() {
            return grand.to_path_buf();
        }
    }
    parent.to_path_buf()
}

pub(crate) fn apply_python_env_activation(cmd: &mut Command, exe_path: &Path) {
    let env_root = infer_python_env_root(exe_path);
    let is_conda = env_root.join("conda-meta").is_dir();
    let is_venv = env_root.join("pyvenv.cfg").is_file();

    let mut prepend: Vec<PathBuf> = Vec::new();
    let candidates = [
        env_root.clone(),
        env_root.join("Library").join("mingw-w64").join("bin"),
        env_root.join("Library").join("usr").join("bin"),
        env_root.join("Library").join("bin"),
        env_root.join("Scripts"),
        env_root.join("bin"),
        env_root.join("DLLs"),
    ];
    for dir in candidates {
        if dir.is_dir() && !prepend.iter().any(|existing| existing == &dir) {
            prepend.push(dir);
        }
    }

    if !prepend.is_empty() {
        let mut combined = prepend;
        if let Some(existing_path) = std::env::var_os("PATH") {
            combined.extend(std::env::split_paths(&existing_path));
        }
        if let Ok(joined) = std::env::join_paths(combined) {
            cmd.env("PATH", joined);
        }
    }

    cmd.env_remove("PYTHONHOME");

    if is_conda {
        let env_name = env_root
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("base")
            .to_string();
        cmd.env("CONDA_PREFIX", &env_root);
        cmd.env("CONDA_DEFAULT_ENV", env_name);
        cmd.env("CONDA_SHLVL", "1");
    } else if is_venv {
        cmd.env("VIRTUAL_ENV", &env_root);
    }
}

pub(crate) fn collect_candidate_envs(
    cwd: Option<&str>,
    extra_paths: Option<&[String]>,
) -> Vec<PythonEnvInfo> {
    let mut seen = HashSet::<String>::new();
    let mut results = Vec::<PythonEnvInfo>::new();

    let mut push_candidate =
        |path: PathBuf, label: String, env_type: &str, conda_env_name: Option<String>| {
            if !path.is_file() {
                return;
            }
            let lower = path.to_string_lossy().to_lowercase();
            if lower.contains("windowsapps\\python") {
                return;
            }
            let key = normalize_path_key(&path);
            if !seen.insert(key.clone()) {
                return;
            }
            let flags = inspect_python_site_packages(&path);
            results.push(PythonEnvInfo {
                id: format!("py-{}", results.len() + 1),
                label,
                python_path: clean_display_path(&path),
                env_type: env_type.to_string(),
                conda_env_name,
                version: flags.version,
                has_numpy: flags.has_numpy,
                has_matplotlib: flags.has_matplotlib,
                has_pandas: flags.has_pandas,
                has_pyarrow: flags.has_pyarrow,
                has_duckdb: flags.has_duckdb,
                has_polars: flags.has_polars,
                has_sqlalchemy: flags.has_sqlalchemy,
                has_scipy: flags.has_scipy,
            });
        };

    // 0. User-configured custom Python paths (supports both python.exe and env directories)
    if let Some(custom_list) = extra_paths {
        for raw in custom_list {
            let Some(p) = resolve_python_executable(raw) else {
                continue;
            };
            let env_root = infer_python_env_root(&p);
            let name = env_root
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("Custom")
                .to_string();
            let is_conda = env_root.join("conda-meta").is_dir();
            let is_venv = env_root.join("pyvenv.cfg").is_file();
            let (label, env_type, conda_name) = if is_conda {
                (format!("Anaconda · {name}"), "conda", Some(name))
            } else if is_venv {
                (format!("Venv · {name}"), "venv", None)
            } else {
                (format!("自定义 Python ({name})"), "custom", None)
            };
            push_candidate(p, label, env_type, conda_name);
        }
    }

    // 1. Workspace virtual environments
    if let Some(cwd_str) = cwd.map(str::trim).filter(|s| !s.is_empty()) {
        let cwd_path = PathBuf::from(cwd_str.trim_start_matches("\\\\?\\"));
        for venv_name in [".venv", "venv"] {
            let exe = if cfg!(windows) {
                cwd_path.join(venv_name).join("Scripts").join("python.exe")
            } else {
                cwd_path.join(venv_name).join("bin").join("python")
            };
            push_candidate(exe, format!("工作区 {venv_name}"), "venv", None);
        }
    }

    // 2. All Anaconda / Miniconda / Miniforge / Mambaforge environments
    for (env_dir, env_name) in discover_conda_env_dirs() {
        let exe = if cfg!(windows) {
            env_dir.join("python.exe")
        } else {
            env_dir.join("bin").join("python")
        };
        let label = if env_name == "base" {
            let dist_name = env_dir
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("conda");
            format!("Anaconda base ({dist_name})")
        } else {
            format!("Anaconda · {env_name}")
        };
        push_candidate(exe, label, "conda", Some(env_name));
    }

    // 3. System PATH python binaries
    let where_cmd = if cfg!(windows) { "where.exe" } else { "which" };
    let args: &[&str] = if cfg!(windows) {
        &["python"]
    } else {
        &["-a", "python3"]
    };
    let mut cmd = std::process::Command::new(where_cmd);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    if let Ok(output) = cmd.output() {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                let p = PathBuf::from(line.trim());
                let name = p
                    .parent()
                    .and_then(|dir| dir.file_name())
                    .and_then(|s| s.to_str())
                    .unwrap_or("System")
                    .to_string();
                let is_conda = line.to_lowercase().contains("conda");
                let label = if is_conda {
                    format!("Anaconda · {name}")
                } else {
                    format!("System Python ({name})")
                };
                push_candidate(
                    p,
                    label,
                    if is_conda { "conda" } else { "system" },
                    if is_conda { Some(name) } else { None },
                );
            }
        }
    }

    results
}

#[tauri::command]
pub fn python_kernel_detect_envs(
    cwd: Option<String>,
    extra_paths: Option<Vec<String>>,
) -> Result<Vec<PythonEnvInfo>, String> {
    Ok(collect_candidate_envs(
        cwd.as_deref(),
        extra_paths.as_deref(),
    ))
}

async fn spawn_kernel_process(
    python_path: &str,
    cwd: Option<&str>,
    session_id: Option<&str>,
) -> Result<KernelProcess, String> {
    let exe_path = resolve_python_executable(python_path).ok_or_else(|| {
        format!(
            "无法在路径 ({python_path}) 中找到 python 可执行文件。请确认该 Conda/venv 目录包含 python.exe，或直接指定 python.exe 路径。"
        )
    })?;
    let exe_display = exe_path.to_string_lossy().to_string();
    let mut cmd = Command::new(&exe_path);
    // Windows' locale codec can fail while reading UTF-8 .pth files before our
    // driver starts. PYTHONIOENCODING only covers stdio, so enable UTF-8 mode.
    cmd.args(["-X", "utf8", "-u", "-c", EMBEDDED_KERNEL_DRIVER]);
    apply_python_env_activation(&mut cmd, &exe_path);
    if let Some(dir) = cwd.map(str::trim).filter(|s| !s.is_empty()) {
        let p = PathBuf::from(dir.trim_start_matches("\\\\?\\"));
        if p.is_dir() {
            cmd.current_dir(p);
        }
    }
    if let Ok((_, bus_dir, tables_dir, artifacts_dir)) =
        crate::data_lab::ensure_session_bus_dirs(session_id)
    {
        cmd.env("SEAMIND_BUS_DIR", bus_dir.to_string_lossy().to_string());
        cmd.env(
            "SEAMIND_TABLES_DIR",
            tables_dir.to_string_lossy().to_string(),
        );
        cmd.env(
            "SEAMIND_ARTIFACTS_DIR",
            artifacts_dir.to_string_lossy().to_string(),
        );
    }
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.env("MPLBACKEND", "Agg");
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 Python 内核 ({exe_display}) 失败：{e}"))?;
    let pid = child.id();
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法连接 Python 内核标准输入。".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法连接 Python 内核标准输出。".to_string())?;

    Ok(KernelProcess {
        pid,
        child,
        stdin,
        stdout_lines: BufReader::new(stdout).lines(),
        python_path: exe_display,
        cwd: cwd.map(|s| s.to_string()),
        session_id: session_id.map(|s| s.to_string()),
    })
}

async fn send_kernel_request(
    kernel: &SharedKernel,
    request: serde_json::Value,
) -> Result<PythonEvalResult, String> {
    let start = std::time::Instant::now();
    let line = format!(
        "{}\n",
        serde_json::to_string(&request).map_err(|e| format!("编码内核请求失败：{e}"))?
    );
    let mut guard = kernel.lock().await;
    guard
        .stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("写入 Python 内核失败（可能已退出）：{e}"))?;
    guard
        .stdin
        .flush()
        .await
        .map_err(|e| format!("刷新 Python 内核输入失败：{e}"))?;

    let read_res = tokio::time::timeout(
        std::time::Duration::from_secs(EXEC_TIMEOUT_SECS),
        guard.stdout_lines.next_line(),
    )
    .await;

    let raw_line = match read_res {
        Ok(Ok(Some(line))) => line,
        Ok(Ok(None)) => return Err("Python 内核已意外终止。".to_string()),
        Ok(Err(e)) => return Err(format!("读取 Python 内核响应失败：{e}")),
        Err(_) => {
            kill_process_tree(guard.pid, &mut guard.child);
            return Err(format!(
                "Python 执行超过 {EXEC_TIMEOUT_SECS} 秒超时，已终止当前内核。请点击「重启内核」。"
            ));
        }
    };

    let parsed: serde_json::Value =
        serde_json::from_str(&raw_line).map_err(|e| format!("解析内核输出失败：{e}"))?;
    Ok(PythonEvalResult {
        ok: parsed.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
        stdout: parsed
            .get("stdout")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        stderr: parsed
            .get("stderr")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        result_text: parsed
            .get("resultText")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        images: serde_json::from_value(parsed.get("images").cloned().unwrap_or(serde_json::json!([])))
            .unwrap_or_default(),
        saved_images: serde_json::from_value(
            parsed
                .get("savedImages")
                .cloned()
                .unwrap_or(serde_json::json!([])),
        )
        .unwrap_or_default(),
        svgs: serde_json::from_value(parsed.get("svgs").cloned().unwrap_or(serde_json::json!([])))
            .unwrap_or_default(),
        htmls: serde_json::from_value(parsed.get("htmls").cloned().unwrap_or(serde_json::json!([])))
            .unwrap_or_default(),
        latexes: serde_json::from_value(parsed.get("latexes").cloned().unwrap_or(serde_json::json!([])))
            .unwrap_or_default(),
        variables: serde_json::from_value(
            parsed.get("variables").cloned().unwrap_or(serde_json::json!([])),
        )
        .unwrap_or_default(),
        error: parsed
            .get("error")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

async fn spawn_verified_kernel_process(
    python_path: &str,
    cwd: Option<&str>,
    session_id: Option<&str>,
) -> Result<KernelProcess, String> {
    let proc = spawn_kernel_process(python_path, cwd, session_id).await?;
    let shared = Arc::new(tokio::sync::Mutex::new(proc));
    // A successful spawn does not mean Python survived site initialization.
    let ready = send_kernel_request(
        &shared,
        serde_json::json!({ "id": Uuid::new_v4().to_string(), "op": "vars" }),
    )
    .await;
    match ready {
        Ok(response) if response.ok => {}
        other => {
            let mut guard = shared.lock().await;
            kill_process_tree(guard.pid, &mut guard.child);
            let cause = match other {
                Ok(response) => response
                    .error
                    .unwrap_or_else(|| "内核未返回就绪确认。".to_string()),
                Err(error) => error,
            };
            return Err(format!("Python 内核启动校验失败：{cause}"));
        }
    }
    Arc::try_unwrap(shared)
        .map_err(|_| "无法取得已校验的 Python 内核。".to_string())
        .map(tokio::sync::Mutex::into_inner)
}

#[tauri::command]
pub async fn python_kernel_start(
    state: State<'_, PythonKernelState>,
    python_path: Option<String>,
    cwd: Option<String>,
    session_id: Option<String>,
) -> Result<String, String> {
    let resolved_path = match python_path.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        Some(path) => path,
        None => collect_candidate_envs(cwd.as_deref(), None)
            .into_iter()
            .next()
            .map(|env| env.python_path)
            .ok_or_else(|| "未检测到本地 Python / Conda 环境，可直接使用 Pyodide 沙盒。".to_string())?,
    };

    let proc =
        spawn_verified_kernel_process(&resolved_path, cwd.as_deref(), session_id.as_deref()).await?;
    let pid = proc.pid;
    let shared = Arc::new(tokio::sync::Mutex::new(proc));

    let kernel_id = format!("pyk-{}", Uuid::new_v4());

    state
        .0
        .lock()
        .map_err(|_| "Python 内核管理器不可用。".to_string())?
        .insert(kernel_id.clone(), KernelEntry { pid, kernel: shared });
    Ok(kernel_id)
}

fn get_kernel(state: &State<'_, PythonKernelState>, kernel_id: &str) -> Result<SharedKernel, String> {
    state
        .0
        .lock()
        .map_err(|_| "Python 内核管理器不可用。".to_string())?
        .get(kernel_id)
        .map(|entry| entry.kernel.clone())
        .ok_or_else(|| "Python 内核会话不存在或已关闭。".to_string())
}

#[tauri::command]
pub async fn python_kernel_eval(
    state: State<'_, PythonKernelState>,
    kernel_id: String,
    code: String,
) -> Result<PythonEvalResult, String> {
    if code.as_bytes().len() > MAX_CODE_BYTES {
        return Err("单格 Python 代码不能超过 120 KB。".to_string());
    }
    let kernel = get_kernel(&state, &kernel_id)?;
    let req_id = Uuid::new_v4().to_string();
    send_kernel_request(
        &kernel,
        serde_json::json!({ "id": req_id, "op": "exec", "code": code }),
    )
    .await
}

#[tauri::command]
pub async fn python_kernel_reset(
    state: State<'_, PythonKernelState>,
    kernel_id: String,
) -> Result<PythonEvalResult, String> {
    let kernel = get_kernel(&state, &kernel_id)?;
    let req_id = Uuid::new_v4().to_string();
    let res = send_kernel_request(&kernel, serde_json::json!({ "id": req_id, "op": "reset" })).await;
    if res.as_ref().is_ok_and(|response| response.ok) {
        return res;
    }
    // If the kernel died after timeout, transparently respawn a fresh process.
    let (python_path, cwd, session_id) = {
        let mut guard = kernel.lock().await;
        kill_process_tree(guard.pid, &mut guard.child);
        (
            guard.python_path.clone(),
            guard.cwd.clone(),
            guard.session_id.clone(),
        )
    };
    let fresh =
        spawn_verified_kernel_process(&python_path, cwd.as_deref(), session_id.as_deref()).await?;
    {
        let mut guard = kernel.lock().await;
        *guard = fresh;
    }
    Ok(PythonEvalResult {
        ok: true,
        stdout: String::new(),
        stderr: String::new(),
        result_text: String::new(),
        images: Vec::new(),
        saved_images: Vec::new(),
        svgs: Vec::new(),
        htmls: Vec::new(),
        latexes: Vec::new(),
        variables: Vec::new(),
        error: None,
        duration_ms: 0,
    })
}

#[tauri::command]
pub async fn python_kernel_vars(
    state: State<'_, PythonKernelState>,
    kernel_id: String,
) -> Result<Vec<PythonVarSummary>, String> {
    let kernel = get_kernel(&state, &kernel_id)?;
    let req_id = Uuid::new_v4().to_string();
    let res = send_kernel_request(&kernel, serde_json::json!({ "id": req_id, "op": "vars" })).await?;
    Ok(res.variables)
}

#[tauri::command]
pub async fn python_kernel_close(
    state: State<'_, PythonKernelState>,
    kernel_id: String,
) -> Result<(), String> {
    let entry = state
        .0
        .lock()
        .map_err(|_| "Python 内核管理器不可用。".to_string())?
        .remove(&kernel_id);
    if let Some(item) = entry {
        if let Some(pid_val) = item.pid {
            kill_pid_only(pid_val);
        }
        let mut guard = item.kernel.lock().await;
        kill_process_tree(guard.pid, &mut guard.child);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_driver_has_valid_json_protocol_markers() {
        assert!(EMBEDDED_KERNEL_DRIVER.contains("ast.parse(code"));
        assert!(EMBEDDED_KERNEL_DRIVER.contains("matplotlib.use('Agg')"));
        assert!(EMBEDDED_KERNEL_DRIVER.contains("'resultText'"));
        assert!(EMBEDDED_KERNEL_DRIVER.contains("def sm_show_image("));
        assert!(EMBEDDED_KERNEL_DRIVER.contains("def display(*objs"));
        assert!(EMBEDDED_KERNEL_DRIVER.contains("_seamind_savefig_hooked"));
        assert!(EMBEDDED_KERNEL_DRIVER.contains("_seamind_show_hooked"));
        assert!(EMBEDDED_KERNEL_DRIVER.contains("_seamind_display_hooked"));
    }

    #[test]
    fn detect_envs_deduplicates_paths() {
        let envs = collect_candidate_envs(None, None);
        let mut unique = HashSet::new();
        for env in &envs {
            let key = env.python_path.to_lowercase();
            assert!(unique.insert(key), "duplicate python path: {}", env.python_path);
        }
    }

    #[test]
    fn resolves_python_executable_from_conda_directory() {
        let dir = std::env::temp_dir().join(format!("seamind_test_conda_{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let py_exe = dir.join("python.exe");
        std::fs::write(&py_exe, b"stub").unwrap();
        let resolved = resolve_python_executable(&dir.to_string_lossy()).expect("should resolve");
        assert_eq!(resolved, py_exe);
        assert_eq!(infer_python_env_root(&resolved), dir);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn selected_python_kernel_completes_protocol_handshake() {
        let Ok(python_path) = std::env::var("SEAMIND_TEST_PYTHON") else {
            return;
        };
        let proc = spawn_verified_kernel_process(&python_path, None, None)
            .await
            .expect("selected Python should start");
        let shared = Arc::new(tokio::sync::Mutex::new(proc));
        let ready = send_kernel_request(
            &shared,
            serde_json::json!({ "id": "ready", "op": "vars" }),
        )
        .await;
        let execution = send_kernel_request(
            &shared,
            serde_json::json!({ "id": "exec", "op": "exec", "code": "print('seamind-kernel-ready')" }),
        )
        .await;
        {
            let mut guard = shared.lock().await;
            kill_process_tree(guard.pid, &mut guard.child);
        }
        assert!(ready.expect("handshake should respond").ok);
        let output = execution.expect("execution should respond");
        assert!(output.ok);
        assert!(output.stdout.contains("seamind-kernel-ready"));
    }
}
