# DESIGN-TOKENS.md — 3840×1100 触摸副屏仪表盘 实现对照表

来源:`public/design/static.html`(布局权威,918行)、`proto.html`(交互权威,1213行)、`support.js`(仅框架壳,无业务逻辑,已确认)。
所有数值均为直接从源码摘取的精确值,画布本身就是 3840×1100 物理像素,**无需换算缩放**。

---

## 0. 权威性说明(源内部已有出入,以此表标注为准)

| 项目 | README 说法 | 源码实际值 | 采信 |
|---|---|---|---|
| Steam 长按弹层阈值 | 1.5s | `proto.html` `press()`:`setTimeout(...,600)` = **0.6s**;`static.html` 标注也写"长按 0.6s" | 0.6s(README 自称"两者如有出入以交互原型为准",此处 3 处源材料 2:1) |
| 切页过渡曲线 | `transform 0.45s cubic-bezier(0.22,1,0.36,1)` | `proto.html`:`s.dragging ? 'none' : 'transform 0.35s cubic-bezier(0.22, 0.9, 0.26, 1)'` | **0.35s cubic-bezier(0.22,0.9,0.26,1)** |
| 看板性能磁贴 | "5×2"(10 项,含 GPU风扇/磁盘读写/进程数/开机时长) | `grid-template-columns:repeat(3,1fr); grid-template-rows:1fr 1fr` = **3×2(6 格)**;`bigTiles` 数据数组也只有 6 项(GPU/CPU/内存/显存/GPU功耗/网络延迟) | 3×2,6 格;GPU风扇/磁盘读写/进程数/开机时长 **未实现**,需自行按此规格新增 |
| 危险操作长按反馈 | "环形进度动画" | 实际是 `position:absolute; bottom:10px; width:60%; height:8px` 的**水平线性进度条**(`width:{{holdW}}` 从 0%→100%),不是圆环 | 线性条,非圆环 |
| tabular-nums 覆盖范围 | "所有数字加 font-variant-numeric:tabular-nums" | grep 全源码只在 2 处出现:磁贴主数字(104px)、时钟 HH:MM(220px) | 仅这 2 处显式声明,其余数字未加(实现时建议统一补齐,但对照原稿只有这两处) |

---

## 1. CSS 变量 / 颜色

```css
:root { --accent:#F59E0B; --radius:24px; }
html, body { margin:0; padding:0; background:#05070a; } /* 画布外底色,非屏幕背景 */
```

| 分类 | 值 | 使用场景 |
|---|---|---|
| 屏幕背景 | `#0a0c10` | 页面根容器 background |
| 卡片背景 | `#11151d` | 所有磁贴/面板主背景 |
| 卡片次级/内嵌块 | `#171d27` | 应用图标格、快捷开关按钮、静音状态框 |
| 卡片次级 2 | `#1a212c` | 封面图占位底色、音量条轨道(部分)、静音填充色 |
| 弹层内嵌块 | `#0d1118` | 磁贴详情大图表底、磁贴详情小卡背景、游戏页"勿扰"提示框 |
| 底栏背景 | `#0e1218` | 三个专属底栏 |
| 描边(主) | `#1c222d` | 卡片边框、进度槽底色、磁贴分隔线 |
| 描边(次级) | `#232b38` | 快捷按钮/开关边框 |
| 描边(强调容器) | `#2a3342` | 弹层母版边框、日程分隔竖线 |
| 描边(音量芯片) | `#2f3948` | 声音磁贴内嵌音量条容器边框 |
| 强调色变量 | `var(--accent)` 默认 `#F59E0B` | 唯一强调色;备选 `#22D3EE`/`#34D399`/`#A78BFA`(props 里的 `accentColor` 换肤项) |
| 强调色高亮变体 | `#F5C36B` | "开启"态图标/文字颜色(比 --accent 更亮,用于 on 态图标而非背景) |
| 链接 hover | `#FBBF24` | `a:hover` |
| 文字-主 | `#F2F6FA` / `#E7ECF2` | 磁贴主数字、正文强调、修饰词 |
| 文字-次 | `#B9C3CF` / `#9AA6B5` / `#8A96A6` | 磁贴标题、次级数值、单位、副标签 |
| 文字-弱 | `#718092` | 描述性小字、通知正文 |
| 文字-最弱/标签 | `#525E6E` | 时间戳、次级标签、分隔线颜色源 |
| 文字-极弱 | `#3b4656` | 弹层内最不显著提示文案 |
| 白色控件(旋钮/把手) | `#F5F8FC` | 滑块圆形拖钮、边缘拖拽把手、Toast 背景 |
| 语义-正常/在线 | `#34D399`(光晕 `#34D39988`) | 服务器状态点、拾音中文字、静音表底段 |
| 语义-警告/强调 | `#F59E0B` | 同 --accent 默认值,OAuth 临期文字 |
| 语义-危险/离线 | `#F87171` | 静音态图标/文字、麦克风关闭色 |
| 危险按钮背景 | `#1d1418` | 锁屏/睡眠/重启/关机按钮底 |
| 危险按钮描边 | `#3a2228` | 同上按钮边框、hold 进度条轨道底色 |
| 危险按钮描边(强) | `#EF4444` | hold 进度条填充色、静音态描边 |
| 危险图标色 | `#E8A0A8` | 锁屏/睡眠/重启/关机图标与文字 |
| 静音芯片背景 | `#2a1a1e` | 麦克风关闭/应用静音芯片底色 |

---

## 2. 布局骨架

画布:`width:3840px; height:1100px; background:#0a0c10;`

三个一级页面(看板/操控台/媒体)结构一致:
```css
box-sizing:border-box; padding:28px 28px 0; /* 上28 左右28 下0 */
display:flex; flex-direction:column; gap:16px;
/* 子元素: [flex:1 主体区]  [height:170px flex:none 底栏] */
```
内容高度 = 1100 − 28(顶padding) = **1072px**;主体区高度 = 1072 − 16(gap) − 170(底栏) = **886px**。
内容宽度 = 3840 − 56(左右padding) = **3784px**。

### 2.1 看板页四区(35/30/20/15)

```css
display:grid; grid-template-columns:35fr 30fr 20fr 15fr; gap:22px;
```
3 个列间隙共 66px,可分配宽度 = 3784 − 66 = **3718px**。

| 区域 | fr | 实际像素宽 |
|---|---|---|
| 性能磁贴(左) | 35 | **1301px** |
| 焦点(时钟+用量,中) | 30 | **1115px** |
| 媒体(播放+天气,中右) | 20 | **744px** |
| 动态(日程/通知/服务器,最右) | 15 | **558px** |

### 2.2 性能磁贴网格(实为 3×2,非 5×2)

```css
display:grid; grid-template-columns:repeat(3,1fr); grid-template-rows:1fr 1fr; gap:16px;
```
容器 1301×886。单格宽 = (1301 − 32)/3 = **423px**;单格高 = (886 − 16)/2 = **435px**。
磁贴内边距 `padding:28px 32px`;标题区自动高,主指标区 `flex:1` 垂直居中。

### 2.3 底栏(170px)

```css
height:170px; background:#0e1218; border:1px solid #1c222d; border-bottom:none;
border-radius:var(--radius) var(--radius) 0 0; /* 只有上圆角 */
display:flex; align-items:center; gap:22px; padding:0 36px; margin:0 -4px;
```
内部:页名标签(`letter-spacing:6px`)→ 若干快捷按钮(`height:122px; min-width:230px; border-radius:22px`)→ 音量/亮度条(看板)或播放控制(媒体)。
媒体底栏按钮略大:`height:96/116px`(播放/暂停为116圆形,前后曲96圆形)。

### 2.4 操控台/游戏页网格

- 操控台应用启动:`grid-template-columns:repeat(8,1fr); gap:16px;`(单行 8 格,非"三行"字面意义,是"应用/声音/开关"三个分组区块)
- 游戏副驾驶精简磁贴:`grid-template-columns:repeat(3,1fr); grid-template-rows:1fr 1fr; gap:16px;`(同样 3×2=6 格)
- 游戏页三栏:900px(帧率) + flex:1(磁贴) + 800px(社交+快捷),`gap:20px`
- 媒体页三栏:920px(封面) + flex:1(歌词) + 760px(队列+天气),`gap:24px`

---

## 3. 字号标尺

| 元素 | font-size | weight | font-family | 备注 |
|---|---|---|---|---|
| 磁贴标题 | 38px | 700 | Noto Sans SC | `color:#9AA6B5; letter-spacing:1px` |
| 磁贴主数字 | 104px | 800 | JetBrains Mono | `line-height:1; tabular-nums; color:#F2F6FA` |
| 磁贴单位 | 42px | 700 | Noto Sans SC | `color:#8A96A6; margin-left:8px` |
| 磁贴副指标数值 | 44px | 700 | JetBrains Mono | `color:var(--accent)` |
| 磁贴副指标标签 | 30px | 400 | Noto Sans SC | `color:#525E6E` |
| 时钟 时:分 | **220px**(非README的260px) | 800 | JetBrains Mono | `line-height:0.95; letter-spacing:-6px; tabular-nums; color:#F5F8FC` |
| 时钟 秒 | 76px | 700 | JetBrains Mono | `color:var(--accent); margin-left:16px` |
| 星期/日期/农历 | 40px | 400(星期本身900) | Noto Sans SC | `color:#8A96A6`,星期 `color:#D4DCE6` |
| Claude 环形大数字 | 72px | 800 | JetBrains Mono | 圆环中心 |
| 用量条百分比 | 40px | 700 | JetBrains Mono | `color:var(--accent)` |
| 歌名(看板迷你卡) | 52px | 900 | Noto Sans SC | |
| 歌手/专辑 | 36px | 400 | Noto Sans SC | `color:#8A96A6` |
| 歌词-当前句(看板) | 50px | 900 | Noto Sans SC | `line-height:1.35; color:var(--accent); text-wrap:balance` |
| 歌词-相邻句(看板) | 36px | 400 | Noto Sans SC | `opacity:0.75; color:#8A96A6` |
| 歌名(媒体页大) | 64px | 900 | Noto Sans SC | |
| 歌词-当前句(媒体页) | 62px | 900 | Noto Sans SC | `line-height:1.4` |
| 歌词-相邻句(媒体页近) | 42px | 400 | Noto Sans SC | `color:#8A96A6` |
| 歌词-相邻句(媒体页远) | 34px | 400 | Noto Sans SC | `opacity:0.7; color:#525E6E` |
| 日程时间 | 38px | 700 | JetBrains Mono | `color:var(--accent)` |
| 日程事件 | 36px | 400 | Noto Sans SC | `color:#D4DCE6` |
| 通知标题 | 34px | 700 | Noto Sans SC | `color:#D4DCE6` |
| 通知摘要 | 30px | 400 | Noto Sans SC | `color:#718092` |
| 底栏页名 | 36px | 900 | Noto Sans SC | `letter-spacing:6px; color:#525E6E` |
| 底栏按钮文字 | 30px | 700 | Noto Sans SC | |
| 帧率大数字(游戏页) | 230px | 800 | JetBrains Mono | 无 tabular-nums 声明(注意) |
| 游戏磁贴主数字 | 88px | 800 | JetBrains Mono | 比看板磁贴(104px)略小 |

`tabular-nums` 实际只出现在**磁贴主数字(104px)**与**时钟时分(220px)**两处,详情见第0节。

---

## 4. 圆角 / 阴影 / 间距

| 项 | 值 |
|---|---|
| 磁贴圆角 `--radius` | 24px(可换肤 0–28px,step 2) |
| 弹层母版圆角 | 28px |
| 底栏圆角 | `var(--radius) var(--radius) 0 0`(仅上圆角) |
| 快捷按钮/图标格圆角 | 22px |
| 小控件圆角(输出块/静音块) | 12–16px |
| 磁贴阴影 | 无(纯描边卡片) |
| 弹层阴影 | `box-shadow:0 40px 120px rgba(0,0,0,0.8)` |
| 封面图阴影(看板迷你) | `0 8px 24px rgba(0,0,0,0.5)` |
| 封面图阴影(媒体页大) | `0 16px 50px rgba(0,0,0,0.6)` |
| 滑块圆钮阴影 | `0 2px 10px~14px rgba(0,0,0,0.6~0.7)` |
| 卡片间距(gap) | 16px(网格默认)、22px(四区/操控台行间)、18–20px(弹层内) |
| 画布内边距 | 28px(仅左右+顶,底部 0,因为底栏顶到画布边) |
| 弹层内边距 | `padding:34px 44px` |

---

## 5. 弹层母版(3560×980)

```css
position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
width:3560px; height:980px; background:#0e1218; border:1px solid #2a3342;
border-radius:28px; box-shadow:0 40px 120px rgba(0,0,0,0.8);
padding:34px 44px; box-sizing:border-box; display:flex; flex-direction:column; gap:20~24px;
```
遮罩层:`position:absolute; inset:0; background:rgba(5,7,10,0.72); z-index:60;`(点遮罩本身 `onClick=closeModals`;内容区 `onClick=stopProp` 阻止冒泡)
标题栏(flex:none):标题 44px/900 + 说明文字 28px `#525E6E` + `flex:1` 占位 + 关闭钮 `76×76 圆形 #1c222d`,✕ 用文本字符非 SVG。
内容区 = 3560−88=**3472px** 宽,980−(标题栏约76~92)−gap−68(上下padding)≈**~800px** 高(视标题栏高度浮动)。

三个弹层内部栅格:

| 弹层 | 列结构 | gap | 计算得中间列宽 |
|---|---|---|---|
| 声音控制(5e) | 880px(输出+主音量) + flex:1(分应用混音台) + 880px(麦克风) | 22px | 3472−880−880−44=**1668px** |
| 磁贴详情(5f) | flex:1(大曲线) + 860px(2×3 指标网格) | 28px | 3472−860−28=**2584px**(左侧) |
| STEAM(5g) | 640px(操作列) + flex:1(最近游戏2×2) + 820px(好友+下载) | 22px | 3472−640−820−44=**1968px** |

混音台每列:`flex:1; max-width:250px`,内部推子宽 76px + 电平表宽 12px,gap 12px。

---

## 6. 交互参数

| 参数 | 值 / 实现方式 |
|---|---|
| 边缘热区宽 | **64px**,左右各一个 `position:absolute; width:64px; top:0; bottom:0; z-index:50; touch-action:none;` 透明层,绑定 `onPointerDown` |
| 热区可见反馈 | 平时不可见;按下时(或首次开机 2.6s)显示两层:①120px 宽渐变辉光 `linear-gradient(to right/left, color-mix(in srgb, var(--accent) 18%, transparent), transparent)` z-index:55;②白色把手 `14×160px, border-radius:7px, background:#F5F8FC, box-shadow:0 4px 20px rgba(0,0,0,.6)`,距边缘 16px,垂直居中 |
| 首次提示 | `localStorage['omdash-edgehint']` 不存在时,`edgeHint=true` 持续 **2600ms** 后写入该 key 并关闭,不再提示 |
| 拖动跟手 | `dragX` 实时跟随 `(pointermove.clientY − startY)/scale`,`scale = 实际渲染高度/1100`(适配非 1:1 缩放预览) |
| 边界回弹阻尼 | 越界方向(page0 下拉 / page2 上拉)时 `dy *= 0.25`(橡皮筋效果,README 未提) |
| 拖动阈值 | **180px**:`dy < -180` 且未到最后页→下一页;`dy > 180` 且未到第一页→上一页;否则回弹 |
| 过渡曲线(松手/翻页) | `transition: dragging ? 'none' : 'transform 0.35s cubic-bezier(0.22, 0.9, 0.26, 1)'`(实测值,见第0节) |
| 切页 transform 结构 | 单个"轨道"div,`height:3300px`(=3页×1100),`flex-direction:column`,内嵌 3 个 `height:1100px flex:none` 页面;`transform:translateY(-(page*1100)+dragX)` 整体位移 |
| 弹层/游戏层级 | 游戏覆盖层 `z-index:40`;弹层遮罩+内容 `z-index:60`;Toast `z-index:70`;边缘热区 `z-index:50`,辉光/把手 `z-index:55` |
| 按压反馈(声明式) | 通过非标准属性 `style-active="..."` 标注(**support.js 中未找到任何解析此属性的代码**——它只是设计稿给实现者的"按下应长这样"提示,不是可运行 CSS,需自行用 `:active` 或 pointerdown/up 状态实现) |
| 按压反馈实际取值范围 | 并非统一的 0.75/0.96:磁贴 `scale(0.97) brightness(0.8)`;快捷/开关按钮 `scale(0.95) brightness(0.75)`;播放控制圆钮 `scale(0.92) brightness(0.7~0.8)`;Steam动作/游戏库项 `brightness(0.78) scale(0.97)`;静音/输出小按钮 `brightness(0.75) scale(0.96)`;危险按钮 `scale(0.95) brightness(0.7)` |
| 长按(应用图标通用,含 Steam) | `press(tapFn, longFn)` helper:`onPointerDown` 启动 `setTimeout(600ms)` 触发 `longFn`;`onPointerUp` 若未触发长按则执行 `tapFn`;`onPointerLeave` 取消计时器。**无长按视觉进度反馈** |
| 长按(危险操作:锁屏/睡眠/重启/关机) | `startHold(key,label)`:`onPointerDown` 记录 `t0=performance.now()`,`requestAnimationFrame` 循环计算 `pct=min(1,(t-t0)/1500)`,即 **1500ms**;`onPointerUp`/`onPointerLeave` 均绑定 `endHold` 清零;达到 100% 时触发动作+Toast 提示(演示态无真实系统调用) |
| 长按视觉反馈(危险操作) | **线性进度条**(非环形):`position:absolute; bottom:10px; width:60%; height:8px; border-radius:4px; background:#3a2228;` 内层 `width:{{holdW}}` (0%→100%) `background:#EF4444` |
| 水平滑块拖动(音量/亮度/进度) | `hDrag(e,cb)`:取 `rect=getBoundingClientRect()`,`pct=clamp((clientX-rect.left)/rect.width,0,1)`,`pointerdown` 时立即 set 一次,随后监听 `window` 级 `pointermove/pointerup` |
| 垂直推子拖动(分应用混音台) | `vDrag(e,cb)`:`pct=clamp(1-(clientY-rect.top)/rect.height,0,1)`(Y 轴向上为增大) |
| 状态持久化 | `localStorage['omdash-proto']` 保存 `{page, volume, micOn, outputIdx, bright}`,`componentDidUpdate` 里 diff 后才写入 |

---

## 7. SVG 折线图(磁贴底部通铺面积图)

生成逻辑(`makeSpark`,viewBox 固定 `0 0 100 30`):
```js
makeSpark(vals) {
  const n = vals.length;
  const pts = vals.map((v, i) => [(i / (n - 1)) * 100, 30 - v * 26]); // v∈[0,1] 归一化值,y轴向下,底部留4px余量(30-26)
  const line = 'M' + pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' L');
  return { line, area: line + ' L100,30 L0,30 Z' }; // 面积路径=折线闭合到底边
}
```
渲染(磁贴,真实代码):
```html
<svg viewBox="0 0 100 30" preserveAspectRatio="none"
     style="position:absolute; left:0; right:0; bottom:0; width:100%; height:80px; display:block; pointer-events:none;">
  <path d="{{ t.area }}" fill="var(--accent)" opacity="0.10"></path>
  <path d="{{ t.line }}" fill="none" stroke="var(--accent)" stroke-width="1.4" opacity="0.55"
        vector-effect="non-scaling-stroke"></path>
</svg>
```
差异点:磁贴详情弹层大图 `stroke-width:1.2` `opacity:1`(无半透明)、面积 `opacity:0.12`,且 `style="position:absolute; inset:0; width:100%; height:100%;"`(铺满整个图表容器而非仅80px高)。游戏页帧率图 `height:120px`,游戏磁贴 `height:64px`。

Claude 用量环形进度(非折线,SVG 圆环):
```html
<svg viewBox="0 0 100 100" width="260" height="260">
  <circle cx="50" cy="50" r="43" fill="none" stroke="#1c222d" stroke-width="10"></circle>
  <circle cx="50" cy="50" r="43" fill="none" stroke="var(--accent)" stroke-width="10"
          stroke-linecap="round" stroke-dasharray="183.7 270.2" transform="rotate(-90 50 50)"></circle>
</svg>
```
`183.7/270.2 ≈ 0.68`(对应 68%),`270.2 = 2π×43`(周长)。公式:`dasharray = (pct/100)*2*PI*r + " " + 2*PI*r`。

---

## 8. 各页网格布局参数汇总

| 页面 | 结构 | 关键 CSS |
|---|---|---|
| 看板页 | 四区(1) + 性能磁贴3×2(2) + 中列时钟42fr/用量58fr + 右列 auto/1fr/140px(日程/通知/服务器) | 见第2节 |
| 操控台页 | 左固定560px(时钟迷你卡) + 右flex:1(应用启动 flex:1 + 声音 flex:1,纵向各半) | 应用格 `repeat(8,1fr) gap:16`;声音磁贴内混音迷你条 `gap:10px` 每项 |
| 媒体页 | 920px(封面) + flex:1(歌词) + 760px(队列 flex:1 34~36px padding + 天气 150px) | `gap:24px` |
| 游戏副驾驶页 | 顶部条 130px(游戏图标+名称+计时+退出) + 主体: 900px(帧率) + flex:1(6磁贴3×2) + 800px(社交flex:1 + 3格快捷210px) | `gap:20px`(主体)/`gap:18px`(整体纵向) |
| 声音弹层(5e) | 880 + flex:1 + 880,`gap:22` | 混音台每列 `max-width:250px` |
| 磁贴详情弹层(5f) | flex:1(图表) + 860(2×3指标) | `grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr 1fr; gap:18px` |
| STEAM弹层(5g) | 640 + flex:1(2×2最近游戏) + 820,`gap:22` | 最近游戏 `grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr; gap:16` |

---

## 附:字体加载

```html
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700;900&family=JetBrains+Mono:wght@500;700;800&display=swap" rel="stylesheet">
```
生产环境建议本地打包这两款字体(README 已提示,此处补充实际请求的字重子集:Noto Sans SC 400/500/700/900,JetBrains Mono 500/700/800 —— 但源码中实际用到的 weight 只有 400/700/800/900,500 未见任何元素使用)。
