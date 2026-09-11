# 交付说明

本文档对应 `project.md` 第五十六节要求的十项交付内容。三项产出物为
[README.md](./README.md)（快速上手与脚本手册）、[ARCHITECTURE.md](./ARCHITECTURE.md)
（架构与设计决策）、[DEPLOYMENT.md](./DEPLOYMENT.md)（生产部署运行手册），
以及本文档。

文中每一条结论都来自对当前代码的实际阅读。凡与 `project.md` 的要求不一致之处，
均如实写出并说明原因，不做"已经实现"的声明。文末附有 `ARCHITECTURE.md` 与当前
实现已经不同步的几处说明。

---

## 1. Architecture Summary（架构摘要）

**定位**：Personal Knowledge System + Publishing Platform。前台是阅读体验，后台是
发布工具，两者共用同一套内容管线；不是博客模板，也不依赖 Ghost 或任何 Headless CMS。

**贯穿全部设计的第一原则**：Markdown 文件是内容的唯一真实来源。文章正文
**不存在于数据库**——数据库里没有任何 `body` 列，`content/*.md` 是正文的唯一载体。
数据库保存文件无法保存的东西：内容索引、标签与链接关系、修订历史、资源元数据、
重定向、站点设置、导航、会话、访问统计、审计日志、任务队列。

由此推出四条推论，它们解释了代码库中大部分的形态：

| 原则 | 含义 | 代码体现 |
|------|------|----------|
| 文件管内容，数据库管状态 | 正文永不入 Postgres | `content_index` 只有元数据与 `checksum`，没有正文列 |
| 退化为文件系统 | 数据库不可用时，已发布页面依然能渲染 | 读路径 `content/*.md` → frontmatter → Markdown → HTML，不经过数据库 |
| 不允许静默损坏 | 保存失败绝不触碰原文件 | `src/lib/content/writer.ts`：加锁 → 临时文件 → `fsync` → 原子 `rename` → `fsync(dir)` |
| Server 优先 | 页面默认是 Server Component，客户端 JS 按需加载 | 代码高亮在服务端完成；Mermaid、图谱、编辑器动态加载 |

**读路径**：`content/*.md` → 解析 frontmatter → 服务端渲染 Markdown（Shiki）→ RSC →
HTML。渲染一篇文章不需要任何数据库往返。

**写路径**：后台 UI → Server Action（Zod 校验 + CSRF + 会话检查）→ 序列化 frontmatter 与
正文 → 加锁、写临时文件、`fsync`、原子 `rename` → 生成修订快照（gzip）并 upsert
`content_index` → 失效缓存与进程内搜索索引 → 可选 git 提交 → `revalidatePath`。

**关系计算不使用 AI**：相关文章是基于标签 Jaccard 相似度、同分类、共同内链与标题关键词
的加权打分；反链来自 `content_links` 的反向查询；知识图谱是文档与标签构成的节点图。
三者在 `src/lib/graph/` 中实现。

**渲染策略**：公共站点整棵树与根 `not-found.tsx` 导出 `dynamic = 'force-dynamic'`，
数据库驱动的页面**不在构建期预渲染**。原因有两条，见 `src/app/(site)/layout.tsx` 的
长注释：Docker 构建环境里没有数据库（预渲染会直接失败），而在有数据库的机器上构建则会把
"当时开发库里的内容"静默烤进镜像。已移除所有 `revalidate` 导出（它们在 `force-dynamic`
下不起作用，一个看起来在控制缓存却不起作用的数字比没有更糟）。`/_not-found` 与
`/robots.txt` 是仅有的静态路由。

细节与取舍见 `ARCHITECTURE.md`。

---

## 2. Project Structure（项目结构）

```
src/
  app/
    (site)/            前台：首页、posts、notes、projects、tags、archive、
                       series、about、search、graph
    admin/             后台 CMS：dashboard、[type]（文章/笔记/项目）、编辑、
                       revisions（含 diff 与 compare）、assets、tags、
                       navigation、redirects、analytics、settings、system、
                       import、login
    api/               search、assets（上传与文件服务）、analytics、graph、
                       preview、og（动态 OG 图）、health
    rss.xml/ atom.xml/ 订阅源路由；robots.ts、sitemap.ts
  components/
    ui/                Radix + CVA 基础组件
    site/              阅读体验（导航、命令面板、阅读进度、主题切换）
    admin/             后台组件（含 editor/ 下的 CodeMirror 6 编辑器与元数据面板）
    markdown/          渲染结果包装（代码块增强、Mermaid、Tabs）
    graph/             图谱画布与交互
  lib/
    content/           唯一允许读写 content/ 的模块
    markdown/          unified 管线与自研插件
    db/                Drizzle schema、客户端、SQL 迁移
    auth/              密码、会话、守卫、CSRF、限流
    search/            本地 BM25 与 SearchProvider 接口
    analytics/         采集、按日聚合、留存清理
    seo/               metadata、JSON-LD、RSS/Atom、Sitemap、OG 图
    jobs/              任务队列、处理器、Worker 循环
    revision/          快照、diff、恢复
    assets/            上传、图像处理、blur 占位
    security/          路径越狱、MIME 嗅探、SVG 与 HTML 消毒
    graph/             反链、相关内容、关系模型与力导布局
    settings/          类型化站点设置读取
  env.ts               环境变量校验与生产姿态检查
  instrumentation.ts   服务器启动钩子（每个进程一次，构建期不执行）
  middleware.ts        仅作用于 /admin/:path*，注入 x-pathname 请求头
scripts/               CLI（content:*、db:*、worker）与 backup/restore 脚本
tests/                 unit（17 个文件）、integration（3 个）、e2e（2 个 spec）
content/               Markdown 内容源（posts / notes / projects）
public/uploads/        上传的媒体
```

**与设定稿的差异**

- 后台不设 `/admin/posts`、`/admin/notes`、`/admin/projects` 三个并列目录，而是用一条
  动态路由 `/admin/[type]`（`posts|notes|projects` 映射到 `post|note|project`）。三种类型
  的列表、新建、编辑、修订页共用同一套实现，差异只在 frontmatter 字段上，复制三份是
  三份会各自漂移的代码。
- 在设定稿列出的页面之外，另加了 `/series/[series]`（系列页）、`/search`（命令面板之外的
  可分享搜索页）与 `/atom.xml`。

---

## 3. Database Schema（数据库结构）

Postgres + Drizzle ORM，SQL 迁移签入仓库（`src/lib/db/migrations/`，由 `pnpm db:generate`
生成、`pnpm db:migrate` 应用）。共 16 张表：

| 表 | 用途 | 关键列 |
|----|------|--------|
| `users` | 管理员账号，不开放注册 | `email`、`password_hash`（Argon2id）、`role`、`last_login_at` |
| `sessions` | 服务端会话（令牌以哈希形式存储） | `token_hash`（SHA-256）、`user_id`、`expires_at`、`user_agent`、`ip_hash` |
| `content_index` | 每个 Markdown 文件一行，支撑列表、统计与搜索 | `type`、`slug`、`path`、`title`、`status`、`published_at`、`scheduled_at`、`updated_at`、`checksum`、`word_count`、`reading_time`、`view_count`、`search_index_version` |
| `content_revisions` | gzip 压缩的全文快照 + 增删行数 | `content_id`、`revision_no`、`snapshot`（bytea）、`additions`、`deletions`、`author_id`、`kind` |
| `tags` / `content_tags` | 标签与其多对多关系 | `slug`（唯一）、`name`、`description`、`color` |
| `content_links` | 已解析的内链、锚点与图片引用，驱动反链与"未被引用" | `source_id`、`kind`、`href`、`target_key`、`target_id`、`asset_id`、`label`、`resolved` |
| `assets` | 上传媒体元数据 | `url`、`mime`、`size`、`width`、`height`、`blur_data_url`、`sha256`、`storage` |
| `redirects` | 旧 URL → 新 URL（Ghost 迁移用） | `from_path`（唯一）、`to_path`、`status_code`、`enabled`、`hits` |
| `site_settings` | 单行类型化设置（用 check 约束保证单行） | 站点标识、SEO、analytics/search/graph/rss/comments 开关、git、修订策略、About 内容 |
| `navigation` | 头部/底部/社交菜单 | `location`、`label`、`href`、`position`、`parent_id` |
| `analytics_daily` | 按日预聚合 | `day`、`path`、`content_id`、`views`、`visitors`、`referrer_domain`、`device`、`country` |
| `analytics_events` | 原始事件，短期留存，**不含 IP** | `created_at`、`path`、`content_id`、`referrer_domain`、`device`、`visitor_hash` |
| `audit_logs` | 所有后台写操作 | `user_id`、`action`、`target_type`、`target_id`、`metadata`、`ip_hash` |
| `scheduled_jobs` | 持久化任务队列 | `type`、`run_at`、`status`、`attempts`、`locked_at`、`last_error` |
| `rate_limits` | 限流令牌桶（登录、上传） | `key`、`tokens`、`last_refill_at`、`expires_at` |

对照设定稿第三十六节要求的最少表集合，全部具备；额外增加了 `content_links`、
`content_revisions`、`analytics_events` 与 `rate_limits` 四张表。

**最重要的空缺是有意为之**：没有 `posts.body`。正文只存在于 `.md` 文件中。

**修订为什么放在数据库**（设定稿允许 `content/revisions/` 或压缩 diff）：选择在
`bytea` 中存 gzip 压缩的**完整快照**。理由：恢复是一次单行读取，不存在"链式 diff 断一环
就全废"的失败模式；`+23 −5` 这类统计由任意两份快照按需 diff 得出，不存冗余派生数据；
`content/posts/*.md` 保持"就是内容本身"，文件树干净；修订是历史而非内容源，放在数据库
并不违反第一原则。保留条数由 `revisions.max_per_content`（默认 50）限制，由定时任务裁剪。

---

## 4. Content Format（内容格式）

```
content/
  posts/      长文            → /posts/<slug>
  notes/      短笔记、片段    → /notes/<slug>
  projects/   项目页          → /projects/<slug>
  .locks/     写入锁（临时）
  .tmp/       原子写暂存（临时）
```

一个文件 = 一篇文档，文件名只是线索，frontmatter 里的 `slug` 才是权威。`.locks/` 与
`.tmp/` 是运行期状态并已被 gitignore，内容树里没有别的东西。

Frontmatter 由 `src/lib/content/schema.ts` 用 Zod 定义一次，解析器、校验器、CLI 与编辑器
共用同一套定义——一个文件通过了其中一个，就通过全部。

```yaml
---
title: "Linux 网络排查笔记"
slug: "linux-network-debugging"
description: "从 tcpdump 到 netstat 的一次完整排查记录"
date: 2026-09-11
updated: 2026-09-11
status: published                # draft | scheduled | published | archived
publishAt: 2026-10-01T09:00:00Z  # status: scheduled 时必填
tags: [Linux, Network]
category: Technology
featured: false
toc: true
lang: zh
---
```

规则细节：

- **三种类型的宽松度不同**。Post 与 Project 必须有 `title`；Note 可以没有（由第一个
  标题或首行推导），`description` 与 `slug` 同样可以省略。
- **状态是推导出来的，不是默认出来的**。显式写 `status` 时以它为准；否则有日期即
  `published`，无日期即 `draft`。这一条看似可以写成 `.default('published')`，但那会让
  一个"只有标题和正文、没写日期"的普通文件被判为已发布同时又缺少日期而报错——把
  手写文件判为草稿，作者能在后台看见并补上日期，才是对的失败方向。`scheduled` 必须有
  `publishAt`；`published` 必须有日期。
- **未知键会保留**。解析时把 schema 之外的键收集起来，序列化时原样写在规范字段之后，
  所以手写的 frontmatter 不会被后台保存悄悄抹掉（`src/lib/content/frontmatter.ts`
  的 round-trip 契约）。
- **日期锚定 UTC 正午**。裸日期（`2026-09-11`）是一个没有时区的本地事实，锚定 UTC 零点
  会让格林威治以西的所有读者看到前一天；显示层统一以 UTC 格式化，正午锚点是双保险。
- **原子写入契约**：加锁（`content/.locks/` 下的锁文件，`O_EXCL` 创建，10 秒后视为陈旧，
  等待上限 5 秒）→ 写 `content/.tmp/<随机名>.tmp` → `fsync(file)` → `rename()`（POSIX 上
  原子）→ `fsync(dir)` → 释放锁。`rename` 的原子性保证读者只会看到旧文件或新文件，绝不会看到
  写了一半的。进程中途死掉只会遗留一个临时文件，原文件完好，启动时清理孤儿临时文件。
  每次正式保存前还会写入一份修订快照，所以即便一次"保存成功但内容错了"也可恢复。

**内容同步引擎**（设定稿第三十八节）：文件可以在应用背后被改动——`git pull`、`vim`、
容器挂载、后台 UI。`src/lib/content/sync.ts` 是唯一的对账方：扫描 `content/**.md` → 逐个
计算 sha256 → 与 `content_index` 比对（缺失则 INSERT，校验和不同则 UPDATE 并写修订，
库中有行而文件已消失则标记删除，未变则跳过）→ 重解析 frontmatter、刷新标签与链接。触发
时机有三处：`pnpm content:sync`（完整、详细）、应用启动时的轻量检查（只比 mtime 和大小，
不哈希）、以及每次后台保存后的单文档定向同步。扫描有上限，`CONTENT_MAX_FILES`（默认
5000）防止挂载错的卷把一次启动变成对 `/` 的遍历。

---

## 5. Local Development（本地开发）

前置条件：Node.js 22+、pnpm（`packageManager` 固定 `pnpm@12.3.4`，Corepack 读取它）、
PostgreSQL。不需要 Redis、Meilisearch 或消息队列。

```bash
cp .env.example .env.local      # .env.local 优先于 .env，两者都不入库
openssl rand -base64 48         # 填 SESSION_SECRET
pnpm db:migrate                 # 建表
pnpm db:seed                    # 建管理员、设置行、默认导航
pnpm content:sync               # 用现有 Markdown 建立内容索引
pnpm dev                        # http://localhost:3000 · /admin/login
```

**`ADMIN_PASSWORD` 是必填的，脚本不会替你生成**。`scripts/db/seed.ts` 在缺任意一项时以
非零码退出且不写入任何数据（三项校验都在第一次写库之前完成，所以 `.env` 里一个笔误不会
留下半初始化的数据库）。不生成密码的理由写在脚本注释里：自动生成的密码不是被打印进
日志，就是变成一个没人能登录的账号，两者都比直接拒绝更糟。

`db:seed` 是幂等的：第二次运行不改动任何已存在的东西——密码、站点名、菜单都不会被重置。
实现上每一处写入都是条件写而非 upsert，因为 upsert 会静默覆盖管理员在后台做过的修改，
而运行脚本的人无从察觉。

**脚本清单**（`package.json` 全量，逐条说明见 README）：

| 类别 | 脚本 |
|------|------|
| 开发 | `dev`、`build`、`start`、`lint`、`typecheck` |
| 测试 | `test`、`test:watch`、`test:integration`、`test:e2e` |
| 数据库 | `db:generate`、`db:migrate`、`db:seed`、`db:studio` |
| 内容 | `content:sync`、`content:validate`、`content:reindex`、`content:import`、`content:links`、`content:stats` |
| 运行 | `worker`、`backup`、`restore` |

**测试分三层**（设定稿第五十一节要求 Unit / Integration / E2E）：

- **Unit**（`tests/unit/`，17 个文件，`pnpm test`）不需要数据库。覆盖 frontmatter 解析、
  slug、Markdown 渲染、内链解析、反链、内容同步、重定向、路径越界校验、搜索、修订、
  任务、Analytics、SEO、设置。
- **Integration**（`tests/integration/`，3 个文件，`pnpm test:integration`）跑真实 Postgres
  与真实临时内容树。配置里 `fileParallelism: false` 不是保守，而是必需：每个文件有自己
  的 `CONTENT_DIR`，但共用一个数据库，而 `syncContent` 会把"看不到文件"的索引行删掉——
  两个文件同时跑会互相删掉对方的夹具，失败现象是随机断言失败。缺少
  `TEST_DATABASE_URL` 时**跳过**而非失败，没有数据库的检出仍能得到一次绿色的单测运行。
- **E2E**（`tests/e2e/`，`pnpm test:e2e`）用 `next build && next start` 起真实生产服务器，
  使用自己的数据库（`myblog_e2e`，从 `TEST_DATABASE_URL` 推导）与自己临时内容树，在
  Chromium 的桌面与移动两个 profile 下驱动，单 worker 串行。它必须用独立数据库和独立
  内容树，见 `tests/e2e/environment.ts`：这个套件会创建文档再**删除**文档（删除本身是
  被测流程之一），指向仓库的 `content/` 就不是测试而是数据丢失工具。

`TEST_DATABASE_URL` 必须与 `DATABASE_URL` 指向同一台服务器、但**不同的库名**。

---

## 6. Production Deployment（生产部署）

支持路径是 Docker Compose：

```bash
cp .env.example .env      # compose 读 .env
docker compose up -d      # 启动 postgres → migrate（跑完退出）→ app
```

- **三阶段镜像**（`Dockerfile`，`deps` / `build` / `runner` 三个工作阶段共用一个 `base`）。
  `next.config.ts` 设 `output: 'standalone'`，运行时镜像里**没有 `node_modules`**，只有
  被追踪到的依赖与 `.next/standalone`、`.next/static`、`public/`。它不包含任何可以用来
  安装东西的包管理器。
- **迁移单独一个服务**，构建在同一提交的 `build` 阶段。运行时镜像**不能**跑迁移：迁移器
  是 TypeScript、要靠 devDependency `tsx` 执行，而 standalone 产物是按应用入口追踪出来
  的，两者都不在里面——把 `src/`、`scripts/`、`drizzle/` 拷进去会"看起来能跑"然后第一次
  使用就失败。`app` 用 `service_completed_successfully` 等 `migrate` 退出，因此一次部署
  不可能服务于一个与代码不匹配的 schema。
- **卷**：`./content:/app/content` 与 `./public/uploads:/app/public/uploads` 都是**读写
  bind mount**，不是命名卷。Markdown 就是要能在宿主机上用编辑器、用 git、用 SSH 直接改
  的目录，而不是 Docker 管理的一坨数据。镜像里不含任何内容，所以回滚是换 tag，不是恢复
  备份。注意容器以 uid 1001 运行，bind mount 保留宿主机的属主，两个目录必须对该 uid 可写。
- **生产姿态检查**（`src/env.ts` 的 `assertProductionPosture`，由 `src/instrumentation.ts`
  在服务器进程启动时调用一次、构建期不调用）：在生产环境下，`SESSION_SECRET` 仍是开发
  默认值、`COOKIE_SECURE` 不为 1、`SITE_URL` 是 `http://` 三者任意一条都会让进程直接
  拒绝启动。这三项都是"配置错了会静默失效而不是显式报错"的控制项——已知的会话密钥可以
  伪造任何会话，没有 `Secure` 的 Cookie 会明文传输，`http://` 的站点地址会产出指向错误
  协议的 canonical 与 sitemap。
- **健康检查**：`GET /api/health`。只回答两个问题——数据库是否可达、内容索引与磁盘文件
  是否一致。数据库不可达返回 503，内容漂移只在响应体里报 `degraded` 并保持 200（页面
  仍能渲染，能修好漂移的是同步而不是重启，503 只会让一个正常工作的容器陷入无法自愈的
  重启循环）。不吐环境变量、版本、连接信息、文件路径，也不回显驱动的报错原文。
- **反向代理与 TLS**：容器内部是明文 HTTP，生产必须由代理终止 TLS（因为 `SITE_URL` 必须
  是 https 且 Cookie 带 Secure）。`SITE_URL` 必须是读者实际访问的主机名——站点的来源
  校验拿它和 `TRUSTED_ORIGINS` 比对。

完整命令、环境变量全表（含哪些在生产必填）、升级步骤与故障排查见
[DEPLOYMENT.md](./DEPLOYMENT.md)。

---

## 7. Markdown Import Guide（Markdown 导入指南）

导入引擎在 `src/lib/content/import.ts`（约 2100 行），后台入口是 `/admin/import`，命令行
入口是 `pnpm content:import`。四种来源全部支持（设定稿第四节）：

| 来源 | 后台 | CLI |
|------|------|-----|
| 单文件 | 支持 | `--from a.md` |
| 多文件 | 支持 | `--from a.md,b.md` |
| ZIP | 支持 | `--zip export.zip` |
| 服务器目录扫描 | 支持 | `--scan-dir ~/blog` |

自动处理：扫描 Markdown → 读取 frontmatter → 尝试识别 title（无标题时从首个标题或首行
推导）→ 生成 slug → 识别日期 → 提取 description → 提取标题树 → 建立全文搜索索引 →
检查图片链接 → 检查内部链接 → 检查重复 slug → 生成报告。

报告按问题代码分类计数，设定稿示例中的四类都在其中：
`missing-description`、`duplicate-slug`、`broken-image`、`broken-link`（另有 19 类，如
未知 frontmatter 键、无法解析的日期等）。每个问题都带一条 `suggestion` 修复建议，并在
界面上按文件、按行号、按严重级别展示。

**不修改原始文件**：导入是两阶段的。先扫描并产出计划（`buildImportPlan`），计划带一个
`fingerprint` 指纹，应用时必须回传同一个指纹，不一致就拒绝写入——这防止"看到报告之后、
真正写入之前"文件被换掉。写入只作用于目标位置的副本，走的是与后台保存同一套原子写；
唯一会被自动应用的修复是标题推导，且必须显式勾选。源文件从头到尾只读。命令行版本默认是
dry run，必须显式写 `--apply` 才会落盘。

ZIP 处理是自写的中央目录解析，全程在内存中，拒绝 ZIP64 与加密压缩包，并带压缩比与总
体积上限（防 zip bomb）。

---

## 8. Backup / Restore（备份与恢复）

```bash
pnpm backup                                          # → ./backups/<UTC 时间戳>/
bash scripts/backup.sh /mnt/backups                  # 备份到别处
BACKUP_KEEP=30 bash scripts/backup.sh                # 保留 30 份（默认 14，0 表示不清理）
bash scripts/restore.sh backups/2026-09-11T10-30-00Z # 需要手输 restore 确认
bash scripts/restore.sh <dir> --yes                  # 或 --database-only / --files-only
```

（`pnpm backup` / `pnpm restore` 是不带参数时的别名；需要传参数时直接调用脚本。）

一份备份包含三样无法再生的东西：数据库（索引、会话、标签、修订、审计日志、统计）、
`content/`（Markdown，内容真源）、`public/uploads/`（媒体）。`.next/`、`node_modules/`
与镜像都不包含——它们可以从源码重建，放进去只会让每份备份膨胀一百倍。

```
backups/2026-09-11T10-30-00Z/
  database.dump     pg_dump custom 格式（压缩、可部分恢复）
  content.tar.gz    Markdown 树
  uploads.tar.gz    媒体树
  *.toc             校验步骤写出的目录清单
  MANIFEST          这是什么、来自哪里、是否校验通过
```

**每一份归档都会被读回验证**：`pg_restore --list` 解析 dump 的目录，`tar --list` 验证两棵
树。没人读回过的备份只是希望，不是备份。`MANIFEST` 里的数据库 URL 会去掉密码。

**恢复的语义**（`scripts/restore.sh`）：

- 不 drop 数据库。它恢复到既有库中，用 `pg_restore --clean --if-exists
  --single-transaction --exit-on-error` 重建对象：要么整体提交，要么整体回滚。这样同一台
  服务器上的属主、扩展与其他数据库都不受影响。
- 内容树与上传目录是**替换**而非合并，被替换的目录会被移到 `*.before-<时间戳>` 而不是
  删除——恢复错了备份是可以回退的。合并会留下一个"既不是备份也不是恢复前"的状态，那是
  最难推理的状态。
- 所有可能失败的检查都在第一条破坏性命令之前完成。

恢复之后有两件事脚本会打印出来但无法替你做：`pnpm content:sync`（数据库与内容树是分别
恢复的，需要重新对账），以及重启应用（搜索索引与关系索引是进程内构建的，此时已经过期）。

---

## 9. Security Notes（安全说明）

| 面向 | 措施 |
|------|------|
| 密码 | Argon2id（`@node-rs/argon2`），每个密码独立盐，内存代价已调优；长度限制 12–1024 |
| 会话 | 32 字节随机令牌，**以 SHA-256 哈希存库**；Cookie 为 `HttpOnly` + `Secure`（生产）+ `SameSite=Lax` + `Path=/`，登录时轮换；绝对过期与空闲过期双重限制；不开放注册 |
| CSRF | 与会话绑定的双提交令牌，外加每个写请求上的 `Origin` / `Sec-Fetch-Site` 校验；Server Action 走同一套守卫 |
| 限流 | Postgres 中的令牌桶（`rate_limits` 表），登录 `5 次 / 15 分钟 / ip_hash`，上传同样受限。存在数据库里意味着重启不丢、多副本共享 |
| 路径穿越 | 所有路径先 `path.resolve`，再用基于 `path.relative` 的 `isInside(root, p)` 判定，**从不使用字符串 `startsWith`**；内容路径、上传路径、ZIP 条目一律适用 |
| 上传 | 从魔数字节嗅探 MIME（不看 `Content-Type` 头），扩展名由嗅探结果推导；SVG 经过消毒（剥离脚本、`on*`、`foreignObject`、外部引用），否则改为下载 |
| Markdown XSS | `rehype-sanitize` 显式白名单收尾，`iframe` 仅限配置的来源白名单；这是关闭 `dangerouslySetInnerHTML` 这个攻击面的地方 |
| 授权 | 每个后台动作顶部一个 `requireAdmin()` 守卫，后台 layout 再强制一次，所以即使某个页面忘了写，也不存在无保护的面 |
| 审计 | 每次写操作写 `audit_logs`：操作者、动作、目标、脱敏后的 diff 摘要、ip_hash |
| 密钥 | `SESSION_SECRET`、`DATABASE_URL` 由 `src/env.ts` 在启动时校验；生产环境下密钥为默认值或过短、Cookie 不带 Secure、站点地址是 http 时会拒绝启动（见第 6 节） |
| 响应头 | `next.config.ts` 下发 CSP、`X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、`Permissions-Policy`；`/api/assets` 被显式排除在通用规则之外，因为它对用户上传的 SVG 使用更严格的 `default-src 'none'; sandbox`，被通用规则覆盖会等于没有保护 |

`/api/analytics` 与 `/api/health` 是公开未鉴权端点：前者按设计如此（发起它的页面已经
知道请求里的全部内容），且不读取任何携带 IP 的请求头、不记录 IP；后者只回布尔值与计数。

---

## 10. Future Improvements（后续改进）

以下是实际阅读代码后确认的**未完成项与缺口**，一条一条列出，不含推测。这一节随实现移动：
上一版列在这里、现已补齐的有九项——重定向未生效、Analytics 两端未接、按 tag / 分类的 RSS
缺失、Git 自动提交只有开关、Worker 循环无人启动、About 页缺两个区块、TOC 无平滑滚动、
终端样式是空规则、sitemap 缺 tag 与 series 页（依次对应设定稿第二十五、二十八、二十六、
四十二、三十九、四十三、八、七、二十三节），因此不再出现在下面。

补上来的三项顺带记下三个决定：第八节的平滑滚动没有写成 `html { scroll-behavior: smooth }`，
因为那个属性作用于视口的**每一次**滚动——Next 在路由切换时用 `scrollIntoView()` 定位，全局
声明会把"从长文中点开另一篇文章"也变成动画。改为在点击目录链接时把该属性临时设在根元素上、
滚动结束（`scrollend`，或 1s 上限）后收回，浏览器的原生行为——URL 片段、历史记录、焦点顺序、
`scroll-padding-top`——一样都没动，实现见 `src/components/content/table-of-contents.tsx`。
第七节的"bash output"落成了 ```` ```bash terminal ```` 这个元数据词（`code-meta.ts` 已有文档但
此前没实现），终端块因此有一条左侧竖轨，并且不再重复显示语言徽标。第二十三节的 tag 页与
series 页由文档本身派生（`buildSitemapEntries` 里新增的 `topicEntries`）：只有当某个 tag 底下
真的有一篇可被索引的文章时，它才会出现在 sitemap 里——与 tag 页本身"没有内容就 404"是同一条
规则；tag 名到 slug 的映射由路由从 `listTags()` 传入，因为只有 `tags` 表知道 `C++` 的页面
地址是 `/tags/c-plus-plus`。

**功能缺口**

1. **资源缩略图变体没有实现**。`src/lib/assets/` 生成 webp/avif 变体并保存宽高与 blur
   占位，但没有 thumbnail 变体；后台列表用 CSS 缩放原图。设定稿第二十节列出了 thumbnail。
2. **编辑器的两个快捷键没有绑定**：`Ctrl/Cmd+K` 插入链接与 `Ctrl/Cmd+Shift+I` 上传图片
   （`Cmd+S` 保存、`Cmd+P` 预览、粘贴图片、拖拽图片上传都已实现）。设定稿第十七节列出
   了这四个快捷键。
3. **没有 `loading.tsx`**。`src/components/ui/skeleton.tsx` 存在但没有任何引用点，设定稿
   第四十九节要求加载时用 Skeleton。
4. **JSON-LD 只输出 Article 与 Breadcrumb**。`buildWebsiteJsonLd` 与
   `buildPersonJsonLd` 已实现并有测试，但没有生产调用方。

**架构性限制**（属于已知取舍，不是遗漏）

5. 搜索索引与关系索引都在进程内，多副本部署会成为陈旧窗口的来源（副本自己构建一份索引
   是正确的，但写时的失效只到达处理本次保存的那个副本）。
6. CJK 采用 bigram 分词，对罕见词会过度切分、无法做单字前缀匹配；`SearchProvider`
   接口就是为换 Meilisearch 留的缝。
7. 修订以完整快照存在 `bytea` 中会增长数据库。约束是**内联**的而非后台任务：每次具名保存
    之后 `pruneRevisions` 按 `revisionsMaxPerContent`（默认 50）裁剪该文档的具名修订，
    自动保存由存储层在自己的事务里按 `AUTOSAVE_REVISIONS_KEPT` 单独裁剪
    （`src/lib/revision/store.ts`）。裁剪按文档进行，且总在写入之后——删掉文档，修订随之
    级联删除；没有任何 worker 任务参与这一步（`JOB_KINDS` 里没有 revision 相关类型）。
8. 没有多作者工作流：schema 里有 `owner` / `editor` 角色，但没有评审队列或编辑审批。

**有意保留的"没有读取方"**

9. `site_settings.googleVerification` 与 `commentsEnabled` 没有任何生产读取点。这是披露
    而不是遗漏：后台在各自的输入框下面直接写明"加入它不会验证站点"/"打开它不会改变任何
    页面"。另有 `SETTINGS_CACHE_TAG`，后台的"清除缓存"动作会 `updateTag` 它，但当前没有
    `'use cache'` 消费者（`getSettings` 是每请求 memo）——这同样写在
    `src/app/admin/actions/system.ts` 的注释里，按钮的回复也照实说。

---

## 附录：`ARCHITECTURE.md` 与当前实现已经不同步的几处

`ARCHITECTURE.md` 先于实现写成，以下几条在实现过程中被推翻或调整，读它时请以本附录与
代码为准（本文档不修改该文件）：

1. **§10 渲染与缓存表**：文中写 `/posts/[slug]` 等用 `generateStaticParams` + ISR
   （`revalidate = 3600`），并写全站文章路由共用 `s-maxage=3600, stale-while-revalidate=86400`。
   当前实现完全相反：没有任何 `generateStaticParams`、没有任何 `revalidate` 导出，公共
   站点整棵树是 `force-dynamic`（理由见 `src/app/(site)/layout.tsx`）；只有订阅源、
   `/api/graph` 与 OG 图路由自己设置了 `Cache-Control`。
2. **§8** 写 `/graph` 是 `dynamic = 'force-static'` 并客户端拉取 `/api/graph`。当前
   `src/app/(site)/graph/page.tsx` 没有 `force-static` 导出（"图谱不进入主 bundle"这一点
   仍然成立）。
3. **§11** 写 `src/lib/health.ts` 对外暴露检查。该文件不存在；健康检查在
   `src/app/api/health/route.ts`，直接调用 `src/lib/db` 与 `src/lib/content/sync`。
4. **§6 Markdown 管线** 列的插件名（`rehype-pretty-code`、`rehype-slug`、
   `rehype-autolink-headings`、`remark-frontmatter`）并不在依赖里。能力都在，但由自研插件
   实现：`rehype-code.ts`（Shiki 集成）、`slugger.ts`（标题 id）、`remark-blocks.ts` /
   `remark-alerts.ts`（callout 与 GitHub Alert）、`remark-deflist`（定义列表）。
5. **§4** 写 "Postgres 16+"，而 `docker-compose.yml` 固定 `postgres:17-alpine`。二者不冲突
   （schema 不需要 16 以上的特性），只是版本口径不一致。
