# dsh-session-cost — 统计每个对话消耗的 token 与金额

DSH 插件（Cordis bundle）· 工具 `session_cost` / `list_session_costs` · 命令 `/cost` · 界面「💰 消耗」药丸

DSH 自己**只记 token、不记钱**：`dsh-token-meter` 的 `tokenUsage` 投影给出精确的 token 桶
（未命中缓存输入 / 命中缓存输入 / 缓存写入 / 输出），但整个自带安装里没有任何文本单价——
唯一带价格的是图片 visual token。本插件补上"金额"这一半，并且把两半都做成
**可按模型分别计价**的账。

```
会话日志（每条 assistant/message 自带 provider/model + usage）
   └─ lib/usage.js   按 attempt 归属到它自己的路由，按 attempt 当时的时刻判断高峰/非高峰（仅峰谷价模型）
        └─ lib/rates.js   查单价表 → 整数最小单位（1e-6）累加
             ├─ 工具 session_cost / list_session_costs   （模型可调，精确到每次调用）
             ├─ 命令 /cost                                （不花 token，直接看）
             └─ 界面 💰 药丸                              （会话级近似，可一键与日志核对）
```

## 数字从哪来（以及哪一半是精确的）

| 数字 | 来源 | 精确度 |
|---|---|---|
| token 桶 | 已落盘的 `assistant/message.data.usage`（缺省回退到流里最后一个 `usage` chunk） | **精确**，与 DSH 自己的 `tokenUsage` 投影逐字节一致（[见验证](#验证)） |
| 路由归属 | 该条 assistant 消息自己的 `message.source.provider/model` | **精确**，中途换模型会分成多行分别计价 |
| 高峰/非高峰 | 该次调用的 `event.time` | **精确到规则**：周一至周五 01:00–04:00、06:00–10:00（按 `offPeakTimezone`，默认 UTC）为高峰，中国法定节假日全天按非高峰；**只对峰谷价模型生效**（键名含 `deepseek` 或 `peakPricing: true`），其余模型全天一个价 |
| 单价 | 本插件的 `rates` 配置 | **取决于你填的对不对**；未配置的模型只统计 token、不计金额，并明确列出来 |
| 💰 药丸 | `tokenUsage` + `modelSelection` 两个投影 | **近似**：整段对话按当前模型计价；换过模型时请点「与日志核对」或看 `/cost` |

缓存写入（`cacheWriteTokens`）DeepSeek 不单独计费，因此默认按普通输入（cache miss）价计价，
可用 `cacheWrite` 覆盖。金额用**整数最小单位**（1e-6，即"微元"）累加，避免长对话里浮点误差；
单位是 `currency` 那一个，不是美元。

## 安装

```powershell
# 在 dsh-session-cost 目录下
node install/install.mjs                 # 装进默认 desktop profile（含默认单价表）
node install/install.mjs --dry-run       # 先看会改什么
node install/install.mjs --currency '{"symbol":"$","code":"USD","perUsd":1}'   # 若账号按美元计费
node install/install.mjs --uninstall     # 卸载
```

安装做三件事，每件都有 `.dsh-session-cost-<时间戳>.bak` 备份：

1. 把包**实体复制**到 `<profile>\node_modules\@local\dsh-session-cost`（不用符号链接：源目录
   曾被链接清空过一次；实体复制还能让 `@deepseek-ai/*` 的裸导入走 profile 自己的解析路径）
2. profile `package.json`：加 `file:` 依赖，并把包名追加进 `dsh.profile.bundles`
   （这一步才让它出现在「插件」页的**已安装**里）
3. profile `cordis.patch.yml`：用受管块按 id 覆写两行，写入单价表 / 货币 / 非高峰设置

**装完**：改 `lib/index.js`、`lib/command.js` 等宿主半边 → **完全退出 DSH 再启动**；
改 `lib/client.js`（界面半边）→ 页面**硬刷新**（Ctrl+R）。插件页 → 已安装 →
`@local/dsh-session-cost` → 任一行 → **配置**，可直接编辑单价表（表单由本包自己渲染，
因为 DSH 只提供 `plugins.row.config` 扩展点、不自带渲染器）。

> 实测差异（本插件开发时踩到的）：**首次**把包加进 profile 会让运行中的 DSH 热重组，
> 宿主侧的工具/命令/路由**立刻可用**；但**插件模块本身不会被重新导入**——之后再改
> `lib/*.js` 并刷新副本，运行中的进程仍在跑旧代码，必须重启 DSH 才会换新。界面半边的
> 插槽注册发生在页面加载时，所以至少要硬刷新一次。

> 另一个实测差异：**DSH 自己开着的沙箱可能只允许写工作区**。这种情况下
> `<profile>\cordis.patch.yml` 能写、`<profile>\node_modules\@local\dsh-session-cost\` 却
> `EPERM`——因为前者在允许列表里、后者不在。安装器会逐文件复制并把
> `NOT updated (permission denied): lib/ ...` 明确打出来（而不是假装成功），此时**行已改、
> 模块还是旧的**：换一个能写该目录的权限重跑同一命令即可，不需要退出 DSH。
> 注意这与「文件真的被运行中的 DSH 锁住」（`EBUSY`）是两回事，安装器分开报告。

## 配置字段

**在界面里填单价**（推荐）：插件页 → 已安装 → `@local/dsh-session-cost` → 任一行 → **配置**。
那一页的「模型单价」是一张**可编辑表格**，每个模型一行，直接输入数字即可：

```
模型（<provider>/<model>）   未命中   命中缓存   缓存写入   输出
deepseek-official/deepseek-flash   2     0.04              8    ×
deepseek-official/deepseek-v4-pro  9     0.3              27    ×
[＋ 添加模型]   留空的「命中缓存 / 缓存写入」= 与未命中同价

模型   未命中   命中缓存   缓存写入   输出
DeepSeek-V4.1-Flash   ¥2   ¥0.04   ¥2   ¥8      ← 只读预览（跟随 currency）
DeepSeek-V4-Pro       ¥9   ¥0.3    ¥9   ¥27

▸ 高级：直接编辑 rates JSON
```

- **未命中、输出必填**；命中缓存 / 缓存写入留空 = 与未命中同价（DeepSeek 的缓存写入不单独计费）；
- **「＋ 添加模型」**加一行，每行的 **×** 删掉该行（至少留一行）；
- 表格只改这四列，**同一模型上的其它字段会被保留**（`label`、`offPeakMultiplier`、
  `inputOffPeak` 等），不会因为你在界面上改了一个价就把高级设置悄悄删掉；
- 模型名必须写成 `<provider>/<model>`，**可以直接复制下面只读预览里的键名**；
- 下面是**只读预览**：按当前 `currency` 标注单位，把每个模型的四个单价列全，一眼能看出
  「我填的价会不会被这么算」；
- 最下面的**「高级」**是可折叠的 `rates` JSON 原文——要写表格没有暴露的字段
  （`inputOffPeak` 之类）时用它；两处是同一个值的两个视角，改哪边都会同步另一边的表格；
- **保存前会校验**：缺 `input`/`output`、值不是数字、模型名没有 `/`、模型名重复，都会**拒绝保存**
  并指出是**哪一行哪个字段**——因为 Host 挂载时会拒绝这种表，那会让整个读数不显示，
  所以宁可在这里拦住。

字段清单（表格没覆盖的部分用「高级」直接写）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `rates` | DeepSeek 官方价（见下） | JSON：`"<provider>/<model>"` → 每 100 万 token 的单价，**单位与 `currency` 一致** |
| `currency` | `{"symbol":"¥","code":"CNY","perUsd":1}` | 展示货币；`perUsd` 是 1 美元兑多少该货币 |
| `offPeakMultiplier` | `0.5` | 非高峰价 = 高峰价 × 该系数，**只对「峰谷价」的模型生效**（见 `peakPricing`） |
| `offPeakTimezone` | `UTC` | 判断高峰时段的 IANA 时区 |
| `offPeakHolidays` | 空 = 用内置清单 | 中国法定节假日（`YYYY-MM-DD`，逗号分隔），这些日期全天按非高峰价 |
| `dshHome` | 空 | 空 = `$DSH_HOME`，再退回 `~/.dsh` |

单价表每个条目可用的字段：

| 字段 | 必填 | 含义 |
|---|---|---|
| `input` | ✅ | 未命中缓存的输入价 |
| `output` | ✅ | 输出价 |
| `cacheRead` | | 命中缓存的输入价；缺省 = `input` |
| `cacheWrite` | | 缓存写入价；缺省 = `input`（DeepSeek 不单独计费） |
| `label` | | 界面/报告里显示的名字，如 `DeepSeek-V4.1-Flash` |
| `peakPricing` | | 该模型是否有高峰/非高峰两档价；**不填时按键名判断：含 `deepseek` 才是 `true`，其余一律 `false`（固定价）** |
| `offPeakMultiplier` | | 该模型自己的非高峰系数，覆盖全局值；只对 `peakPricing: true` 的模型生效 |
| `inputOffPeak` / `cacheReadOffPeak` / `cacheWriteOffPeak` / `outputOffPeak` | | 直接写死非高峰价，覆盖系数；同样只对峰谷价模型生效 |

**峰谷价只属于 DeepSeek**。这是实测踩到的第二个坑：插件原来把非高峰折扣套在了**每一条**已配置
单价的路由上，于是本机真实存在的 `our-free-model/mimo-v2.6-flash-free`（只有一个固定价）被算成
半价，面板还理直气壮地写着「非高峰 ×0.5」——那个模型根本没有低谷时段。现在的规则是：

- 键名含 `deepseek` 的路由 → 峰谷价（`deepseek-official/*`、`deepseek-account/*`）；
- 其它一切路由 → 固定价，全天按表里的价格，面板显示「固定价」；
- 想覆盖就在该条目写 `peakPricing: true`（比如 DeepSeek 模型走了别的 provider 名，
  或某个转售商也分时计价）或 `peakPricing: false`（比如 DeepSeek 模型被按平价转售）。

实测（本机全部会话日志 + 已装配置）：修复前 `our-free-model/mimo-v2.6-flash-free`
合计 **¥0.945**，修复后 **¥1.8907**，正好差一倍；同一份数据里三条 DeepSeek 路由金额
一分不变（¥48.9713 / ¥10.5830 / ¥0.523）——也就是这次修正没有动到本来就正确的部分。

默认表按 [DeepSeek 官方定价](https://api-docs.deepseek.com/quick_start/pricing/) 的**高峰价**
填写，单位是**人民币元 / 百万 token**——因为 DeepSeek 账号本身以人民币计费、余额也按人民币变动。
非高峰由 `offPeakMultiplier: 0.5` 折半（官方非高峰价为高峰价的一半）：

```json
{
  "deepseek-official/deepseek-flash": { "label": "DeepSeek-V4.1-Flash", "input": 2, "cacheRead": 0.04, "output": 8 },
  "deepseek-official/deepseek-v4-pro": { "label": "DeepSeek-V4-Pro", "input": 9, "cacheRead": 0.3, "output": 27 }
}
```

> **为什么默认是人民币，而不是美元**：这是实测踩到的坑。DeepSeek 的官方文档同时给出美元价
> （Flash 高峰 `$0.3 / $0.006 / $1.2`）。早期版本照抄美元价、`currency` 写 `$`，于是同一个
> 会话显示 `$1.1262`，而平台余额实际扣了 **¥9.06**——看起来像"统计少了一个数量级"，其实是
> **币种错了**，而且因为不能拿中美汇率当 1 用，误差正好是汇率倍数。把单价表和 `currency` 都
> 换成账号自己的人民币口径后，同一个会话算出 **¥4.9610**，与平台对得上。
>
> 如果你的账号是美元计费（或你想看美元），把 `rates` 换成美元价、`currency` 换成
> `{"symbol":"$","code":"USD","perUsd":1}` 即可——**两处必须同时改**，只改一个就会差一个汇率。

**高峰时段**（官方脚注）：周一至周五 `01:00–04:00` 与 `06:00–10:00` **UTC**，
**不含中国法定节假日**——节假日全天按非高峰。窗口是规则，节假日是日历，所以后者是
`offPeakHolidays` 数据：内置 2026 年清单，**每年 11 月国务院公布次年安排后需要更新**
（不更新只会把工作日节假日按高峰算，即偏高，不会偏低）。留空就用内置清单，填了就完全替换。

这个窗口**只对峰谷价的模型生效**（键名含 `deepseek`，或显式 `peakPricing: true`）；
固定价模型不看时间，也就不会因为节假日/时段变化而算错。`offPeakHolidays` 与
`offPeakTimezone` 只在前者身上起作用。

价格会变，**请以官方页面为准**自行更新。

## 用法

### 1. 界面：消耗药丸 + 明细面板

对话输入框上方（DSH 自带统计药丸那一排）会多一个胶囊：

```
● ¥0.0138 · 129k / 1.00M ⌄        ← 圆点：灰=空闲，绿=正在跑；未配置价格时描边转警告色
● ¥10.3089 · 284k / 1.00M ⌄       ← 金额是本会话（或家族）的花费，token 数是「当前上下文」
● ¥8.2288 [含派生 4] · 144k / 1.05M ⌄   ← 派生出过子代理时：金额是「本会话 + 派生会话」
```

**token 数字刻意用 DSH 自己的口径**：`已用 / 窗口`，也就是「下一次调用要发送的长度」。
这是 DSH 自带统计显示的那个数，用它才不会让人以为两边对不上（见下面「三个 token 数」）。

**只要这个对话派生出过子代理 / workflow agent，胶囊的金额就是整个家族的花费**，并在后面
标出包含了几个派生会话——否则它会看起来比实际便宜（子代理是独立会话、独立计费，它们的
token 根本不在本会话的 `tokenUsage` 投影里，所以这个数必须问宿主）。鼠标悬停会写清全部口径：

```
deepseek-official/deepseek-flash · 本会话 ¥5.6821 + 4 个派生会话 ¥2.5467 · 家族合计 ¥8.2288
  · 整段对话累计计费 243,629,270 tokens（含缓存重读） · 本次新增 1,372,099 tokens · 当前上下文 144k / 1.05M
```

**路由一律写成 `<provider>/<model>`**（悬停提示、面板头部、`/cost`、工具返回都是），
因为 `rates` 就是按这个键写的：它指的就是你要去编辑的那一条，而且同一个模型名可能被两个
provider 提供，只写模型名分不出是哪一条。配置过的 `label` 只在有空间的地方补在后面，
如面板头部的 `deepseek-official/deepseek-flash（DeepSeek-V4.1-Flash）`。

本会话自身的金额始终在同一行里，所以与 DSH 自带统计对照时不会失去参照。

点开是一个面板（点击外部或按 Esc 关闭；展开状态记在 `localStorage`，刷新后保持）：

```
对话消耗        deepseek-official/deepseek-flash（DeepSeek-V4.1-Flash）  [非高峰 ×0.5]
对话消耗        our-free-model/mimo-v2.6-flash-free                  [固定价]   ← 这条路只有一个价，不分峰谷
██████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░   ← 金额构成条（本会话自身的构成）
■ 未命中 20%   ■ 命中缓存 2%   ■ 输出 78%      ← 图例：每种 token 的金额占比

输入 · 未命中缓存        1,000,000        ¥2.00
输入 · 命中缓存          1,000,000        ¥0.02
输入 · 缓存写入                  0        ¥0.00
输出                     1,000,000        ¥4.00
────────────────────────────────────────────────
当前上下文（DSH 统计口径）   168,962   窗口 1.00M   ← 就是 DSH 自带统计显示的那个数
本次新增（不含缓存重读）   2,000,000        ¥6.00   ← 真正新产生的 token
整段累计计费（含缓存重读）102,000,000        ¥6.02  ← 金额就是按它算的
────────────────────────────────────────────────
¥6.02                 累计 3,000,000 tokens · 缓存命中 50% · 本会话自身
────────────────────────────────────────────────
██████████████░░░░░░░░░░░                     ← 本会话 / 派生会话 金额占比
■ 本会话 61%   ■ 派生会话 39%
本会话自身                     3,000,000        ¥6.02
6 个派生会话（独立计费）        52,330,000        ¥3.23
¥9.25                 本会话 + 派生会话合计 · 55,330,000 tokens
────────────────────────────────────────────────
另有 6 个派生会话（独立计费，已计入上方金额）   +52.3M · ¥3.23
本会话 + 派生会话合计                55.3M · ¥9.25
[展开明细] [刷新]
单价来自插件配置（1 个模型）· 每 30s 自动刷新 · 估算值，以厂商账单为准
```

### 三个 token 数不是同一个量（对不上先看这里）

同一个对话可以有三个数量级完全不同的 token 数，**它们都对**：

| 说法 | 含义 | 本机实测（`session-88b3d2cb`） |
|---|---|---|
| 当前上下文 | 下一次调用要发送的长度（**DSH 自带统计显示的就是它**） | 144,366 / 1,048,576 |
| 本次新增 | 真正新产生、不重复的部分：未命中输入 + 缓存写入 + 输出 | 1,372,099 |
| 整段累计计费 | 每次调用的**完整输入**逐次相加；缓存命中的部分被反复计费 | 165,303,278 |

在这个会话里累计是上下文的 **1000 倍以上**——因为 99% 的 token 是缓存命中（便宜但确实按次计费），
所以「累计」这个数天生就很大。**金额是按累计算的**（这正是厂商计费的方式），而面板把三个数
分开列出、并写明各自含义，就是为了不让任何人把其中一个当成另一个。

另外：这三个数只统计**本会话**；胶囊金额在存在子代理时是「本会话 + 派生会话」，家族那一段会拆开。

- **金额构成条**：按每种 token 的**金额占比**画，一眼看出钱花在哪。刻意**不按 token 数**画：
  命中缓存的 token 数量很大但单价极低，按 token 数画会严重误导（实测本机某会话 98% 的 token
  是缓存命中，却只占约 50% 的钱）；
- **家族那一段**：胶囊与面板上方的金额已经包含派生会话，这一段是把它拆开——「本会话自身 /
  派生会话 / 合计」三行，外加一条本会话 vs 派生会话的金额占比条。没有子代理时明确写
  「无派生会话（…金额即本会话自身）」，而不是让你以为总数就是全部。
  点「展开明细」列出每个子会话的花费，点「刷新」重查（**强制重扫**，子代理可能是刚跑完的）；
- **本会话那一半是实时的**：它的数字来自 DSH 的 `tokenUsage` 投影（跑对话时即时更新），
  派生会话的数字来自宿主读日志。所以这一行不会为了显示子代理而滞后；
- **「与日志核对」**：把当前会话 id 发给宿主，宿主**按会话日志重算**并显示权威结果
  （来源：内存 / 磁盘日志，附完整文本报告）——判断药丸近似值是否可信最快的路径；
  注意它只核对**本会话**，家族口径请用 `/cost --family`；
- **「复制明细」**：把当前读数放进剪贴板，三个 token 口径与家族拆账一起复制；
- **未配置价格时**：药丸描边转警告色、只显示 token 数，面板里直接说明该补哪条 `rates`；
  派生会话全部未配置价格时不会显示占比条（分母不可知，不编数字）；
- **读不到 `contextPressure` 投影时**（另一种宿主/嵌入方式）：胶囊退回显示累计 token 数，
  并把 `data-cost-tokens` 标成 `cumulative`，不会空着不显示；
- 样式只用主题 token 并跟随浅色/深色；`Tag` / `Button` / `Tooltip` 原语可用时自动启用
  （高峰/非高峰徽章、按钮、悬停提示），原语缺失时降级为原生元素；
- **面板永远留在可视区内**：它挂在输入框下方的药丸上、朝上展开，而 DSH 把 composer 放在会话
  滚动区**内部**——面板真正的天花板是那个滚动区的上沿，不是窗口上沿。所以面板自带高度上限并
  **内部滚动**：样式表给一个首帧上限（`max(220px, min(64vh, 100vh - 200px))`），打开时再按
  「药丸顶边到该边界」的实测距离精确收紧（见「已知边界」里的 `clipTopOf` / `panelCeiling`）。
  内容再长——包括点「与日志核对」后多出来的那段报告——也只会让面板内部滚动，而不是把自己的
  标题、金额构成条或明细行顶出可视区；
- 纯展示，出错也只是这一行变成一行说明，不会影响输入框。

### 2. 命令 `/cost`（不花 token）

```
/cost                    当前对话的总消耗
/cost --family           再加上本对话派生出的子代理会话（subagent / workflow agent）
/cost --turns 3          只看最近 3 轮
/cost --steps 10         只看最近 10 次模型调用
/cost --detail           附上按模型、按 token 类型的单价表
/cost --all [--limit 20] 本机所有对话的消耗排行（含已归档）
/cost <标题或ID>          查另一个对话（日志还在本机时）
```

命令直接在执行它的 agent 上跑，**不产生模型消息、不花 token**。

> **`--turns` 和 `--steps` 的区别**：一轮（turn）只在模型不再调用工具时结束，所以一次真实
> 长对话常常**只有 1 轮、却包含几百次模型调用**（实测本插件开发时那次会话就是 1 轮几百步）。
> 想知道「刚才花了多少」要用 `--steps N`（= 最近 N 次计费调用）；`--turns` 适合"按提问分块"的场景。

### 2b. 子代理是独立会话，`--family` 才把它们算进来

**这是"对不上"最常见的原因**：`subagent`、`workflow` 里的每个 agent、团队协作的每个成员，
都是**独立的会话**——自己的日志、自己的账单，**默认不汇总进父对话**。

关系不是猜的，是**日志里的持久字段**：子会话在自己的 `session` 头里写
`parentSession: "session-<父 id>"`，再带 `origin: "subagent"` 与 `delegationDepth`。
本插件只读这个字段，所以：

- 跨重启、跨"会话已不在内存"都成立；
- **绝不按"日志里出现过某个 uuid"来归并**（那样会把工具输出、引用里提到的会话都算成子会话，
  我第一版就踩了这个坑，数字虚高到 4.5 倍）；
- 父会话日志被删过的空洞会**明确报出来**，而不是静默少算。

实测本机某次真实对话（**当时默认单价表还是美元，所以下面是 `$`；现在默认是人民币**，
数字也会随后续子代理继续增长）：

```
会话 session-daa390a3… 「dsh对话完成弹窗插件设计」 及其派生会话

本会话自身：136,660,898 token · $0.626（453 次模型调用）
派生会话：6 个 · 合计 52,329,984 token · $0.404
  [subagent] 8a818281…  42,625,582 token · $0.255
  [subagent] 9e9dd730…   3,030,642 token · $0.0444
  …
合计：188,990,882 token · $1.0301
```

也就是"这次对话"的账有两种口径，差 38%——两个数都对，取决于你问的是哪一个。**界面上的胶囊
与面板默认给的是后者（含派生）**，并在旁边标明"含派生 N"，同时保留本会话自身的那一行。

### 3. 工具（模型自己调）

```
session_cost(session?, turns?, steps?, detail?, includeDescendants?)
list_session_costs(limit?)
```

`session_cost` 返回结构化结果：`tokens`、四个桶、`usd`、`amount`、`amountText`、
`pricedModels`、`unpricedModels`，以及一段可读文本。目标解析**绝不猜**：
精确 id → 唯一 id 前缀 → 唯一标题片段；有歧义就报错并列出候选，一个都不统计。

## 验证

```powershell
node --test --test-isolation=none --test-force-exit test/*.test.mjs   # 166 项
```

| 文件 | 覆盖 |
|---|---|
| [test/rates.test.mjs](test/rates.test.mjs) | 单价表解析与校验、路由解析（含歧义拒答）、高峰窗口、逐桶计价与舍入、格式化 |
| [test/usage.test.mjs](test/usage.test.mjs) | usage 归一化、流内 usage 回退、按路由归属、逐 attempt 高峰/非高峰、未配置价格 |
| [test/engine.test.mjs](test/engine.test.mjs) | 多帧 zstd 解码、会话枚举与标题、目标解析（歧义/找不到）、磁盘报告、两种作用域、**与真实 DSH 日志的真值对照** |
| [test/plugin.test.mjs](test/plugin.test.mjs) | 挂载校验、两个工具的参数/输出 schema、两条 Fetch 路由、内存与磁盘两条 execute 路径 |
| [test/command.test.mjs](test/command.test.mjs) | `/cost` 参数解析、各分支、失败降级 |
| [test/client.test.mjs](test/client.test.mjs) | 模块加载器契约、插槽注册、药丸各状态、**三个 token 口径的区分**、**含派生的合计口径与拆账**、核对按钮、**可编辑单价表（增删、校验、货币标注、保留高级字段）** |
| [test/family.test.mjs](test/family.test.mjs) | 持久父子链解析、头行-only 读取（含损坏帧的降级）、家族遍历与深度、缺失父日志、自身/派生/合计、渲染、**家族索引缓存的命中/失效/上限** |
| [test/install.test.mjs](test/install.test.mjs) | 受管 patch 块是**合法 YAML**、block scalar 解出的是插件要的 JSON 文本、幂等/可回滚/适配各种 patch 形态 |

除离线测试外，另有三道"对着真东西"的验证——前两道是 `_recon/` 下的脚本（不属于发布包），
第三道在仓库里、且需要浏览器所以是可选的：

- **对真实包做加载**：从 `app.asar` 抽出真的 `@deepseek-ai/dsh-tools`（0.2.0-rc.2）与
  `@deepseek-ai/schemastery`（3.18.4），用真的 `defineTool` 与真的 `Config` schema 挂载两行并
  执行工具/命令——离线 stub 证明不了"注册表是否接受这些 schema"，这一步能（21 项全 PASS）。
- **逐会话与 DSH 自己的账本对照**：拿本机 **41 个真实会话**，把每个会话日志折叠到它自己的
  `tokenUsage` 投影检查点水位，与本插件的折叠**逐字段比对 → 41/41 完全相等**。
- **在真实 DSH 里跑**：
  - 宿主侧：本次会话的工具列表里出现了 `session_cost` 与 `list_session_costs`，`session_cost`
    实测返回本对话 55.9M token / $0.343（**当时默认单价表还是美元**；数字随对话继续增长）；
  - 客户端侧：`cordis_inspect_query`（client / `Slots`）显示本插件注册的三个占位**全部 active**——
    `conversation.composer.dock` 下的 `session-cost`（order 60，紧邻自带 `stats`），以及
    `plugins.row.config` 下 `@local/dsh-session-cost#session-cost` 与 `#session-cost-command`。
    占位 active 即证明浏览器已加载并执行了 `lib/client.js`（bundle 由 DSH 按
    `/plugins/<包名>/client.js?rev=<文件哈希>` 提供）；
  - 同一次查询确认该插槽会下发 `useProjection: UseProjection`，而本插件使用的
    `useProjection("tokenUsage")` 单参调用形态与自带 `StatsPills` 完全一致。

第三道验证针对**面板的高度上限**：它是几何，离线单测只能验算术，验不了"面板会不会被裁"。
[test/ceiling-check.mjs](test/ceiling-check.mjs) 生成一个 DSH 形状的页面（composer 在
`overflow-y:auto` 的滚动区里、底部是 sticky 的席位），把**发布用的样式表**与**发布用的
`clipTopOf` / `panelCeiling`**（从 `lib/client.js` 原样抽出，不重写）装进去，再用无头 Chromium
跑两种窗口尺寸。它需要浏览器，所以**不在** `npm test` 里（脚本名不是 `.test.mjs`）：

```powershell
node test/ceiling-check.mjs "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
```

```
window 2582x1485 (viewport 2552x1390)
  natural    1273px tall, top   75 vs port 141 → insidePort false  ← 无上限：面板顶部越过边界 66px
  stylesheet  890px tall, top  458 → insidePort true,  scrollable true
  measured   1206px tall, top  142 → insidePort true,  scrollable true, reachedBottom true
window 1600x780 (viewport 1570x685)
  natural    1273px tall, top -630 vs port 141 → insidePort false  ← 无上限：越界 771px
  stylesheet  438px tall, top  204 → insidePort true,  scrollable true
  measured    501px tall, top  142 → insidePort true,  scrollable true, reachedBottom true
```

同一页里量出三种几何：**无上限**（bug 的形状：面板顶部越过滚动区上沿）、**只靠样式表**
（首帧上限）、**实测上限**；后两者都断言在边界内、面板可滚动、最后一行可达。

最有力的一条在 [test/engine.test.mjs](test/engine.test.mjs)：`test/fixtures/real-deepseek.*`
取自一个**真实 DSH 会话**（只保留该折叠读取的事件，逐字节原样），
`.expected.json` 里带着 DSH 自己的 `tokenUsage` 投影为该会话记录的累计值——
本插件的折叠必须与它**逐字段相等**：

```
attempts=37  uncachedInputTokens=60520  cacheReadTokens=2784512  cacheWriteTokens=0  outputTokens=33975
```

（`step/end` 与 `assistant/message` 在真实日志里一一对应，这正是"按 assistant/message 折叠"
能与 DSH 投影相等的原因；同一断言守着这条不变式。）

## 已知边界

- **药丸显示「金额统计不可用：HTTP 400」**（已修复，留作排查参考）：`connection.fetch.register` 的
  `requestBody` 不是"这条路由收不收 body"，而是连接层的**读取模式**，取值只允许
  `'buffered' | 'streaming'`（`ConnectionRequestBodyMode`）。当时传了 `"none"`：共享处理器因此走
  streaming 分支，为 GET 构造带流 body 的 `Request`，平台直接抛
  `TypeError: Request with GET/HEAD method cannot have body` → 页面拿到 400。宿主的
  `assertFetchRoute` 只校验路径与方法，**不会**拦住这个取值。改成 `"buffered"` 即可（GET 的缓冲
  body 就是空，处理器也从不读它）。`test/plugin.test.mjs` 现在守着"每个路由的 `requestBody` 必须
  是这两个值之一"这条契约。
- **只处理本机 `$DSH_HOME`**；远程 Host / 多 profile 需在行配置里指定 `dshHome`。
- **摘要不建模**：命中/未命中缓存按 provider 上报的桶直接计价，不做自己的 tokenizer；
  只有"未上报 usage"的调用才回退到流内 chunk，两条都拿不到就**不计入**（宁可少算不虚算）。
- **药丸是近似的**：客户端只拿到会话级 `tokenUsage` 聚合，拿不到"每次调用用的是哪个模型"，
  所以本会话那一半按当前模型计价；换过模型时用 `/cost` 或「与日志核对」。
- **金额单位跟着 `currency`**：默认人民币（账号口径）。换成美元必须**同时**改 `rates` 与
  `currency`，只改一个就会差一个汇率——这正是早期版本"少了一个数量级"的原因。
- **节假日清单会过期**：`offPeakHolidays` 内置到 2026 年；次年未更新时，工作日节假日按高峰价
  算（偏高，不会偏低）。
- **家族合计的两半来自不同来源**：本会话那一半是实时投影，派生会话那一半是宿主读日志，
  所以合成数字的最后几位在跑对话时会有微小抖动；宿主侧的家族索引按「日志列表指纹」做了缓存，
  同一份日志列表只扫一次，日志一被写长（有人正在对话）就是新指纹、自动重扫。
- **显示位数**：金额按量级选有效数字（极小金额给到 7~8 位小数），所以极小的两笔相加后
  末位可能与手算差 1 个最小单位——内部一律整数最小单位、逐桶各舍入一次，
  上方「合计」也由这些已舍入的整数相加而成，不存在二次舍入丢失。
- **压缩/裁剪不改变历史账单**：统计的是**整段日志**（`tokenUsage` 投影的语义），
  不是当前上下文窗口；被压缩掉的内容仍然算钱，因为它们确实被计费过。
- **面板的高度上限是量出来的，不是猜的**：`clipTopOf` 沿祖先找声明了 overflow 的盒子、取最靠近
  药丸的那条上沿（DSH 里就是会话滚动区），`panelCeiling` 用它算出上限，窗口改变大小时重算；
  量不到 DOM 时（测试、非浏览器宿主）回退到样式表里的视口上限。上限有 220px 地板：窗口小到连
  它都放不下时，宁可让面板被裁一点也不缩成一条缝。因为量的是「最近的裁剪边界」，DSH 再往
  composer 上套一层 overflow 盒子也不失效；反过来，祖先链上若**一条可读的 overflow 都没有**，
  面板会退回按窗口上沿计算，顶部仍可能被裁（那条路径由 `test/ceiling-check.mjs` 之外的
  单元测试守着算术，几何本身见「验证」一节）。
- 金额一律是**估算**；与厂商账单对不上时以账单为准。

## 目录结构

| 路径 | 作用 |
|---|---|
| [lib/rates.js](lib/rates.js) | 纯逻辑：配置解析、路由解析、高峰窗口与节假日、整数最小单位计价、格式化 |
| [lib/usage.js](lib/usage.js) | 纯逻辑：会话事件 → 按路由的 token 桶 + 金额 |
| [lib/engine.js](lib/engine.js) | 磁盘半边：多帧 zstd 解码、会话枚举、目标解析、路径守卫 |
| [lib/report.js](lib/report.js) | 共用流程与文本渲染（工具与命令同一份） |
| [lib/index.js](lib/index.js) | Cordis 行：`session_cost` / `list_session_costs` + 两条只读 Fetch 路由 |
| [lib/command.js](lib/command.js) | Cordis 行：`/cost` |
| [lib/client.js](lib/client.js) | 浏览器半边：💰 药丸 + 明细面板 + 核对按钮 + 插件页配置表单 |
| [cordis.patch.yml](cordis.patch.yml) | bundle 层：声明两行 |
| [install/install.mjs](install/install.mjs) | 安装/卸载（幂等、带备份） |
| [test/](test/) | 离线测试与真值夹具 |

