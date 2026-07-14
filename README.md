# 副屏仪表盘（Kevin / ProArt）

960×640 深色仪表盘，跑在 TYPE-C 小副屏上。**配置驱动的多页面板系统**：面板类型 gpu/cpu/ram/pet(官方 Clawd)/usage/clock/text，网格 4×4 自由布局，多页可轮换。

**管理台**: `http://192.168.1.3:3777/admin`（局域网任意设备可开，周芯宇的电脑也行）。改布局/主题色/轮换/亮度/开机自启，自动保存实时生效。

**亮度键 = 翻页键**: 副屏按钮不发 HID 事件（纯固件），`ddc-agent.ps1` 轮询 DDC/CI 亮度寄存器感知按键并弹回原值，服务端收到 PRESS 翻页。

**多设备 Claude 状态**: 远程设备(Mac)的 Claude Code hooks 用 curl POST 到 `/api/activity-report?device=Mac`，与本机 hooks 同权合并（配置片段见管理台"接入的设备"卡）。

## 启动

双击 `start-sidescreen.cmd`（起 Node 服务 → 开 Edge kiosk → 自动落位副屏）。

手动方式：`node server.js` 后浏览器开 `http://localhost:3777`。

## 组成

- `server.js` — 零依赖 Node 服务端，端口 3777
  - `/api/stats` — CPU(os 模块) / RAM / GPU(nvidia-smi)，2 秒采样，12 点走势历史
  - `/api/claude` — Claude 官方额度 + 会话活动状态
- `public/index.html` — 仪表盘页面（960×640 固定布局）
- `start-sidescreen.ps1 / .cmd` — 一键启动

## Claude 额度数据来源

走 Claude 客户端内部同款接口 `api.anthropic.com/api/oauth/usage`（**非公开接口，格式可能随时变**），
返回账号级数据（全设备汇总）。凭据读写 `~/.claude/.credentials.json`：

- access token 过期前自动用 refresh token 换新，并写回该文件（原子替换）
- 遇 429/403 指数退避（5 分钟起，上限 1 小时），不会硬刷
- 首次成功后会在服务端日志打印原始响应——若官方改了字段名，据此更新 `server.js` 里的 `mapUsage()`

## 桌宠状态判定

扫描 `~/.claude/projects/*/*.jsonl` 的修改时间：20 秒内有写入=干活中，10 分钟内=待机，更久=睡觉。

## 换了副屏摆放位置怎么办

`start-sidescreen.ps1` 顶部的 `$screenX/$screenY/$screenW/$screenH` 是副屏的**物理像素**坐标
（Windows 显示设置里挪动副屏后需要同步改）。当前值：(-905, 2160) 960×640。
