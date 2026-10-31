# 双语配对契约

这份文件只在**需要写对照文件、或处理配对问题**时读。缺省状态下语料是单语的：没有对照文件、没有一致性记录，门禁不会施加任何双语要求。

配对只发生在**被理解面**。指令文件——`AGENTS.md`、`docs/AGENTS.md`、归档树说明书——**永不配对**，无论语料是否双语：它们被逐字执行，两份副本就是两个事实。决策记录要能配对，是因为读者是人，两侧的意见都要被读懂的；判据与语言选择见 `project-harness` skill 的 `references/language-policy.md`。

## 主语言与配置

语料用一种**主语言**书写，声明在 `.agents/notes/harness.json`：

```json
{ "primaryLanguage": "zh" }
```

- 缺省 `en`（上游语料的形态）。字段封闭：只接受 `primaryLanguage`（`en`/`zh`）与 `pairedDocuments`（布尔）。
- `pairedDocuments` 只约束**归档**（是否要求三件套一起进归档）；活跃树的配对是逐篇可选的。
- 门禁按**文件存在**启用规则：没有对照文件，切换行、镜像、记录这三组要求都不会被检查。

主语言声明一次，管住整棵树的拼写：每个文件的骨架标题（按文件自身语言）、三个 lifecycle 目录（`proposed|implemented|rejected` ↔ `提案中|已实施|已否决`）、六个 class 目录（`feature|bug-fix|simplification|architecture|process|testing` ↔ `功能|缺陷修复|简化|架构|流程|测试`）、归档容器（`archived` ↔ `归档`），以及文件名主干的用词（约定，见 [format.md](format.md)）。**两种拼写不混住一棵树**：出现另一种拼写时门禁会点名期望的名字。

**怎么定主语言**：跟仓库自己的散文走。常驻档、`docs/` 链、提交信息是中文，语料就声明 `zh`，这样读者在文档与决策记录之间来回走时不必换脑子；反之留缺省 `en`。上游语料是英文，所以缺省值是 `en` 而不是某个更中立的值。语言是每个仓库一次的声明；**换语言是一次显式改动**——改 `harness.json`，把整棵树连同文件名主干一起移动（`git mv`），门禁会逐条报出还留在旧拼写上的目录。归档树里**已封存的路径不改名**：封存时是什么拼写就一直是（见 [archiving.md](archiving.md)）。

## 正文件与对照文件

`yyyy-mm-dd-topic.md` 是**正文件**，语言就是主语言；`yyyy-mm-dd-topic.<locale>.md` 是**对照文件**——同一篇笔记在另一语言的版本，后缀标的是文件**自身**的语言。分类计数只算一篇。

| 情况 | 判定 |
|---|---|
| 主语言那一侧的 tier（主语言是 `en` 时的 `.en.md`） | 命名错误：正文件不带后缀（活跃树；归档里按封存时的名字认，见下） |
| 对照文件没有正文件 | 结构错误：对照文件是翻译，不是独立笔记 |
| 一致性记录没有对照文件 | 结构错误：记录确认的是配对 |
| 记录没有对应的笔记 | 结构错误：孤儿记录 |

## 骨架按语言各写各的

每份文件按**自己语言**的标题模板校验：中文文件写 `## 决策`，英文文件写 `## Decision`，混用会被逐条报出。两语言都认的标准小节：

| 语义 | 英文 | 中文 |
|---|---|---|
| problem | `## Problem` | `## 问题` |
| proposal | `## Proposal` | `## 提案` |
| decision | `## Decision` | `## 决策` |
| alternatives | `## Alternatives considered` | `## 曾考虑的替代方案` |
| acceptance | `## Acceptance criteria` | `## 验收标准` |
| risks | `## Risks` | `## 风险` |
| consequences | `## Consequences` | `## 后果` |
| plan / migration | `## Plan` / `## Migration plan` | `## 计划` / `## 迁移计划` |
| testing / verification | `## Testing` / `## Verification` | `## 测试` / `## 验证` |
| deferred / related | `## Deferred` / `## Related` | `## 推迟工作` / `## 相关` |

中文语料历史上出现过用词漂移（`## 决定`、`## 影响` 之类）；门禁以上表为准，表里的中文名取上游 `README.zh.md` 的规范译名。

`# Agent Note: ` 前缀与 `Status:` 行在两种语言里都保持英文原样；`rejected` 的理由用文件自己的语言写。

## 语言切换行

配对笔记的第 5 行（第一个 `## ` 之前）固定是切换行：**自己语言写成纯文本，对侧语言写成相对链接**。

- 英文侧：`English | [中文](<stem>.zh.md)`
- 中文侧：`[English](<stem>.md) | 中文`

未配对的笔记不放切换行。模板在 [templates/](../templates/) 下按语言各一份（`implemented.en.md` / `implemented.zh.md` 等六份；模板名里的 tier 标的是**模板语言**，落进语料时由主语言决定谁用不带后缀的正文件名）。

## 逐节镜像

两份文件的标题序列必须一一对应：

- **标题深度按序相同**——含 `###` 及更深的小节；只多不少都会被点名。
- 正文件中标准小节的位置，对照文件必须写该小节在**自己语言**里的标题；自定义小节可以自由命名，但不得占用任何语言的标准标题名。

门禁只保证结构同形，**不保证两侧说的是同一件事**——那半责任在评审。

## 一致性记录：改一侧必重录

配对即三个文件：正文件、对照文件、`yyyy-mm-dd-topic.i18n.yaml`。记录是「这两侧在这些确切内容上被确认过一致」的凭据，不是翻译质量证明。它按标题小节逐节记录两侧内容的哈希：

```yaml
# Bilingual-pair consistency record for 2026-10-13-topic.md: per heading section, a hash of
# each side's blocks outside fenced code blocks. ...
/agent-note-topic-slug:
  en: cf33ffdd07df7257
  zh: 3d6895c9c80b0b1f
/agent-note-topic-slug/problem:
  en: e5d87f6c5aef2dad
  zh: 9f7f1459d99c523c
```

- 键是**正文件**那一侧的小节 slug 路径（`/` 是第一个标题之前的块），重复路径加 `~2`、`~3`；`en`/`zh` 两个字段是各自语言的块哈希（sha256 前 16 位），代码围栏内的内容不参与哈希。
- 只算有内容的块：整节只有代码块时不产生条目。
- **任一侧改动后**（含改标题），同一个改动里更新对侧并重录：`node scripts/verify-agent-note-format.ts --write`。它只重录结构已经过关的配对——镜像或骨架没修好的配对不会被盖戳。
- 门禁报出的三种失调：`section <key> changed since confirmation (en, zh)`（哪侧变了）、`section <key> has unconfirmed translated content`（新小节没确认过）、`section <key> is recorded but no longer has translated content`（记录里的小节没了）。
- 分节记录让互不相干的小节各自成行，git 默认的文本合并就能处理并行编辑；这正是它比整文件哈希更适合活跃树的原因。

## 归档时的转换

归档把这份记录改写成**整文件 Git blob 形态**（`foo.md: <40 位>` 两行），归档门禁校验的是后者、并把它连同两侧一起封存。转换与移动步骤见 [archiving.md](archiving.md)。

封存之后，路径的拼写（类目录名、对照文件的 tier）不再与当前声明比对——归档记录的就是**封存当时的样子**。所以改了主语言的仓库，归档里可能同时住着两种拼写的类目录和「按新声明看是主语言那一侧」的 tier；门禁认这些历史拼写，活跃树则不认。
