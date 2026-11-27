import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import type { DataBusInfo, PythonEnvInfo, REnvInfo } from './terminal-api';
import {
  DEFAULT_PYTHON_STABLE_LIBS,
  DEFAULT_R_STABLE_LIBS,
  type DataLabBaseProfile,
  type DataLabCustomEnvPaths,
  type DataLabDbConnection,
} from './terminal-codelab-model';

interface CodeLabEnvPanelProps {
  pythonEnvs: PythonEnvInfo[];
  rEnvs: REnvInfo[];
  dbConnections: DataLabDbConnection[];
  baseProfile: DataLabBaseProfile;
  busInfo?: DataBusInfo | null;
  selectedPythonPath: string;
  selectedRPath: string;
  customEnvPaths: DataLabCustomEnvPaths;
  loading?: boolean;
  onRefresh: () => void;
  onRefreshBus?: () => void;
  onSaveBaseProfile: (next: DataLabBaseProfile) => void;
  onSelectPythonRuntime: (runtime: string) => void;
  onSelectRRuntime: (rscriptPath: string) => void;
  onActivateInTerminal: (command: string) => void;
  onUpdateCustomEnvPaths: (next: DataLabCustomEnvPaths) => void;
}

function collectPythonPkgTags(env: PythonEnvInfo): string[] {
  const tags: string[] = [];
  if (env.hasPandas) tags.push('pandas');
  if (env.hasDuckdb) tags.push('duckdb');
  if (env.hasPyarrow) tags.push('pyarrow');
  if (env.hasPolars) tags.push('polars');
  if (env.hasNumpy) tags.push('numpy');
  if (env.hasMatplotlib) tags.push('matplotlib');
  if (env.hasSqlalchemy) tags.push('sqlalchemy');
  if (env.hasScipy) tags.push('scipy');
  if (env.hasPsycopg) tags.push('psycopg');
  if (env.hasPymysql) tags.push('pymysql');
  return tags;
}

function collectRPkgTags(env: REnvInfo): string[] {
  const tags: string[] = [];
  if (env.hasTidyverse) tags.push('tidyverse');
  if (env.hasGgplot2) tags.push('ggplot2');
  if (env.hasDataTable) tags.push('data.table');
  if (env.hasArrow) tags.push('arrow');
  if (env.hasDuckdb) tags.push('duckdb');
  if (env.hasDbi) tags.push('DBI');
  if (env.hasRpostgres) tags.push('RPostgres');
  return tags;
}

function isPythonLibInstalled(
  env: PythonEnvInfo | undefined,
  lib: string,
): boolean | null {
  if (!env) return null;
  switch (lib.toLowerCase()) {
    case 'pandas':
      return env.hasPandas;
    case 'numpy':
      return env.hasNumpy;
    case 'pyarrow':
      return env.hasPyarrow;
    case 'duckdb':
      return env.hasDuckdb;
    case 'matplotlib':
      return env.hasMatplotlib;
    case 'scipy':
      return env.hasScipy;
    case 'sqlalchemy':
      return env.hasSqlalchemy;
    case 'polars':
      return env.hasPolars;
    default:
      return null;
  }
}

function isRLibInstalled(
  env: REnvInfo | undefined,
  lib: string,
): boolean | null {
  if (!env) return null;
  switch (lib.toLowerCase()) {
    case 'tidyverse':
      return env.hasTidyverse;
    case 'ggplot2':
      return env.hasGgplot2;
    case 'data.table':
      return env.hasDataTable;
    case 'arrow':
      return env.hasArrow;
    case 'dbi':
      return env.hasDbi;
    case 'duckdb':
      return env.hasDuckdb;
    default:
      return null;
  }
}

export function CodeLabEnvPanel({
  pythonEnvs,
  rEnvs,
  dbConnections,
  baseProfile,
  busInfo,
  selectedPythonPath,
  selectedRPath,
  customEnvPaths,
  loading = false,
  onRefresh,
  onRefreshBus,
  onSaveBaseProfile,
  onSelectPythonRuntime,
  onSelectRRuntime,
  onActivateInTerminal,
  onUpdateCustomEnvPaths,
}: CodeLabEnvPanelProps) {
  const [pyPathDraft, setPyPathDraft] = useState(baseProfile.pythonPath);
  const [rPathDraft, setRPathDraft] = useState(baseProfile.rscriptPath);
  const [showDiscovered, setShowDiscovered] = useState(
    !baseProfile.pythonPath && !baseProfile.rscriptPath,
  );

  useEffect(() => {
    setPyPathDraft(baseProfile.pythonPath);
  }, [baseProfile.pythonPath]);

  useEffect(() => {
    setRPathDraft(baseProfile.rscriptPath);
  }, [baseProfile.rscriptPath]);

  const pinnedPyEnv = pythonEnvs.find(
    (e) =>
      baseProfile.pythonPath &&
      e.pythonPath.toLowerCase() === baseProfile.pythonPath.toLowerCase(),
  );
  const pinnedREnv = rEnvs.find(
    (e) =>
      baseProfile.rscriptPath &&
      e.rscriptPath.toLowerCase() === baseProfile.rscriptPath.toLowerCase(),
  );

  const pinPythonBase = (path: string, label?: string) => {
    const clean = path.trim();
    const nextProfile: DataLabBaseProfile = {
      ...baseProfile,
      pythonPath: clean,
      pythonLabel: label || undefined,
      updatedAt: Date.now(),
    };
    onSaveBaseProfile(nextProfile);
    if (clean) {
      onSelectPythonRuntime(clean);
      if (clean !== 'pyodide' && !customEnvPaths.pythonPaths.includes(clean)) {
        onUpdateCustomEnvPaths({
          ...customEnvPaths,
          pythonPaths: [...customEnvPaths.pythonPaths, clean],
        });
      }
    }
  };

  const pinRBase = (path: string, label?: string) => {
    const clean = path.trim();
    const nextProfile: DataLabBaseProfile = {
      ...baseProfile,
      rscriptPath: clean,
      rLabel: label || undefined,
      updatedAt: Date.now(),
    };
    onSaveBaseProfile(nextProfile);
    if (clean) {
      onSelectRRuntime(clean);
      if (!customEnvPaths.rPaths.includes(clean)) {
        onUpdateCustomEnvPaths({
          ...customEnvPaths,
          rPaths: [...customEnvPaths.rPaths, clean],
        });
      }
    }
  };

  const inferEnvBadgeName = (rawPath: string) => {
    const clean = rawPath.trim().replace(/[\\/]+$/, '');
    if (!clean) return '';
    const parts = clean.split(/[\\/]/).filter(Boolean);
    const last = parts[parts.length - 1] ?? '';
    if (/^(python|rscript)(\.exe)?$/i.test(last)) {
      const parent = parts[parts.length - 2] ?? '';
      if (/^(scripts|bin|x64)$/i.test(parent)) {
        const grand = parts[parts.length - 3] ?? '';
        return /^(bin)$/i.test(grand)
          ? (parts[parts.length - 4] ?? parent)
          : grand || parent;
      }
      return parent || last;
    }
    return last;
  };

  const handleBrowseBasePython = async (directory = false) => {
    try {
      const selected = await open({
        multiple: false,
        directory,
        title: directory
          ? '选择 Conda / venv 虚拟环境目录（运行时自动激活）'
          : '指定默认 Python / Anaconda 基座解释器 (python.exe)',
        filters: directory
          ? undefined
          : [{ name: 'Python', extensions: ['exe', '*'] }],
      });
      if (typeof selected === 'string' && selected) {
        setPyPathDraft(selected);
        pinPythonBase(selected);
      }
    } catch {
      // ignore cancel
    }
  };

  const handleBrowseBaseR = async (directory = false) => {
    try {
      const selected = await open({
        multiple: false,
        directory,
        title: directory
          ? '选择 R 安装目录或 Conda-R 环境目录（运行时自动激活）'
          : '指定默认 R 基座解释器 (Rscript.exe)',
        filters: directory
          ? undefined
          : [{ name: 'Rscript', extensions: ['exe', '*'] }],
      });
      if (typeof selected === 'string' && selected) {
        setRPathDraft(selected);
        pinRBase(selected);
      }
    } catch {
      // ignore cancel
    }
  };

  const pyBaselineLibs =
    baseProfile.preferredPythonLibs.length > 0
      ? baseProfile.preferredPythonLibs
      : [...DEFAULT_PYTHON_STABLE_LIBS];
  const rBaselineLibs =
    baseProfile.preferredRLibs.length > 0
      ? baseProfile.preferredRLibs
      : [...DEFAULT_R_STABLE_LIBS];

  const missingPyLibs = pyBaselineLibs.filter(
    (lib) => isPythonLibInstalled(pinnedPyEnv, lib) === false,
  );
  const missingRLibs = rBaselineLibs.filter(
    (lib) => isRLibInstalled(pinnedREnv, lib) === false,
  );

  const installPyCmd =
    baseProfile.pythonPath && baseProfile.pythonPath !== 'pyodide'
      ? `& "${baseProfile.pythonPath}" -m pip install -U ${(missingPyLibs.length > 0 ? missingPyLibs : pyBaselineLibs).join(' ')}`
      : `pip install -U ${pyBaselineLibs.join(' ')}`;

  const installRCmd = baseProfile.rscriptPath
    ? `& "${baseProfile.rscriptPath}" -e "install.packages(c(${(missingRLibs.length > 0 ? missingRLibs : rBaselineLibs).map((l) => `'${l}'`).join(', ')}), repos='https://cloud.r-project.org')"`
    : '';

  return (
    <div className="datalab-panel">
      {/* Section 0: User-Designated Permanent Base Foundation */}
      <div className="datalab-section">
        <div className="datalab-section-head">
          <span>默认分析基座</span>
          <span className="datalab-base-pill">永久生效</span>
        </div>

        <div className="datalab-base-card">
          <div className="datalab-base-desc">
            指定后，Notebook（SQL/Python/R）与 Agent/CLI
            每次启动都会默认固定使用这组基座环境。
          </div>

          {/* Base Python */}
          <div className="datalab-base-field">
            <div className="datalab-base-field-head">
              <strong>Python 基座</strong>
              <span
                className={`datalab-base-state${baseProfile.pythonPath && baseProfile.pythonPath !== 'pyodide' ? ' is-ready' : ''}`}
              >
                {baseProfile.pythonPath
                  ? baseProfile.pythonPath === 'pyodide'
                    ? 'Pyodide'
                    : `自动激活 · ${pinnedPyEnv?.condaEnvName || inferEnvBadgeName(baseProfile.pythonPath) || '已固定'}`
                  : '未指定'}
              </span>
            </div>
            <div className="datalab-file-picker-row">
              <input
                type="text"
                className="terminal-rail-search"
                value={pyPathDraft}
                onChange={(e) => setPyPathDraft(e.target.value)}
                onBlur={() => {
                  if (pyPathDraft.trim() !== baseProfile.pythonPath) {
                    pinPythonBase(pyPathDraft);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    pinPythonBase(pyPathDraft);
                  }
                }}
                placeholder="Conda/venv 目录或 python.exe（自动激活）"
                aria-label="默认 Python 基座路径"
              />
              <button
                type="button"
                className="terminal-rail-mini-btn"
                onClick={() => void handleBrowseBasePython(true)}
                title="选择 Conda 或 venv 虚拟环境文件夹"
              >
                目录
              </button>
              <button
                type="button"
                className="terminal-rail-mini-btn is-accent"
                onClick={() => void handleBrowseBasePython(false)}
                title="选择本地 python.exe 文件"
              >
                文件
              </button>
            </div>
          </div>

          {/* Base R */}
          <div className="datalab-base-field">
            <div className="datalab-base-field-head">
              <strong>R 语言基座</strong>
              <span
                className={`datalab-base-state${baseProfile.rscriptPath ? ' is-ready' : ''}`}
              >
                {baseProfile.rscriptPath
                  ? `自动激活 · ${pinnedREnv?.version ? `R ${pinnedREnv.version}` : inferEnvBadgeName(baseProfile.rscriptPath) || '已固定'}`
                  : '未指定'}
              </span>
            </div>
            <div className="datalab-file-picker-row">
              <input
                type="text"
                className="terminal-rail-search"
                value={rPathDraft}
                onChange={(e) => setRPathDraft(e.target.value)}
                onBlur={() => {
                  if (rPathDraft.trim() !== baseProfile.rscriptPath) {
                    pinRBase(rPathDraft);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    pinRBase(rPathDraft);
                  }
                }}
                placeholder="R/Conda 目录或 Rscript.exe（自动激活）"
                aria-label="默认 Rscript 基座路径"
              />
              <button
                type="button"
                className="terminal-rail-mini-btn"
                onClick={() => void handleBrowseBaseR(true)}
                title="选择 R 安装目录或 Conda-R 目录"
              >
                目录
              </button>
              <button
                type="button"
                className="terminal-rail-mini-btn is-accent"
                onClick={() => void handleBrowseBaseR(false)}
                title="选择本地 Rscript.exe 文件"
              >
                文件
              </button>
            </div>
          </div>

          {/* Base DB Connection */}
          <div className="datalab-base-field">
            <div className="datalab-base-field-head">
              <strong>默认 SQL 数据源</strong>
              <span className="datalab-base-state is-ready">
                {baseProfile.defaultConnectionId
                  ? '已绑定数据库'
                  : 'DuckDB / 挂载文件'}
              </span>
            </div>
            <select
              className="terminal-rail-search datalab-base-select"
              value={baseProfile.defaultConnectionId}
              onChange={(e) =>
                onSaveBaseProfile({
                  ...baseProfile,
                  defaultConnectionId: e.target.value,
                  updatedAt: Date.now(),
                })
              }
              aria-label="默认 SQL 数据源"
            >
              <option value="">本地挂载文件 + 会话总线 (DuckDB)</option>
              {dbConnections.map((conn) => (
                <option key={conn.id} value={conn.id}>
                  [{conn.dbType.toUpperCase()}] {conn.name}
                </option>
              ))}
            </select>
          </div>

          {/* Baseline Libraries Checklist */}
          <div className="datalab-base-field">
            <div className="datalab-base-field-head">
              <strong>基座稳定库检查</strong>
              <div className="datalab-head-btns">
                <button
                  type="button"
                  className="terminal-rail-mini-btn"
                  onClick={() => onActivateInTerminal(installPyCmd)}
                  title="在终端安装/升级基座 Python 稳定分析库"
                >
                  补齐 Py 库
                </button>
                {installRCmd && (
                  <button
                    type="button"
                    className="terminal-rail-mini-btn"
                    onClick={() => onActivateInTerminal(installRCmd)}
                    title="在终端安装基座 R 统计绘图库"
                  >
                    补齐 R 库
                  </button>
                )}
              </div>
            </div>
            <div className="datalab-pkg-tags">
              {pyBaselineLibs.map((lib) => {
                const st = isPythonLibInstalled(pinnedPyEnv, lib);
                return (
                  <span
                    key={`py-${lib}`}
                    className={`datalab-pkg-tag${st === true ? ' is-ok' : st === false ? ' is-miss' : ''}`}
                    title={
                      st === true
                        ? `${lib} 已就绪`
                        : st === false
                          ? `${lib} 未在当前基座检出`
                          : `${lib}（点击下方扫描验证）`
                    }
                  >
                    {lib}
                  </span>
                );
              })}
            </div>
            <div className="datalab-pkg-tags">
              {rBaselineLibs.map((lib) => {
                const st = isRLibInstalled(pinnedREnv, lib);
                return (
                  <span
                    key={`r-${lib}`}
                    className={`datalab-pkg-tag${st === true ? ' is-ok' : st === false ? ' is-miss' : ''}`}
                    title={
                      st === true
                        ? `R · ${lib} 已就绪`
                        : st === false
                          ? `R · ${lib} 未检出`
                          : `R · ${lib}`
                    }
                  >
                    R:{lib}
                  </span>
                );
              })}
            </div>
          </div>

          {/* Session Shared Bus Status */}
          <div className="datalab-bus-status">
            <div className="datalab-base-field-head">
              <strong>跨语言共享总线</strong>
              {onRefreshBus && (
                <button
                  type="button"
                  className="terminal-rail-mini-btn"
                  onClick={onRefreshBus}
                  title="刷新共享总线中的中间表与图表产物"
                >
                  刷新总线
                </button>
              )}
            </div>
            <div className="datalab-path-caption">
              共享表 {busInfo?.tables.length ?? 0} 张 · 图表产物{' '}
              {busInfo?.artifacts.length ?? 0} 份 · 支持 <code>sm_load()</code>{' '}
              / <code>sm_save()</code> / <code>sm_sql()</code>
            </div>
            {busInfo && busInfo.tables.length > 0 && (
              <div className="datalab-pkg-tags">
                {busInfo.tables.slice(0, 8).map((tbl) => (
                  <span
                    key={tbl.path}
                    className="datalab-pkg-tag is-ok"
                    title={tbl.path}
                  >
                    {tbl.name}.{tbl.format}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Section 1: Optional Manual Scan Helper */}
      <div className="datalab-section">
        <div className="datalab-section-head">
          <span>辅助扫描本机环境</span>
          <div className="datalab-head-btns">
            <button
              type="button"
              className="terminal-rail-mini-btn"
              onClick={() => {
                setShowDiscovered(true);
                onRefresh();
              }}
              disabled={loading}
              title="按需扫描本机 Anaconda / Python / R，扫描不会覆盖你已固定的基座"
            >
              {loading ? '扫描中…' : '扫描本机'}
            </button>
            <button
              type="button"
              className="terminal-rail-mini-btn"
              onClick={() => setShowDiscovered((v) => !v)}
            >
              {showDiscovered ? '收起' : '展开'}
            </button>
          </div>
        </div>

        {showDiscovered && (
          <>
            <div className="datalab-card-list">
              <div
                className={`datalab-card${selectedPythonPath === 'pyodide' ? ' is-selected' : ''}`}
              >
                <div className="datalab-card-head is-static">
                  <span className="datalab-fmt-badge">WASM</span>
                  <strong className="datalab-card-name">
                    Pyodide 内置沙盒
                  </strong>
                </div>
                <div className="datalab-path-caption">
                  零配置浏览器隔离环境 · 适合轻量算法验证
                </div>
                <div className="datalab-card-actions">
                  <button
                    type="button"
                    className={`terminal-rail-mini-btn${selectedPythonPath === 'pyodide' ? ' is-accent' : ''}`}
                    onClick={() => onSelectPythonRuntime('pyodide')}
                  >
                    {selectedPythonPath === 'pyodide'
                      ? '当前临时内核'
                      : '临时切换'}
                  </button>
                </div>
              </div>

              {pythonEnvs.map((env) => {
                const isPinned =
                  baseProfile.pythonPath.toLowerCase() ===
                  env.pythonPath.toLowerCase();
                const isSelected = selectedPythonPath === env.pythonPath;
                const pkgs = collectPythonPkgTags(env);
                const badge =
                  env.envType === 'conda'
                    ? 'CONDA'
                    : env.envType === 'venv'
                      ? 'VENV'
                      : env.envType === 'custom'
                        ? 'CUSTOM'
                        : 'SYS';
                return (
                  <div
                    key={env.id}
                    className={`datalab-card${isPinned || isSelected ? ' is-selected' : ''}`}
                  >
                    <div className="datalab-card-head is-static">
                      <span className="datalab-fmt-badge">{badge}</span>
                      <strong className="datalab-card-name" title={env.label}>
                        {env.label}
                      </strong>
                      {env.version && (
                        <span className="datalab-card-meta">
                          v{env.version}
                        </span>
                      )}
                    </div>

                    <div
                      className="datalab-path-caption"
                      title={env.pythonPath}
                    >
                      {env.pythonPath}
                    </div>

                    {pkgs.length > 0 && (
                      <div className="datalab-pkg-tags">
                        {pkgs.map((pkg) => (
                          <span key={pkg} className="datalab-pkg-tag">
                            {pkg}
                          </span>
                        ))}
                      </div>
                    )}

                    <div className="datalab-card-actions">
                      <button
                        type="button"
                        className={`terminal-rail-mini-btn${isPinned ? ' is-accent' : ''}`}
                        onClick={() => pinPythonBase(env.pythonPath, env.label)}
                      >
                        {isPinned ? '✓ 默认基座' : '设为基座'}
                      </button>
                      {env.condaEnvName && (
                        <button
                          type="button"
                          className="terminal-rail-mini-btn"
                          onClick={() =>
                            onActivateInTerminal(
                              `conda activate ${env.condaEnvName}`,
                            )
                          }
                          title={`在终端执行 conda activate ${env.condaEnvName}`}
                        >
                          终端激活
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}

              {rEnvs.map((env) => {
                const isPinned =
                  baseProfile.rscriptPath.toLowerCase() ===
                  env.rscriptPath.toLowerCase();
                const isSelected = selectedRPath === env.rscriptPath;
                const pkgs = collectRPkgTags(env);
                return (
                  <div
                    key={env.id}
                    className={`datalab-card${isPinned || isSelected ? ' is-selected' : ''}`}
                  >
                    <div className="datalab-card-head is-static">
                      <span className="datalab-fmt-badge">
                        {env.envType === 'conda' ? 'CONDA-R' : 'R'}
                      </span>
                      <strong className="datalab-card-name" title={env.label}>
                        {env.label}
                      </strong>
                      {env.version && (
                        <span className="datalab-card-meta">
                          v{env.version}
                        </span>
                      )}
                    </div>

                    <div
                      className="datalab-path-caption"
                      title={env.rscriptPath}
                    >
                      {env.rscriptPath}
                    </div>

                    {pkgs.length > 0 && (
                      <div className="datalab-pkg-tags">
                        {pkgs.map((pkg) => (
                          <span key={pkg} className="datalab-pkg-tag">
                            {pkg}
                          </span>
                        ))}
                      </div>
                    )}

                    <div className="datalab-card-actions">
                      <button
                        type="button"
                        className={`terminal-rail-mini-btn${isPinned ? ' is-accent' : ''}`}
                        onClick={() => pinRBase(env.rscriptPath, env.label)}
                      >
                        {isPinned ? '✓ R 默认基座' : '设为 R 基座'}
                      </button>
                      <button
                        type="button"
                        className="terminal-rail-mini-btn"
                        onClick={() =>
                          onActivateInTerminal(
                            `& "${env.rscriptPath}" --version`,
                          )
                        }
                        title="在终端测试此 Rscript 版本"
                      >
                        终端验证
                      </button>
                    </div>
                  </div>
                );
              })}

              {pythonEnvs.length === 0 && rEnvs.length === 0 && (
                <div className="terminal-rail-empty-hint">
                  点击上方「扫描本机」发现已安装的 Anaconda / Python /
                  R，或直接在「默认分析基座」中手动指定路径。
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
