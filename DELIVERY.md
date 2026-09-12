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
uploads/               上传的媒体（compose 把它挂到容器的 /app/public/uploads；
                       本地 `pnpm dev` 则写 public/uploads/）
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
| `assets` | 上传媒体元数据 | `url`、`mime`、`size`、`width`、`height`、`blur_data_url`、`average_color`、`variants`（webp/avif 派生物）、`thumbnail`（网格用的缩小副本）、`sha256`、`storage` |
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
并不违反第一原则。保留条数由 `revisions.max_per_content`（默认 50）限制，在每次具名保存之后
**内联**裁剪而不是交给后台任务（第 10 节"架构性限制"第 3 条记了为什么）。

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
docker compose up -d      # 启动 postgres → migrate（跑完退出）→ web
```

- **三阶段镜像**（`Dockerfile`，`deps` / `build` / `runner` 三个工作阶段共用一个 `base`）。
  `next.config.ts` 设 `output: 'standalone'`，运行时镜像里**没有 `node_modules`**，只有
  被追踪到的依赖与 `.next/standalone`、`.next/static`、`public/`。它不包含任何可以用来
  安装东西的包管理器。
- **迁移单独一个服务**，构建在同一提交的 `build` 阶段。运行时镜像**不能**跑迁移：迁移器
  是 TypeScript、要靠 devDependency `tsx` 执行，而 standalone 产物是按应用入口追踪出来
  的，两者都不在里面——把 `src/`、`scripts/`、`drizzle/` 拷进去会"看起来能跑"然后第一次
  使用就失败。`web` 用 `service_completed_successfully` 等 `migrate` 退出，因此一次部署
  不可能服务于一个与代码不匹配的 schema。
- **卷**：`./content:/app/content` 与 `./uploads:/app/public/uploads` 都是**读写
  bind mount**，不是命名卷。Markdown 就是要能在宿主机上用编辑器、用 git、用 SSH 直接改
  的目录，而不是 Docker 管理的一坨数据。镜像里不含任何内容，所以回滚是换 tag，不是恢复
  备份。注意容器以 uid 1001 运行，bind mount 保留宿主机的属主，两个目录必须对该 uid 可写，
  且必须在第一次 `up` **之前** `sudo chown -R 1001:1001 content uploads`：宿主目录缺失时
  Docker 会以 root 创建它，那时容器已经写不进去了。
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
  校验拿它和 `TRUSTED_ORIGINS` 比对。compose 里带一个 `reverse-proxy` 服务（Caddy，
  `profiles: ['proxy']`，默认不启动），`DOMAIN=blog.example.com docker compose --profile
  proxy up -d` 即可自动签发与续期证书；不启用它时 `web` 只监听 `127.0.0.1:${PORT}`，
  由宿主机上你自己已有的代理转发。

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
pnpm backup                                                # → ./backups/backup-2026-09-11.tar.zst
bash scripts/backup.sh /mnt/backups                        # 备份到别处
BACKUP_KEEP=30 bash scripts/backup.sh                      # 保留 30 份（默认 14，0 表示不清理）
bash scripts/restore.sh backups/backup-2026-09-11.tar.zst  # 需要手输 restore 确认
bash scripts/restore.sh <archive> --yes                    # 或 --database-only / --files-only
```

（`pnpm backup` / `pnpm restore` 是不带参数时的别名；需要传参数时直接调用脚本。）

一份备份包含四样无法再生的东西：数据库（索引、会话、标签、修订、审计日志、统计）、
`content/`（Markdown，内容真源）、`uploads/`（媒体），以及环境文件（没有它，恢复出来的
站点无法给任何人签发会话）。`.next/`、`node_modules/` 与镜像都不包含——它们可以从源码
重建，放进去只会让每份备份膨胀一百倍。

```
backups/backup-2026-09-11.tar.zst
  database.dump     pg_dump custom 格式（压缩、可部分恢复）
  content/          Markdown 树
  uploads/          媒体树
  config/           环境文件（.env、.env.local）原样
  MANIFEST          这是什么、来自哪里、是否校验通过
```

**是一份备份文件，不是一个备份目录**。目录形态的备份就是会被拷一半的备份：`scp`、
`rsync`、U 盘、对象存储都有办法让一个目录不完整，而没有一种能让单个文件不完整却不说。
所以所有成员先在目标旁边的 staging 目录里组装、整体压一次 zstd、**校验通过之后**才改成
最终文件名——失败的运行不会碰到上一份备份，也不会盖在它上面。同一天第二次备份不会被
拒绝也不会覆盖第一次，而是拿到下一个后缀（`backup-2026-09-11-2.tar.zst`）：夜里的定时
任务和升级前手敲的那一次都是要留的。

**归档本身是带密钥的**：`config/` 里是 `SESSION_SECRET` 与数据库口令的原样副本，而
`database.dump` 本来就含全部口令哈希、活跃会话令牌与审计日志。按对待 `.env` 的方式对待
整份归档。`MANIFEST` 里的数据库 URL 会去掉密码。

**每一份归档都会被读回验证**：`zstd --test` 校验帧校验和，`tar --list` 列出成员，再从
归档里把 dump 读出来交给 `pg_restore --list` 解析。没人读回过的备份只是希望，不是备份。

**恢复的语义**（`scripts/restore.sh`）：

- 不 drop 数据库。它恢复到既有库中，用 `pg_restore --clean --if-exists
  --single-transaction --exit-on-error` 重建对象：要么整体提交，要么整体回滚。这样同一台
  服务器上的属主、扩展与其他数据库都不受影响。dump 直接从归档流进 `pg_restore`，它是
  最大的一员，根本不需要落盘。
- **不覆盖你的 `.env`**。归档里的环境文件落在 `config.restored/`，脚本会列出文件名。
  从备份里回来的会话密钥，可能正是你当初有意轮换掉的那一个。
- 内容树与上传目录是**替换**而非合并，被替换的目录会被移到 `*.before-<UTC 时间戳>` 而不是
  删除——恢复错了备份是可以回退的。合并会留下一个"既不是备份也不是恢复前"的状态，那是
  最难推理的状态。
- **所有可能失败的检查都在第一条破坏性命令之前完成**，且顺序保证"报出来的原因是原因"：
  先校验 zstd 校验和（截断的文件会被说成"损坏"，而不是被误报成"这不是一份备份"），再读
  MANIFEST，最后 `pg_restore --list`。损坏的归档在现状被触及之前就失败。
- 确认提示会说出**要替换哪个数据库、以及这个答案从哪来**。环境里的 `DATABASE_URL` 优先于
  `.env.local`，两者肉眼无法区分；不一致时脚本在 `--yes` 下也会明说——否则一个为测试或者
  上一次部署留在 shell 里的 `DATABASE_URL` 会静默决定目标。

恢复之后有三件事脚本会打印出来但无法替你做：`pnpm content:sync`（数据库与内容树是分别
恢复的，需要重新对账）、重启应用（搜索索引与关系索引是进程内构建的，此时已经过期），
以及核对 `config.restored/` 与你当前的环境文件。

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
上一版列在这里、现已补齐的有十三项——重定向未生效、Analytics 两端未接、按 tag / 分类的 RSS
缺失、Git 自动提交只有开关、Worker 循环无人启动、About 页缺两个区块、TOC 无平滑滚动、
终端样式是空规则、sitemap 缺 tag 与 series 页、加载时没有骨架屏、JSON-LD 只有 Article 与
Breadcrumb、编辑器的两个快捷键、资源缩略图（依次对应设定稿第二十五、二十八、二十六、四十二、
三十九、四十三、八、七、二十三、四十九、二十三、十七、二十节，其中 sitemap 与 JSON-LD 同属
第二十三节），因此不再出现在下面。

补上来的几项顺带记下七个决定：第八节的平滑滚动没有写成 `html { scroll-behavior: smooth }`，
因为那个属性作用于视口的**每一次**滚动——Next 在路由切换时用 `scrollIntoView()` 定位，全局
声明会把"从长文中点开另一篇文章"也变成动画。改为在点击目录链接时把该属性临时设在根元素上、
滚动结束（`scrollend`，或 1s 上限）后收回，浏览器的原生行为——URL 片段、历史记录、焦点顺序、
`scroll-padding-top`——一样都没动，实现见 `src/components/content/table-of-contents.tsx`。
第七节的"bash output"落成了 ```` ```bash terminal ```` 这个元数据词（`code-meta.ts` 已有文档但
此前没实现），终端块因此有一条左侧竖轨，并且不再重复显示语言徽标。第二十三节的 tag 页与
series 页由文档本身派生（`buildSitemapEntries` 里新增的 `topicEntries`）：只有当某个 tag 底下
真的有一篇可被索引的文章时，它才会出现在 sitemap 里——与 tag 页本身"没有内容就 404"是同一条
规则；tag 名到 slug 的映射由路由从 `listTags()` 传入，因为只有 `tags` 表知道 `C++` 的页面
地址是 `/tags/c-plus-plus`。第四十九节的加载态只落在 `/search` 一个路由上
（`src/app/(site)/search/loading.tsx`），因为 `loading.tsx` 不是免费的：它在导航开始的一瞬
就会替换掉上一页，而本站其余路由都是一次索引查询、读者多半正从一篇文章走向另一篇，用骨架屏
盖住还没读完的页面比等待更糟；搜索是唯一同时满足"全站最重的一次读"和"内容正是读者刚刚要求
换掉的"的页面。骨架的高度按真实元素的行高排布（`h-8`/`sm:h-9` 对应标题、`h-7` 对应搜索框），
替换时下面不会跳动；整块 `aria-hidden`，只有一行 `role="status"` 的 "Searching…" 会被读出——
没有它，屏幕阅读器什么都听不到。这里要记一条实测结论：fallback 是否**渲染**取决于服务端那次
渲染是否真的挂起（React 在渲染 suspend 时才冲刷 shell），查询够快时整页一次到达、从不产生
fallback，这是正确行为而不是缺陷；用 `page.route` 延迟响应也复现不出来，因为客户端路由会一直
持有旧页面直到 payload 落地——骨架只在**服务端渲染慢**时出现，不在网络慢时出现。所以 E2E
断言的是"该路由带着一个加载态，且它是骨架不是 spinner"（`tests/e2e/states.spec.ts`），
而不是"读者一定会看到它"。第二十三节的另外半边——结构化数据——现在有三种节点而不是两种：
首页是 `WebSite`（带 sitelinks search box 用的 `SearchAction`，模板写成 RFC 6570 的
`/search{?q}`，并且在 `searchEnabled` 关闭时不发——指向一个"没有搜索"的搜索框是站点兑不了的
承诺），About 页是 `Person`，而每篇文章的 `author` 用 `@id` 指向那个 `Person`，不再重复一个
名字：`authorNodeId()` 是两处唯一的算法，站点没填作者名时它返回 `null`，两个文档同时不发——
指向一个没有任何页面定义过的 `@id` 比不写更糟，消费方解析之后只会得到空，而且分辨不出这是
遗漏还是错误。`Person` 的 `sameAs` 只收 About 联系人里能标识身份的外部链接：`mailto:` 联系
得到人但不标识人，指回本站的链接则等于说"作者就是这个站点"。这一条 E2E 在两端各断言一半
（`about.spec.ts` 与 `authoring.spec.ts`，两者比的是**对方页面实际发出的那个 id** 而不是各自
拼出来的字符串），因为"两个文档、一个实体"这种约定只有跨页比较才测得到；首页那个节点单独
放在 `tests/e2e/structured-data.spec.ts`。

第十七节的两个快捷键落在编辑器自己身上。`Ctrl/Cmd+K` 插入 `[text](url)`，两种形状各自缺的
那一半不同：有选区时 `text` 用选中的文字、光标停在空的圆括号里，粘贴 URL 即完成；没有选区时
模板整段落下、`text` 是选中态，敲字即替换。目标地址因此保留字面量 `url` 而不是留空——一个
括号里什么都没有的链接，作者看不出它是"还没写完"还是"本来就没写"。这里也没有弹窗去问 URL：
作者面前就是 Markdown 源码，用一个模态框问他想写的两个字符比直接写更慢。`Ctrl/Cmd+Shift+I`
不能由编辑器自己开文件选择框——上传属于父组件（它拥有 action、进度行和失败提示），编辑器只
负责说"这个键被按了"（`onPickImage`），返回的 Markdown 走粘贴与拖拽同一条插入路径。
`tests/e2e/authoring.spec.ts` 用真实文件选择框和一张真实的一像素 PNG 证明这一条：先断言源码，
再断言渲染后的页面——链接被跟到 href、图片被读 `naturalWidth`，因为"存了 Markdown 没存字节"
看起来正好是一张加载不出来的图片。这条用例还改了一处部署配置：E2E 的 `UPLOAD_DIR` 是临时
目录，而 Next 的静态处理器只服务 `public/`，所以 `serverEnv()` 把 `UPLOAD_URL_PREFIX` 指到
`/api/assets`——那正是这个路由存在的部署，于是这条用例顺带把整条服务链路也证明了。顺带记一条
实测：`mobile` 项目里"先点一下编辑器再按 `Enter`"会丢按键（带点击 6/6、不带点击 2/6，
`chromium` 0/6），事件日志显示 `Enter` 在那里走的是浏览器原生的 contenteditable 插入路径
（`keypress` + `beforeinput insertParagraph`）而不是 CodeMirror 的 keymap——所以这条用例里
没有一处按 `Enter`，插入的落点由正文最后一段给出。

第二十节的缩略图现在是一个真正的派生物，但它没有写进 `assets.variants`，而是自己一列
（`assets.thumbnail`，jsonb）。理由是 `variants` 的语义是"同一张图、另一种格式"，它会被当作
`<picture>` 的候选源——把一个 480px 的小图放进去，等于让消费方有机会把缩略图当成原图发出去。
长边 480（`THUMBNAIL_LONG_EDGE`）：后台网格最宽是四列，一格略大于 200px，2 倍屏要略多于
400 个设备像素。编码复用派生物那支 WebP 编码器（质量 82），缩略图与同尺寸派生物的区别在尺寸
而不在编码器有多讲究，所以质量只写在一处。已经装得进这个盒子的图不生成缩略图——同样的像素
换个名字再存一份没有意义——判定用的是**输出**的宽高而不是源文件的元数据，因为走到这一步
sharp 已经应用过 EXIF 旋转，元数据里的宽高可能还是转之前的；编码器报错则记一条 note，不让
上传失败。文件照旧按内容寻址（`storedRelativePath(sha256(bytes), '.webp')`），因此天然去重；
`assetFilePaths` 把它算进这个资源的文件清单（删行之后一起删），`referenceMatchKeys` 把它的
URL 算进引用键（有人把缩略图 URL 贴进文档时，"未使用"视图和删除前的拦截都会认这笔引用）。
**没有做回填**：这一列是可加的，旧行是 `NULL`，网格回落到原图——正确，只是更大。后台的
网格、列表徽标与资源详情页各显示一处（详情页把 URL 以文本印出，没有复制按钮）。
`tests/unit/assets.test.ts` 验的是磁盘上的那个文件（480×320、webp、按哈希命名），集成测试
验的是行与"删一个资源清掉四个文件"，`tests/e2e/assets.spec.ts` 验的是浏览器真的拿到了小图
（`naturalWidth` 为 480，且缩略图响应字节数小于原图）。这条 E2E 顺带撞上一个真实现象并记在
用例注释里：上传按内容寻址，两次运行若产出**逐字节相同**的图，第二次会被去重到第一次那一行，
行上的文件名还是第一次的——所以 fixture 的颜色由用例名派生，保证每次都不同。

第三十二节的图片优化落在"服务端渲染时把已经知道的事写进 HTML"，而不是引入一个优化服务。每张站内
图片现在带两样东西：`width`/`height`（来自 `assets` 行的固有尺寸，浏览器据此在字节到达前把
位置留好，图片因此不会把下面的文字挤走——这也是它敢全部 `loading="lazy"` 的前提）与一个
`<picture>`：`assets.variants` 里的 avif / webp 成为 `<source>`，avif 在前（浏览器取第一个它
认识的源，而同等质量下 avif 更小）。`<img>` 仍然是作者写下的那张原图，一个字节都没被改写：
派生文件是提议，原图是事实，把 `src` 换成派生文件等于用一个只是相信存在的文件替换一个确定
存在的文件，失败的样子是图片裂开而不是图片变大。缩略图刻意不进这个列表，理由与它不进
`variants` 相同——它是另一个尺寸，不是一个格式。

这条规则**没有下限**：一张 1×1 的 PNG（90 字节）也会得到一个只含 WebP（60 字节）的
`<picture>`，那段标记比它省下的字节还多——实测如此。不设阈值，是因为阈值只能是个任意数，而
"更小就留"一句话就能讲完；代价有界，而且只发生在小图上：每张图约一百字节的标记，而大图的节省
以 KB 计。

为什么不是 `next/image`：上传在入库时就已经把派生格式写好了（`process.ts`），按需优化会再引入
一条编码路径、一个缓存目录和一次每请求的解码，只为产出磁盘上已有的字节；而
`/api/assets/[...path]` 刻意不按 `Accept` 协商（它按魔数嗅探后自己声明类型，并带 `sandbox`
CSP），所以格式协商只能发生在 HTML 里。把它放进 HTML 的代价是一次按存储路径的索引查询，且只
对**含图**的文档发生——提取器先跑，正文里没有图片引用就一次库都不查。这份"提取 + 查库 + 渲染"
的接口只有一处，在 `src/lib/content/render.ts`（`renderDocument` / `documentImages` /
`describeImage`），三个详情页、预览与修订预览都走它——正文里的引用由 `documentImages` 扫出，
而封面是 frontmatter 里的一个字段、不在正文里，所以由 `describeImage` 单独回答，两者共用同一
个 `normalizeImageKey` 与同一次查询的形状；`renderMarkdown` 本身仍是纯函数（`images` 是它的一个可选参数），
因此搜索索引、feed、OG 图与单元测试都不需要数据库。查询的键是**文档里的写法**而不是存储路径：
同一张图在一篇文档里可能有两种写法（`/api/assets/` 与旧的 `uploads/` 前缀都被接受），两种写法
映射到同一份描述；没被描述到的图片（外链、data URI、行已被删的资源）按原样渲染——缺失等于
不变。这个 `<picture>` 由 `rehypeEnhance` 发出，而它跑在净化**之后**，所以白名单不必为一个
本项目自己生成的元素开口子；`<picture>` 也仍然包在 `span.md-image` 里层之外（`<picture>` 中
除了 `<source>` 和一个 `<img>` 什么都放不下，中间夹一层就是无效 HTML）。

这一节顺带修掉一个一直存在的视觉瑕疵：包裹层是 `inline`，而图片是 `block`（preflight 定的），
按 block-in-inline 规则，包裹层的边框画在 inline 盒子上而不是图片周围——渲染出来是图片两侧两根
比图片还高的竖线。`.md-image` 现在是 `inline-block`，盒子与图片逐像素重合（实测，且由 E2E 的盒
相等断言守住），边框只由图片自己画一次：两个元素围着同一张图画同一个矩形，读者看到的是"这一条
线比页面上其它线粗"。这个瑕疵与 `<picture>` 无关——先前的标记同样有，测量过加与不加
`<picture>` 的包裹层盒子完全一致。

证据分三层：`tests/unit/markdown-renderer.test.ts`（给了描述才产出 `<picture>`、顺序由调用方
决定、作者自己写的 width/height 不被覆盖、没有派生格式就不产出 `<picture>`、未知图片与完全没有
map 时输出**完全一致**）、`tests/integration/content-render.test.ts`（描述里的 URL 就是行里
`variants` 写的 URL、两种写法映射到同一份描述、原图没有被替换成派生文件）、
`tests/e2e/image-formats.spec.ts`（浏览器真的取了 avif：断言 `currentSrc`，以及解码后的
`naturalWidth`）。最后一条的 fixture 是**噪声**，而且每次运行的字节都不同。噪声是因为派生格式
只在严格小于原图时才保留，所以 fixture 得是派生格式赢得明显的那种图：同尺寸（400×300）下噪声是
361 KB 的 PNG 对 86 KB 的 WebP、76 KB 的 AVIF，断言问的因此是管线而不是两个编码器在小数点上
是否一致。用真随机字节而不是同余发生器，是因为后者产生的场 PNG 滤镜压得很好——同尺寸下 19 KB，
它的 WebP 反而比 PNG 大，派生格式一个都留不下，于是 fixture 看起来随机、用例却什么都没断言。
每次不同则是因为上传按内容寻址：固定字节会被去重到上一轮那一行，用例就会断言一个本轮没有写过的
行。（诚实的补充：纯色图**也会**留下派生格式——PNG 压不动噪声，但在纯色上也赢不了 WebP——所以
"必须用噪声"只在"余量要宽"和"不能被去重"这两条上成立。）

第三十二节的另外半边是 Lighthouse，这一条要说具体，因为**默认配置给出的数字与本项目的
实际情况不一致，而不一致的原因指得出来**。测量对象是 Lighthouse 13.4.1、移动端形态、默认的
`simulate` 节流；被测量的服务是 `scripts/serve-standalone.ts` 起的生产构建（`next start`
在 `output: 'standalone'` 上会打印一条警告，但它服务这个构建是正确的——它不放松的是应用
自己的生产姿态，见 `next.config.ts` 里那一段）。四类分数的结果是：accessibility、
best-practices、seo 在每一条路由上都是 100；performance 在列表页、标签页、归档页、搜索页
是 98–100，在两处最重的文档路由（`/posts/atomic-writes`、`/projects`）落在 90–95。同一份
构建改用 `--throttling-method=devtools`（真实限速、指标是观测值而不是模拟值）之后是 **99**，
LCP 1716 ms。

Lighthouse 13 起这个分数要按**边界**读，不能按单次结果读。在最重的那条文档路由上连续跑同一
份构建、同一个已预热的服务进程，交替得到 95（LCP 2874 ms）与 92（LCP 3363 ms），两次之间
没有任何代码或资源差异。也就是说这个模型输出的不是一个可比较的测量值，而是一段会随机器负载
漂移的区间；把它当成回归信号会追到噪声上去。

**差在哪里，机制是清楚的**：`simulate` 先不限速地把页面跑一遍，记下每个请求的结束时刻与
每个任务的耗时，然后拿"观测到的 LCP"当一个截止点，把结束在它之前的**每一个**网络节点都算进
LCP 的关键路径，悲观半边（`treatNodeAsRenderBlocking: _ => true`）再把它们统统当作渲染阻塞，
最后取这些节点模拟结束时刻的最大值。在 localhost 上，第一帧之前一切都已经到了：文档 24 KB、
样式表 21 KB（两个文件）、三个 Web 字体 139 KB、15 个 JS chunk 200 KB、10 条 RSC 预取
15 KB，合计约 400 KB 全部结束在 300 ms 以内，浏览器自己记录的 LCP 是 166–261 ms。于是模型
算出来的"LCP"其实是"把整页 400 KB 在 Slow 4G 上重新下载一遍"。

这不是这个页面的关键路径，有三条实测可以证明。其一：**拿掉关键路径上的东西，数字不动**。
下面是按资源逐项阻塞的重测，每一项跑两次，同一份构建、同一个已预热的进程（不阻塞时三次为
2874、2875、3363 ms）：

| 阻塞掉的东西 | 传输大小 | 模拟 LCP |
| --- | --- | --- |
| 什么都不阻塞（基线） | — | 2874、2875、3363 ms |
| 第二张样式表（KaTeX，本页无公式） | 4 KB | 2867、2871 ms——**没有变化** |
| 承载 React DOM 的那个 chunk | 74 KB | 2864、2869 ms——**没有变化** |
| JetBrains Mono | 40 KB | 2712、2711 ms |
| Inter | 48 KB | 2724、2762 ms |
| Source Serif 4 | 51 KB | 2777、2775 ms |
| 全部 JS（15 个 chunk） | 200 KB | 2408、2405 ms（98 分） |
| 全部字体 | 139 KB | 3200、3810 ms（90、86 分） |

拦掉承载 React DOM 的那个 chunk，页面总重从 399 KB 掉到 306 KB，少下 93 KB——模拟 LCP 只动了
3 ms。拦掉 KaTeX 那张样式表（`network-dependency-tree-insight` 指认它是本页最长的链，
`isLongest: true`），少下 4 KB，同样一动不动。**模型对"少下多少字节"不是单调响应的**，它响应
的是别的东西。

其二：**阻塞更多资源会得到更差的数字**。把三个字体请求全部拦掉，FCP 从 1368 ms 涨到 2306 ms、
分数从 95 掉到 90 与 86——字体是 preload 的，拦掉它等于把首屏绘制往后推。关键路径不会因为
从路径上拿掉东西而变长。其三：同一次运行里浏览器自己测到的 LCP 是 174 ms，而对整篇文档做
一次强制同步重排（`display` 来回切、逼出完整的样式与布局）实测 **4.97 ms**，同一份 trace 却把
394 ms 记在"Style & Layout"名下——采集是不限速跑的，机器上有别的东西占 CPU 时，被记下的任务
耗时（以及模拟器随后乘上的 4 倍）就会漂，这正是同一份代码在 90 与 95 之间摆动的原因：连续五次
跑同一份构建得到 95/95/95/95/95、LCP 2860–2866 ms，而在机器更忙时同样的命令给出 90 与 94。

**所以没有为这个数字去改设计。**表里唯一一致、可复现的信号是单个字体家族值约 1 分
（95 → 96），而 1 分不足以在这段 92–95 的漂移里站住。用系统等宽字体替换 JetBrains Mono 能省下
40 KB 与一次请求、拿到那 1 分，代价是本节的排版质量——在一个对输入不单调的模型上调参，调的是
噪声。这一条留给站长按自己的判断决定，代码里它是 `layout.tsx` 的一行。

**这一节真正要求的东西是做到了的，而且是扫 chunk 验的，不是凭印象**：初次加载的 15 个 JS
chunk（202 KB 压缩后）里没有 CodeMirror、没有 lezer、没有 Shiki、没有 drizzle；`mermaid` 只以
加载器的形式出现，它用 `e.l()` 去拉的那些 chunk 一个都不在初次集合里，编辑器的动态边界是
有效的。其中最大的一块 74 KB 是 React DOM 本体，其余是 Next 的客户端运行时与错误边界、
Turbopack 的运行时代码、chunk 加载器，以及本项目自己那点 UI 表面：Radix 的 Slot / Presence /
Dialog、react-remove-scroll、sonner、lucide 图标、主题切换与搜索框。图片优化与 `<picture>`
见上一段。

这里不给"框架占多少、应用占多少"的拆分，因为**按 chunk 归属切不干净**——多数 chunk 同时装着
两边的东西，任何这样的数字都会比它看起来更不可靠。能核对的是上面这句：最大的一块是 React DOM，
而 CodeMirror、Shiki、drizzle 这些重东西一个都不在初次加载里。

**结论要写清楚**：这一节的 >95 是在"网络被真正塑形"的测量下达成的（99），而在默认模拟器下
两条最重的路由停在 95 的边界上，且如上所述那个模型对页面实际资源的增减并不单调响应。真正
该做的测量是在真实部署上做一次。

**功能缺口**

一项：**第三十二节的 Lighthouse performance 目标**。它在"网络被真正塑形"的测量下是达成的
（99），但在默认模拟器下，两条最重的文档路由停在 95 的边界上，同一份构建在 92 与 95 之间
漂移——列表页、标签页、归档页、搜索页则是 98–100（accessibility、best-practices、seo 在每一条
路由上都是 100）。可走的路只有两条，都在上面写过：换掉 JetBrains Mono（实测约 +1 分，代价是
本节的排版质量），或者接受那个模拟器测的不是这个页面的关键路径、并按真实部署的测量来判它。
两条都不该由实现者单方面决定，所以这里记成一项目未完成，而不是算作已完成。**除这一项之外，
没有别的未完成项**；下面剩下的是两类被明确接受的东西。

**架构性限制**（属于已知取舍，不是遗漏）

1. 搜索索引与关系索引都在进程内，多副本部署会成为陈旧窗口的来源（副本自己构建一份索引
   是正确的，但写时的失效只到达处理本次保存的那个副本）。
2. CJK 采用 bigram 分词，对罕见词会过度切分、无法做单字前缀匹配；`SearchProvider`
   接口就是为换 Meilisearch 留的缝。
3. 修订以完整快照存在 `bytea` 中会增长数据库。约束是**内联**的而非后台任务：每次具名保存
    之后 `pruneRevisions` 按 `revisionsMaxPerContent`（默认 50）裁剪该文档的具名修订，
    自动保存由存储层在自己的事务里按 `AUTOSAVE_REVISIONS_KEPT` 单独裁剪
    （`src/lib/revision/store.ts`）。裁剪按文档进行，且总在写入之后——删掉文档，修订随之
    级联删除；没有任何 worker 任务参与这一步（`JOB_KINDS` 里没有 revision 相关类型）。
4. 没有多作者工作流：schema 里有 `owner` / `editor` 角色，但没有评审队列或编辑审批。
5. 内部链接在保存时**只解析被保存的那个文档**，用的是那一刻的索引。代价是前向引用：先写下
   的 `[[某篇还没写的文档]]` 在目标出现后不会自己变成一条边，要等下一次全量同步——一次启动
   （`CONTENT_SYNC_ON_BOOT=1`）或一次导入——才解析。按文档解析让一次保存的代价与这篇文档成
   正比，全量重解析则会让"改一个错别字"变成"重扫全库"，所以这是取舍而不是疏漏；行本身是正
   确的：`content_links` 里存下了 `target_key`、`target_id` 为 `null`，只是没有解析。
   `tests/e2e/graph.spec.ts` 的注释里记了这个方向上的实测（顺序反过来——先发被引用者、再发
   引用者——边就在，因为保存时解析得到目标）。补起来不必改接口：保存后按该文档的候选键走
   `content_links_target_key_idx` 反查，把命中的 `null` 补上即可；没有做，是因为它需要自己
   的用例，以及"导入时是否也补做"这条口径。
6. 图片的 `<source>` 列表只有格式协商，没有宽度描述符：一张 4000px 宽的照片在手机上仍然下载
   4000px 的 avif——比原图小，但比该显示宽度该有的小图大。要做得对，得在入库时为若干显示宽度
   各生成一份并写进 `variants`，而那会改变 `variants` 的语义（现在是"同一张图、另一种格式"，
   尺寸相同因而可以互换），也会让每张图从三个文件变成十几个。后台网格那个 480px 副本
   （`THUMBNAIL_LONG_EDGE`）不是这条路的替代品：它只服务网格那一格。

**有意保留的"没有读取方"**

7. `site_settings.googleVerification` 与 `commentsEnabled` 没有任何生产读取点。这是披露
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
6. **§7 搜索**：文中给 `SearchProvider` 定的接口含 `upsert` / `remove` / `rebuild`，当前只有
   `search(query)` 一个方法（`src/lib/search/provider.ts` 的注释写明了为什么不放：那些方法
   是本地存储的形状，不该强加给一个远端实现）。文中写索引持久化在 `.cache/search-index.json`、
   按文档 checksum 增量重建——没有这个文件：本地 provider 在进程内从内容树构建，用内容树指纹
   （`FINGERPRINT_TTL_MS`，5 秒）判断要不要重建，写完文档时由
   `src/lib/admin/revalidate.ts` 显式作废。字段权重写的是 `title 5 / tags+category 3 /
   description 2 / body 1` 且没有 `headings`，实际是
   `title 8 / tags 6 / category 5 / description 4 / headings 3 / body 1`（`FIELD_WEIGHTS`）。
   分词写成 "ASCII words (lowercased, stem-free, length ≥ 2)"，实际会做保守词干归并
   （`render` / `renders` / `rendering` 是同一个词），也没有长度下限。查询语法只实现了
   `type:` / `tag:` / `category:`（复数形式同义），`before:` / `after:` 会被当作不支持的
   过滤器回报给读者（`ParsedQuery.unsupported` 变成页面与 palette 上的一句提示）。
