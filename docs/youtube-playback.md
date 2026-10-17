# YouTube 播放解析

Seamind 按实际媒体格式选择播放器：兼容的 HTTPS H.264/AAC MP4 使用内嵌 `<video>`；HLS、DASH 和分离音视频交给 mpv。对于 NewPipe 返回的单一媒体地址，mpv 缺失时会尝试 ffplay；分离的音视频需要 mpv。

## 可选 NewPipe 解析器

NewPipe Extractor 按 GPL-3.0-or-later 发布，因此 Seamind 不链接或打包该代码。Seamind 优先调用 NewPipe 独立辅助进程；Windows 默认查找 `%USERPROFILE%\Desktop\NewPipe\seamind-newpipe-bridge.ps1`，也可通过 `SEAMIND_NEWPIPE_BRIDGE` 显式指定。这个开发桥接需要 JDK 21+ 和 NewPipe 仓库；脚本会校验 YouTube URL 和临时响应文件。Seamind 对解析进程设置 60 秒上限，只接受 HTTPS `googlevideo.com` 媒体地址，并在 NewPipe 失败时回退到 yt-dlp。

“智能选择播放方式”和“用 mpv 外部播放”都使用解析器返回的媒体直链。mpv 以 `--ytdl=no` 播放已解析媒体，因此 NewPipe 辅助进程可用时不需要 yt-dlp 或浏览器 cookie。若 NewPipe 未配置或不可用，才回退到 yt-dlp；需登录、年龄限制或地区限制的视频可能仍需要独立的身份验证方案。

在 PowerShell 中启动开发版时设置：

```powershell
$env:SEAMIND_NEWPIPE_BRIDGE = (Join-Path $env:USERPROFILE 'Desktop\NewPipe\seamind-newpipe-bridge.ps1')
corepack pnpm@9.15.9 --filter @markmap/desktop tauri dev
```

也可通过 `SEAMIND_YT_DLP_PATH` 指定 yt-dlp，通过 `SEAMIND_MPV_PATH` 指定 mpv。没有配置 NewPipe 解析器时，Seamind 使用 yt-dlp；若机器上没有 yt-dlp 和 mpv/ffplay，媒体解析或外部播放会显示对应错误。

NewPipe 当前以独立进程作为可选解析器，不作为 Seamind 的内嵌播放器库。若要分发 NewPipe 辅助程序，需单独处理 GPL 源码、许可证和第三方依赖告知；跨进程设计本身不替代分发许可审查。
