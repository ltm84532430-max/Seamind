# YouTube 播放

导图里的 YouTube 卡片点击后打开播放窗口。Seamind 有三种播放方式，并在失败时自动回退：

1. **YouTube 内嵌播放器**（默认）：官方 IFrame 播放器。内嵌播放器报错或 15 秒内没有连上时，窗口会自动改用内置播放器一次。
2. **内置播放器**：Seamind 自己向 YouTube 取流，用 Shaka 在窗口里播放。不依赖嵌入许可，可以选画质、音轨和字幕，并且和内嵌播放器之间可以按当前进度互相切换。
3. **本地解析（yt-dlp）**：yt-dlp 解析出兼容的 MP4 就用内嵌 `<video>` 播放，HLS、DASH 和分离音视频交给 mpv；没有 mpv 时回退到 ffplay，分离的音视频需要 ffmpeg 加 ffplay。

“播放诊断与设置”里可以勾选“打开视频时优先使用内置播放器”。

## 内置播放器

流程：YouTube.js 以 visionOS、iOS、Android VR、Android 客户端依次请求播放信息，取第一个可用的结果，生成 DASH 清单交给 Shaka。直播用 YouTube 提供的 HLS 清单。

- **客户端表**：这几个客户端在 2026 年 10 月的 yt-dlp 客户端表里不要求 PO token（visionOS 和 iOS 也不需要 JavaScript 播放器）。YouTube 每隔几个月就会收紧或下线一个客户端，列表在 `src/youtube-native.ts` 的 `defaultNativeClients`，需要时对照 yt-dlp 的 `INNERTUBE_CLIENTS`（`yt_dlp/extractor/youtube/_base.py`）调整。
- **签名与 n 参数**：只有格式带 `n` 参数或签名密文时才下载播放器脚本（约 2.6 MB），处理结果缓存在 `%LOCALAPPDATA%\Seamind\cache\youtube-player`，同一个播放器版本只付一次代价。脚本是 Google 的代码，在 Rust 侧的 QuickJS 沙箱里执行：没有文件和网络，内存上限 128 MB，最多运行 8 秒。**目前链里的客户端都用不到这条路径**：visionOS、iOS、Android VR 返回的是不带 `n` 参数的直链，Android 客户端返回的格式连地址都没有（SABR-only 实验，会被判为没有可用流）。它是为 YouTube 以后改策略，或者换用 TV、WEB 客户端准备的；`cargo test` 用真实播放器脚本验证过引擎，应用内也验证过“下载 → 解析 → 缓存 → 执行”的整条链路。
- **不支持**：只提供 SABR 流的视频、需要 PO token 的客户端、需要登录的视频（年龄限制、会员专享、私享）和 DRM。遇到这些情况窗口会说明原因，并保留其他播放方式。
- 播放地址有有效期（通常 6 小时），过期时播放器会自动重新解析一次并从当前位置继续。

## 本地媒体代理

WebView 对跨域请求强制 CORS，也不能设置 YouTube 要求的 Origin 和 Referer。Seamind 在 `127.0.0.1` 的随机端口上启动一个代理（第一次播放时才启动），页面通过它访问 YouTube：

- 每次启动生成随机令牌，请求必须带 `x-seamind-token`，并校验 `Host` 和 `Origin`，其他网页即使知道端口也用不了。
- 只转发到 `youtube.com`、`googlevideo.com`、`ytimg.com` 的 HTTPS 地址；重定向的每一跳都重新检查。
- 只转发白名单里的请求头；Cookie 和 Authorization 不会发给 YouTube，响应里的 Set-Cookie 也不会回到页面。请求体最大 1 MB。
- 响应按流转发，支持 Range，所以拖动进度不需要等整段下载。

## 网络慢或延迟高时

经过代理或 VPN 的链路上，每建立一个新连接都要付出约一秒的 TLS 握手，而播放器的分片只有几十到几百 KB，所以小请求的速度远低于大文件下载的速度。Seamind 做了几件事来缓解：

- 内置播放器从较低画质起播，再根据实测带宽上升，而不是相信浏览器给出的乐观估计；播放中画质可能先低后高，这是预期行为。
- googlevideo 经常把请求重定向到另一个节点（出口 IP 与解析时不一致时，会带 `cms_redirect` 和 `ipbypass` 重新签名），并且那个重定向会关闭连接。本地代理记住每个地址的最终位置（15 分钟），之后的请求直接访问最终节点；记住的节点失效时会自动忘掉并回到原始地址重试。
- 代理到 YouTube 的空闲连接保留 90 秒，并开启 TCP keep-alive，让一个节点上的连续请求复用同一条连接。

可以用 `cargo test --lib live_throughput -- --ignored --nocapture` 量一下当前链路的单流速度和重定向的代价。

## 失败时怎么看

窗口会把失败分成以下几类，并给出对应的提示：

| 类型 | 含义 |
| --- | --- |
| 机器人验证 | YouTube 对当前出口 IP 和这个视频要求验证。**这是按视频动态判定的**：同一个出口上，有的视频可以播放，有的不行。 |
| 年龄限制、会员专享、私享、地区不可用、找不到、直播未开始 | 所有客户端都会得到同样的结果，不会再尝试其他客户端。 |
| 网络 | 到本地代理或 YouTube 的连接失败。 |
| 播放地址被拒绝（403） | 地址过期，或者解析和取流走了不同的网络出口。直链绑定的是解析时的出口 IP，多出口或轮换节点的代理会导致这个问题，请固定一个节点。 |

“播放诊断与设置”里的“测试连通性”分层检查：内嵌播放器自己的网络、应用后端到 YouTube、应用后端到视频服务器、解析当前视频。当前视频解析失败时还会解析一个参考视频，如果参考视频可以解析，说明连接正常，只是这个视频被限制了。

## 设置和环境变量

- **代理**：诊断面板里的代理地址（`http`、`https`、`socks5`、`socks5h`，不含账号密码）同时用于内置播放器、yt-dlp、mpv 和 ffplay（后两者只支持 HTTP 代理）。YouTube 内嵌播放器使用 WebView2 的网络，保存后需要重启应用才会带上这个代理。留空则使用系统网络；TUN 模式的代理工具不需要设置。设置保存在 `%LOCALAPPDATA%\Seamind\youtube-settings.json`。
- **yt-dlp**：诊断面板的“安装 / 更新 yt-dlp”会从 GitHub 发布页下载官方 `yt-dlp.exe`，用同一发布页的 `SHA2-256SUMS` 校验，验证能运行后保存到 `%LOCALAPPDATA%\Seamind\tools`。该校验只能发现下载损坏，不能证明发布者身份。查找顺序：`SEAMIND_YT_DLP_PATH`、应用目录的 `tools\yt-dlp.exe`、`%LOCALAPPDATA%\Seamind\tools\yt-dlp.exe`、桌面上的 yt-dlp 源码、系统 PATH。官方可执行文件自带 JavaScript 挑战求解组件，但仍需要系统里有 Node.js（`--js-runtimes node`）。桌面上的源码版没有 `yt-dlp-ejs`。在开发机上对同一个视频实测：官方版约 8 秒得到可直接播放的 MP4，源码版用了约 15 秒，并且只得到需要 mpv 的分离流（网络波动也会影响耗时，仅供参考）。
- **mpv**：`SEAMIND_MPV_PATH` 指定可执行文件，默认从 PATH 查找。
- **浏览器会话**：YouTube 要求登录或真人验证时，可以让 yt-dlp 读取浏览器的 Cookie 重试。Firefox 最可靠；Chrome 127 之后和 Edge 在 Windows 上的 Cookie 通常无法被读取。Seamind 不保存也不外传 Cookie。
- **解析时限**：yt-dlp 最长 60 秒，超时或关闭播放窗口时会终止 yt-dlp 及它启动的所有子进程（Windows 作业对象）。同一个视频的解析结果会缓存到播放地址过期前，“用 mpv 外部播放”不会重新解析。

## 可选的 NewPipe 解析器

NewPipe Extractor 按 GPL-3.0-or-later 发布，因此 Seamind 不链接或打包该代码。设置 `SEAMIND_NEWPIPE_BRIDGE` 指向独立的辅助进程后，Seamind 会在 yt-dlp 之前调用它；**未设置时不会使用，也不再自动查找桌面上的脚本**。开发桥接脚本需要 JDK 21+ 和 NewPipe 仓库，首次运行会用 Gradle 编译，还可能弹出 YouTube 验证窗口，所以时限是 120 秒。只接受 HTTPS `googlevideo.com` 媒体地址。若要分发 NewPipe 辅助程序，需单独处理 GPL 源码、许可证和第三方依赖告知；跨进程设计本身不替代分发许可审查。

## 开发与测试

- Rust：`cargo test --lib`。联网测试默认忽略，`cargo test --lib live_ -- --ignored` 会向 YouTube 请求一个公开视频，经本地代理取一段媒体数据。把抓取到的播放器脚本放进 JSON（`{"script", "expected"}`）并设置 `SEAMIND_PLAYER_FIXTURE`，可以用 `cargo test --lib evaluates_a_real_player_fixture -- --ignored` 检查 QuickJS 对真实脚本的结果。
- 前端：在 `apps/desktop` 下运行 `vitest --run test/`。
- 端到端：构建带内嵌前端的调试版，设置 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`、`WEBVIEW2_USER_DATA_FOLDER=<临时目录>` 和 `SEAMIND_YT_PROXY_ALLOW_LOOPBACK=1`，在页面里执行 `localStorage.setItem('seamind.debug.youtube', '1')` 后刷新，就会出现 `window.__seamindYouTube.open(...)`，可以直接打开指定视频，或者传入本地 DASH 清单验证代理、Shaka 和 MSE。回环上游只在调试构建里生效。
