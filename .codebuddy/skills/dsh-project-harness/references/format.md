# 格式细则

门禁逐条校验下列规则。理解「为什么」比记住「是什么」更重要，因为规则之间会冲突，冲突时要靠理由判断。

## 头部三行

```markdown
# Agent Note: <title>

Status: <status>
```

第 5 行（第一个 `## ` 之前）在**配对**笔记里固定是语言切换行；未配对的笔记不放。切换行的形状是「自己语言写成纯文本，对侧语言写成相对链接」：英文侧 `English | [中文](<stem>.zh.md)`，中文侧 `[English](<stem>.md) | 中文`。第 6 行起才是正文。`Status:` 有三个合法取值，必须与所在目录一致：

- `Status: proposed`
- `Status: implemented`
- `Status: rejected — <一句话理由>`

状态行**不带日期、不带括号补充**。日期在文件名里（首次提出日），其余交给 git；「以修正后的形式通过」这类信息写在正文里，不写在状态行。只有 rejected 的状态行承载内容，因为被否决方案的判决就是读者最先要看的东西。

`Status:` 在全文件只能出现**一次**。文档里举例说明状态行写法时，请放进代码围栏——围栏内的格式 token 不被当作结构。

## 必需与禁止的 section

`## Problem` 必须是第一个二级标题，且必须能脱离解法独立成立。

必需：

| lifecycle | 必需 section |
|---|---|
| proposed | `## Proposal`、`## Acceptance criteria`、`## Risks` |
| implemented | `## Decision`、`## Consequences` |
| rejected | `## Proposal` |

禁止（只在 implemented 中）：`## Proposal`、`## Plan`、`## Migration plan`、`## Acceptance criteria`。这些是提案期的措辞，出现在已交付的笔记里说明它没有随实现改写。要么折进 `## Decision` / `## Consequences`，要么新建一个现在时的小节（`## Testing`、`## Verification`、`## Deferred`、`## Related` 都是合法的）。

自定义小节允许出现在必需小节**之间**。`## Verification` 之类的小节名可以随技术需要自由起名。

## Alternatives considered

每篇必备，唯一例外见下。写法是「每个真正的备选一段，粗体起头」：

```markdown
**Keep the whole-file hash and the merge driver.** Rejected because the platform's
mergeability check never runs a local driver, so conflicts still appear on the host.
```

**先写它最强的理由，再写为什么否决。** 只反驳弱处等于没有评估过它：读者会以为被否的是一个没人会选的选项，于是把真正的选项重新提一遍。最强理由写完仍被否决，这个决定才站得住。

**不要编造备选方案。** 只为凑齐格式而虚构一条从未考虑的路径，会让读者以为它被评估过。真的没有可写的历史时，用祖父注释代替（仅限 2026-07-05 之前提出的笔记）：

```markdown
<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->
```

这个注释与 `## Alternatives considered` 只能二选一，不能同时出现。文档日期在 2026-07-05 之后的笔记不得使用它——门禁会报错。

## 后果要写全，重访条件要有

`## Consequences` 里**代价和收获都要写**。自问「什么变难了、维护成本是什么」——只有收益的后果是挑选过的。

做减法、收窄范围或降低能力的决策，另写**已知上限与重访条件**：什么情况下它不再成立、该回头重看。没有重访条件的简化会悄悄变成永久决定。

## 生命周期之间的搬家

在目录之间移动文件时，必须**在同一个改动里**更新状态行并重新满足目标目录的骨架，否则门禁拒绝这次移动。具体来说：

`proposed/` → `implemented/` 要把 `## Proposal` 改写成现在时的 `## Decision`，把 `## Acceptance criteria` 与 `## Risks` 折进 `## Consequences`（或一个现在时的 `## Testing` / `## Verification`，说明现在什么在钉住这个行为），并删掉所有计划性表述——只留实际交付的东西。

`proposed/` → `rejected/` 只在状态行加理由，然后冻结全文。

## 命名与日期

文件名是 `yyyy-mm-dd-topic-title.md`。日期是**该主题首次被提出**的那天，从 git 历史取，不是你写文件的今天——一篇 7 月提出、10 月写成的笔记，日期是 7 月那条。

标题是短横线连接的短语，语言跟语料的主语言一致（英文语料用英文小写词，中文语料用中文词），配对的两侧共用同一个文件名主干。标题里不要出现日期（日期已经在文件名里了）。

门禁只校验 `yyyy-mm-dd-` 前缀与 `-` 分隔的形态——「标题用了哪种语言」它判不了，是约定。路径其余部分（lifecycle、class、归档容器）由主语言拼写，那几处门禁逐条校验。

## 双语：正文件与对照文件

`yyyy-mm-dd-topic.md` 是**正文件**，语言取 `.agents/notes/harness.json` 声明的主语言；`yyyy-mm-dd-topic.<locale>.md` 是对照文件，后缀标的是文件**自身**的语言。配对是可选能力，双语细则——语言骨架、切换行、逐节镜像、分节一致性记录、中文标题别名表——见 [bilingual.md](bilingual.md)，需要时再读。

## 交叉引用

笔记之间的引用一律用**相对 Markdown 链接**，不要用编号或裸散文：

```markdown
[the archive policy](../../implemented/process/2026-07-26-frozen-archive.md)
```

这样引用可以被机械校验，且在文件搬家后仍然有效。用 `#fragment` 指向某一节时，锚点必须真实存在。

## 反模式

- **推理转录**：把「我看了 A，发现不行，于是去看 B」这类过程写进文档。读者要的是结论和理由，不是过程。要写过程就写进 PR 描述。
- **实现状态标注**：「已实现！」「未来计划……」「TODO：稍后补上」。状态由 lifecycle 目录表达，笔记里不重复声明。
- **手抄目录**：把代码里的常量、测试清单、函数签名抄进笔记。它们会腐烂，而且抄的那一刻就已经是冗余副本。
- **强调膨胀**：满篇加粗、大写、`critically`、`very important`。处处是重点等于没有重点。
- **规格腔**：在 implemented 笔记里写 should、写迁移计划、写验收清单。已交付的东西用陈述句。
