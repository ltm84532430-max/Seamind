import type { LinuxCheatItem, KnowledgeActionItem } from './terminal-types';

export const LINUX_CHEAT_ITEMS: readonly LinuxCheatItem[] = [
  // 1. 文件与权限系统 (fs)
  {
    id: 'fs-ls',
    cmd: 'ls -lah',
    category: 'fs',
    categoryLabel: '文件与目录',
    title: '全量详细列表',
    explanation: '-l 详细列表，-a 显示隐藏文件，-h 人性化文件大小 (KB/MB)。',
    practicalScenario:
      '快速排查当前工作目录下的隐藏配置文件 (.config, .bashrc) 及所有权。',
  },
  {
    id: 'fs-find',
    cmd: 'find . -type f -name "*.md" -size +10k',
    category: 'fs',
    categoryLabel: '文件与目录',
    title: '深度检索指定文件',
    explanation: '-type f 限制普通文件，-name 支持通配符，-size 过滤尺寸。',
    practicalScenario: '在庞大的知识库与笔记库中快速检索大型 Markdown 文档。',
  },
  {
    id: 'fs-chmod',
    cmd: 'chmod 755 run.sh && chmod 600 config.json',
    category: 'fs',
    categoryLabel: '文件与目录',
    title: '权限八进制控制',
    explanation:
      '755=rwxr-xr-x (所有者完全，其余读执行)；600=rw------- (私密文件仅所有者可读写)。',
    practicalScenario:
      '脚本执行提权与私有会话凭据安全配置（如 Z-Library session.json）。',
  },
  {
    id: 'fs-du',
    cmd: 'du -sh * | sort -hr | head -n 10',
    category: 'fs',
    categoryLabel: '文件与目录',
    title: '磁盘目录占用分析',
    explanation: 'du 统计占用，sort -hr 逆向数值排序，获取前 10 大文件或目录。',
    practicalScenario: '排查电子书、音视频缓存或 node_modules 膨胀空间。',
  },

  // 2. 文本三剑客 (text)
  {
    id: 'text-grep',
    cmd: 'grep -rnI --color=auto "TODO\\|FIXME" ./src',
    category: 'text',
    categoryLabel: '文本三剑客',
    title: '递归检索文本特征',
    explanation: '-r 递归子目录，-n 显示行号，-I 自动跳过二进制文件。',
    practicalScenario: '在代码库或笔记库中精准定位未完成项与核心概念引用。',
  },
  {
    id: 'text-awk',
    cmd: "awk -F':' '{print $1, $3, $6}' /etc/passwd",
    category: 'text',
    categoryLabel: '文本三剑客',
    title: '列提取与格式化输出',
    explanation: '-F 指定分隔符，print $1 $3 输出第 1、3 列数据。',
    practicalScenario: 'Linux 用户账户分析与结构化日志字段截取。',
  },
  {
    id: 'text-sed',
    cmd: "sed -i 's/OLD_HOST/NEW_HOST/g' config.yaml",
    category: 'text',
    categoryLabel: '文本三剑客',
    title: '流编辑器批量替换',
    explanation: '-i 直接修改原文件，s/原文本/新文本/g 全局替换。',
    practicalScenario: '自动化配置环境切换与批量文本规范化对齐。',
  },

  // 3. 进程与系统诊断 (proc)
  {
    id: 'proc-ps',
    cmd: 'ps aux | grep node',
    category: 'proc',
    categoryLabel: '进程与监控',
    title: '进程全景与管道过滤',
    explanation: 'a 显示所有进程，u 详细用户指标，x 包括无终端进程。',
    practicalScenario: '排查后台常驻服务、僵尸进程与高占用进程号 PID。',
  },
  {
    id: 'proc-lsof',
    cmd: 'lsof -i :1420',
    category: 'proc',
    categoryLabel: '进程与监控',
    title: '端口占用排查',
    explanation: '列出指定网络端口当前绑定的进程与其 PID。',
    practicalScenario:
      '开发服务器端口冲突排查（如 Vite 1420 或 MCP 服务端口）。',
  },
  {
    id: 'proc-htop',
    cmd: 'top -b -n 1 | head -n 20',
    category: 'proc',
    categoryLabel: '进程与监控',
    title: 'CPU 与内存实时负载',
    explanation: '-b 批处理模式，-n 刷新次数，适合快速抓取系统负荷快照。',
    practicalScenario: '在 Linux 实验中观测程序多线程或算法运算时的资源开销。',
  },

  // 4. 网络诊断与排错 (net)
  {
    id: 'net-curl',
    cmd: 'curl -Iv https://z-lib.gd',
    category: 'net',
    categoryLabel: '网络与排错',
    title: 'HTTP 协议握手与头分析',
    explanation: '-I 仅拉取响应头，-v 输出详细 TLS 握手与 DNS 解析过程。',
    practicalScenario:
      '排查在线服务连通性、301/302 重定向回路与 SSL 证书状态。',
  },
  {
    id: 'net-ss',
    cmd: 'ss -tulwn',
    category: 'net',
    categoryLabel: '网络与排错',
    title: '套接字监听状态速查',
    explanation: '-t TCP, -u UDP, -l 监听态, -w RAW, -n 数字端口展示。',
    practicalScenario:
      '验证本地代理 (127.0.0.1:7890) 或内置服务端口监听健康度。',
  },

  // 5. 系统级诊断与排查 (sys)
  {
    id: 'sys-journal',
    cmd: 'journalctl -xe --no-pager -n 50',
    category: 'sys',
    categoryLabel: '系统级诊断',
    title: 'systemd 日志快速排查',
    explanation: '-x 包含附加说明，-e 跳至末尾，-n 显示最新条数。',
    practicalScenario: '排查 Linux 系统服务启动崩溃或硬件错误事件。',
  },
  {
    id: 'sys-strace',
    cmd: 'strace -c ls',
    category: 'sys',
    categoryLabel: '系统级诊断',
    title: '系统调用性能统计',
    explanation:
      '-c 统计每个系统调用 (open, read, write) 消耗的时间与调用次数。',
    practicalScenario: '深入理解 Linux 操作系统内核调度与 IO 执行成本。',
  },
];

export const KNOWLEDGE_ACTION_ITEMS: readonly KnowledgeActionItem[] = [
  // 1. 知识库联动
  {
    id: 'act-kb-list',
    category: 'kb',
    categoryBadge: 'KB',
    targetWorkspace: '知识库',
    title: '检索知识库特定分类文件',
    commandTemplate:
      'Get-ChildItem -Path . -Recurse -Filter "*.md" | Select-Object Name, Length, LastWriteTime',
    description: '在当前文件库目录下快速列出所有 Markdown 笔记文件元数据。',
  },
  {
    id: 'act-kb-append',
    category: 'kb',
    categoryBadge: 'KB',
    targetWorkspace: '知识库',
    title: '向当前学习笔记追加复习总结',
    commandTemplate:
      'Add-Content -Path "计算机网络复习.md" -Value "`n### 今日攻坚总结`n- 完成传输层滑动窗口协议与拥塞控制理论验证。"',
    description: '通过终端重定向或追加命令无缝为知识库笔记补充实验结论。',
  },

  // 2. 思维导图联动
  {
    id: 'act-map-inspect',
    category: 'map',
    categoryBadge: 'MAP',
    targetWorkspace: '思维导图',
    title: '提取导图文档的大纲层级结构',
    commandTemplate:
      'Select-String -Path "*.md" -Pattern "^#+\\s" | Select-Object Filename, LineNumber, Line',
    description: '从导图源文件中提取所有标题节点，快速校验思维导图骨架层级。',
  },

  // 3. 试卷与复习联动
  {
    id: 'act-exam-review',
    category: 'exam',
    categoryBadge: 'EXAM',
    targetWorkspace: '试卷与复习',
    title: '生成特定章节代码自测练习',
    commandTemplate: 'gcc -Wall -O2 test.c -o test && ./test',
    description:
      '在终端中现场编译运行《C Primer Plus》章节练习题源码，验证逻辑。',
  },

  // 4. 智能体 Agent 联动
  {
    id: 'act-agent-review',
    category: 'agent',
    categoryBadge: 'AGENT',
    targetWorkspace: '全应用联动',
    title: '调用 AGY 智能体校准知识库与导图',
    commandTemplate:
      'agy "检查当前工作区笔记与导图结构，补充 Linux 权限系统要点并对齐格式"',
    description:
      '通过注入 Seamind MCP 的 Google AGY CLI 执行跨界面自动化知识校验。',
  },
];
