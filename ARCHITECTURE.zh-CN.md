# 架构

[English](./ARCHITECTURE.md)

> 一个个人知识系统与发布平台。
> Markdown 文件是唯一事实来源。数据库是索引，不是保险库。

---

## 1. 设计原则

这五条规则决定了代码库里的每一处取舍。拿不定主意的时候，回来重读一遍。

| # | 原则 | 后果 |
|---|-----------|-------------|
| 1 | **文件持有内容，数据库持有状态** | 正文永远不存放在 Postgres 里。数据库存的是元数据、索引、会话与分析数据。 |
| 2 | **降级到文件系统** | 即使 Postgres 消失，每个已发布的页面仍然能从 `content/` 渲染出来。 |
| 3 | **不允许静默损坏** | 一次失败的保存绝不会碰到原文件。写入要么是原子的，要么就不发生。 |
| 4 | **服务端优先** | 页面都是 Server Component。客户端 JS 是按功能逐项选择加入的，并且要有正当理由。 |
| 5 | **该保守的地方就保守** | 认证、路径处理与文件写入都用广为人知的原语。聪明才智留给阅读体验。 |

---

## 2. 系统概览

```
                       ┌──────────────────────────────┐
   Browser ──────────► │  Next.js (App Router, RSC)   │
                       │                              │
                       │  (site)   public reading     │
                       │  admin    CMS (auth-gated)   │
                       │  api      search / upload /  │
                       │           analytics collect  │
                       └───────┬──────────────┬───────┘
                               │              │
              ┌────────────────▼───┐    ┌─────▼──────────────────┐
              │  Content Engine    │    │  Postgres (Drizzle)    │
              │                    │    │                        │
              │  read  ──► cache   │    │  users, sessions       │
              │  write ──► atomic  │◄──►│  content_index         │
              │  sync  ──► index   │    │  tags, assets, links   │
              └────────┬───────────┘    │  revisions, audit      │
                       │                │  analytics, jobs       │
              ┌────────▼───────────┐    └────────────────────────┘
              │  content/*.md      │
              │  uploads/          │    ┌────────────────────────┐
              └────────────────────┘    │  Search Index (local)  │
                                        │  inverted, BM25, CJK   │
                                        └────────────────────────┘
```

### 读取路径

`content/*.md` → 解析 frontmatter → 渲染 Markdown（Shiki，服务端）→ 缓存 → RSC payload → HTML。
渲染一篇文章不需要任何数据库往返。

### 不是文档的页面

大多数公开页面要么是一篇文档，要么是一串文档的列表。`/about` 则是由七个区块拼成、背后没有任何文件的页面：profile、focus、currently、stack、projects、contact 和 latest writing。其中五个来自设置 —— 可以在 `/admin/settings` 里编辑，因为它们是一年才改一次的、作者不该为了改它去打开编辑器的信息 —— 另外两个从 `content_index` 读取，所以去年写的页面依然能说出作者现在在做什么。profile 渲染成段落，而不是 Markdown：设置是从表单写入的，而这个站点唯一会转成 HTML 的输入是内容，内容要过一遍消毒器。首页以同样的方式拼装 —— 身份来自设置，区块来自索引 —— 完整的推理写在 `src/app/(site)/about/page.tsx` 里。

### 写入路径

```
Admin UI
  → Server Action（Zod 校验 + CSRF + 会话检查）
  → 序列化 frontmatter + body
  → lock → 写临时文件 → fsync → 原子 rename → fsync(dir)
  → 快照修订（gzip）+ content_index upsert
  → 失效缓存，刷新搜索文档
  → 可选的 git 提交
  → revalidatePath
```

"serialize" 之后的每一个箭头都是事务性的或幂等的。如果第 3 步失败，原文件分毫未动，界面会明确告诉你。

---

## 3. 内容模型

### 目录布局

```
content/
  posts/      长文                  → /posts/<slug>
  notes/      短笔记、片段           → /notes/<slug>
  projects/   项目页                → /projects/<slug>
```

一个文件 = 一篇文档。文件名只是提示；frontmatter 里的 `slug` 才是权威。

### Frontmatter schema

用 Zod 在 `src/lib/content/schema.ts` 里定义一次，解析器、校验器、CLI 与编辑器共用同一份。

```yaml
---
title: "Linux 网络排查笔记"
slug: "linux-network-debugging"
description: "从 tcpdump 到 netstat 的一次完整排查记录"
date: 2026-09-11
updated: 2026-09-11
status: published          # draft | scheduled | published | archived
publishAt: 2026-10-01T09:00:00Z   # required when status: scheduled
tags: [Linux, Network]
category: Technology
cover: /uploads/2026/09/cover.webp
featured: false
toc: true
summary: "..."             # optional, overrides auto-derived excerpt
seo:
  title: "..."
  description: "..."
  canonical: "https://..."
  ogImage: "/og/..."
  noindex: false
series: "Kubernetes 深入"    # optional, groups posts
lang: zh
---
```

未知键在往返过程中会被保留（`_extra`），所以手写的 frontmatter 永远不会被后台的一次保存毁掉。

### Note 更轻

Note 允许缺 `title`（从第一个标题或第一行推导）、缺 `description`（从正文推导）、缺 `slug`（从文件名 + 日期推导）。

---

## 4. 数据库 Schema

Postgres。版本下限是 13，这个下限由 `gen_random_uuid()` 决定 —— 它是 schema 要求的最新特性；`docker-compose.yml` 固定使用 `postgres:17-alpine`，而实际测试针对的就是 17。Drizzle ORM，SQL 迁移文件签入在 `src/lib/db/migrations/` 下。

| 表 | 用途 | 关键列 |
|-------|---------|-------------|
| `users` | 管理员账号。不开放注册。 | `email`、`password_hash`（Argon2id）、`last_login_at` |
| `sessions` | 服务端会话。 | `token_hash`（SHA-256）、`user_id`、`expires_at`、`user_agent`、`ip_hash` |
| `content_index` | 每个 Markdown 文件一行。驱动列表、统计与搜索。 | `type`、`slug`（与 type 联合唯一）、`path`、`title`、`status`、`published_at`、`updated_at`、`checksum`、`word_count`、`reading_time`、`view_count` |
| `content_revisions` | gzip 压缩的完整快照 + 统计。 | `content_id`、`revision_no`、`snapshot`（bytea，gzip）、`additions`、`deletions`、`author_id`、`summary` |
| `tags` | 规范化的标签记录。 | `slug`（唯一）、`name`、`description`、`color` |
| `content_tags` | 多对多。 | `content_id`、`tag_id` |
| `content_links` | 已解析的内部链接 + 图片引用。驱动反向链接与"未被使用的资源"。 | `source_id`、`kind`（`internal`\|`wiki`\|`image`\|`anchor`）、`target_key`、`target_id`、`label` |
| `assets` | 上传媒体的元数据。 | `url`、`mime`、`size`、`width`、`height`、`blur_data_url`、`sha256`、`storage` |
| `redirects` | 旧 URL → 新 URL。用于处理 Ghost 迁移。 | `from_path`（唯一）、`to_path`、`status_code`、`enabled`、`hits` |
| `site_settings` | 单行、类型化的设置。 | 身份信息、SEO、分析、功能开关、git、外观 |
| `navigation` | 页头 / 页脚 / 社交菜单。 | `location`、`label`、`href`、`position`、`parent_id` |
| `analytics_daily` | 按天预聚合。 | `date`、`path`、`content_id`、`views`、`referrer_domain`、`device`、`country` |
| `analytics_events` | 原始事件，短期保留，**不存 IP**。 | `created_at`、`path`、`content_id`、`referrer_domain`、`device`、`visitor_hash` |
| `audit_logs` | 每一次会改数据的后台操作。 | `user_id`、`action`、`target_type`、`target_id`、`meta`（jsonb）、`ip_hash` |
| `scheduled_jobs` | 发布与保留任务的持久队列。 | `type`、`run_at`、`status`、`attempts`、`locked_at`、`last_error` |

**刻意缺席的：** `posts.body` 列。文章正文只存在于一个地方 —— 那个 `.md` 文件。

### 为什么修订放在数据库里

需求允许 `content/revisions/` 或者压缩的 diff。我们选择在 `bytea` 里存 **gzip 压缩的完整快照**，理由是：

- 恢复是一次单行读取 —— 不可能出现链上局部损坏。
- `+23 −5` 这类统计来自任意两个快照之间按需计算的 diff，所以我们不存任何冗余的派生数据。
- 文件系统保持干净：`content/posts/*.md` 就是内容本身，别无他物。
- 修订是*历史*，不是*源*，所以把它们放进数据库并不违反第 1 条原则。

保留策略：`revisions.max_per_content`（默认 50）由定时任务强制执行；更早的快照会被清理。

---

## 5. 内容引擎

`src/lib/content/` 是唯一被允许接触 `content/` 的模块。

| 文件 | 职责 |
|------|----------------|
| `schema.ts` | 每种内容类型的 frontmatter 的 Zod schema。 |
| `frontmatter.ts` | 解析 / 序列化 `---` 块。保留未知键与键的顺序。 |
| `paths.ts` | 对 `CONTENT_DIR` 下的每个路径做解析 + 归一化 + 关进牢笼。 |
| `reader.ts` | 读单篇 / 列文档，带 mtime+size 缓存。 |
| `writer.ts` | 原子写入：lock → tmp → fsync → rename → fsync(dir)。 |
| `sync.ts` | 按 checksum 把文件系统与 `content_index` 对齐。 |
| `links.ts` | 从文档中抽取内部链接与图片引用。 |
| `resolve.ts` | 在给定内容索引的前提下，判定一条链接指向哪篇文档。同步引擎与渲染器共用。 |
| `derive.ts` | slug、摘要、字数、阅读时长、标题树。 |
| `render.ts` | 渲染文档正文 —— 描述图片、解析 wiki 链接 —— 再交给管线。 |

### 原子写入契约

```
acquire lock (content/.locks/<type>-<slug>.lock, O_EXCL, 10 秒后视为过期)
  write content/.tmp/<uuid>.md
  fsync(file)
  rename(tmp, target)          ← POSIX 上原子，且同一文件系统
  fsync(dir)
release lock
```

`rename()` 是原子的，所以读者要么看到旧文件、要么看到新文件 —— 绝不会看到一个写了一半的。如果进程在写入中途死掉，tmp 文件会成为孤儿，而目标文件完好无损。孤儿 tmp 文件会在启动时被清扫。

每次保存还会往 `content_revisions` 写一份写前快照，所以即使一次"被接受但内容是错的"编辑也是可恢复的。

### 内容同步引擎

文件可能在应用背后发生变化（`git pull`、`vim`、容器挂载、后台界面）。`syncContent()` 是唯一的对齐者：

```
scan content/**.md
  → 对每个文件算 checksum（原始字节的 sha256）
  → 与 content_index 比对
      DB 里没有这个文件     → INSERT
      checksum 不同         → UPDATE（+ 新修订）
      DB 有行但文件已不在   → 标记删除 / 移除该行
      没变化                → 跳过
  → 重新解析 frontmatter，刷新标签 + 链接
  → 把搜索文档标记为脏
```

触发时机：
- `pnpm content:sync`（完整、verbose）
- 应用启动时 —— 一次**轻量**扫描，只 stat mtime（不做哈希），如果发现有东西动过，就在后台跑完整同步。
- 每次后台保存之后（定向的、单篇文档）。

定向保存会解析**这篇文档里**的链接，用的是当时的索引 —— 一次保存的代价因此与一篇文档成正比。
指向这篇文档的链接在同一次保存里从另一头解析：拿这篇文档的候选键去反查
`content_links.target_key`（走 `content_links_target_key_idx`），命中且判给这篇文档的未解析行
就补上，判定用的是保存路径同一个判定函数。于是"目标还没写就先写下"的 `[[引用]]` 会在目标被
保存时成为一条边，而不是等到下一次全量同步。

扫描是有边界的：`CONTENT_MAX_FILES`（默认 5000）防止一个挂错的卷把启动变成对 `/` 的文件系统遍历。

### Git 自动提交

可选，默认关闭，且从不 push。`src/lib/git/` 在写入已经成功之后才去调用 `git`，这样内容目录在持有文件的同时也保有一份提交历史：

```
content: update "Linux Network Debugging"
content: publish "Linux Network Debugging"
content: delete "Linux Network Debugging"
content: tag "linux → unix"            (one commit for the whole rewrite)
content: publish "12 documents"        (one commit for a bulk run)
```

**两个开关必须一致。** 设置项（`gitEnabled`、`gitAutoCommit`）表达的是*站点*是否想要提交；`GIT_INTEGRATION_ENABLED` 表达的是*部署*是否允许提交，而且没有任何后台界面能把它打开。有三种组合值得说明：

| 设置 | 环境变量 | 行为 |
|----------|-----|-----------|
| 关闭 | 任意 | 静默 —— 站点根本没提这个要求 |
| 开启 | `0` | 每次保存后编辑器里出现一条 `deployment-disabled` 提示，日志里也有 |
| 开启 | `1` | 会尝试提交并报告结果 |

**一次决定一个提交，而不是一个文件一个提交。** 一次保存、一次删除、一次修订恢复，各自提交它那一篇文档。一次批量操作和一次标签重命名，整轮只提交一次，并逐一列出它实际写过的每个文件 —— 为一次重命名往日志里塞四十条是噪音，而四十个文件本来就是一次决定。

**是强制执行的，而不只是承诺**（`src/lib/git/index.ts`）：

- `GIT_SUBCOMMANDS` 是一份白名单 —— `add`、`commit`、`rev-parse`、`status`、`var` —— 在每次 spawn 之前都会检查，所以 `push` 根本不是这个模块拥有的代码路径。这里没有任何东西能碰到远端。
- 每条命令都带一个显式的 pathspec，所以运维自己已经 stage 的改动、或者文档旁边的一个野文件，都不可能搭上一条名为 `content: update "…"` 的提交。`:(literal)` 会中和 glob；绝对路径、`..` 和开头的 `-` 一律拒绝。
- 用带参数数组的 `execFile`：不走 shell，所以标题里带 `$(…)` 就只是个标题。
- 提交在进程内串行成链，因为两个重叠的提交会争抢 `.git/index.lock`。第二个进程不受协调 —— 那是一次被记录下来的失败，而不是一次丢失的保存。

**提交不可能让一次保存失败。** 文件先写好；提交是一个动作做的最后一件事，而每一种结局 —— 没有仓库、没有身份、没有 `git` 可执行文件、没有东西可提交、git 拒绝 —— 都是一个被描述出来的结果。失败以 git 自己的措辞写进服务端日志；浏览器拿到的只是一个分类（`src/lib/git/message.ts`），绝不是一段原始输出，因为 git 的 stderr 可能带上路径。编辑器把这句提示显示在保存旁边，而从不把它当作保存本身。

**提交信息**来自 `gitCommitTemplate`（默认 `content: {action} "{title}"`），其中 `{action}` 取 `create`、`update`、`publish`、`unpublish`、`delete`、`restore`、`tag` 之一。标题会被压平成一行并截断到 100 个字符 —— 否则标题里一个换行就会变成提交正文，而这不是模板承诺的东西 —— 未知的占位符按原样保留。模板默认值只存在于一个地方：`DEFAULT_COMMIT_TEMPLATE`，而 `SETTINGS_DEFAULTS` 复用它。

**它是怎么被测试的。** `tests/unit/git.test.ts` 拿真东西跑，仓库建在一个用完即弃的内容根下：信息规则、白名单、pathspec 作用域、一次删除，以及每一种失败模式都以"结果"而非"拒绝"的形式出现。`tests/integration/git-commit.test.ts` 用真实存在的设置行把后台那一半拼起来。`tests/e2e/git.spec.ts` 是那个把主张端到端落实的文件：它在设置界面里打开开关，通过编辑器发布一篇文章，然后检查它被展示的 `committed <sha>` 就是仓库的 `HEAD`。最后那条断言正是这个文件的意义 —— 那句提示是本产品关于提交的唯一主张，所以一个相信它的测试套件会对着一条撒谎的状态行通过。

---

## 6. Markdown 管线

只在服务端。渲染不带来任何客户端 JS。Frontmatter 不属于这条管线：`src/lib/content/frontmatter.ts` 在渲染任何 Markdown 之前就把它切下来并解析掉。

```
raw markdown
  → remark-parse
  → remark-gfm            表格、任务列表、脚注、删除线
  → remark-deflist        定义列表
  → remark-math           $inline$ 与 $$block$$
  → remark-directive      :::note 容器
  → remark-blocks         文件树、tabs、keys、details（本项目）
  → remark-alerts         > [!NOTE] GitHub alerts（本项目）
  → remark-display-math   把 $$ 包围的行内数学改写为块级节点（本项目）
  → mdast → hast          remark-rehype、allowDangerousHtml、我们自己的 handlers
  → rehype-capture-code-meta   在 rehype-raw 之前把围栏 meta 移出节点（本项目）
  → rehype-raw
  → rehype-sanitize       显式白名单，为上面的节点做了扩展
  → rehype-enhance        标题 id、表格包装、链接策略、<picture>（本项目）
  → rehype-code           Shiki、双主题、diff 与行高亮（本项目）
  → rehype-katex
  → feature collection    页面需要知道的、关于自身标记的信息（本项目）
  → rehype-stringify
```

这份清单里的插件名就是 `package.json` 里的那些；标了 *(ours)* 的处理在 `src/lib/markdown/` 里。这里没有 `rehype-pretty-code`，没有 `rehype-slug`，也没有 `rehype-autolink-headings` —— 能力都在，只是它们由本项目自己的处理实现，而正是这一点让它们能按下面的顺序运行。

**顺序承载了两个决定。** 第一，`rehype-sanitize` 跑在那些产出本站标记的变换器*之前*，而不是之后：它下游的一切（`rehypeEnhance`、`rehypeCode`、`rehypeKatex`）产出的都是本项目自己掌控的标记，所以没有什么需要再消毒，而 `rehypeEnhance` 也就可以产出一个不在白名单里的 `<picture>`。第二，`rehypeCaptureCodeMeta` 跑在 `rehype-raw` 之前，因为 parse5 的往返带不了节点上的 data。

### Wiki 链接

`[[目标]]` 是在管线**之前**解析的，不是管线里的一个插件。解析是一次数据库读取，而管线是纯的 —— `renderMarkdown` 收一个字符串、返回一个字符串，不碰数据库也不碰文件系统 —— 所以由 `renderDocument` 先把正文改写掉，等 `[[why-not-catch]]` 到达 `remark-parse` 时，它已经是一个普通的 Markdown 链接。正文里没有 wiki 链接时原样返回，因此常见情形除了一遍扫描不付任何代价。

**一个扫描器，一个判定函数。** `src/lib/content/links.ts` 里的 `proseLines` 只走一遍文档，一边跟踪围栏（围栏块里的 `[[x]]` 于是仍是内容），一边把行内代码挖空（被引用的 `[[x]]` 于是仍是引用）。应用的两半都通过它来读 `[[…]]`：`extractLinks` 由它写入 `content_links`，`scanWikiLinks` 由它改写正文，而两者都用 `src/lib/content/resolve.ts` 里同一个 `pickTarget` 来断定目标是谁。两个扫描器一旦各说各话，就会出现页面上有链接、数据库记成坏链，或者图上有一条边、读者点不动的情况；这样的事出过一次，而这个共用模块的意义正在于它不会再出。

**目标可以写 slug，也可以写文件名。** 文档的 slug 由标题推导，文件名则是作者在目录列表里看到的那个；对于标题是 "An empty catch block is a claim that nothing can go wrong" 的 note，两者并不是同一个字符串 —— 文件叫 `why-not-catch.md`。两种拼写都会注册成键，所以 `[[why-not-catch]]` 与 `[[the-whole-sentence]]` 各自都能解析，谁也不会无声地输给另一个。不带 `/` 的目标依次在 `posts/`、`notes/`、`projects/` 下尝试，第一个存在的胜出。

**解析不到的目标原样留下。** `[[nobody-wrote-this]]` 到达读者眼前的就是这几个字符 —— 不是指向 404 的链接，也不是指向空处的反链。这是作者唯一能得到的信号，而它与编辑器预览里看到的是同一个，因为预览走的是同一条管线。

**Shiki 在服务端的构建 / 渲染期运行。** 客户端收到的是预先高亮好的 HTML，带成对的 `--shiki-light` / `--shiki-dark` CSS 变量。切换主题只是改一个 CSS class —— 不重新高亮，客户端也没有 highlighter 包。

只有 `copy` 按钮、Mermaid 和交互式 tabs 会带上客户端 JS，而且只有当文档里真的有图时才会动态 import Mermaid。

### 支持的语法

标题 · 表格 · 引用块 · 任务列表 · 脚注 · KaTeX · Mermaid · GitHub alerts（`> [!NOTE]`）· `<details>` · 定义列表 · 图片 · 视频 · iframe（白名单来源）· 代码块 · diff · tabs · callouts · `<kbd>` · 文件树。

### 安全

`rehype-sanitize` 很早就跑，带着一份显式白名单，覆盖作者写下的一切：原始 HTML 只有在标签位于白名单上、且只使用为该标签列出的属性时才能存活，所以 `script`、`style` 和事件处理器都活不下来。它之后运行的是本项目自己的代码，产出的标记中作者能施加影响的途径仅限于交给它的那些输入 —— 这就是下游不再消毒一次的原因。

`iframe` 在白名单上，但必须同时满足三件事：消毒器以受限的属性集保留该元素，`rehypeEnhance` 把来源不在 `ALLOWED_EMBED_ORIGINS` 上的那些移除，最后浏览器还得真的加载那个活下来的 frame —— CSP 的 `frame-src` 就是第三件，而它由同一份清单生成。两道检查而不是一道，是因为消毒器无从知道这个站点信任哪些来源；第三道则是因为：管线留住了、浏览器却拒收的 frame，是一个没有任何东西会报告的空白矩形。两条指令都放在 `src/lib/security/embed-origins.ts` 里、由 `next.config.ts` 导入，所以新增一个来源只需要改一处，渲染器和浏览器也不可能对它各执一词。

两者合起来堵住了 `dangerouslySetInnerHTML` 处的 Markdown-XSS 攻击面。

---

## 7. 搜索

`src/lib/search/` 暴露一个 `SearchProvider` 接口，以便日后换入 Meilisearch 而不必改动调用点。

```ts
interface SearchProvider {
  readonly name: string
  search(query: SearchQuery): Promise<SearchResult>
}
```

**两个方法，接口小是故意的。** 早先的形态还带 `upsert`、`remove` 和 `rebuild`，它们被删掉了：那是*本地*存储的形状 —— 一个持有索引、每次编辑都得被告知的东西 —— 把它们强加给一个远端实现，等于把本地存储的记账工作推给一个自己会记账的服务。一个需要知道某篇文档变了的 provider，可以从 `src/lib/admin/revalidate.ts` 听到消息，而随项目发布的那个 provider 正是在那里听到的。

随项目发布的 provider 是**本地的、进程内的 BM25**：

- **分词：** ASCII 单词**加上 CJK bigram**。bigram 在不需要基于词典的分词器、也不需要原生依赖的前提下，给出了可用的中文召回。词会被归约到一个保守的词干（`render`、`renders` 和 `rendering` 是同一个词项），并且没有长度下限 —— 索引同时存书写形式和它的词干，所以 `postgres` → `postgre` 在召回上不付出任何代价。
- **字段：** `title`（权重 8）、`tags`（6）、`category`（5）、`description`（4）、`headings`（3）、`body`（1）—— 见 `src/lib/search/local.ts` 里的 `FIELD_WEIGHTS`，那里记录了为什么 `category` 位于 `tags` 和 `description` 之间。
- **持久化：** 没有。不存在索引文件。索引在进程内从内容树构建，由内容树的指纹决定是否需要重建 —— 每 `FINGERPRINT_TTL_MS`（5 秒）最多检查一次，所以一阵密集的查询只会遍历内容树一次。
- **生命周期：** 一个模块级单例，在第一次查询时惰性构建，写入时由 `src/lib/admin/revalidate.ts` 显式失效。
- **查询语法：** `type:note`、`tag:linux` / `tags:linux`、`category:engineering` / `categories:engineering`、带引号的短语，以及普通词项。无法识别的 `name:value` 不会被悄悄忽略：它会出现在 `ParsedQuery.unsupported` 里，搜索页和命令面板都会告诉读者哪个过滤器没有被应用。`before:` 和 `after:` 就属于这一类 —— 它们没有被实现，读者会被告知这一点，而不是拿到未经过滤的结果。

命令面板（`Cmd/Ctrl+K`）查询 `/api/search`（防抖，用 `AbortController` 取消）。响应是一小段 JSON；面板负责渲染它。命令模式（`>theme`、`>admin`、`>rss`）完全在客户端解析 —— 不往返。

---

## 8. 关联

三套彼此独立的机制，不涉及 AI。

1. **反向链接** —— `content_links` 中 `target_id` 非空的行，来自 Markdown 链接或 `[[wiki]]` 链接。反向查找就得到"被引用"。
2. **相关内容** —— 对共享标签（Jaccard）、同分类、共享内部链接和标题关键词重合度加权打分。在请求时从 `content_index` + 标签集合计算；结果按 slug 缓存。
3. **知识图谱** —— 节点是文档和标签；边是 `content_tags` 加上 `content_links`。序列化成一个紧凑的 `{nodes, edges}` payload，只在 `/graph` 挂载时抓取，用一小段手写的力导向布局渲染到 canvas 上。

把图排除在主 bundle 之外是一条硬性要求：`/graph` 是唯一 import 它的路由，而该路由渲染的是一个从浏览器抓取 `/api/graph` 的客户端组件。页面本身没有声明任何自己的缓存 —— 它位于 `force-dynamic` 的公开布局之下（§10）—— 携带缓存头的是 `/api/graph` 的响应：`public, max-age=300, s-maxage=3600, stale-while-revalidate=86400`。

---

## 9. 安全模型

| 领域 | 控制手段 |
|------|---------|
| 密码 | Argon2id（`@node-rs/argon2`），每个密码独立 salt，调优过的内存开销。 |
| 会话 | 32 字节随机数，在 `sessions` 里**以哈希形式**（SHA-256）存储。Cookie：`HttpOnly`、`Secure`（生产环境）、`SameSite=Lax`、`Path=/`，登录时轮换。绝对过期 + 空闲过期。会话是数据库里的行、而不是签名的 Cookie，这正是设备列表得以存在的前提：`/admin/settings` 读这个账户的行（一个带不出 `token_hash` 的投影）并按 id 删除其中一行，于是撤销在该设备的下一次请求上生效。`ip_hash` 每次登录都写，而唯一的读者就是那里。 |
| CSRF | 与会话绑定的 double-submit token，外加对每个会改数据的请求做 `Origin`/`Sec-Fetch-Site` 校验。Server Action 在共享 guard 里得到一次显式检查。 |
| 限流 | 登录（`5 / 15 min / ip_hash`）与上传使用 Postgres 里的令牌桶。能扛住重启，在多副本下也有效。 |
| 路径穿越 | 每个路径都用 `path.resolve` 构建，然后用 `isInside(root, p)`（内部走 `path.relative`）校验 —— 绝不用字符串 `startsWith`。适用于内容路径、上传路径和 ZIP 条目。 |
| 上传 | MIME 从 magic bytes 嗅探（而不是 `Content-Type` 头），扩展名由嗅探结果推导。SVG 会被消毒（剥离脚本、`on*`、`foreignObject`、外部引用）或以下载方式提供。 |
| Markdown XSS | `rehype-sanitize` 白名单、iframe 来源白名单 —— 同一份清单，`rehypeEnhance` 与 CSP 都读它（`src/lib/security/embed-origins.ts`）。 |
| 授权 | 每个后台动作顶部都有一道 `requireAdmin()` guard；后台布局也会强制它，所以即使某个页面忘了，也不存在未受保护的面。 |
| 审计 | 每次变更都往 `audit_logs` 写入操作者、动作、目标和一份脱敏后的 diff 摘要。 |

机密（`SESSION_SECRET`、`DATABASE_URL`）在启动时由 `src/env.ts` 校验；生产环境下如果机密是默认值或过短，应用会拒绝启动。

---

## 10. 渲染与缓存

**公开阅读区是 `force-dynamic` 的。** `src/app/(site)/` 里没有 `generateStaticParams`，没有 `revalidate` 导出，也没有任何 ISR —— 布局上的一个导出覆盖了整组路由。

| 路由类别 | 策略 | 新鲜度 |
|-------------|----------|-----------|
| `/`、`/posts`、`/notes`、`/projects`、`/archive`、`/tags`、`/search` | 动态 RSC，按请求渲染 | 保存时触发 `revalidateContentChange`，清掉受影响路径的客户端路由缓存 |
| `/posts/[slug]`、`/notes/[slug]`、`/projects/[slug]` | 动态 RSC —— 每次请求都从文件读取正文 | 同上 |
| `/graph`、`/admin/*` | 按请求渲染，从不预渲染 —— `/graph` 渲染的是一个抓取 `/api/graph` 的客户端组件 | — |
| `/rss.xml`、`/atom.xml`、`/rss/[tag]`、`/rss/category/[category]`、`/sitemap.xml` | 路由处理器，`force-dynamic` —— 构建时没有数据库可读 | 没有需要失效的东西：按请求渲染，之后由共享缓存缓存 |
| `/robots.txt` | `MetadataRoute`，预渲染 —— 它只读 `SITE_URL`，别的什么都不读 | 一次重新构建 |

**为什么阅读区是动态的**（`src/app/(site)/layout.tsx` 里有长篇论证）：内容树是一个卷，而镜像的意图是：无论旁边发布了什么，它都保持字节一致。一个读取内容树的构建会把已发布状态烤进镜像里，而这种失败是安静的、且方向错误。按需渲染每请求要付出一小把针对本地 Postgres 的带索引查询，换来三件事：发布立即可见、构建不需要数据库、镜像不可能含有内容。它还覆盖了那些从不经过后台的变更 —— 一个被丢进 `content/` 的文件、一次 `content:sync`、worker 把一篇定时文章翻成已发布。这些都不会调用 `revalidatePath`，而在基于时间的缓存下，每一个都要等到窗口过去才可见。

剩下需要失效的是*客户端*路由缓存：没有它，一次回到列表页的客户端导航会送出路由缓存里的副本。那就是 `src/lib/admin/revalidate.ts` 里的 `revalidateContentChange`，而它就是新鲜度机制的全部。

**公开页面不自带 `Cache-Control`。** 只有三条路由设置它，且仅有三条：订阅源（`public, max-age=600, s-maxage=3600, stale-while-revalidate=86400` —— 订阅源渲染很便宜，而读者是一个按自己节奏轮询的聚合器，所以订阅者比发布晚几分钟不是问题）、`/api/graph`（`max-age=300, s-maxage=3600, stale-while-revalidate=86400`）以及 OG 图片路由。别处的文档可能描述文章路由上有一条一刀切的 `s-maxage`；这里没有，而且在一个刻意保持动态的树上也不该有。

### 订阅源

四个地址，一份实现。`/rss.xml` 和 `/atom.xml` 是同一份站点订阅的两种序列化；`/rss/<tag>.xml` 和 `/rss/category/<category>.xml` 各是一个主题。`src/app/rss/_feeds.ts` 持有共用的那一半 —— 设置、文档列表、条目上限、响应头 —— 每个路由文件只持有它自己的地址，这样四个地址就不可能对"什么是订阅源"产生分歧。

关于这些地址，有两个细节并不显然：

- **`.xml` 后缀是 URL 的一部分，不是扩展名。** Next 的动态段带不了字面后缀，所以 `/rss/linux.xml` 由 `[tag]` 处理，`params.tag === 'linux.xml'`，而 `feedSlug` 负责把一个段变成主题或者拒绝它。不带后缀的段不是订阅源地址，因此 `/rss/linux` 给出的是本站那句"这个地址不提供订阅源"，而不是一个空订阅源 —— 一个被塞了空订阅源的读者，会从一个根本不存在的主题上退订。
- **`/rss/category/…` 是与 `[tag]` 并列的静态段，** Next 会优先匹配它，所以 `/rss/` 下的两段路径永远是分类，一段路径永远是标签。

一个主题要满足什么才能有订阅源：

| 主题 | 查找方式 | 理由 |
|-------|--------|-----|
| 标签 | `getTag(slug)` —— 只有背后有已发布内容的标签 | 与 `/tags/<slug>` 用的是同一次查找，所以"标签页 404 而标签订阅源却送出一份空文档"这两件事不可能同时发生 |
| 分类 | `countContent({ category }) > 0` —— 只统计可见文档 | 分类只以文档上的一个字符串形式存在，所以一个只有草稿的分类不该拥有一个声称它存在的订阅源 |

文档按存储的字符串匹配（`doc.category === name`，标签按名称成员关系），所以一个分类恰好只有一个订阅源 URL —— 而且是大小写敏感的：`atom:link rel="self"` 只能指定一个地址，一个宽容的比较会让两个地址同时流通。

**每个页面各自声明自己的订阅源链接。** 当页面设置 `alternates` 时，Next 会整体替换它，所以根布局的 `<link rel="alternate">` 只到达首页，别处没有。因此 `buildPageMetadata` 会在每一个与主题无关的页面上输出站点订阅源，而标签页发布的是它自己的标签订阅源，*取而代之* —— 这就是为什么布局里那份被记录为"那一条不渲染自身元数据的路由的答案"。

## 11. 可观测性

`/admin/system` 报告：内容索引的新鲜度（行数 vs. 文件数）、搜索索引状态、上传目录大小、数据库大小、待执行的定时任务、失败的任务，以及最近 50 条审计记录。

`docker healthcheck` 用的是一个更窄的面：`GET /api/health`（`src/app/api/health/route.ts`）检查数据库和内容索引漂移，且只在数据库不可达时返回 503。仅有漂移是 `degraded` + 200 —— 一个在同步任务跑起来之前就已启动完成的构建，不是那种应该被重启的容器，而把这一点说出来，正是"会报告的 healthcheck"与"会反复抖动的 healthcheck"之间的区别。

---

## 12. 目录地图

```
src/
  app/
    (site)/            前台阅读体验
    admin/             后台 CMS
    api/               search、upload、analytics、graph、preview、health
  components/
    ui/                shadcn 风格基础组件（Radix + CVA）
    site/              阅读体验
    admin/             后台组件
    markdown/          渲染器 + 交互式区块包装
  lib/
    content/           唯一接触 content/ 的模块
    markdown/          unified 管线 + 插件
    db/                drizzle schema、客户端、迁移
    auth/              会话、密码、守卫、csrf、限流
    search/            provider 接口 + 本地 BM25 provider
    analytics/         采集、聚合、保留
    seo/               元数据、JSON-LD、订阅源、OG 图片
    jobs/              定时任务运行器 + 处理器
    git/               可选的 content 自动提交
    security/          路径监狱、mime 嗅探、消毒器、嵌入来源白名单
    settings/          类型化的站点设置读取器
  env.ts               经过校验的环境变量
scripts/               CLI（content:*、db:*、backup）
tests/                 unit + integration + e2e
content/               Markdown 事实来源
uploads/               媒体文件（跑 `pnpm dev` 时是 public/uploads/）
```

---

## 13. 取舍与已知限制

诚实记录，因为一份只列优点的设计文档就是营销材料。

1. **CJK bigram 分词**会对罕见词过度切分，也无法对单个汉字做前缀匹配。对单人站点可以接受；Meilisearch 是逃生舱，而 provider 接口就是为它准备的。
2. **进程内搜索索引**撑不到多实例部署。第二个副本要么自己建一份（没问题，它很便宜），要么去跟外部 provider 说话。
3. **`bytea` 里的修订**会让数据库增长。清理发生在写入路径而不是任务里：一次具名保存会在新修订写好后立即把该文档的具名修订裁到 `revisionsMaxPerContent`（默认 50），而自动保存则由 store 在自己的事务内裁到一个更大的上限。因此这个上限是按文档计的 —— 删除一篇文档会级联带走它的历史，也不需要任何后台任务运行来让数据库保持有限。
4. **Git 自动提交**会调用 `git`，并假定内容目录已经是一个仓库（或位于某个仓库内）且配置了身份 —— 容器里得装了 git 它才能做任何事。它默认关闭，需要两个开关一致，且从不 push。提交只在一个进程内串行；两个进程同时提交会在索引锁上争抢，输的那个被记录并跳过。
5. **没有多作者工作流。** 只有一个管理员账号，而且授权就是认证：任何路由问的唯一问题都是"这个请求带没带一个有效的会话"。没有角色列，也没有审阅队列或编辑审批环节。
6. **分析数据在设计上只有聚合。** 没有漏斗、没有会话、没有人群分群 —— 这是一条刻意的产品边界，不是一个没做完的功能。
