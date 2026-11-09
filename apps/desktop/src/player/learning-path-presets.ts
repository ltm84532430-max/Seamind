import type { LearningPathInput } from './types';

export const HACKER_CONSTELLATION_PATH_ID =
  'hacker-offensive-sec-constellation';

export interface AcademicEngineeringBlueprint {
  id: string;
  tag: string;
  title: string;
  academicBenchmarks: string;
  engineeringTargets: string;
  searchKeywords: string[];
  prompt: string;
}

/**
 * Curated institutional prompt blueprints that combine top-tier university courses
 * (MIT, CMU, Stanford, UC Berkeley, ETH, ASU pwn.college) with industrial source-code
 * dissection, debugging toolchains, and systems engineering labs.
 */
export const ACADEMIC_ENGINEERING_PROMPT_BLUEPRINTS: AcademicEngineeringBlueprint[] =
  [
    {
      id: 'os-kernel-ebpf',
      tag: 'OS × KERNEL',
      title: '操作系统与 Linux 内核源码工程',
      academicBenchmarks:
        'MIT 6.S081 (xv6) · CMU 15-213 (CS:APP) · UC Berkeley CS162',
      engineeringTargets:
        'Linux mm/sched/vfs 源码剖析 · QEMU+GDB 内核联调 · eBPF/XDP 可观测性',
      searchKeywords: [
        'MIT 6.S081 Operating Systems lecture',
        'CMU 15-213 CSAPP virtual memory exceptions',
        'Linux kernel memory management page table source code',
        'Linux scheduler CFS RCU lockless kernel internals',
        'QEMU GDB Linux kernel debugging syscalls',
        'eBPF XDP kprobe tracing Linux kernel engineering',
      ],
      prompt:
        '操作系统与 Linux 内核工程（学术对标：MIT 6.S081 Operating Systems Engineering、CMU 15-213 CS:APP、UC Berkeley CS162；工程落地：xv6 与 Linux Kernel 源码剖析、虚拟内存四级页表与 Slab/SLUB 分配器、CFS/EEVDF 进程调度器与 RCU 并发原语、VFS 文件系统与 Page Cache、QEMU+GDB 内核态源码联调、eBPF/kprobe 内核追踪与性能剖析）',
    },
    {
      id: 'distributed-storage-db',
      tag: 'DIST × STORAGE',
      title: '分布式系统与数据库存储引擎',
      academicBenchmarks:
        'MIT 6.824 / 6.5840 · CMU 15-445 / 15-721 (Andy Pavlo) · DDIA',
      engineeringTargets:
        'Raft/Paxos 工业实现 · RocksDB LSM-Tree · MVCC 事务隔离 · 分布式共识容错',
      searchKeywords: [
        'MIT 6.824 Distributed Systems Raft Paxos lecture',
        'CMU 15-445 Andy Pavlo database storage engine B+tree LSM',
        'CMU 15-721 MVCC concurrency control query execution',
        'RocksDB LSM tree compaction WAL memtable internals',
        'Designing Data Intensive Applications replication partitioning',
        'Jepsen distributed consensus linearizability fault tolerance',
      ],
      prompt:
        '分布式系统与数据库存储引擎（学术对标：MIT 6.824/6.5840 Distributed Systems、CMU 15-445/15-721 Database Systems、Martin Kleppmann DDIA；工程落地：Raft/Paxos 共识状态机实现与脑裂容错、B+Tree 与 RocksDB LSM-Tree 源码剖析、WAL 预写日志与 ARIES 崩溃恢复、MVCC 多版本并发控制与可串行化隔离、两阶段提交 2PC/Spanner TrueTime 与分布式压测调优）',
    },
    {
      id: 'offensive-sec-pwn',
      tag: 'SEC × PWN',
      title: '系统安全、逆向工程与二进制漏洞利用',
      academicBenchmarks:
        'MIT 6.858 Systems Security · ASU pwn.college · Christof Paar Cryptography',
      engineeringTargets:
        'Ghidra/GDB 逆向 · 栈/堆/内核 Pwn · AFL++ Fuzzing · USENIX/DEF CON 攻防',
      searchKeywords: [
        'MIT 6.858 Computer Systems Security lecture Zeldovich',
        'pwn.college binary exploitation assembly reverse engineering',
        'LiveOverflow binary exploitation heap ROP ptmalloc',
        'Christof Paar Understanding Cryptography AES RSA ECC',
        'Linux kernel exploitation SMEP KPTI eBPF container escape',
        'AFL++ LLVM sanitizer fuzzing symbolic execution angr',
      ],
      prompt:
        '系统安全、二进制逆向与漏洞工程（学术对标：MIT 6.858 Computer Systems Security、ASU pwn.college、Christof Paar 现代密码学；工程落地：x86-64/ARM64 汇编与 ELF 动态链接机制、Ghidra/IDA 静态反编译与 GDB/pwndbg 调试、栈溢出与 ROP 链构造、glibc ptmalloc 堆利用 UAF/Tcache Poisoning、Linux 内核态提权与容器逃逸、LLVM Sanitizer 与 AFL++ 覆盖率引导 Fuzzing）',
    },
    {
      id: 'compiler-llvm-pl',
      tag: 'PL × LLVM',
      title: '现代编译器、静态程序分析与 LLVM/MLIR',
      academicBenchmarks:
        'Stanford CS143 Compilers · Cornell CS6120 · 南京大学静态程序分析',
      engineeringTargets:
        'Lexer/Parser AST · SSA 数据流优化 · LLVM Pass 编写 · MLIR 与 JIT 虚拟机',
      searchKeywords: [
        'Stanford CS143 Compilers parsing type checking code generation',
        'LLVM IR SSA form compiler optimization pass tutorial',
        'Static program analysis dataflow pointer analysis abstract interpretation',
        'MLIR compiler infrastructure dialect lowering LLVM Dev Meeting',
        'JIT compiler V8 HotSpot garbage collection runtime internals',
        'Rust borrow checker type system compiler internals',
      ],
      prompt:
        '现代编译器、静态程序分析与语言运行时（学术对标：Stanford CS143 Compilers、Cornell CS6120 Advanced Compilers、南京大学软件分析课程；工程落地：词法/语法分析与 AST 构建、类型系统与 Hindley-Milner 类型推导、SSA 静态单赋值形式与控制流图 CFG、数据流分析与指针分析、LLVM IR 与自定义 Optimization Pass 开发、MLIR 多级中间表示、JIT 即时编译与分代 GC 运行时实现）',
    },
    {
      id: 'net-protocol-dpdk',
      tag: 'NET × HIGH-PERF',
      title: '计算机网络协议栈与高性能网关工程',
      academicBenchmarks:
        'Stanford CS144 Networking · 计算机网络自顶向下 · IETF RFC 核心规范',
      engineeringTargets:
        'Linux sk_buff 网络栈源码 · TCP 拥塞控制 BBR · Wireshark 抓包 · DPDK/io_uring',
      searchKeywords: [
        'Stanford CS144 Introduction to Computer Networking lecture',
        'TCP congestion control BBR CUBIC handshake RFC internals',
        'Linux network stack sk_buff NAPI epoll io_uring internals',
        'Wireshark packet analysis TLS 1.3 HTTP3 QUIC dissection',
        'DPDK XDP eBPF high performance packet processing bypass',
        'BGP OSPF anycast CDN load balancer architecture',
      ],
      prompt:
        '计算机网络协议栈与高性能网络工程（学术对标：Stanford CS144 Computer Networking、Kurose《自顶向下方法》、TCP/IP 详解与核心 RFC；工程落地：Wireshark 报文级抓包取证、TCP 滑动窗口与 BBR/CUBIC 拥塞控制算法源码、TLS 1.3 密码学握手与 QUIC/HTTP3 多路复用、Linux 内核 sk_buff/NAPI/epoll/io_uring 收发包链路、DPDK 用户态网卡旁路与 XDP 高吞吐网关设计）',
    },
    {
      id: 'ai-infra-cuda-llm',
      tag: 'AI × INFRA',
      title: '大模型底层系统、CUDA 算子与推理引擎工程',
      academicBenchmarks:
        'Stanford CS336 (LM from Scratch) · CMU 10-414 Deep Learning Systems · Karpathy',
      engineeringTargets:
        'Autograd 自动微分引擎 · CUDA/Triton GPU 算子 · FlashAttention · vLLM/分布式训练',
      searchKeywords: [
        'Andrej Karpathy neural networks zero to hero GPT tokenizer',
        'CMU Deep Learning Systems automatic differentiation GPU acceleration',
        'CUDA programming GPU memory hierarchy warp shared memory kernel',
        'FlashAttention KV cache PagedAttention vLLM inference optimization',
        'Distributed training ZeRO FSDP Megatron tensor pipeline parallelism',
        'Triton GPU kernel quantization AWQ FP8 inference engine',
      ],
      prompt:
        '大模型底层系统、GPU 算子优化与分布式推理工程（学术对标：Stanford CS336 Language Modeling from Scratch、CMU Deep Learning Systems、Andrej Karpathy Zero-to-Hero；工程落地：手写计算图与 Autograd 自动微分引擎、Transformer 架构与旋转位置编码 RoPE、GPU 硬件微架构与 CUDA/Triton 高性能算子编写、FlashAttention 显存 IO 优化、Megatron 3D 并行分布式训练、vLLM PagedAttention 与量化推理引擎部署）',
    },
  ];

/**
 * Compiles any user topic into an institutional Academic × Engineering Dual-Helix
 * prompt specification so both built-in AI and external CLI agents perform deep
 * multi-batch searches instead of shallow 1-query summaries.
 */
export function compileAcademicEngineeringPrompt(
  rawTopic: string,
  topologyMode: 'constellation' | 'linear' | 'radial',
  options?: {
    targetPathId?: string;
    targetPathTitle?: string;
    mode?: 'create' | 'append_nodes' | 'replace';
  },
): string {
  const topic = rawTopic.trim();
  const matchedBlueprint = ACADEMIC_ENGINEERING_PROMPT_BLUEPRINTS.find(
    (bp) =>
      topic.includes(bp.title) ||
      bp.prompt === topic ||
      topic.toLowerCase().includes(bp.id),
  );

  const benchmarkHint = matchedBlueprint
    ? `\n- 重点参考对标体系：学术基准（${matchedBlueprint.academicBenchmarks}）× 工程靶标（${matchedBlueprint.engineeringTargets}）\n- 推荐优先检索词批次：${matchedBlueprint.searchKeywords.map((q) => `"${q}"`).join('、')}`
    : `\n- 请自动推演该主题对应的顶尖高校公开课/经典教材（如 MIT / CMU / Stanford / UC Berkeley / ETH / 经典论文与 RFC），以及对应的工业级源码实现、调试工具链与实战 Lab。`;

  const topologyInstruction =
    topologyMode === 'constellation'
      ? '采用「Obsidian 多星域知识星图」拓扑：规划 6–9 个正交知识星域（kind="stage"），每个星域下配置 4–7 节真实视频课（总计 30–60+ 节点），并大量使用 prerequisiteIds 建立跨星域前置依赖网，在关键汇合处设置 kind="checkpoint" 里程碑节点。'
      : topologyMode === 'radial'
        ? '采用「向心辐射星图」拓扑：围绕核心底座规划 6–8 个辐射能力分支（kind="stage"），每个分支由浅入深挂载 4–6 节学术与工程视频节点，并用 prerequisiteIds 串联跨分支协同关系。'
        : '采用「全链路递进工程路径」拓扑：规划 6–8 个从底层理论基石、核心源码机制到高阶系统工程的递进阶段（kind="stage"），每个阶段配置 4–7 节视频与阶段里程碑（kind="checkpoint"），总计 30–55+ 节点。';

  if (options?.targetPathId && options?.mode === 'append_nodes') {
    return [
      `请先调用 learning_path_get 读取当前学习路径「${options.targetPathTitle ?? options.targetPathId}」（pathId: "${options.targetPathId}"）。`,
      topic
        ? `围绕扩充方向「${topic}」，按照「学术理论 × 底层工程双螺旋」准则对该路径进行大规模深度扩充：`
        : `按照「学术理论 × 底层工程双螺旋」准则，对当前路径进行大规模深度扩充（补齐名校理论公开课、底层源码剖析与硬核工程实验）：`,
      benchmarkHint,
      `1. 分多批次（至少 6–10 次调用 player_search_youtube，每次 limit: 20）正交检索：(a) MIT/CMU/Stanford 等名校公开课与形式化原理；(b) 底层源码剖析、协议栈/内核机制与 GDB/Wireshark/eBPF 调试；(c) 经典 Lab 实验与 USENIX/DEF CON/CppCon 等工业顶会演讲。`,
      `2. 严禁编造 videoId，严禁选用几分钟的营销科普短视频，优先挑选 25–180+ 分钟的体系化深度长视频。`,
      `3. 每个新增视频节点的 note 必须以【学术基座】、【工程实现】、【源码剖析】或【实验靶场】开头，并用顿号「、」列出 3–6 个核心底层技术概念（供星图自动渲染第三级知识卫星点），同时配置跨阶段 prerequisiteIds。`,
      `4. 调用 learning_path_propose（mode: "append_nodes" 或 "replace", pathId: "${options.targetPathId}"）提交预览弹窗。`,
    ].join('\n');
  }

  return [
    `请围绕主题「${topic}」，按照「学术理论基座 × 工业底层工程双螺旋」架构准则，构建一套庞大、硬核的可视化视频学习星图：`,
    benchmarkHint,
    `1. 【多批次正交检索（强制要求）】：必须分 6–10 个批次调用 player_search_youtube（每次 limit: 20），分别检索：`,
    `   - 学术维度：MIT / CMU / Stanford / UC Berkeley / ETH 等名校课程讲座、数学与算法形式化推导、RFC/论文精读；`,
    `   - 工程维度：源码级走读（Internals / Source code walkthrough）、底层调试（GDB / Wireshark / eBPF / perf）、经典高校 Lab 实验与工业顶会深度分享（USENIX / OSDI / DEF CON / Black Hat / CppCon）。`,
    `2. 【拓扑与体量要求】：${topologyInstruction} 严禁只生成十几个浅层入门视频，严禁编造 videoId。`,
    `3. 【三级知识卫星点标注】：每个视频节点的 note 必须以【学术基座】、【工程实现】、【源码剖析】或【实验靶场】开头，并用顿号「、」列出 3–6 个具体底层原语或工具术语（星图引擎会将其解析为环绕视频节点的第三级知识微粒点）。`,
    `4. 检索完成后调用 learning_path_propose（mode: "create"）提交预览弹窗等待确认。`,
  ].join('\n');
}

/**
 * Institutional 10-Domain, 64-Node (54 Videos + 10 Stages) Academic × Engineering
 * Offensive Security, Systems Internals & Binary Exploitation Constellation.
 */
export const HACKER_LEARNING_PATH_PRESET: LearningPathInput = {
  pathId: HACKER_CONSTELLATION_PATH_ID,
  title: '黑客与系统安全全链路星图（学术理论 × 底层工程 64 节点巨型图谱）',
  description:
    '融合 MIT 6.858 Computer Systems Security、ASU pwn.college、CMU 15-213 (CS:APP) 与 Christof Paar 密码学学术基座，结合 Linux 内核源码剖析、x86-64/ELF 逆向、glibc ptmalloc 堆利用、LLVM Fuzzing 模糊测试、eBPF 容器逃逸、OWASP Web 协议穿透与企业 AD 域控红蓝对抗的十大星域双螺旋知识体系。',
  videos: [
    // --- Stage 1: Systems Security Threat Modeling & Linux Kernel Privilege Base ---
    {
      videoId: '073D9t3ltEw',
      title:
        'MIT 6.858 Computer Systems Security Lec 1: Threat Models & Security Architecture',
      channelName: 'MIT OpenCourseWare',
      channelId: 'UCEBb1b_L6zDS3xTUrIALZOw',
      durationSeconds: 4740,
      thumbnailUrl: 'https://i.ytimg.com/vi/073D9t3ltEw/mqdefault.jpg',
    },
    {
      videoId: 'v392lEyM29A',
      title:
        'Linux for Ethical Hackers Full Course (Kali Linux & Terminal Architecture)',
      channelName: 'freeCodeCamp.org',
      channelId: 'UC8butISFwT-Wl7EV0hUK0BQ',
      durationSeconds: 19260,
      thumbnailUrl: 'https://i.ytimg.com/vi/v392lEyM29A/mqdefault.jpg',
    },
    {
      videoId: 'lZAoFs75_cs',
      title:
        'Linux DAC/MAC Permissions, SUID/SGID Bit & POSIX Capabilities Internals',
      channelName: 'NetworkChuck',
      channelId: 'UC9x0AN7BWHpCDHSm9NiJFJQ',
      durationSeconds: 1380,
      thumbnailUrl: 'https://i.ytimg.com/vi/lZAoFs75_cs/mqdefault.jpg',
    },
    {
      videoId: '2TofunAI6fU',
      title:
        'Linux Process Scheduling, /proc VFS, systemd Daemons & Auditd Forensics',
      channelName: 'David Bombal',
      channelId: 'UCP7WmQ_U4GB3K51Od9QvM0w',
      durationSeconds: 1980,
      thumbnailUrl: 'https://i.ytimg.com/vi/2TofunAI6fU/mqdefault.jpg',
    },
    {
      videoId: 'tK9Oc6AEnR4',
      title:
        'Bash & Python Offensive Automation: Concurrent Scanners & Payload Pipelines',
      channelName: 'John Hammond',
      channelId: 'UCVeW9qkBjo3zosnqUbG7CFw',
      durationSeconds: 2640,
      thumbnailUrl: 'https://i.ytimg.com/vi/tK9Oc6AEnR4/mqdefault.jpg',
    },
    {
      videoId: 'ZTnwg3qCdVM',
      title:
        'Linux Privilege Escalation Engineering: SUID, Capabilities, Sudo & Kernel Bugs',
      channelName: 'John Hammond',
      channelId: 'UCVeW9qkBjo3zosnqUbG7CFw',
      durationSeconds: 4320,
      thumbnailUrl: 'https://i.ytimg.com/vi/ZTnwg3qCdVM/mqdefault.jpg',
    },

    // --- Stage 2: Network Stack RFC Dissection, Packet Forensics & Global Recon ---
    {
      videoId: 'qiQR5rTSshw',
      title:
        'TCP/IP Protocol Stack, State Machine, ARP & Subnet Routing Internals',
      channelName: 'NetworkChuck',
      channelId: 'UC9x0AN7BWHpCDHSm9NiJFJQ',
      durationSeconds: 3120,
      thumbnailUrl: 'https://i.ytimg.com/vi/qiQR5rTSshw/mqdefault.jpg',
    },
    {
      videoId: 'bYV8f1b8A1I',
      title:
        'MIT 6.858 Network Security: TCP Sequence Prediction, BGP Hijacking & DNSSEC',
      channelName: 'MIT OpenCourseWare',
      channelId: 'UCEBb1b_L6zDS3xTUrIALZOw',
      durationSeconds: 4860,
      thumbnailUrl: 'https://i.ytimg.com/vi/bYV8f1b8A1I/mqdefault.jpg',
    },
    {
      videoId: '4t4kBkMsDbQ',
      title:
        'Nmap Raw Socket Scanning (-sS/-sA), OS Fingerprinting & NSE Lua Engine',
      channelName: 'NetworkChuck',
      channelId: 'UC9x0AN7BWHpCDHSm9NiJFJQ',
      durationSeconds: 2240,
      thumbnailUrl: 'https://i.ytimg.com/vi/4t4kBkMsDbQ/mqdefault.jpg',
    },
    {
      videoId: 'lb1Dw0elw0Q',
      title:
        'Wireshark Packet Dissection, TCP Reassembly & C2 Beacon Traffic Forensics',
      channelName: 'David Bombal',
      channelId: 'UCP7WmQ_U4GB3K51Od9QvM0w',
      durationSeconds: 3480,
      thumbnailUrl: 'https://i.ytimg.com/vi/lb1Dw0elw0Q/mqdefault.jpg',
    },
    {
      videoId: 'opRMrEfAIiI',
      title:
        'OSINT Infrastructure Mapping, ASN/BGP Recon, DNS Zone Transfer & CT Logs',
      channelName: 'freeCodeCamp.org',
      channelId: 'UC8butISFwT-Wl7EV0hUK0BQ',
      durationSeconds: 16200,
      thumbnailUrl: 'https://i.ytimg.com/vi/opRMrEfAIiI/mqdefault.jpg',
    },

    // --- Stage 3: Applied Cryptography Primitives & Protocol Cryptanalysis ---
    {
      videoId: '2aHkqB2-46k',
      title:
        'Introduction to Cryptography, Modular Arithmetic & Shannon Perfect Secrecy',
      channelName: 'Christof Paar',
      channelId: 'UC1usFRN4LCMcfIV7UjHNuQg',
      durationSeconds: 5160,
      thumbnailUrl: 'https://i.ytimg.com/vi/2aHkqB2-46k/mqdefault.jpg',
    },
    {
      videoId: 'AELVJL0axRs',
      title:
        'Stream Ciphers, LFSR, ChaCha20 & PRNG Seed Entropy Vulnerabilities',
      channelName: 'Christof Paar',
      channelId: 'UC1usFRN4LCMcfIV7UjHNuQg',
      durationSeconds: 5040,
      thumbnailUrl: 'https://i.ytimg.com/vi/AELVJL0axRs/mqdefault.jpg',
    },
    {
      videoId: 'NuyzuNBFWxQ',
      title:
        'AES Galois Field Internals, ECB/CBC Bit-Flipping & Padding Oracle Attacks',
      channelName: 'Christof Paar',
      channelId: 'UC1usFRN4LCMcfIV7UjHNuQg',
      durationSeconds: 4800,
      thumbnailUrl: 'https://i.ytimg.com/vi/NuyzuNBFWxQ/mqdefault.jpg',
    },
    {
      videoId: 'wXB-V_Keiu8',
      title:
        'RSA Number Theory, Diffie-Hellman, Elliptic Curve Cryptography (ECC) & Side-Channels',
      channelName: 'Christof Paar',
      channelId: 'UC1usFRN4LCMcfIV7UjHNuQg',
      durationSeconds: 5280,
      thumbnailUrl: 'https://i.ytimg.com/vi/wXB-V_Keiu8/mqdefault.jpg',
    },
    {
      videoId: '7Q17ubqLfaM',
      title:
        'JWT Algorithm Confusion (RS256 to HS256), OAuth 2.0 & TLS Handshake Downgrade',
      channelName: 'PwnFunction',
      channelId: 'UCW6MNdOsqv2E9AjQkv9we7A',
      durationSeconds: 1620,
      thumbnailUrl: 'https://i.ytimg.com/vi/7Q17ubqLfaM/mqdefault.jpg',
    },

    // --- Stage 4: x86-64 Architecture, ELF Dynamic Linking & Reverse Engineering ---
    {
      videoId: 'iyAyN3GFM7A',
      title:
        'x86-64 Virtual Memory Layout, Registers, Calling Conventions & Segfault Internals',
      channelName: 'LiveOverflow',
      channelId: 'UClcE-kVhqyiHCcjYwcpfj9w',
      durationSeconds: 1420,
      thumbnailUrl: 'https://i.ytimg.com/vi/iyAyN3GFM7A/mqdefault.jpg',
    },
    {
      videoId: '75gBFiFtAb8',
      title:
        'CMU 15-213 CS:APP Machine-Level Programming: x86-64 Assembly & Stack Frames',
      channelName: 'Carnegie Mellon Computer Science',
      channelId: 'UC8butISFwT-Wl7EV0hUK0BQ',
      durationSeconds: 4680,
      thumbnailUrl: 'https://i.ytimg.com/vi/75gBFiFtAb8/mqdefault.jpg',
    },
    {
      videoId: 'kUk5pw4w0h4',
      title:
        'ELF Binary Format, GOT/PLT Lazy Binding & Dynamic Linker (ld.so) Internals',
      channelName: 'LiveOverflow',
      channelId: 'UClcE-kVhqyiHCcjYwcpfj9w',
      durationSeconds: 1580,
      thumbnailUrl: 'https://i.ytimg.com/vi/kUk5pw4w0h4/mqdefault.jpg',
    },
    {
      videoId: 'fTGTnrgjuGA',
      title:
        'Ghidra Decompiler Engineering: CFG Reconstruction, Structs & Stripped ELF Analysis',
      channelName: 'Low Level Learning',
      channelId: 'UC6biysICWOJ-C3P4Tyeggzg',
      durationSeconds: 1920,
      thumbnailUrl: 'https://i.ytimg.com/vi/fTGTnrgjuGA/mqdefault.jpg',
    },
    {
      videoId: 'PorfLSr3DDI',
      title:
        'GDB & pwndbg Dynamic Reverse Engineering: Hardware Watchpoints & CMU Bomb Lab',
      channelName: 'John Hammond',
      channelId: 'UCVeW9qkBjo3zosnqUbG7CFw',
      durationSeconds: 2820,
      thumbnailUrl: 'https://i.ytimg.com/vi/PorfLSr3DDI/mqdefault.jpg',
    },
    {
      videoId: 'VroEiMOJPm8',
      title:
        'Reverse Engineering Obfuscated Malware, Anti-Debugging (ptrace) & Unpacking',
      channelName: 'OALabs',
      channelId: 'UC--DwaiMV-jtO-6EvmKOnqg',
      durationSeconds: 3540,
      thumbnailUrl: 'https://i.ytimg.com/vi/VroEiMOJPm8/mqdefault.jpg',
    },

    // --- Stage 5–8: Stack, ROP, Heap, Kernel & Fuzzing ---
    {
      videoId: '1S0aBV-Waeo',
      title:
        'Stack Buffer Overflow Mechanics: Saved RIP Overwrite & Position-Independent Shellcode',
      channelName: 'LiveOverflow',
      channelId: 'UClcE-kVhqyiHCcjYwcpfj9w',
      durationSeconds: 1760,
      thumbnailUrl: 'https://i.ytimg.com/vi/1S0aBV-Waeo/mqdefault.jpg',
    },
    {
      videoId: '0WvrSfcdq1I',
      title:
        'Format String Exploitation: Stack Leak (%p), Arbitrary Write (%n) & GOT Hijack',
      channelName: 'LiveOverflow',
      channelId: 'UClcE-kVhqyiHCcjYwcpfj9w',
      durationSeconds: 1690,
      thumbnailUrl: 'https://i.ytimg.com/vi/0WvrSfcdq1I/mqdefault.jpg',
    },
    {
      videoId: 'tMN5N5oid2c',
      title: 'pwn.college System Security, Shellcoding, Seccomp & Kernel Rings',
      channelName: 'pwn.college (Yan Shoshitaishvili)',
      channelId: 'UCW6MNdOsqv2E9AjQkv9we7A',
      durationSeconds: 4140,
      thumbnailUrl: 'https://i.ytimg.com/vi/tMN5N5oid2c/mqdefault.jpg',
    },
    {
      videoId: '8zRoGf7I24M',
      title:
        'Return-Oriented Programming (ROP), Gadgets, ret2libc, SROP & ASLR/NX Bypass',
      channelName: 'LiveOverflow',
      channelId: 'UClcE-kVhqyiHCcjYwcpfj9w',
      durationSeconds: 2080,
      thumbnailUrl: 'https://i.ytimg.com/vi/8zRoGf7I24M/mqdefault.jpg',
    },
    {
      videoId: 'HPDBOhiKaD8',
      title:
        'Dynamic Memory Allocator Internals: Doug Lea dlmalloc, glibc ptmalloc2 & UAF',
      channelName: 'LiveOverflow',
      channelId: 'UClcE-kVhqyiHCcjYwcpfj9w',
      durationSeconds: 1840,
      thumbnailUrl: 'https://i.ytimg.com/vi/HPDBOhiKaD8/mqdefault.jpg',
    },
    {
      videoId: 'gLbe5I2_9F0',
      title:
        'pwn.college Dynamic Allocator Misuse: Fastbins, Unsorted Bin, Tcache & FSOP',
      channelName: 'pwn.college (Yan Shoshitaishvili)',
      channelId: 'UCW6MNdOsqv2E9AjQkv9we7A',
      durationSeconds: 5340,
      thumbnailUrl: 'https://i.ytimg.com/vi/gLbe5I2_9F0/mqdefault.jpg',
    },

    // --- Stage 9–10: Web Exploitation, Active Directory & Red/Blue Team Capstone ---
    {
      videoId: 'G3hpAeoZ4ek',
      title:
        'Burp Suite Proxy Architecture, HTTP/2 Desync, Race Conditions & Request Smuggling',
      channelName: 'John Hammond',
      channelId: 'UCVeW9qkBjo3zosnqUbG7CFw',
      durationSeconds: 2150,
      thumbnailUrl: 'https://i.ytimg.com/vi/G3hpAeoZ4ek/mqdefault.jpg',
    },
    {
      videoId: 'ciNHn38EyRc',
      title:
        'SQL Injection AST Parser Pollution, Second-Order Injection & Time-Based Blind Channels',
      channelName: 'LiveOverflow',
      channelId: 'UClcE-kVhqyiHCcjYwcpfj9w',
      durationSeconds: 1640,
      thumbnailUrl: 'https://i.ytimg.com/vi/ciNHn38EyRc/mqdefault.jpg',
    },
    {
      videoId: 'EoaDgUgS6QA',
      title:
        'DOM XSS, JavaScript Prototype Pollution, DOM Clobbering & CSP Bypass Engineering',
      channelName: 'LiveOverflow',
      channelId: 'UClcE-kVhqyiHCcjYwcpfj9w',
      durationSeconds: 1520,
      thumbnailUrl: 'https://i.ytimg.com/vi/EoaDgUgS6QA/mqdefault.jpg',
    },
    {
      videoId: 'Z5Sc3_0H9nI',
      title:
        'SSRF Cloud IMDSv2 Pivot, Deserialization Gadget Chains & SSTI Sandbox Escape',
      channelName: 'PwnFunction',
      channelId: 'UCW6MNdOsqv2E9AjQkv9we7A',
      durationSeconds: 1860,
      thumbnailUrl: 'https://i.ytimg.com/vi/Z5Sc3_0H9nI/mqdefault.jpg',
    },
    {
      videoId: 'VXxH4n684HE',
      title:
        'Active Directory Architecture, Kerberos, NTLM, ADCS, C2 Pivoting & BloodHound',
      channelName: 'freeCodeCamp.org',
      channelId: 'UC8butISFwT-Wl7EV0hUK0BQ',
      durationSeconds: 14400,
      thumbnailUrl: 'https://i.ytimg.com/vi/VXxH4n684HE/mqdefault.jpg',
    },
    {
      videoId: '3Kq1MIfTWCE',
      title:
        'Full-Scope Red/Blue Team Enterprise Penetration Testing & Defense Remediation Capstone',
      channelName: 'freeCodeCamp.org',
      channelId: 'UC8butISFwT-Wl7EV0hUK0BQ',
      durationSeconds: 54000,
      thumbnailUrl: 'https://i.ytimg.com/vi/3Kq1MIfTWCE/mqdefault.jpg',
    },
  ],
  nodes: [
    // =========================================================================
    // 星域一：系统安全威胁建模与 Linux 内核特权基座 (MIT 6.858 × Linux Internals)
    // =========================================================================
    {
      nodeId: 'stage-linux',
      parentId: null,
      position: 0,
      kind: 'stage',
      title: '星域一：系统安全威胁建模与 Linux 内核特权基座',
      note: '融合 MIT 6.858 安全架构原则与 Linux DAC/MAC 权限模型、VFS 进程隔离及自动化武器库',
      videoId: null,
      startSeconds: 0,
      optional: false,
      prerequisiteIds: [],
    },
    {
      nodeId: 'hk-sec-threat-model',
      parentId: 'stage-linux',
      position: 1,
      kind: 'video',
      title:
        'MIT 6.858 导论：计算机系统安全威胁建模、可信计算基 (TCB) 与最小特权原则',
      note: '【学术基座】威胁建模 Threat Model、可信计算基 TCB、最小特权原则、安全策略与机制分离',
      videoId: '073D9t3ltEw',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: [],
    },
    {
      nodeId: 'hk-linux-core',
      parentId: 'stage-linux',
      position: 2,
      kind: 'video',
      title:
        'Linux 系统工程基座：FHS 目录树规范、虚拟文件系统 VFS、文件描述符与流重定向',
      note: '【工程实现】VFS 虚拟文件系统、文件描述符 fd 表、标准流管道重定向、文本流处理三剑客',
      videoId: 'v392lEyM29A',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['hk-sec-threat-model'],
    },
    {
      nodeId: 'hk-linux-perm',
      parentId: 'stage-linux',
      position: 3,
      kind: 'video',
      title:
        '内核访问控制模型：DAC 自主访问控制、SUID/SGID 位、POSIX Capabilities 细分特权与 SELinux',
      note: '【源码剖析】task_struct 凭据结构体 cred、real/effective UID、SUID 特权继承、POSIX Capabilities 位掩码',
      videoId: 'lZAoFs75_cs',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['hk-linux-core'],
    },
    {
      nodeId: 'hk-linux-proc',
      parentId: 'stage-linux',
      position: 4,
      kind: 'video',
      title:
        '进程生命周期、/proc 伪文件系统内存映射、systemd 守护单元与 auditd 审计子系统',
      note: '【工程实现】fork/execve 系统调用、/proc/pid/maps 内存布局、Cron/systemd 持久化、auditd 内核审计钩子',
      videoId: '2TofunAI6fU',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['hk-linux-perm'],
    },
    {
      nodeId: 'hk-linux-bash',
      parentId: 'stage-linux',
      position: 5,
      kind: 'video',
      title:
        'Bash 与 Python 渗透工程自动化：异步套接字探测、子进程管道编排与载荷生成器',
      note: '【工程实现】Subprocess 管道控制、非阻塞 Socket 扫描、正则提取流水线、自动化 PoC 封装',
      videoId: 'tK9Oc6AEnR4',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['hk-linux-core'],
    },
    {
      nodeId: 'hk-linux-privesc-cp',
      parentId: 'stage-linux',
      position: 6,
      kind: 'checkpoint',
      title:
        '【星域一里程碑】Linux 用户态提权工程闭环：GTFOBins、LD_PRELOAD 动态库劫持与 Capabilities 逃逸',
      note: '【实验靶场】SUID 二进制劫持、LD_PRELOAD 动态链接注入、PATH 环境变量污染、Capabilities 提权实战',
      videoId: 'ZTnwg3qCdVM',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['hk-linux-perm', 'hk-linux-proc', 'hk-linux-bash'],
    },

    // =========================================================================
    // 星域二：网络协议栈 RFC 剖析、流量取证与全网侦察测绘 (Stanford CS144 × Packet Eng)
    // =========================================================================
    {
      nodeId: 'stage-recon',
      parentId: null,
      position: 7,
      kind: 'stage',
      title: '星域二：网络协议栈 RFC 剖析、流量取证与全网测绘',
      note: '从 TCP/IP 状态机与 BGP/DNS 协议安全，到原始套接字扫描、Wireshark 报文重组及全网攻击面测绘',
      videoId: null,
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['stage-linux'],
    },
    {
      nodeId: 'hk-net-tcpip',
      parentId: 'stage-recon',
      position: 8,
      kind: 'video',
      title:
        'TCP/IP 协议栈底层状态机：三次握手 ISN 序列号、ARP 缓存投毒、ICMP 重定向与 NAT 穿透',
      note: '【学术基座】TCP 有限状态机 FSM、初始序列号 ISN、ARP 无状态欺骗、NAT 会话表穿透',
      videoId: 'qiQR5rTSshw',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['hk-linux-core'],
    },
    {
      nodeId: 'hk-net-mit-sec',
      parentId: 'stage-recon',
      position: 9,
      kind: 'video',
      title:
        'MIT 6.858 网络安全架构：TCP 序列号盲猜劫持、SYN Cookies、BGP 路由劫持与 DNSSEC 签名链',
      note: '【学术基座】TCP 盲注入复位攻击、SYN Cookie 无状态防御、BGP 自治系统路由劫持、DNS Kaminsky 缓存投毒',
      videoId: 'bYV8f1b8A1I',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['hk-net-tcpip', 'hk-sec-threat-model'],
    },
    {
      nodeId: 'hk-net-nmap',
      parentId: 'stage-recon',
      position: 10,
      kind: 'video',
      title:
        'Nmap 原始套接字探测工程：SYN 半开扫描 (-sS)、TCP 窗口指纹识别、防火墙分片规避与 NSE 引擎',
      note: '【工程实现】Raw Socket 报文构造、SYN/FIN/ACK 旗标探测、TCP/IP 协议栈 OS 指纹、NSE Lua 漏洞脚本',
      videoId: '4t4kBkMsDbQ',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['hk-net-tcpip', 'hk-linux-bash'],
    },
    {
      nodeId: 'hk-net-wireshark',
      parentId: 'stage-recon',
      position: 11,
      kind: 'video',
      title:
        'Wireshark 深度流量取证：BPF 抓包过滤器、TCP 乱序流重组、TLS 密钥解密与恶意软件 C2 信标分析',
      note: '【工程实现】BPF 字节码过滤、TCP 会话流重组、SSLKEYLOGFILE 解密、C2 心跳抖动 Jitter 取证',
      videoId: 'lb1Dw0elw0Q',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['hk-net-mit-sec'],
    },
    {
      nodeId: 'hk-net-osint',
      parentId: 'stage-recon',
      position: 12,
      kind: 'checkpoint',
      title:
        '【星域二里程碑】全网资产测绘与 OSINT 工程：ASN 自治域拓扑、DNS 区域传送 (AXFR) 与证书透明度日志',
      note: '【实验靶场】BGP/ASN 边界测绘、DNS AXFR 区域传送、CT 证书透明度日志挖掘、Shodan/Censys 空间测绘',
      videoId: 'opRMrEfAIiI',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['hk-net-nmap', 'hk-net-wireshark'],
    },

    // =========================================================================
    // 星域三：现代密码学数学原语与协议侧信道破解 (Christof Paar × Cryptanalysis)
    // =========================================================================
    {
      nodeId: 'stage-crypto',
      parentId: null,
      position: 13,
      kind: 'stage',
      title: '星域三：现代密码学数学原语与协议侧信道破解',
      note: '以 Christof Paar《Understanding Cryptography》代数理论为基石，剖析流密码、分组密码、公钥体系及现代认证协议实现漏洞',
      videoId: null,
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['stage-recon'],
    },
    {
      nodeId: 'hk-crypto-math',
      parentId: 'stage-crypto',
      position: 14,
      kind: 'video',
      title:
        '密码学数学基石：模算术环 $Z_m$、扩展欧几里得算法、香农信息论与完美保密性 (One-Time Pad)',
      note: '【学术基座】模算术环与群论、扩展欧几里得求逆、香农完美保密定理、双倍一次性密码本重用攻击',
      videoId: '2aHkqB2-46k',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['hk-sec-threat-model'],
    },
    {
      nodeId: 'hk-crypto-stream',
      parentId: 'stage-crypto',
      position: 15,
      kind: 'video',
      title:
        '流密码与伪随机数生成器 (PRNG)：LFSR 线性反馈移位寄存器、ChaCha20 与弱熵种子预测攻击',
      note: '【学术基座】CSPRNG 密码学安全随机数、LFSR 贝尔坎普-梅西算法、Mersenne Twister 状态逆推、Nonce 重用漏洞',
      videoId: 'AELVJL0axRs',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['hk-crypto-math'],
    },
    {
      nodeId: 'hk-crypto-core',
      parentId: 'stage-crypto',
      position: 16,
      kind: 'video',
      title:
        '分组密码与工作模式攻防：AES 伽罗瓦域 $GF(2^8)$ S-Box、ECB 块重排、CBC 字节翻转与 Padding Oracle',
      note: '【工程实现】有限域 GF(2^8) 矩阵变换、ECB 模式块粘贴、CBC IV 位翻转篡改、PKCS#7 Padding Oracle 逐字节解密',
      videoId: 'NuyzuNBFWxQ',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['hk-crypto-stream'],
    },
    {
      nodeId: 'hk-crypto-pubkey',
      parentId: 'stage-crypto',
      position: 17,
      kind: 'video',
      title:
        '公钥密码学与数论攻击：RSA 欧拉定理、共模攻击、Wiener 低私指数攻击、Diffie-Hellman 与椭圆曲线 ECC',
      note: '【学术基座】欧拉函数与费马小定理、RSA 小公钥指数广播攻击、Bleichenbacher 填充攻击、ECDSA 随机数重用私钥恢复',
      videoId: 'wXB-V_Keiu8',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['hk-crypto-core'],
    },
    {
      nodeId: 'hk-crypto-jwt',
      parentId: 'stage-crypto',
      position: 18,
      kind: 'checkpoint',
      title:
        '【星域三里程碑】现代认证协议密码学破译：JWT 算法混淆 (RS256→HS256)、JWK 注入与 OAuth 2.0 令牌劫持',
      note: '【实验靶场】JWT alg:none 签名剥离、非对称公钥降级对称密钥混淆、kid 目录穿越注入、OAuth 状态码劫持',
      videoId: '7Q17ubqLfaM',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['hk-crypto-pubkey', 'hk-net-wireshark'],
    },

    // =========================================================================
    // 星域四：x86-64 体系结构、ELF 链接机制与逆向工程 (CS:APP × Ghidra/GDB)
    // =========================================================================
    {
      nodeId: 'stage-re',
      parentId: null,
      position: 19,
      kind: 'stage',
      title: '星域四：x86-64 体系结构、ELF 链接机制与逆向工程',
      note: '结合 CMU 15-213 (CS:APP) 机器级表示与 ELF 动态链接源码，掌握 Ghidra 静态反编译与 GDB/pwndbg 动态逆向',
      videoId: null,
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['stage-linux'],
    },
    {
      nodeId: 'hk-pwn-intro',
      parentId: 'stage-re',
      position: 20,
      kind: 'video',
      title:
        '进程虚拟地址空间与内存模型：代码段/数据段/堆/栈布局、MMU 页表权限位与 SIGSEGV 段错误本质',
      note: '【学术基座】虚拟地址空间布局、x86-64 通用寄存器、小端序字节序 Little-Endian、MMU 页表 NX 权限位',
      videoId: 'iyAyN3GFM7A',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['hk-linux-perm'],
    },
    {
      nodeId: 'hk-re-csapp-asm',
      parentId: 'stage-re',
      position: 21,
      kind: 'video',
      title:
        'CMU 15-213 机器级编程：x86-64 指令集、System V ABI 调用约定、栈帧指针 (RSP/RBP) 与结构体对齐',
      note: '【学术基座】System V AMD64 ABI 参数传递寄存器、调用者/被调用者保存寄存器、栈帧分配与叶函数红区 Red Zone',
      videoId: '75gBFiFtAb8',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['hk-pwn-intro'],
    },
    {
      nodeId: 'hk-re-elf-got',
      parentId: 'stage-re',
      position: 22,
      kind: 'video',
      title:
        'ELF 二进制结构与动态链接器 (ld-linux.so)：Section/Segment 头、GOT 全局偏移表与 PLT 延迟绑定',
      note: '【源码剖析】ELF64_Ehdr/Phdr 结构、.got.plt 延迟解析 _dl_runtime_resolve、RELRO 重定位只读防护',
      videoId: 'kUk5pw4w0h4',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['hk-re-csapp-asm'],
    },
    {
      nodeId: 'hk-pwn-ghidra',
      parentId: 'stage-re',
      position: 23,
      kind: 'video',
      title:
        'Ghidra 静态逆向工程：P-Code 中间表示、控制流图 (CFG) 恢复、自定义结构体修复与去符号表分析',
      note: '【工程实现】Ghidra P-Code 语义抬升、无符号 Strip 二进制主函数定位、C 结构体与虚函数表 vtable 重建',
      videoId: 'fTGTnrgjuGA',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['hk-re-elf-got'],
    },
    {
      nodeId: 'hk-re-gdb-bomblab',
      parentId: 'stage-re',
      position: 24,
      kind: 'checkpoint',
      title:
        '【星域四里程碑】GDB / pwndbg 动态调试与 CMU Bomb Lab 拆弹实验：硬件读写断点、栈回溯与时间旅行调试',
      note: '【实验靶场】CMU 15-213 Bomb Lab 逆向拆解、pwndbg 上下文监视、硬件观察点 watchpoint、GDB Python 脚本自动化',
      videoId: 'PorfLSr3DDI',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['hk-pwn-ghidra'],
    },
    {
      nodeId: 'hk-re-obfuscation',
      parentId: 'stage-re',
      position: 25,
      kind: 'video',
      title:
        '高级恶意代码逆向：控制流平坦化 (OLLVM)、ptrace 反调试绕过、UPX/自定义加壳与内存 Dump 脱壳',
      note: '【工程实现】控制流平坦化分发器识别、ptrace/RDTSC 反调试补丁、内存断点脱壳 OEP 重建、IAT 导入表修复',
      videoId: 'VroEiMOJPm8',
      startSeconds: 0,
      optional: true,
      prerequisiteIds: ['hk-re-gdb-bomblab'],
    },

    // =========================================================================
    // 星域五：用户态栈内存破坏、格式化字符串与 ROP 图灵完备利用 (MIT 6.858 × pwn.college)
    // =========================================================================
    {
      nodeId: 'stage-pwn',
      parentId: null,
      position: 26,
      kind: 'stage',
      title: '星域五：用户态栈内存破坏、格式化字符串与 ROP 利用',
      note: '对标 MIT 6.858 控制流劫持讲义与 ASU pwn.college 靶场，打通栈溢出、Shellcode 编写、格式化字符串与 ROP 链构造',
      videoId: null,
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['stage-re'],
    },
    {
      nodeId: 'hk-pwn-mit-hijack',
      parentId: 'stage-pwn',
      position: 27,
      kind: 'video',
      title:
        'MIT 6.858 控制流劫持理论：缓冲区边界缺失、Stack Canary 金丝雀、DEP/NX 不可执行栈与 ASLR 地址随机化',
      note: '【学术基座】控制流完整性 CFI、Stack Guard 金丝雀值、W^X 页表互斥策略、ASLR 信息熵与基址泄露',
      videoId: '073D9t3ltEw',
      startSeconds: 1800,
      optional: false,
      prerequisiteIds: ['hk-re-csapp-asm', 'hk-sec-threat-model'],
    },
    {
      nodeId: 'hk-pwn-bof',
      parentId: 'stage-pwn',
      position: 28,
      kind: 'video',
      title:
        '栈缓冲区溢出工程实战：Cyclic 偏移测算、Saved RIP 覆盖、NOP Sled 与无空字节 Shellcode 注入',
      note: '【工程实现】De Bruijn 序列偏移定位、返回地址 RIP 劫持、坏字符 Badchars 规避、execve("/bin/sh") 汇编构造',
      videoId: '1S0aBV-Waeo',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['hk-pwn-mit-hijack', 'hk-re-gdb-bomblab'],
    },
    {
      nodeId: 'hk-pwn-fmtstr',
      parentId: 'stage-pwn',
      position: 29,
      kind: 'video',
      title:
        '格式化字符串漏洞深潜：可变参数栈帧越界读取 (%p)、%n 任意地址写入、Canary 泄露与 GOT 表覆写',
      note: '【源码剖析】vfprintf 格式化解析状态机、%k$p 位置参数任意栈读、%hn/%hhn 分段任意内存写、GOT 表劫持',
      videoId: '0WvrSfcdq1I',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['hk-pwn-bof', 'hk-re-elf-got'],
    },
    {
      nodeId: 'hk-pwn-shellcode-seccomp',
      parentId: 'stage-pwn',
      position: 30,
      kind: 'video',
      title:
        'pwn.college 高级 Shellcode 与 Seccomp 沙箱逃逸：ORW (open-read-write) 链、侧信道泄密与系统调用号切换',
      note: '【实验靶场】Seccomp-BPF 过滤器规则审计、openat/sendfile 系统调用替代、基于时间延迟的逐位侧信道盲注',
      videoId: 'tMN5N5oid2c',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['hk-pwn-bof'],
    },
    {
      nodeId: 'hk-pwn-rop',
      parentId: 'stage-pwn',
      position: 31,
      kind: 'checkpoint',
      title:
        '【星域五里程碑】ROP 面向返回编程：Gadgets 链式拼接、ret2libc、栈迁移 (Stack Pivot) 与 SROP 信号帧伪造',
      note: '【实验靶场】ROPgadget/ropper 搜索、puts/write 泄露 libc 基址、leave;ret 栈迁移、rt_sigreturn SROP 帧构造',
      videoId: '8zRoGf7I24M',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['hk-pwn-fmtstr', 'hk-pwn-shellcode-seccomp'],
    },

    // =========================================================================
    // 星域六：glibc ptmalloc2 堆分配器源码剖析与高级堆利用 (Heap Internals × FSOP)
    // =========================================================================
    {
      nodeId: 'stage-heap',
      parentId: null,
      position: 32,
      kind: 'stage',
      title: '星域六：glibc ptmalloc2 堆分配器源码与高级堆利用',
      note: '深入 glibc malloc.c 源码，剖析 malloc_chunk 元数据、Tcache/Fastbin/Unsorted Bin 链表结构及现代堆利用原语',
      videoId: null,
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['stage-pwn'],
    },
    {
      nodeId: 'hk-heap-allocator',
      parentId: 'stage-heap',
      position: 33,
      kind: 'video',
      title:
        '动态内存分配器设计原理：brk/mmap 系统调用、malloc_chunk 头部元数据 (prev_size/size/AMP 位) 与碎片合并',
      note: '【学术基座】隐式/显式空闲链表、边界标记合并 Boundary Tag Coalescing、malloc_chunk 结构、Arena 线程锁竞争',
      videoId: 'HPDBOhiKaD8',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['hk-pwn-rop'],
    },
    {
      nodeId: 'hk-heap-ptmalloc',
      parentId: 'stage-heap',
      position: 34,
      kind: 'video',
      title:
        'pwn.college glibc ptmalloc2 源码精讲：Tcache、Fastbins、Unsorted/Small/Large Bins 双向链表状态机',
      note: '【源码剖析】tcache_perthread_struct 缓存池、Fastbin LIFO 单链表、Unsorted Bin 分拣循环、unlink 宏双向链表校验',
      videoId: 'gLbe5I2_9F0',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['hk-heap-allocator'],
    },
    {
      nodeId: 'hk-heap-uaf-tcache',
      parentId: 'stage-heap',
      position: 35,
      kind: 'video',
      title:
        '现代堆漏洞利用原语：Use-After-Free (UAF)、Double Free、Tcache Poisoning 与 glibc 2.32+ Safe-Linking 绕过',
      note: '【工程实现】悬挂指针 Dangling Pointer 复用、Tcache next 指针异或加密 Safe-Linking 解密、Heap Feng Shui 堆风水排布',
      videoId: 'HPDBOhiKaD8',
      startSeconds: 600,
      optional: false,
      prerequisiteIds: ['hk-heap-ptmalloc'],
    },
    {
      nodeId: 'hk-heap-fsop',
      parentId: 'stage-heap',
      position: 36,
      kind: 'video',
      title:
        '高版本 glibc 利用与 FSOP 面向文件流编程：__free_hook 移除后的 _IO_FILE_plus vtable 伪造与 House of Apple',
      note: '【源码剖析】_IO_list_all 链表遍历、_IO_FILE_plus 虚表指针校验绕过、_wide_data 结构伪造、exit() 函数调用链劫持',
      videoId: 'gLbe5I2_9F0',
      startSeconds: 2100,
      optional: true,
      prerequisiteIds: ['hk-heap-uaf-tcache'],
    },
    {
      nodeId: 'hk-heap-capstone',
      parentId: 'stage-heap',
      position: 37,
      kind: 'checkpoint',
      title:
        '【星域六里程碑】堆分配器逆向与任意读写原语综合实验：从 Off-by-Null 块重叠到全保护绕过 GetShell',
      note: '【实验靶场】Off-by-Null 清除 PREV_INUSE 位、Chunk Overlapping 块重叠、Unsorted Bin 泄露 main_arena 与综合 GetShell',
      videoId: 'gLbe5I2_9F0',
      startSeconds: 3600,
      optional: false,
      prerequisiteIds: ['hk-heap-uaf-tcache', 'hk-heap-fsop'],
    },

    // =========================================================================
    // 星域七：操作系统内核漏洞挖掘、驱动 Pwn 与容器逃逸 (Linux Kernel Pwn × eBPF)
    // =========================================================================
    {
      nodeId: 'stage-kernel',
      parentId: null,
      position: 38,
      kind: 'stage',
      title: '星域七：Linux 内核漏洞利用、SLUB 分配器与容器逃逸',
      note: '从用户态 Ring 3 跨越到内核态 Ring 0：剖析字符设备驱动、内核 ROP、SLUB 跨缓存溢出、Dirty Pipe 与 eBPF 逃逸',
      videoId: null,
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['stage-linux', 'stage-heap'],
    },
    {
      nodeId: 'hk-krn-arch',
      parentId: 'stage-kernel',
      position: 39,
      kind: 'video',
      title:
        'pwn.college 内核安全架构：Ring 0/Ring 3 特权级切换、swapgs/iretq 指令、LKM 驱动模块与 ioctl 接口审计',
      note: '【学术基座】CPU 特权环 Ring 0/3、syscall/sysret 上下文切换、copy_from_user/copy_to_user 边界、LKM 字符设备驱动',
      videoId: 'tMN5N5oid2c',
      startSeconds: 900,
      optional: false,
      prerequisiteIds: ['hk-linux-privesc-cp', 'hk-pwn-rop'],
    },
    {
      nodeId: 'hk-krn-rop',
      parentId: 'stage-kernel',
      position: 40,
      kind: 'video',
      title:
        'Linux 内核态控制流劫持：Kernel Stack Overflow、commit_creds(prepare_kernel_cred(0)) 与 SMEP/SMAP/KPTI 绕过',
      note: '【工程实现】CR4 寄存器 SMEP/SMAP 防护、KPTI 页表隔离 swapgs_restore_regs_and_return_to_usermode 跳板、modprobe_path 覆写',
      videoId: '8zRoGf7I24M',
      startSeconds: 960,
      optional: false,
      prerequisiteIds: ['hk-krn-arch'],
    },
    {
      nodeId: 'hk-krn-slub',
      parentId: 'stage-kernel',
      position: 41,
      kind: 'video',
      title:
        '内核堆分配器 (SLUB) 利用与经典 CVE 源码剖析：kmalloc 缓存池、msg_msg 堆喷射与 Dirty Pipe (CVE-2022-0847)',
      note: '【源码剖析】kmem_cache SLUB 分配器、struct msg_msg 弹性堆喷、pipe_buffer flags 未初始化漏洞 (Dirty Pipe) 源码级复现',
      videoId: 'ZTnwg3qCdVM',
      startSeconds: 2100,
      optional: false,
      prerequisiteIds: ['hk-krn-rop', 'hk-heap-capstone'],
    },
    {
      nodeId: 'hk-krn-ebpf-escape',
      parentId: 'stage-kernel',
      position: 42,
      kind: 'video',
      title:
        'eBPF 验证器范围推导漏洞与云原生容器逃逸：ALU32 边界越界读写、Namespace 突破与 Kubernetes 节点接管',
      note: '【工程实现】eBPF Verifier 抽象解释器缺陷、有符号/无符号范围不一致、任意内核读写原语构造、Docker/K8s 容器逃逸',
      videoId: '2TofunAI6fU',
      startSeconds: 900,
      optional: true,
      prerequisiteIds: ['hk-krn-slub'],
    },
    {
      nodeId: 'hk-krn-capstone',
      parentId: 'stage-kernel',
      position: 43,
      kind: 'checkpoint',
      title:
        '【星域七里程碑】QEMU + GDB 内核 Pwn 靶场全流程实战：定位驱动 UAF 漏洞、绕过 KASLR/SMEP 并提权至 Root',
      note: '【实验靶场】buildroot 根文件系统打包、QEMU -s -S 双机联调、vmlinux 符号表导入、内核 UAF 利用链完整编写',
      videoId: 'ZTnwg3qCdVM',
      startSeconds: 3100,
      optional: false,
      prerequisiteIds: ['hk-krn-slub', 'hk-krn-ebpf-escape'],
    },

    // =========================================================================
    // 星域八：静态程序分析、编译期插桩、Fuzzing 模糊测试与符号执行 (LLVM × AFL++ × angr)
    // =========================================================================
    {
      nodeId: 'stage-fuzz',
      parentId: null,
      position: 44,
      kind: 'stage',
      title: '星域八：程序分析、LLVM 插桩、Fuzzing 与符号执行',
      note: '将编译器理论与漏洞挖掘结合：掌握 CodeQL 污点分析、LLVM Sanitizer 影子内存、AFL++ 覆盖率模糊测试与 Z3/angr 符号执行',
      videoId: null,
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['stage-re', 'stage-pwn'],
    },
    {
      nodeId: 'hk-fuzz-afl',
      parentId: 'stage-fuzz',
      position: 45,
      kind: 'video',
      title:
        '覆盖率引导模糊测试 (Coverage-Guided Fuzzing)：AFL++ 边覆盖率位图、Forkserver 机制与 LibFuzzer 内存内变异',
      note: '【工程实现】基本块边覆盖率 Edge Coverage、共享内存 Bitmap、Forkserver 消除 execve 开销、自定义语法变异器 Custom Mutator',
      videoId: 'iyAyN3GFM7A',
      startSeconds: 480,
      optional: false,
      prerequisiteIds: ['hk-re-gdb-bomblab'],
    },
    {
      nodeId: 'hk-fuzz-asan',
      parentId: 'stage-fuzz',
      position: 46,
      kind: 'video',
      title:
        'LLVM 编译期消毒器底层实现：AddressSanitizer (ASan) 1:8 影子内存、Redzone 投毒、UBSan 与内核 KASAN',
      note: '【源码剖析】LLVM IR 编译期插桩 Pass、Shadow Memory 1/8 映射公式、malloc/free 隔离队列 Quarantine、Use-After-Return 检测',
      videoId: '1S0aBV-Waeo',
      startSeconds: 780,
      optional: false,
      prerequisiteIds: ['hk-fuzz-afl', 'hk-heap-allocator'],
    },
    {
      nodeId: 'hk-fuzz-codeql',
      parentId: 'stage-fuzz',
      position: 47,
      kind: 'video',
      title:
        '静态程序分析与批量同源漏洞挖掘：AST 抽象语法树、SSA 数据流图、污点追踪 (Source-to-Sink) 与 CodeQL 查询',
      note: '【学术基座】控制流图 CFG 与支配树、SSA 静态单赋值定义-使用链、跨函数污点传播 Taint Analysis、CodeQL 谓词逻辑编写',
      videoId: 'fTGTnrgjuGA',
      startSeconds: 840,
      optional: false,
      prerequisiteIds: ['hk-pwn-ghidra'],
    },
    {
      nodeId: 'hk-fuzz-angr',
      parentId: 'stage-fuzz',
      position: 48,
      kind: 'checkpoint',
      title:
        '【星域八里程碑】符号执行与自动漏洞利用 (AEG)：路径约束收集、路径爆炸剪枝、Z3 SMT 求解器与 angr 实战',
      note: '【实验靶场】符号状态空间探索、VEX IR 语义转换、Z3 可满足性模理论求解、混合符号执行 Concolic Execution 自动生成输入',
      videoId: 'PorfLSr3DDI',
      startSeconds: 1320,
      optional: false,
      prerequisiteIds: ['hk-fuzz-asan', 'hk-fuzz-codeql'],
    },
    {
      nodeId: 'hk-fuzz-syzkaller',
      parentId: 'stage-fuzz',
      position: 49,
      kind: 'video',
      title:
        '操作系统内核模糊测试工程：Syzkaller 系统调用模板、KCOV 内核覆盖率收集与崩溃复现最小化 (syz-repro)',
      note: '【工程实现】Syzlang 系统调用强类型描述、/sys/kernel/debug/kcov 覆盖率采集、KASAN+KCSAN 并发数据竞争捕获',
      videoId: 'VroEiMOJPm8',
      startSeconds: 1500,
      optional: true,
      prerequisiteIds: ['hk-fuzz-angr', 'hk-krn-capstone'],
    },

    // =========================================================================
    // 星域九：Web 现代分布式架构攻防、反序列化链与协议走私 (OWASP × PortSwigger)
    // =========================================================================
    {
      nodeId: 'stage-web',
      parentId: null,
      position: 50,
      kind: 'stage',
      title: '星域九：Web 现代应用架构攻防、反序列化与请求走私',
      note: '超越传统手工注入：深入 HTTP/1.1 与 HTTP/2 网关解析差异、AST 语法树污染、反序列化 POP 链与云原生 SSRF',
      videoId: null,
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['stage-recon', 'stage-crypto'],
    },
    {
      nodeId: 'hk-web-burp',
      parentId: 'stage-web',
      position: 51,
      kind: 'video',
      title:
        'HTTP 协议解析差异与请求走私 (Request Smuggling)：反向代理与后端 CL.TE / TE.CL / H2.CL 边界异步去同步攻击',
      note: '【工程实现】Content-Length 与 Transfer-Encoding 优先级冲突、HTTP/2 降级走私 H2.TE、前端连接池投毒与缓存投毒',
      videoId: 'G3hpAeoZ4ek',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['hk-net-wireshark'],
    },
    {
      nodeId: 'hk-web-sqli',
      parentId: 'stage-web',
      position: 52,
      kind: 'video',
      title:
        'SQL 注入与数据库引擎底层剖析：SQL 词法/语法 AST 树污染、布尔/时间盲注信息论二分检索与预编译参数化原理',
      note: '【学术基座】SQL 语法分析树 AST 逃逸、Prepared Statement 协议层分离、布尔盲注二分熵搜索、DNS 带外通道 OOB 注入',
      videoId: 'ciNHn38EyRc',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['hk-web-burp'],
    },
    {
      nodeId: 'hk-web-xss',
      parentId: 'stage-web',
      position: 53,
      kind: 'video',
      title:
        '现代浏览器安全模型与客户端攻防：DOM Clobbering、JavaScript 原型链污染 (Prototype Pollution) 与 CSP 绕过',
      note: '【工程实现】同源策略 SOP、__proto__/constructor.prototype 原型链污染、DOMPurify 突变 XSS (mXSS)、CSP script-src 绕过',
      videoId: 'EoaDgUgS6QA',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['hk-web-burp'],
    },
    {
      nodeId: 'hk-web-deser',
      parentId: 'stage-web',
      position: 54,
      kind: 'video',
      title:
        '反序列化属性导向编程 (POP Gadget Chains) 与模板注入 (SSTI)：Java CommonsCollections、Python pickle 与沙箱逃逸',
      note: '【源码剖析】对象序列化字节流协议、魔术方法 Magic Methods 触发链、Python MRO 继承树反射遍历、Jinja2/ Twig 沙箱逃逸',
      videoId: 'Z5Sc3_0H9nI',
      startSeconds: 660,
      optional: false,
      prerequisiteIds: ['hk-web-sqli', 'hk-crypto-jwt'],
    },
    {
      nodeId: 'hk-web-race',
      parentId: 'stage-web',
      position: 55,
      kind: 'video',
      title:
        '高并发 Web 竞争条件 (Race Conditions)：HTTP/2 单包并发攻击 (Single-Packet Attack) 与数据库事务隔离级穿透',
      note: '【工程实现】TOCTOU 检查与使用时间窗、TCP 尾字节同步单包并发、读已提交隔离级写偏斜 Write Skew 漏洞',
      videoId: 'G3hpAeoZ4ek',
      startSeconds: 1080,
      optional: true,
      prerequisiteIds: ['hk-web-deser'],
    },
    {
      nodeId: 'hk-web-ssrf',
      parentId: 'stage-web',
      position: 56,
      kind: 'checkpoint',
      title:
        '【星域九里程碑】SSRF 服务端请求伪造与云边界突破：URL 解析器差异、DNS 重绑定、AWS/K8s 元数据窃取与内网穿透',
      note: '【实验靶场】RFC 3986 URL 解析器歧义、DNS Rebinding TTL=0 同源绕过、Gopher 协议构造 Redis/FastCGI 内网载荷',
      videoId: 'Z5Sc3_0H9nI',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['hk-web-deser', 'hk-web-xss', 'hk-net-osint'],
    },

    // =========================================================================
    // 星域十：企业内网 Active Directory 域控攻防、红蓝对抗与零信任加固 (Red × Blue Team)
    // =========================================================================
    {
      nodeId: 'stage-redteam',
      parentId: null,
      position: 57,
      kind: 'stage',
      title: '星域十：企业内网域控攻防、红队基础设施与零信任防御',
      note: '融会贯通前九大星域：从单点突破横向移动至 Active Directory 域控制器，并从 MIT 6.858 视角建立零信任与蓝队纵深防御',
      videoId: null,
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['stage-kernel', 'stage-web', 'stage-crypto'],
    },
    {
      nodeId: 'hk-red-ad-arch',
      parentId: 'stage-redteam',
      position: 58,
      kind: 'video',
      title:
        'Active Directory 域架构与 Kerberos 认证协议形式化剖析：KDC、AS-REQ/AS-REP、TGS 票据流与 BloodHound 图论路径搜索',
      note: '【学术基座】Kerberos V5 三方认证协议、TGT/TGS 票据加密结构、LDAP 目录树 ACL 访问控制列表、BloodHound 最短攻击路径图论',
      videoId: 'VXxH4n684HE',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['hk-crypto-jwt', 'hk-web-ssrf'],
    },
    {
      nodeId: 'hk-red-kerberos',
      parentId: 'stage-redteam',
      position: 59,
      kind: 'video',
      title:
        'Kerberos 协议机制攻击：Kerberoasting 离线破解、AS-REP Roasting、非约束/约束委派 (S4U2Self/S4U2Proxy) 与黄金票据',
      note: '【工程实现】SPN 服务主体名称枚举、RC4-HMAC/AES 票据离线哈希破解、基于资源的约束委派 RBCD、krbtgt 黄金票据持久化',
      videoId: 'VXxH4n684HE',
      startSeconds: 3600,
      optional: false,
      prerequisiteIds: ['hk-red-ad-arch'],
    },
    {
      nodeId: 'hk-red-ntlm-adcs',
      parentId: 'stage-redteam',
      position: 60,
      kind: 'video',
      title:
        'NTLM 中继、ADCS 企业证书服务漏洞 (ESC1–ESC8) 与 DCSync 目录复制协议接管域控',
      note: '【工程实现】Net-NTLMv2 挑战响应中继、SMB 签名绕过、ADCS 证书模板 SAN 伪造 (ESC1)、MS-DRSR DCSync 域哈希同步',
      videoId: 'VXxH4n684HE',
      startSeconds: 7200,
      optional: false,
      prerequisiteIds: ['hk-red-kerberos'],
    },
    {
      nodeId: 'hk-red-c2-pivot',
      parentId: 'stage-redteam',
      position: 61,
      kind: 'video',
      title:
        '红队多层内网隧道与终端对抗工程：Ligolo-ng 虚拟网卡路由、SOCKS5 代理链、ETW/AMSI 内存补丁与直接系统调用',
      note: '【工程实现】TUN/TAP 虚拟网卡三层内网路由、Userland API Hook 脱钩、Indirect Syscalls 间接系统调用、进程镂空 Process Hollowing',
      videoId: 'VXxH4n684HE',
      startSeconds: 10800,
      optional: true,
      prerequisiteIds: ['hk-red-ntlm-adcs', 'hk-krn-capstone'],
    },
    {
      nodeId: 'hk-blue-zerotrust',
      parentId: 'stage-redteam',
      position: 62,
      kind: 'video',
      title:
        'MIT 6.858 纵深防御与零信任工程：硬件机密计算 (Intel SGX/TDX)、超越边界网络 (BeyondCorp) 与 SIEM 威胁狩猎',
      note: '【学术基座】零信任架构 BeyondCorp、硬件可信执行环境 TEE/SGX、Sysmon/eBPF 遥测日志关联、Sigma 检测规则工程',
      videoId: '073D9t3ltEw',
      startSeconds: 3300,
      optional: false,
      prerequisiteIds: ['hk-red-ntlm-adcs', 'hk-sec-threat-model'],
    },
    {
      nodeId: 'hk-ctf-capstone',
      parentId: 'stage-redteam',
      position: 63,
      kind: 'checkpoint',
      title:
        '【终极星图总成】全链路红蓝对抗毕业演练：外网测绘 → Web/二进制突破 → 内核/域控提权 → 漏洞修复与架构加固闭环',
      note: '【实验靶场】跨星域全链路综合靶场、外网边界突破、内网横向移动、Root/Domain Admin 权限获取、蓝队溯源取证与代码修复',
      videoId: '3Kq1MIfTWCE',
      startSeconds: 0,
      optional: false,
      prerequisiteIds: [
        'hk-red-ntlm-adcs',
        'hk-blue-zerotrust',
        'hk-krn-capstone',
        'hk-fuzz-angr',
        'hk-web-ssrf',
      ],
    },
  ],
};
