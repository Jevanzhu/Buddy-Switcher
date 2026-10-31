---
name: dsh-project-harness
version: 0.1.11
display_name: 决策记录与工程治理门禁
display_name_en: DSH Project Harness
description: >-
  Decision records and executable engineering gates in one skill — 决策记录 / ADR /
  设计文档 / 技术方案 / 归档 / 文档管理 / 文档链 / 活账 / 工程规范 / 代码评审 /
  注释卫生 / 门禁 / 质量体系 / AGENTS.md / 测试可靠性 / 派活. Use when writing or
  auditing decision records (.agents/notes, archiving), setting up repository rules
  and gates, enforcing doc budgets, landing review reports, reviewing a PR, or
  dispatching sub-agents.
description_zh: >-
  单一技能同时承载决策记录与工程治理门禁：决策记录（ADR）的格式、生命周期、双语配对与冻结归档；文档层级与字数预算、Markdown 门禁、bootstrap 脚手架、统一 gate runner、代码评审、测试可靠性、agent 派发纪律。
description_en: >-
  Decision records and executable engineering gates in one skill: ADR format,
  lifecycle, bilingual pairing and frozen archiving; documentation hierarchy and
  word budgets, Markdown gates, bootstrap scaffolding, a unified gate runner, code
  review, test reliability, agent dispatch discipline.
---

# DSH Project Harness

本包把两套能力装进一个目录：**决策记录**（agent-notes——一条决策怎么被记录、推翻与归档）与**工程治理门禁**（project-harness——规则住在哪里、怎么变成可执行的检查）。当干活的主体是 agent 时，任何没写进文件、没接进检查的规则都等于不存在。

这不是一份清单，而是一套判据。规则会互相冲突（预算 vs 完整性、速度 vs 覆盖），冲突时要靠理由判断，不能靠背条款。

本包曾以 `agent-notes` 与 `project-harness` 两个分离技能发布，`0.1.11` 起统一为一个技能：`references/`、`scripts/`、`templates/` 并入本包成为正本，本文件是合并叙述的门面。

## 加载与使用前提

客户端通常只加载本文件正文；`references/` 与 `templates/` 不会自动进入上下文。

正文里的相对路径都相对本 skill 目录，加载结果会给出这个基目录；只读正文就动手，等于只加载了摘要。

**按任务先读对应的参考档，再开始动手：**

| 任务 | 先读 |
|---|---|
| 写提案、已实施或否决记录 | [references/format.md](references/format.md)、[references/classification.md](references/classification.md) |
| 归档、封存、删旧笔记 | [references/archiving.md](references/archiving.md) |
| 启用双语配对 | [references/bilingual.md](references/bilingual.md) |
| 写、迁、归档任何文档 | [references/doc-lifecycle.md](references/doc-lifecycle.md) |
| 决定规则住哪、写多长 | [references/doc-governance.md](references/doc-governance.md) |
| 派活、审计、通读 | [references/agent-work.md](references/agent-work.md) |
| 加门禁、接 CI、核对宣称值 | [references/gates.md](references/gates.md) |
| 换客户端、技能没生效 | [references/client-loading.md](references/client-loading.md) |

文档任务的交付面按 doc-lifecycle 的槽位落，仓根和临时工作目录不算交付；落位与索引、活账在同一改动里更新（细节只在 doc-lifecycle 写一遍）。

# 决策记录

Agent Notes 是给 agent 写、也给 agent 读的 RFC：它记录一个决策，以及**这个决策击败了什么**。代码能说明「是什么」，注释能说明「这一行为什么」，但只有决策记录能说明「当初还考虑过哪三条路，为什么都没选」。

## 什么时候写、什么时候不写

写：存在**持久的决策理由**——被放弃的备选方案、负面保证、所有权边界、持久化或协议语义、安全规则、重新引入的条件。这些内容无法从代码或测试中还原。

不写：机械改动、局部 UI 调整、拼写修复、格式化、依赖升版。判断标准是「三个月后有人想推翻这个决定，他需不需要看到当初的理由」。不需要，就别写。

同一个决策只允许一个 owner。要记录新决策时，先搜活跃树里有没有覆盖同一机制的旧笔记：有就**在原地更新它**，不要新建一篇重复的。真的推翻了旧结论，才写新笔记并交叉链接。

## 生命周期即路径

格式是 `{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`，两个维度都编码在路径里，日期取**该主题首次被提出的那天**（查 git 历史，不是写文件的今天）。

目录名（英文语料 / 中文语料）：

| lifecycle | 含义 |
|---|---|
| `proposed/` · `提案中/` | 已评审但尚未落地（或只落了一部分）。可以用将来时态、写迁移计划。 |
| `implemented/` · `已实施/` | 决策已交付。必须用现在时描述**已存在的事实**。 |
| `rejected/` · `已否决/` | 考虑过并否决了。只在它的理由能防止一个诱人的错误时保留。 |

**声明一次，拼写全树**：语料的主语言（`.agents/notes/harness.json`）同时决定骨架标题和目录名——中文语料从 lifecycle 到文件名主干一路中文，两种拼写不混住一棵树。拼错了门禁会点名期望的名字。

class 是决策的种类，取值封闭：`feature`/`功能`（新的用户或模型可见能力）、`bug-fix`/`缺陷修复`、`simplification`/`简化`（删代码或表面积、不加能力）、`architecture`/`架构`（**交付源码**的结构决策）、`process`/`流程`（**围绕代码**的工具链与工作流）、`testing`/`测试`。

`architecture` 与 `process` 的分界线：架构管我们交付的源码，流程管外围的工具与工作流。`refactor` 被刻意排除——「可观察行为是否改变」这个判据已经被 `simplification` 覆盖。归类判断见 [references/classification.md](references/classification.md)。

## 骨架是强制的

每个 lifecycle 有固定的 section，门禁逐条校验：

- **proposed/**：`## Problem`（必须第一个且脱离解法也能独立成立）→ `## Proposal` → 可插入自定义技术小节 → `## Alternatives considered` → `## Acceptance criteria` → `## Risks`
- **implemented/**：`## Problem` → `## Decision`（现在时）→ 自定义小节 → `## Alternatives considered` → `## Consequences`（代价**和**收获都要写）。**禁止**出现 `## Proposal`、`## Plan`、`## Migration plan`、`## Acceptance criteria`——那是提案期的措辞，门禁会直接报错。
- **rejected/**：保留提案期的结构，判决写在 `Status:` 行上。

`## Alternatives considered` 一篇都不能少。没记录「击败了什么」的决策会反复招来重开争论——这正是决策记录存在的意义。每条备选一段，粗体起头；先写该方案最强的理由，再写为什么否决——只否掉弱处等于没评估过它。

头部三行同样是强制的，门禁逐行比对：第 1 行 `# Agent Note: <标题>`、第 2 行空行、第 3 行 `Status: <状态>`、第 4 行空行。`Status:` 全文件只能出现一次，且必须与所在目录一致；`rejected` 必须在破折号后给出理由。

脚手架在 [templates/](templates/) 下每种语言三份——`implemented.en.md` / `implemented.zh.md`、`proposed.*`、`rejected.*`——按你要写的语言各取一份。格式细则见 [references/format.md](references/format.md)。

## 双语：按需启用

缺省是单语：**没有对照文件、没有一致性记录，门禁不施加任何双语要求**。要用中文主语言或维护中英配对时才启用——

- 主语言声明在 `.agents/notes/harness.json`（`{ "primaryLanguage": "zh" }`，缺省 `en`）；它一次定下三件事：正文件 `foo.md` 的语言、每个文件的骨架标题、目录名与文件名主干。**怎么选**：语料语言跟仓库自己的散文走——常驻档、`docs/`、提交信息是中文就选 `zh`，否则留缺省 `en`；上游语料是英文，所以缺省是 `en`。换语言是显式动作：声明改了，整棵树（三个 lifecycle 目录、六个 class 目录、归档容器、文件名主干）跟着移，门禁按声明逐条点名拼写不符的目录。
- 配对一旦存在就按「一对即三个文件」走：正文件、对照文件、`foo.i18n.yaml` 分节一致性记录；门禁按**文件存在**启用切换行、逐节镜像、记录校验三组规则。
- 改完任一侧（含改标题），同一改动里更新对侧并重录：`node scripts/verify-agent-note-format.ts --write`；它只重录结构已过关的配对。

完整契约（各语言骨架与中文标题别名表、切换行形状、镜像规则、记录文法、归档转换）见 [references/bilingual.md](references/bilingual.md)——只在真要写对照文件时读。

## 「事实新鲜」与「决策冻结」的双面约束

这是整套机制的核心张力，两个方向都必须守住：

- **事实必须永远新鲜**（[references/format.md](references/format.md)）：路径、包名、默认值、机制变了，**必须在同一个改动里原地改写笔记**去匹配现实。不许追加变更历史，不许写「原先是……现在改成……」。
- **决策永远冻结**：改事实不是改结论的许可证。推翻决策必须新写一篇并交叉链接，或者按合并规则把旧笔记彻底并进来再删。绝不能悄悄把旧笔记改写成相反的意思，也不能拿 git 历史当作理由的唯一副本。

## 归档

活跃树会无限增长，所以有 `archived/`（中文语料为 `归档/`）。归档的判据是**语义**，不是字数或年龄——上游语料的校准例子里，533 词的局部 UI 笔记被删掉了，248 词的 event-sourced sessions 笔记被留下了。

流程与纪律见 [references/archiving.md](references/archiving.md)。最要紧的一条：**封存之后不可变**。归档树由一份 append-only 的 `manifest.json` 内容哈希清单钉死，任何对已封存字节的改写——哪怕只是重排格式——都会被门禁拒绝。这不是保守，是因为归档笔记一旦可以被悄悄编辑，「历史没被改写」就不再有任何保证。

# 工程治理门禁

## 四条组织原则

**一、一个事实一个家。** 每条规则、每个事实只在一个文件里定义，其他地方链接过去。重复的规则会分叉，分叉的规则会让人不知道该信哪个。层级划分见 [references/doc-governance.md](references/doc-governance.md)。

**二、本地薄、CI 厚。** 提交钩子只做「立刻能修的小事」——格式化、空白检查、门禁校验。完整的测试矩阵、平台矩阵、覆盖率、构建产物验证交给 CI。理由不是省时间，是**本地全量跑会让开发者学会用 `--no-verify`**。

**三、门禁必须能失败，而且必须证明过它会失败。** 一个从没红过的检查等于装饰。新写任何门禁后，立刻制造一个违规输入确认它真的拒绝——`a guard that passes both ways guards nothing`。

**四、不可机械判定的规则交给评审。** 门禁管「文件在不在、链接通不通、预算超没超」；「这段话是否准确」「这个抽象是否正确」交给人和 agent 的评审。不要为了自动化而假装能判断语义。诚实声明边界的例子：「绿灯意味着在这些确切内容上确认过一致性，不意味着确认本身可靠」。

## 从零建立

```sh
node <skill-dir>/scripts/bootstrap.ts --target <repo> [--notes-language en|zh] [--dry-run]
```

`<skill-dir>` 是已安装副本 `<repo>/.agents/skills/dsh-project-harness`（本仓源码布局为 `skills/dsh-project-harness`）。

它会建好 Agent Note 生命周期树与归档清单、按目标仓库实测词数算出文档预算、把校验器复制到 `<target>/scripts/harness/`（**复制而非引用**——CI 和任何 clone 者必须能独立跑门禁），并列出需要你决策的剩余步骤。详细流程见 [references/bootstrap.md](references/bootstrap.md)。

**运行要求：Node ≥ 24**（门禁是 TypeScript 源文件直跑，靠 Node 的类型剥离特性）。版本下限的声明点是 `package.json` 的 `engines`，这里写的是副本。别把版本当成「装的时候对一次」的事：校验器副本不随 skill 自更新，而偏旧的 Node 上有些组合会让门禁**静默退出 0** 而不是报错——判断手上这一套装的是哪一版，看 `scripts/harness/version.json`。见 [references/gates.md](references/gates.md) 的「入口判断与运行版本」。

## 已有项目：别砸红墙

**目标仓库已经有内容时，加 `--adopt`。**

```sh
node <skill-dir>/scripts/bootstrap.ts --target <repo> --adopt
```

直接把门禁装到一个有历史的仓库上，它会立刻抓到几年积累下来的所有死链、所有折行段落，而它**没有能力区分「历史遗留」和「你这次改坏的」**。一堵第一天就全红的门禁，第二天就会被关掉。

`--adopt` 把当前已存在的违规记进债务台账 `scripts/harness/baseline.json`，门禁从此只拦**新产生**的违规。台账是棘轮，只能变小：默认拒绝扩张（新的违规要显式 `--accept-new` 才能记进去），陈旧条目每次运行都会提示你可以删除。

这条设计和文档预算用的是同一个原则——**从实测值起步，而不是从理想值起步**。两者都只保证「只能变好」，不假装「立刻就好」。已装好的仓库也可以随时手工补记：任何带台账的门禁都接受 `--write-baseline`。

## 主体职责

### 门禁图

门禁是数据对象，不是一堆脚本。每个门禁声明 `needs`（前驱失败则跳过）与 `after`（只排序、不阻塞）两种依赖——这个区分解决真实的并发冲突：一个会重写共享产物的测试不该和读它产物的检查并行，但也不该在它失败时被跳过。

聚合模式（`run-gates.ts` 的 `MODES` 表）让分支保护只要求**一个**稳定的检查名，而不是枚举会随版本变化的矩阵腿。运行器在 [scripts/run-gates.ts](scripts/run-gates.ts)。设计与取舍见 [references/gates.md](references/gates.md)。

### 提交前的证据选择

按改动**触及的面**选最小充分证据，不要反射式跑全量：

| 改了什么 | 跑什么 |
|---|---|
| 行为逻辑 | 拥有该行为的那个测试文件（且必须有会因该回归而失败的用例） |
| 文档 / 决策记录 | 文档门禁 |
| 公开导出 / 构建配置 | 构建 + 产物冒烟 |
| 模型或用户可见输出 | 对应的快照 |

推送前**不要**为了「再确认一次」重跑已经通过的检查。反过来，`Do not push and hope CI differs.` 细节见 [references/pre-push.md](references/pre-push.md)。

### 语言面与配对

每个文件属于哪个面，决定它用哪种语言：**被执行面**（指令、配置、模板）单语，语言 = 仓库工作语言，**永不配对**——要换语言就整体迁移一次；**被理解面**（README、`docs/`、决策记录）跟随主语言，需要双语时只在这一面配对照。采用方的起步模板按 `--notes-language` 出 en/zh 两版，由 bootstrap 选。判据（「这条改了，需要谁点头？」）、四类清单与执法边界见 [references/language-policy.md](references/language-policy.md)。

### 文档层级与预算

每个层级有明确的职责边界和「不属于这里」的清单。字数预算按「空白分词 + 每个汉字另计一词」计数——中文没有词边界，只数空白分词会让中文文档在任何上限下都通过；只在超限和文件缺失时失败，超限的处理顺序是**迁移 → 精简 → 提高上限**，且提高上限必须在同一个改动里给出理由。`A too-low ceiling is a budget bug.` 见 [references/doc-governance.md](references/doc-governance.md)。

### 文档链

常驻文档管「事实住哪」；链管「一件事从提出到了结走哪些档」：索引（导航）、活账（未了结事项的唯一清单）、槽位目录（评审／设计／执行／调研／规范）、归档（明说的冻结）。判据包括：活账一行一条、只记「一句结论 + 指针」；评审必须给出通过／有条件通过／退回之一；归档前核验内容与历史一致、未了结的事先立开放项、归档 commit 号留痕。`verify-doc-index.ts` 强制索引与槽位一一对应——契约是仓库数据（`scripts/harness/doc-index.manifest.json`，`{}` 即不带链）。见 [references/doc-lifecycle.md](references/doc-lifecycle.md) 与模板 [templates/ledger.zh.md](templates/ledger.zh.md)、[templates/docs-index.zh.md](templates/docs-index.zh.md)（英文采用方用同名 `.en.md`）。

### 宣称值对账

文档里写下的数字与清单是**副本**，不会自己更新。`verify-doc-claims.ts` 把每条宣称（数字或清单 + 源头命令）与命令的实测输出对账：`expect: atLeast` 是把「门禁表只增不减」这类下限变成机器可判的形态，`list` 类管「新增了目录而文档没提」。同一事实只在一个地方写数值，别处指过来。这个门禁**有意不挂台账**——改一个错数比记一笔错账便宜。契约是仓库数据（`scripts/harness/doc-claims.manifest.json`，`{}` 即无宣称），见 [references/gates.md](references/gates.md)。

### 技能可加载性

技能装进目录不等于会被用上：客户端只把 `name` + `description` 投影成常驻目录，`description` 超长会被截断、尾部触发词对模型不可见，自动路由于是永远命不中；而这类失败是静默的——技能在目录里，日志里没有红。`verify-skill-catalog.ts` 把「能被加载」做成机器可判：声明的技能根必须存在，每个技能档的 `name` 合法且与目录名一致，`description` 归一后不超过 manifest 声明的上限，扫到零个技能档判红。**它判不了描述质量与语义遵守**——那落在评审与派发任务书（见「Agent 工作纪律」）。契约是仓库数据（`scripts/harness/skill-catalog.manifest.json`，`{}` 即不带技能根），机制细节、根优先级与四种断点见 [references/client-loading.md](references/client-loading.md)。

### 注释卫生

注释只写代码作用与需要说明的东西（约束／不变量／语义／平台差／同步关系），**修复史归 git**。机器判据分两族，缺一不可：写进注释的编年史（日期、轮次、批次括注）与**清理后的残形**（括注被切空、只剩破折号）——只做前者时，清理器留下的半痕会被判成干净。**字面量是红线**：扫描器只读注释面，字符串、模板串、正则里的标签样文本永不报告，清理工具不得触碰生产字面量。例外与「被测试钉住的注释」都进 manifest 显式登记——各带理由与钉住它的测试，陈旧时门会催删。扫描面不可信（根缺失、零文件、不可读）时 fail-closed 报红且不入台账。见 [references/comment-hygiene.md](references/comment-hygiene.md)。

### 散文标准

编辑文档、注释、JSDoc、提示词、面向用户的字符串时的标准。核心是**保留完整命题**：删字之前先逐条识别 actor/action、条件与时序、情态（must/may/never）、负面保证与例外、所有权与副作用、失败模式。`A smaller word count alone is not an improvement.` 见 [references/prose-standard.md](references/prose-standard.md) 与 [references/prose-examples.md](references/prose-examples.md)。

### 错误处理

类型化失败、处理归属、围堵范围、可见报告。三条最常被违反的：`Logging alone is not recovery`、`Catching limits exception propagation, not mutations`（只有受影响状态的所有者才能确立安全续行）、`Never claim success, rollback, or safe retry without guarantees`。见 [references/error-handling.md](references/error-handling.md)。

### 代码评审

评审的目标排序是正确性、生命周期、安全、必需行为**先于**风格。`一条有据可依的阻断项胜过一串 nit`。关键的一条流程要求：先核实 PR 的真实 base 与 head，再看 diff。见 [references/review.md](references/review.md)。

### 测试可靠性

并发下非确定性失败的根因分类与修法。核心是**拒绝掩盖型修复**——加长超时、加重试、跳过的测试不是修好了，只是不再报告问题。两条配套纪律：**先判该不该写**（一条改动 = 一条回退即变红的用例；断言只锚对外可观察面），**表面绿而覆盖消失是门禁的事**（`.only` 一律红，无条件 `.skip` 红，条件式环境门合法——`verify-test-hygiene.ts`）。见 [references/test-reliability.md](references/test-reliability.md)。

### Agent 工作纪律

派活与动手的判据，多数以文字存在而不是门禁（能机器判定的部分已落到别处）。**任务书三件**——靶点、验收判据、不读面，缺件先问再动：agent 的真实成本不是输入贵，而是范围无界。**先定位后阅读**：检索定靶 → 只读命中文件与一跳调用方，结论锚 `file:line`，不写阅读流水账；确需通读先报范围与理由。**通读即专项**：只在作者明示的审计任务下成立，审计只产报告、修复另开靶向任务。**子 agent 单波 ≤4**：上限跟复核能力绑定，不跟核数绑定。**一个批一个主题**：挂账项与待拍板各自成批，夹带的另开批。**提交与对外文案**不引作者指令原文，决策以结论转述。见 [references/agent-work.md](references/agent-work.md)。

### 历史与归档

PR 历史怎么组织、堆叠 PR 怎么落地、什么时候 merge-forward 什么时候 rebase、重写历史的纪律。最硬的一条：`Raw --force is never allowed`，改写必须用带 lease 的形式并在远端移动时中止。见 [references/history.md](references/history.md)。

### 治理模型（团队化时可自建的部分）

加权审批、Issue 看板状态机、发布序列、双语配对——这些机制在上游项目里运作良好，但都依赖组织级基础设施（GitHub App、Projects v2、Python + Pygments、多发布序列）。它们**没有**随本 skill 提供可运行代码。若你将来团队化，[references/governance-model.md](references/governance-model.md) 讲清了每个机制解决什么问题、核心算法是什么、按什么顺序自建最划算。

## 门禁

脚本在 [scripts/](scripts/) 下，纯 Node 直跑，无任何 npm 依赖：

```sh
node scripts/verify-agent-note-classification.ts   # 路径、目录、文件名
node scripts/verify-agent-note-format.ts           # 头部、Status、必需与禁止的 section、双语配对
node scripts/verify-agent-note-format.ts --write    # 重录配对的一致性记录（只盖结构过关的配对）
node scripts/verify-archived-agent-notes.ts        # 归档三件套、封存哈希、基线比对
node scripts/verify-archived-agent-notes.ts --write # 封存新增归档（只追加）
```

全部支持 `--root <path>`，不带参数时从 cwd 向上寻找含 `.git` 或 `.agents/notes` 的祖先目录。主语言与是否要求配对由 `.agents/notes/harness.json` 声明（字段 `primaryLanguage`、`pairedDocuments`）。新仓库的脚手架和门禁安装用本包的 `bootstrap.ts`。

CI 里请用 `HARNESS_ARCHIVE_BASE_REF` 传入受信的基线提交（PR 的 base SHA），否则复用 runner 的浅检出可能让基线比对失效。

## 模板

[templates/](templates/) 下有起步用的骨架，每份按语言两版（`<名>.zh.md` / `<名>.en.md`，`lefthook` 为 `.yml`；模板名里的语言标签标的是模板自身的语言）：`AGENTS.zh.md`（standing orders 层，含工作语言声明与「指令面永不配对」）、`docs-AGENTS`（文档层级与预算）、`ledger`（活账）、`docs-index`（索引）、`lefthook`（薄提交钩子）。bootstrap 按 `--notes-language` 选版；`AGENTS`、`docs-AGENTS`、`lefthook` 三份只在**首次铺装**时写入目标仓（升级重跑不复活已删的起步文件），另两份由采用方按提示自行起步。

派活时由派发的人从模板目录取用 `agent-brief`（中英两版：[templates/agent-brief.zh.md](templates/agent-brief.zh.md)、[templates/agent-brief.en.md](templates/agent-brief.en.md)），它含交付面落位与验收命令。

## 整合与上游

本包内两个职责域的分界：**决策记录的格式与生命周期**（格式、骨架、配对、归档）对上**工程治理**（文档层级与文档链、注释卫生、门禁、技能可加载性、评审、错误处理、测试可靠性、历史与发布纪律、agent 派发与阅读纪律）。两者都涉及 `.agents/` 下的内容：写决策记录时按前者的格式与生命周期，制定「规则住在哪个文件」时按后者的文档层级；两者冲突时，格式与生命周期以决策记录域为准。

本仓曾以 `agent-notes` 与 `project-harness` 两个分离技能发布，`0.1.11` 起统一为本包；仓库自己的技术栈（包管理器、测试框架、语言）不在此 skill 的管辖范围——模板与示例只给判据，具体命令由你在 `run-gates.ts` 的门禁表里填。
