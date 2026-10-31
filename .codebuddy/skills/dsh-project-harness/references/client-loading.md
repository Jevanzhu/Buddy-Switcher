# 客户端加载

采用方装好技能后最常问的三个问题是：这个客户端到底会不会加载它、加载到了哪一步、为什么加载了却没照做。这份参考档把这三个问题拆成可观察的事实与判据：技能在客户端里经过两次加载，第一次只到目录摘要，第二次才取正文；`references/` 与 `templates/` 不在任何一次自动加载里，只能由正文里的指针带过去。

本档讲机制与失败模式，不讲怎么编写技能正文。文中的 `<...>` 是占位符，不是字面路径；按任务先读哪些 references 的索引在 [SKILL.md](../SKILL.md) 的「加载与使用前提」一节，派发纪律在 [agent-work.md](agent-work.md)。机制描述以随包实现为准：`@deepseek-ai/dsh-skill-filesystem` 负责发现与监听，`@deepseek-ai/dsh-skill` 负责合并目录与加载，`@deepseek-ai/dsh-tool-skill` 负责渲染目录与 `skill` 工具。

## 加载是两段：目录常驻、正文按需

**第一段：目录常驻。** 会话第一次请求之前，客户端把当前工作区所有模型可调用的技能投影成一份目录（catalog）：一条持久的用户角色消息，每行一条 ``- `<name>`: <description>``。目录只有名字与有长度上限的描述，没有正文，也没有 `whenToUse`、来源或提供方元数据；成员、描述或可见性变化时，客户端追加一份完整的替换目录。

**第二段：正文按需。** 模型判断任务与某条描述相关后，调用 `skill` 工具并给出精确技能名；工具返回该技能当前的完整正文，包在 `<skill_content name="...">` 里，同时给出资源指引。这一次调用只带来 `SKILL.md` 正文——相对整个技能包，正文是摘要层，细节层仍在 `references/`。

**一次加载只到摘要。** `references/`、`templates/`、`scripts/` 既不在目录里，也不在 `skill` 的返回值里——返回值只有正文与资源指引。它们要由模型在读完正文后自己用文件工具读；客户端最多给出基目录，并提示 `Load referenced resources only as needed`，「哪些算需要」由正文规定，不由客户端推断。正文没有写明先读哪几份 references，等于这次加载只拿到了摘要。

**资源路径相对技能目录。** 加载结果在 `<skill_resources>` 里写 `Base directory for this skill: <path>` 与「相对基目录解析」的提示；正文里的相对路径一律相对这个基目录拼。目录包的基目录是 `<root>/<name>/`，扁平档（`<name>.md`）的基目录是被扫描根 `<root>/`。若资源指引只写 `Resources for this skill are managed by provider "<provider>"` 而没有基目录，说明该提供方不暴露文件系统基址，相对路径没有可解析的锚点。

**用户 `/name` 是第三条路径。** 用户显式输入 `/name` 时，正文以注入方式进入该步骤，不需要模型自己调工具；它的机制与客户端差异见第七节。

## DSH 的根与优先级

DSH 的文件系统 provider 按 rank 扫描固定根，rank 数值小的先被采信：

| source | 根 | rank |
|---|---|---|
| `project-dsh` | `<项目根>/.dsh/skills` | 100 |
| `project-agents` | `<项目根>/.agents/skills` | 200 |
| `custom` | `customSkillDirs` 配置的目录 | 300 |
| `user-dsh` | `<dshHome>/skills` | 400 |
| `user-agents` | `<agentsHome>/skills` | 500 |
| `bundled` | `bundledSkillDir` 配置的随包根 | 600 |

**项目根**是从当前工作目录向上找到的最近一个含 `.git` 的祖先；一路到盘符根都找不到 `.git` 时退回当前工作目录。技能发现只看每个根的直接条目，不递归子目录。

**为什么默认把技能装 `.agents/skills`。** 这个根是跨客户端共享约定：`dsh-agent-instructions` 从同一个 `<agentsHome>` 读用户全局 `AGENTS.md`，其它 agent 工具也认这个位置。项目级装 `<repo>/.agents/skills`，用户级装 `<agentsHome>/skills`，装完即可被 DSH 发现，同时不失去跨客户端共享语义。

**同名冲突的裁决。** 同一层内按上表的 rank 升序先到先得，被遮蔽的一方只在客户端日志留一条 warn；跨层时近作用域（agent preset 层）整体遮蔽全局层。要让某个技能的副本压过共享根里的同名技能，才用 `<项目根>/.dsh/skills`（rank 100）；没有压制需求时放 `.dsh/skills` 只是失去跨客户端共享。

**`~/.agents` 可能整棵不存在。** `agentsHome` 的解析优先级是显式配置、`$DSH_AGENTS_HOME`、`~/.agents`；解析只计算路径，不创建目录。所以文档里的命令一律写 `<skill-dir>`，不写死 `~/.agents/skills/...`：`<skill-dir>` 是解析后实际安装的那份副本目录（本仓的说明写 `<repo>/.agents/skills/dsh-project-harness`）。缺失的根会被客户端轮询直到它出现，不算错误。

## 目录里放什么

两种布局，发现深度都只有一层：

- **目录包**：`<root>/<name>/SKILL.md`，资源基目录是 `<root>/<name>/`。
- **扁平档**：`<root>/<name>.md`，资源基目录是 `<root>/`。

`SKILL.md` 必须以一行 `---` 开头、再用一行 `---` 闭合 frontmatter，然后才是正文。frontmatter 必填 `name` 与 `description`；可选 `whenToUse`、`disable-model-invocation`、`user-invocable`。

`name` 必须匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`：小写字母数字，单词之间单个连字符。目录包形态还要求 `name` 与目录名一致——客户端自己只校验 kebab-case，不校验目录同名，但装出来的技能名与目录对不上时，按目录名定位副本就会落空；本仓把这条做成门禁（见第四节）。缺 `name`、缺 `description`、frontmatter 解析失败、名称非法的文件会被整个丢弃，只在客户端日志里留一条 warn；模型目录收不到逐技能诊断，分不清「缺失」与「无效」。

两个调用策略键决定技能从哪个面消失：`disable-model-invocation: true` 把技能从目录与 `skill` 工具里整体排除，只剩用户 `/name` 一条入口；`user-invocable: false` 把它从用户命令里排除，模型面照常。两个键只接受严格布尔值：YAML 布尔，或不区分大小写的 `true`/`false`、`yes`/`no`、`on`/`off`、`1`/`0`；拼错或给非布尔值会让整个技能被丢弃，而不是静默取默认。

**旧键名被判非法，不是兼容。** `disableModelInvocation`、`modelInvocable`、`userInvocable` 触发 `frontmatter field "<legacy>" is unsupported; use "<canonical>"`，与其它 frontmatter 错误同一条路径：整个技能消失。升级时把键名改成 `disable-model-invocation` 与 `user-invocable`，没有过渡期。

`whenToUse` 是可选字符串元数据，但目录不渲染它，`skill` 返回的包装层也不渲染它，所以它对自动路由没有贡献；`metadata` 同属元数据，目录与加载结果都不渲染它。

## description 是路由面，不是简介

目录每行只渲染名字与描述；description 是模型决定要不要调 `skill` 的唯一依据，`whenToUse` 不进目录。所以它承担路由，不是技能简介。

**客户端的上限与截断。** 客户端配置 `catalogDescriptionMaxLength`，默认 500、最小 3；它先对描述做规范化——`/\s+/g` 折叠为单空格、再 trim——长度按 JS 字符串 `.length` 计。规范化后超过上限时，保留前 `maxLength - 3` 个字符并补 `...`，尾部被截掉。所以默认值 500 不是自选预算，而是「默认配置下整句可见」的边界：尾部触发词一旦被截，模型看到的是半句话，自动路由失效；按名调用不受影响——名字不截断，用户 `/name` 与显式点名仍能加载。把描述压进默认值以内则是每个采用方都能自己做到的修法：调大 `catalogDescriptionMaxLength` 是全局设置，会把目录每一条一起撑长，按轮次付固定上下文成本，采用方通常也不控这个配置。

**触发词前置、中英双写。** 中文任务词与英文 `Use when ...` 都应落在前半段，尾部只放补充信息，因为尾部是第一个被截掉的。中英双写不是装饰：同一任务可能以中文或英文提出，触发词只写一种语言，另一种语言的任务就路由不到。本仓 `SKILL.md` 的 frontmatter 是这条形态的实例：中文触发词在前，英文触发句在后，整段规范化后不超过上限。

**自检的度量。** 客户端量的是规范化后的长度：取 description 的值（`>-` 块标量把换行折叠为空格），套 `value.replace(/\s+/g, ' ').trim()`，再取 `.length`。本仓把这条自检做成门禁：`verify-skill-catalog.ts` 按 manifest 声明的上限逐个检查，超限时报告实测长度与上限。

**阈值只有一个声明点。** 本仓的上限住在 `scripts/harness/skill-catalog.manifest.json` 的 `maxDescriptionLength`；门禁、正文与这份参考档都指过去，不在这里另写一份预算数字。若采用方把客户端的 `catalogDescriptionMaxLength` 调小，manifest 也要跟着调小——否则门禁绿而目录仍在截断，绿灯不再代表「完整可见」。

**门禁判什么。** `verify-skill-catalog.ts`（源码布局 `skills/dsh-project-harness/scripts/verify-skill-catalog.ts`，安装副本落在 `scripts/harness/`）检查：声明的根存在；根下每个技能档有可读 frontmatter、`name` 合法且与目录包名一致、`description` 归一后不超过 manifest 上限；声明了根却扫到零个技能档判红——「扫了个空」不算通过。触发词够不够、描述是否准确它判不了，那落在评审。

## 加载了却没照做：四种断点

按「技能有没有起作用」拆成四个断点，按发生顺序排列：前一个没通，后一个不必查。每个断点有独立的观察面与对策；四个都过，才轮到「内容本身对不对」。

**断点一：没路由到。** 现象是会话里从未出现 `skill` 调用，产出与技能无关，但目录里能搜到该技能名；根因是 description 被截断（尾部触发词不可见）、触发词不在开头，或任务用词与描述用词对不上。对策是改 description：触发词前置、中英双写、尾部只留补充，用 `replace(/\s+/g, ' ').trim().length` 自检并跑 `verify-skill-catalog.ts`。注意按名调用不经过自动路由，一次按名加载成功不能证明路由修好了。

**断点二：只读了正文，没跟指针。** 现象是 `skill` 调用发生过、正文也确实进了上下文，但产物按正文的摘要水平交付——该落槽位的落在仓根，该读的 reference 没读。根因是一次 `skill` 调用只带来 `SKILL.md` 正文，`references/` 不会自动进来，正文里的指针是唯一的跟随义务。对策是让正文首节写清「哪些任务先读哪几个 references」的索引表；判断修好了没有，看下一次任务里是否真的出现对 reference 的读取，而不是看正文里是否写了这句话。

**断点三：任务书压过技能。** 现象是技能加载了、references 也读了，产物仍落在链外；或正文与派发要求冲突时，产物只服从派发书。根因是派发书把「证据面」要求写成了「交付面」禁令——例如为追求独立判断而要求「忽略现有文档」，被扩成「禁读一切文档」，连链的槽位规范一起挡在门外。对策是把两格分开写：证据面允许或禁止读哪些文档；交付面写明产物落哪个槽位或路径、索引与活账是否同批更新（槽位与落位判据见 [doc-lifecycle.md](doc-lifecycle.md)）。判据是产物落在链外时所有门都扫不到，而验收命令可能仍是绿的——落位失败不能被验收通过掩盖。

**断点四：子 agent 不继承。** 现象是父会话加载过技能并读过 references，派出的子 agent 却没加载、没跟指针，产物按它自己理解落位。根因是子 agent 不继承父会话已加载的技能正文与目录消息：spawn 子 agent 以空对话开始，任务书是它唯一收到的用户消息；fork 子 agent 拿到父级已完成轮次的一次性快照，那只是历史文本，不等于技能在子会话里被加载过。对策是派发书写清落位与验收命令，不写「遵守某某规范」；子会话有没有自己的目录取决于它的 preset 是否挂载 `skill` 工具，不能假设「父会话加载过」这个事实对它成立。判据与模板见 [agent-work.md](agent-work.md) 的「技能不继承」一节。

## 怎么验证真的加载了

四个可观察面，按顺序查：

1. **目录里出现过。** 会话的 system-reminder 里有 `<available_skills>` 块，一行 ``- `<name>`: <description>``；没有这个块，说明从未发布过目录——可能全局没有模型可调用技能，或 `skill` 工具被隐藏或被同名作用域工具遮蔽。目录发生成员、描述或可见性变化后，客户端追加一份完整替换目录；出现替换后以最新一份为准，空目录明确停用旧名字。
2. **调用有返回。** 用精确名称调 `skill`：成功时返回 `<skill_content name="...">`，内含 `<skill_resources>`（目录 provider 写 `Base directory for this skill: <path>` 与相对路径解析提示）和 `<skill_instructions>`（正文）。工具结果的数据字段是 `name`、`provider`、可选 `resourceBase`、`content`；模型看到的是渲染后的资源指引与正文，`provider` 在结果载荷里可查。
3. **热更新。** 新增、改名、删除技能，或改 frontmatter 影响 name、description、可见性时，目录在下一个模型步骤被完整替换；只改正文不改变目录（digest 只覆盖名字与截断后的描述），下一次 `skill` 调用才会读到新正文；改 `references/` 不触发任何目录刷新，模型读文件时读到的始终是磁盘当前内容。
4. **报错形态可分辨。** 名称不合法：`Error: invalid skill name "<name>"`；目录里没有或已失效：`Error: skill "<name>" is unknown or no longer available`；被设为不可模型调用：`Error: skill "<name>" is not available for model invocation`。目录里没有某个名字时，无法区分「根没扫到」「frontmatter 无效被丢弃」「被同名更高优先级遮蔽」——只有客户端日志的 warn 能定位。

这些是「能被加载」的可观察面；是否被调用、调用后是否照做不在其中，见第七节的诚实边界。

## 其他客户端的差异

**几个根不是一回事。**

| 路径 | 归属 | DSH 是否扫描 |
|---|---|---|
| `<项目根>/.dsh/skills` | DSH 专属项目根 | 是，rank 100 |
| `<项目根>/.agents/skills` | 跨客户端共享根 | 是，rank 200 |
| `<dshHome>/skills` | DSH 用户根 | 是，rank 400，跳过 `.system` |
| `<agentsHome>/skills` | 用户级共享根 | 是，rank 500 |
| `<项目根>/.claude/skills` | Claude Code 的约定 | 否，DSH 根表里没有它 |

装进 `.claude/skills` 的技能 DSH 不会发现；`.agents/skills` 是两边都可能读的共享位置，默认装这里。`<skill-dir>` 就是这套根解析之后实际安装的那份副本目录——本仓说明给的是 `<repo>/.agents/skills/project-harness`，也可以装到用户级共享根。

**`/name` 是用户的显式入口。** 用户输入里以空白为界的 `/name` token，若命中工作区目录中一个用户可调用技能，就把同一份 `<skill_content>` 作为该步骤的指令上下文注入；这是 `disable-model-invocation: true` 技能的唯一入口。未知名字与用户不可调用的名字保持普通行文；目录里已列出的技能被 `/name` 调用后，目录结尾句要求模型遵循注入块、不再重复加载。

**诚实边界。** 目录里出现一个名字，只证明它被发现；调用 `skill` 成功，只证明正文取到了；两者都不证明模型读了它，更不证明照做了。没有任何门能证明语义遵守——本档与 `verify-skill-catalog.ts` 只把「能被加载」做成可观察事实：名称合法、目录一致、描述完整、目录与正文取得到、错误形态可分辨。语义层面靠两件事兜：任务书里的落位与验收（见 [agent-work.md](agent-work.md)），以及评审。门禁的边界与 [gates.md](gates.md) 的「已知的诚实边界」同形。
