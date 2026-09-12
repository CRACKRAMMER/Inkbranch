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
| `users` | 管理员账号，不开放注册 | `email`、`password_hash`（Argon2id）、`session_version`、`last_login_at` |
| `sessions` | 服务端会话（令牌以哈希形式存储） | `token_hash`（SHA-256）、`user_id`、`expires_at`、`user_agent`、`ip_hash` |
| `content_index` | 每个 Markdown 文件一行，支撑列表、统计与搜索 | `type`、`slug`、`path`、`title`、`status`、`published_at`、`scheduled_at`、`updated_at`、`checksum`、`word_count`、`reading_time`、`view_count`、`search_index_version` |
| `content_revisions` | gzip 压缩的全文快照 + 增删行数 | `content_id`、`revision_no`、`snapshot`（bytea）、`additions`、`deletions`、`byte_size`、`author_id`、`summary` |
| `tags` / `content_tags` | 标签与其多对多关系 | `slug`（唯一）、`name`、`description`、`color` |
| `content_links` | 已解析的内链、锚点与图片引用，驱动反链与"未被引用" | `source_id`、`kind`、`href`、`target_key`、`target_id`、`asset_id`、`label`、`resolved` |
| `assets` | 上传媒体元数据 | `path`、`url`、`filename`、`mime`、`size`、`width`、`height`、`blur_data_url`、`sha256`（内容哈希，上传去重按它查）、`variants`（webp/avif 派生物）、`thumbnail`（网格用的缩小副本）、`alt`、`uploaded_by` |
| `redirects` | 旧 URL → 新 URL（Ghost 迁移用） | `from_path`（唯一）、`to_path`、`status_code`、`enabled`、`hits` |
| `site_settings` | 单行类型化设置（用 check 约束保证单行） | 站点标识、SEO、analytics/search/graph/rss/comments 开关、git、修订策略、About 内容 |
| `navigation` | 头部/底部/社交菜单 | `location`、`label`、`href`、`position`、`visible`、`external`、`icon` |
| `analytics_daily` | 按日预聚合 | `day`、`path`、`content_id`、`views`、`visitors`、`referrer_domain`、`device`、`country` |
| `analytics_events` | 原始事件，短期留存，**不含 IP** | `created_at`、`path`、`content_id`、`referrer_domain`、`device`、`visitor_hash` |
| `audit_logs` | 所有后台写操作 | `user_id`、`action`、`target_type`、`target_id`、`meta`、`ip_hash`、`outcome` |
| `scheduled_jobs` | 持久化任务队列 | `type`、`run_at`、`status`、`attempts`、`max_attempts`、`last_error`、`locked_at`、`locked_by`（持有或最后持有它的 worker）、`dedupe_key`（与 `type` 联合唯一，只在 pending 行上） |
| `rate_limits` | 限流令牌桶（登录、上传、搜索） | `key`、`tokens`、`last_refill_at`、`expires_at` |

对照设定稿第三十六节要求的最少表集合，全部具备；额外增加了 `content_links`、
`content_revisions`、`analytics_events` 与 `rate_limits` 四张表。

**最重要的空缺是有意为之**：没有 `posts.body`。正文只存在于 `.md` 文件中。

**修订为什么放在数据库**（设定稿允许 `content/revisions/` 或压缩 diff）：选择在
`bytea` 中存 gzip 压缩的**完整快照**。理由：恢复是一次单行读取，不存在"链式 diff 断一环
就全废"的失败模式；`+23 −5` 这类统计由任意两份快照按需 diff 得出，不存冗余派生数据；
`content/posts/*.md` 保持"就是内容本身"，文件树干净；修订是历史而非内容源，放在数据库
并不违反第一原则。保留条数由 `revisionsMaxPerContent`（默认 50）限制，在每次具名保存之后
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
| 限流 | Postgres 中的令牌桶（`rate_limits` 表），登录 `5 次 / 15 分钟 / ip_hash`，上传与搜索同样受限（搜索以 `ip_hash` 为键）。存在数据库里意味着重启不丢、多副本共享 |
| 路径穿越 | 所有路径先 `path.resolve`，再用基于 `path.relative` 的 `isInside(root, p)` 判定，**从不使用字符串 `startsWith`**；内容路径、上传路径、ZIP 条目一律适用 |
| 上传 | 从魔数字节嗅探 MIME（不看 `Content-Type` 头），扩展名由嗅探结果推导；SVG 经过消毒（剥离脚本、`on*`、`foreignObject`、外部引用），否则改为下载 |
| Markdown XSS | `rehype-sanitize` 显式白名单收尾，`iframe` 仅限配置的来源白名单；这是关闭 `dangerouslySetInnerHTML` 这个攻击面的地方 |
| 授权 | 每个后台动作顶部一个 `requireAdmin()` 守卫，后台 layout 再强制一次，所以即使某个页面忘了写，也不存在无保护的面 |
| 审计 | 每次写操作写 `audit_logs`：操作者、动作、目标、脱敏后的 diff 摘要、ip_hash |
| 密钥 | `SESSION_SECRET`、`DATABASE_URL` 由 `src/env.ts` 在启动时校验；生产环境下密钥为默认值或过短、Cookie 不带 Secure、站点地址是 http 时会拒绝启动（见第 6 节） |
| 响应头 | `next.config.ts` 下发 CSP、`X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、`Permissions-Policy`；`/api/assets` 被显式排除在通用规则之外，因为它对用户上传的 SVG 使用更严格的 `default-src 'none'; sandbox`，被通用规则覆盖会等于没有保护 |

`/api/analytics` 与 `/api/health` 是公开未鉴权端点：前者按设计如此（发起它的页面已经
知道请求里的全部内容），且不读取任何携带 IP 的请求头、不记录 IP——同一条约束也决定了
它取不到限流主体，理由记在第十节；后者只回布尔值与计数。

---

## 10. Future Improvements（后续改进）

以下是实际阅读代码后确认的**未完成项与缺口**，一条一条列出，不含推测。这一节随实现移动：
上一版列在这里、现已补齐的有十四项——重定向未生效、Analytics 两端未接、按 tag / 分类的 RSS
缺失、Git 自动提交只有开关、Worker 循环无人启动、About 页缺两个区块、TOC 无平滑滚动、
终端样式是空规则、sitemap 缺 tag 与 series 页、加载时没有骨架屏、JSON-LD 只有 Article 与
Breadcrumb、编辑器的两个快捷键、资源缩略图、前向引用（依次对应设定稿第二十五、二十八、
二十六、四十二、三十九、四十三、八、七、二十三、四十九、二十三、十七、二十、十一节，其中
sitemap 与 JSON-LD 同属第二十三节），因此不再出现在下面。

最后补上的一项——前向引用——顶掉的是本节"架构性限制"原先的第 5 条。原条目
写的取舍到现在仍然成立：**保存一个文档时只解析这篇文档自己的出链**，用的是那一刻的索引，
这让一次保存的代价与这篇文档成正比，而不是"改一个错别字就重扫全库"。缺的是另一半：先写下
的 `[[某篇还没写的文档]]` 在目标出现后不会自己变成一条边，要等下一次全量同步——一次启动
（`CONTENT_SYNC_ON_BOOT=1`）或一次导入——才解析，而"先写下链接"正是人写字的顺序。

补法就是原条目自己写下的那句：保存之后按被保存文档的候选键反查 `content_links`。三条口径
记在这里。其一，**反查的判定用的就是保存路径用的那个函数**（写这一段时叫 `resolveLinkTarget`，
现已移入 `src/lib/content/resolve.ts` 并改名 `pickTarget`，原因见本节最后一条），不是另
写一份等价逻辑——这个子系统此前出过一次事故，正是两个判定各说各话：一条坏掉的 wiki 链接被
计成 broken、却存成 `resolved`，图谱于是声称了一个并不存在的目标。其二，**只补 `null`，
从不重判已经指向某处的行**，所以一次保存不会把别处的解析结果改掉；行是按 `target_id` 为空
挑的，不是按 `resolved`——文档被删除时外键把 `target_id` 置空、`resolved` 是独立列留了下来，
按 `target_id` 挑才能让文档回来时重新接上自己的反链。其三，**导入也补做**，原来悬着的
"导入时是否也补做"因此有了答案，而且是"做"：一次导入本来就是一批顺序任意的文件，交叉引用
最多，逐篇补正是它需要的。裸 slug 落在两个类型上时（`[[shared-name]]` 同时有 post 和 note），
判定仍是"候选里第一个存在的"、用当时的索引算——与保存路径同一条规则，歧义照旧由
`pnpm content:links` 报出，这里不猜，也不会从一个已经指向 post 的行上把目标抢给 note。

同一条路径上顺带修掉一个缺陷：删除文档时外键把 `target_id` 置空，但 `resolved` 是独立列，
于是指向已删文档的链接会继续被 `pnpm content:links`——正是为抓这件事而存在的命令——报成
正常。现在三条删除路径都先把这个文档的入链标为未解析，再删行。

`tests/integration/content-sync.test.ts` 新增四例覆盖以上四条（前向 wiki 链接、前向路径
链接、不抢已定的目标、删除后转未解析并在文档回来时接回），`tests/e2e/graph.spec.ts` 的
发布顺序也翻了过来：现在先发**引用者**、再发被引用者，用浏览器把这条路上最贵的一段走
一遍。

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
图片现在带三样东西：`width`/`height`（来自 `assets` 行的固有尺寸，浏览器据此在字节到达前把
位置留好，图片因此不会把下面的文字挤走——这也是它敢全部 `loading="lazy"` 的前提）、一个
`<picture>`（`assets.variants` 里的 avif / webp 成为 `<source>`，avif 在前，因为浏览器取第一个它
认识的源，而同等质量下 avif 更小），以及一个 `blur` 占位（`assets.blur_data_url`，WebP 的
base64 data URI，画在图片自己的盒子里：进图片前读者看到的是这张图的构图，而不是一个空盒子）。
`<img>` 仍然是作者写下的那张原图，一个字节都没被改写：
派生文件是提议，原图是事实，把 `src` 换成派生文件等于用一个只是相信存在的文件替换一个确定
存在的文件，失败的样子是图片裂开而不是图片变大。缩略图刻意不进这个列表，理由与它不进
`variants` 相同——它是另一个尺寸，不是一个格式。

占位这一条此前只有一半：上传时 `process.ts` 算好写进 `assets.blur_data_url`，管理端的资源页也
写着"已存下 N 字节的内联占位"，但没有任何渲染路径读它——`DocumentImage` 里只有尺寸和格式。
补的是读的那一半，理由与上一条相同：写进去了却不画，等于把一个承诺留在库里。值以自定义属性
（`--md-blur`）落在 `<img>` 上，由 `globals.css` 消费，和 `--md-columns` 是同一种分工——内联写
数据、样式表写规则。写在这个元素而不是包裹层上，是因为 `width`/`height` 留出的盒子就是图片将要
占据的盒子，`cover` 正好把构图画在该在的位置；封面走另一条路径（`CoverImage`，frontmatter 而不是
正文），用的是同一个守卫、同一个属性、同一条 CSS 规则。没有淡入：CSS 看不见图片何时加载完成，
没有状态变化就没有过渡，读者拿到的是"先糊后清"，不是"先空后现"。值来自一列可以被手改的文本，
所以写入 `style` 属性前先过 `blurPlaceholderSource`——`data:image/*` 的 base64、且不超过
`BLUR_MAX_DATA_URL_LENGTH`；一条远程 URL 会让每个读者的浏览器去请求它，值里一个分号就会结束这条
声明并开始下一条。被拒绝时页面与没有占位时逐字节相同。

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
map 时输出**完全一致**、占位以自定义属性落在 `<img>` 上且作者自己写的 `style` 被保留、
五类不可信的值一个都不画）、`tests/integration/content-render.test.ts`（描述里的 URL 就是行里
`variants` 写的 URL、两种写法映射到同一份描述、原图没有被替换成派生文件、页面上的占位就是行里
`blur_data_url` 那一串，以及**手改过的行**改不出一个占位来）、
`tests/e2e/image-formats.spec.ts`（浏览器真的取了 avif：断言 `currentSrc`，以及解码后的
`naturalWidth`；占位则断言**计算后**的 `background-image`——属性写在标记里、规则写在样式表里，
只有浏览器解析完两边之后才存在，这条断言正是"存了却没画"那个缺陷守不住的地方）。最后一条的
fixture 是**噪声**，而且每次运行的字节都不同。噪声是因为派生格式只在严格小于原图时才保留，所以
fixture 得是派生格式赢得明显的那种图：同尺寸（400×300）下噪声是
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
自己的生产姿态，见 `next.config.ts` 里那一段）。在一台空闲的机器上（1 分钟 load 1.4–1.9，
`vmstat` 的 CPU 空闲率 92–94%），accessibility、best-practices、seo 在每一条路由上都是
100；performance 则**几乎只跟着页面总重走**，逐条路由测下来是这样（每个数字都是同一份构建、
同一个已预热的进程，重复次数写在分数里）：

| 路由 | 页面总重 | performance | LCP |
| --- | --- | --- | --- |
| `/projects`（列表） | 347–348 KB | 98、98、98 | 2413–2416 ms |
| `/projects/shell-history-viz` | 390–391 KB | 95、95 | 2868–2874 ms |
| `/projects/wikilink-parser` | 393–394 KB | 93、88 | 2877 ms（一次 3555） |
| `/projects/transit-lake` | 394 KB | 95、95 | 2869–2871 ms |
| `/projects/myblog` | 396–398 KB | 94、94 | 2869–2872 ms |
| `/posts/atomic-writes` | 397–399 KB | 95、95、95、95、90 | 2867–2874 ms（一次 3573） |
| `/posts/searching-chinese` | 448–449 KB | 91、91 | 3311–3312 ms |

从 348 KB 到 449 KB，LCP 从 2.42 s 涨到 3.31 s，约合 **9 ms / KB**——那正是把这一页的字节在
Slow 4G 上重下一遍的耗时。所以默认模拟器给这个站点的分数，基本就是"整页字节在 Slow 4G 上下载
一遍"的分数，而不是"这一页何时可读"的分数。顺带纠正一处：站内最重的文档页不是
`/posts/atomic-writes` 而是 `/posts/searching-chinese`（449 KB）——中文正文每字三字节，一篇以
中文为主的文章天生比英文的重，而模型只看字节。

同一份构建改用 `--throttling-method=devtools`（真实限速、指标是观测值而不是模拟值）之后，
`/posts/atomic-writes` 是 **99**、LCP 1662 ms、TBT 50–53 ms，另外三类分数仍是每一条路由 100。

**空闲时这个分数是按路由确定的，不是抖动的。**上表每一行的重复测量都给出同一个数字
（98、98、98；95、95；94、94；91、91），LCP 的重复差在 10 ms 以内。空闲时想得到第二种结果，
是**离散地跳到 2.87 s 那一段之外**，而不是连续漂移：`/posts/atomic-writes` 五次里有一次是
90（LCP 3573 ms）、`/projects/wikilink-parser` 两次里有一次是 88（LCP 3555 ms），而这些次的
页面总重与其它次一模一样。把它当成回归信号要小心的是另一件事：**同一份构建在机器忙起来的
时候会整段下移**。

**而机器忙起来时的下移幅度，比"抖动几分"宽得多，它的下界是机器的属性，不是页面的属性。**
同一条命令、同一份构建，机器空闲时是 95 / 95 / 95，机器上另外有进程吃 CPU 时（load average 7 左右，一个游戏与
两个 Wine 进程在跑）变成 85 / 89 / 83，LCP 从 2.87 s 涨到 3.72–3.80 s，TBT 从 35–45 ms 涨到
56–269 ms，而**页面总重一模一样（397–399 KB）**。同一条件下 devtools 那一组也从 99 掉到 90
（LCP 1716 → 1950 ms）——那一个不是模拟器的毛病：devtools 模式下 TBT 是观测值，那台机器的主
线程确实更慢（354 ms），一份 CPU 被抢走的测量本来就应该这样。所以上面每一个数字都附着一个
条件：机器要空闲。

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

**结论要写清楚**：这一节的 >95 是在"网络被真正塑形"的测量下、在一台空闲机器上达成的（99）；
在默认模拟器下，两条最重的路由停在 95 的边界上，机器一忙同一份构建就掉到 80 几，且如上所述
那个模型对页面实际资源的增减并不单调响应。要判定这一节是否达成，该做的测量是在真实部署上
做一次，而且要在不忙的机器上做。

### 怎么复现上面这些数字

```bash
# 1. 被测量的服务：standalone 生产构建，端口 3200
pnpm build
pnpm serve:standalone

# 2. 测量。Chrome 用 Playwright 已经装好的那个
export CHROME_PATH=$(ls -d ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome | head -1)
npx --yes lighthouse@13.4.1 http://127.0.0.1:3200/posts/atomic-writes \
  --output=json --output-path=/tmp/lh.json \
  --chrome-flags="--headless=new --no-sandbox --disable-dev-shm-usage" --quiet

# 2b. 上表用的是这些路由，每条重复两到五次，每次记下当时的 load
for u in /projects /projects/shell-history-viz /projects/wikilink-parser \
         /projects/transit-lake /projects/myblog \
         /posts/atomic-writes /posts/searching-chinese; do
  npx --yes lighthouse@13.4.1 "http://127.0.0.1:3200$u" \
    --output=json --output-path="/tmp/lh$(echo $u | tr / _).json" \
    --chrome-flags="--headless=new --no-sandbox --disable-dev-shm-usage" --quiet
done

# 3. 换成观测值而不是模拟值的那一半对比
npx --yes lighthouse@13.4.1 http://127.0.0.1:3200/posts/atomic-writes \
  --throttling-method=devtools \
  --chrome-flags="--headless=new --no-sandbox --disable-dev-shm-usage" --quiet
```

**跑之前先看 `uptime`**，这不是客套：上面那段 83–95 的区间就是这么来的，load average 高的时候
测出来的数字没有比较价值。逐项阻塞那几张表用的是 `--blocked-url-patterns`，模式对着资源
URL 写即可。

**功能缺口**

一项：**第三十二节的 Lighthouse performance 目标**。目标写的是 Performance > 95，而在默认
模拟器下、空闲机器上，本站的**文档路由**测出来是 88–95——没有一条真正越过 95 这条线
（列表页 `/projects` 是 98，越过了；accessibility、best-practices、seo 在每一条路由上都是
100）。同一份构建改用 `--throttling-method=devtools`（真实限速、观测值而非模拟值）之后，
同一条文档路由是 99。可走的路只有两条，都在上面写过：换掉 JetBrains Mono（实测约 +1 分，
代价是本节的排版质量），或者接受那个模拟器测的不是这个页面的关键路径、并按真实部署的测量来
判它。两条都不该由实现者单方面决定，所以这里记成一项目未完成，
而不是算作已完成。**除这一项之外，没有别的未完成项**；下面剩下的是两类被明确接受的东西。

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
4. 没有多作者工作流：只有一个管理员账号，schema 里也没有角色——`owner` / `editor` 那一列连枚举
   在 `0002` 迁移里删掉了（理由记在第十节末尾），评审队列与编辑审批同样不存在。
5. 图片的 `<source>` 列表只有格式协商，没有宽度描述符：一张 4000px 宽的照片在手机上仍然下载
   4000px 的 avif——比原图小，但比该显示宽度该有的小图大。要做得对，得在入库时为若干显示宽度
   各生成一份并写进 `variants`，而那会改变 `variants` 的语义（现在是"同一张图、另一种格式"，
   尺寸相同因而可以互换），也会让每张图从三个文件变成十几个。后台网格那个 480px 副本
   （`THUMBNAIL_LONG_EDGE`）不是这条路的替代品：它只服务网格那一格。

**有意保留的"没有读取方"**

6. `site_settings.googleVerification` 与 `commentsEnabled` 没有任何生产读取点。这是披露
    而不是遗漏：后台在各自的输入框下面直接写明"加入它不会验证站点"/"打开它不会改变任何
    页面"。另有 `SETTINGS_CACHE_TAG`，后台的"清除缓存"动作会 `updateTag` 它，但当前没有
    `'use cache'` 消费者（`getSettings` 是每请求 memo）——这同样写在
    `src/app/admin/actions/system.ts` 的注释里，按钮的回复也照实说。
7. `assets.uploaded_by` 写得上、没有读取点，也是有意保留。它记的是"谁上传的"，而这件事在第 4 条
    的账上：本产品只有一个管理员账号，`pnpm db:seed` 是唯一能建账号的地方，所以这一列永远只有
    一个可能的值；同一件事在 `audit_logs` 里还有一份（创建行时那次 `asset.upload` 带 `actorId`）。
    不删的理由是它记的是**上传那一刻**才知道的事实，而那一刻不会再来：留着是零成本，删掉要一次
    破坏性迁移，换来的只是少一列。

**本节最后一条记的是一件已补上的事，而不是缺口：第十一节的 wiki 链接，此前只有"边"那一半。**
它不是设定稿列出的缺口，是查证时发现的。

设定稿第十一节要求 `[[文章链接]]` 建立内容关系，实现里也确实建立了：`content_links` 有行、
反链有列表、图谱有边。缺的是读者那一半——**页面上的 `[[why-not-catch]]` 就是这几个字符本身**。
索引侧与渲染侧各有一套读 `[[…]]` 的代码，而两套只在一件事上一致：都认得方括号。索引那一套把目标
解析成了文档，渲染那一套从头到尾没有解析过，rehype 于是照原样输出。全库 9 条 wiki 链接无一例外，
它们全都能解析，只是没人去解析。

补法不是"在渲染器里再写一遍匹配"。那等于把同一个问题实现两次，而两份实现会漂移——这个子系统此前
正是这么出的事（一条坏链被计成 broken、却存成 `resolved`）。改成**一个扫描器、一个判定函数**：
`src/lib/content/links.ts` 的 `proseLines` 只走一遍文档，同时跟踪围栏（围栏里的示例是内容）并把
行内代码挖空（被引用的 `[[x]]` 是引用）；`extractLinks` 与 `scanWikiLinks` 都从它取 `[[…]]`，
两者都用 `src/lib/content/resolve.ts` 里同一个 `pickTarget` 断定目标是谁——判定函数因此从
`sync.ts` 搬到 `resolve.ts`：它现在有两个调用方，不再属于同步引擎。渲染侧的改写发生在管线**之前**
——解析要读库，而 `renderMarkdown` 是纯函数，这一条不能破——所以 `renderDocument` 先改写正文再交给
管线，`[[x]]` 到达 `remark-parse` 时已经是一个普通的 Markdown 链接。

两条规则跟着一起定下来。其一，**解析不到就原样留下**：`[[nobody-wrote-this]]` 到读者眼前还是这几个
字符，不是指向 404 的链接，也不是指向空处的反链——这是作者唯一能得到的信号。其二，**目标可以写
slug，也可以写文件名**：slug 由标题推导，文件名是目录列表里的那个；标题为 "An empty catch block
is a claim that nothing can go wrong" 的 note，两者并不是同一个字符串，而 `[[why-not-catch]]` 正是
最自然的写法。两种拼写都注册成键，谁也不会无声地输给另一个。

验证在四层各做一次。单元测试断言 `scanWikiLinks` 与 `extractLinks` 对同一份正文给出同一个答案
（共用一次行走，所以一致是构造上的，不是碰巧的）；集成测试把两篇文档真的写进索引，断言渲染结果是
指向另一篇的 href、未命中的仍是字面量、围栏里的示例仍是示例；E2E 用浏览器走一遍发布顺序——先发
引用者、再发被引用者——断言正文里写下的 `[[alpha-slug]]` 在读者打开的那一页上是一个指向 alpha 的
`<a>`；最后对着真实语料跑一遍生产构建，9 条 wiki 链接全部落在正确的 href 上，正文里不再有残留的
方括号。反向验证也做了：去掉围栏跟踪，只有"围栏里的示例"那条用例失败；把改写短路，只有"渲染成
链接"那条失败——两条断言各自都是承重的。

**再补一条，仍是查证时发现的：iframe 白名单有两份，而它们不一致。** 设定稿把 iframe 列为支持的
语法，实现里也确实拦了：`rehypeEnhance` 按 `ALLOWED_EMBED_ORIGINS` 决定作者写的 `<iframe>` 是留
还是删，CSP 的 `frame-src` 决定浏览器肯不肯加载留下来的那个。问题是这两份清单是各写各的：
白名单十个来源，CSP 三个（`www.youtube.com`、`player.vimeo.com`、`www.bilibili.com`）。差的七个
—— `codesandbox.io`、`stackblitz.com`、`observablehq.com`、`www.desmos.com`、`player.bilibili.com`、
裸 `youtube.com`、`youtu.be` —— 于是走完了全程：渲染器认它、保留了元素，浏览器不认、拒绝加载，
读者看到一个空白矩形。文档没被改动，日志没有一行，页面也没坏到让人去查——这正是这个缺陷安静的地方。

修法是让一份清单供两处读：`src/lib/security/embed-origins.ts` 不 import 任何东西（`next.config.ts`
在别的一切之前加载它，所以它不能依赖数据库、环境或 Markdown 包），`rehypeEnhance` 与
`next.config.ts` 都从这里取。`frame-src` 与 `media-src` 因此由清单生成，新增一个来源只需改一处。
顺带把 `ALLOWED_MEDIA_ORIGINS` 也接上：它此前是一句没人执行的声明（CSP 里根本没有 `media-src`，
外部媒体一律落在 `default-src 'self'` 上），现在 CSP 明写 `media-src 'self' https://cdn.jsdelivr.net`。
**这一条改宽了 CSP 两个方向**——frame 多了七个白名单内的来源，媒体从"全禁"变成"允许 jsdelivr"——
这是把已经写下的策略落到部署上，不是新增信任：那七个来源本来就写在安全模块的白名单里，注释里也
写明它是一道 CSP 的洞、所以每个都要单独决定。

同一条路上还发现判定函数本身有两份。`src/lib/security/mime.ts` 里那份被 `security.test.ts` 用
十几条断言测着（子域、`evil-youtube.com`、`youtube.com.evil.test`、协议、空清单……），而生产跑的
是 `rehype-enhance.ts` 里那份私有副本——**被测的那份没人用，在用的那份没被测**。两份对相对路径
的答案还不一样：副本认为 `//evil.test/x` 是"同源相对路径"因而保留（浏览器读作协议相对 URL，
指向别的域），而被测的那份判它 false。现在只有一份，放在 `embed-origins.ts`，两个调用方共用；
判定先按浏览器的读法归一化（`\` 视作 `/`，去掉 tab/换行，两端去空白），再把"单斜杠开头的相对路径"
与"`//` 开头的协议相对 URL"分开。安全测试随之搬家并补了这几种写法。

验证分三层：`tests/unit/embed-origins.test.ts` 把 CSP 从 `next.config.ts` 里**读回来**与白名单逐条
比对（两个方向都比，所以是"相等"而不是"相容"），并且这些断言确认过是承重的——把 `frame-src` 换回
手写那三个来源，恰好这两条失败、并点名缺了哪个来源；`markdown-renderer.test.ts` 断言渲染器确实用
了这份清单（保留 codesandbox、丢弃 `//evil.test`）；`tests/e2e/security-headers.spec.ts` 问正在跑的
服务器要响应头，因为"配置读到了但没生效"是单元测试看不见的另一半。回归数字：lint 干净、typecheck
干净、1070 单元、1202 集成、42 e2e。

**再补一条，仍是查证时发现的：设备列表这块屏幕被三处注释描述过，而它并不存在。**
`sessions.ip_hash` 的列注释写它"只用于设置页的会话列表"，于是每次登录都写、没有任何读者；
`destroyOtherSessions` 的文档写它的调用者是"设置里的会话列表"，导出而无人调用；`sessions` 表
自己的文档把"所有者可以审计的会话列表"列为把会话放进数据库的三个理由之一。三句话描述的是同一件
东西，而它没有实现——一个没人用的导出与一个能用的导出在类型检查面前长得一样。同一条路上还删掉
一个反方向的假函数：`destroyAllUserSessions` 的注释写着 "Called on password change"，既没有调用
者，也**不该**有——改密码那条路靠的是 `session_version` 比较（`src/lib/auth/account.ts`），一次
delete 是同一个问题的第二个答案，而且只能跑在那个事务外面；留着它，下一位读者会以为凭证退役这
件事有两处在管。

修法分三层。其一是读：`listUserSessions` 返回投影而不是 `Session`，被省掉的正是 `token_hash` 与
`csrf_token_hash`——**一个带不出凭证的类型，比"某个调用方没有读它"强**，列表页于是既不可能渲染
它，也不可能把它序列化进客户端 props。其二是写：`revokeSession(userId, sessionId)` 把归属判断与
删除写成同一条语句（`where user_id = ? and id = ?`），没有"先查后删"的窗口，也没有下一位编辑可以
顺手删掉的那句 `if (row.userId !== userId)`——会话 id 从浏览器回来，是这一功能里唯一由攻击者选择
的输入，归属检查因此不能是一个可以被遗漏的步骤。它返回的 `false` 同时覆盖"不是你的"和"已经没了"：
区分这两者等于回答一个调用者无权问的问题（某个不属于它的 id 是否存在），而对按钮前的人来说两者
是同一件事——没有可登出的东西了。其三是显示：`lastSeenAt` 是**派生**的，`touchSession` 把
`idle_expires_at` 写成"那一刻 + 空闲窗口"，减回去就是那一刻，精度受 15 分钟的
`IDLE_TOUCH_INTERVAL_MS` 限制，从未被 touch 的会话派生成 `createdAt`；设备名由
`src/lib/utils/device.ts` 从 UA 读出来，四条陷阱（Edge 与 Opera 都自称 `Chrome/`、iOS 上的 Chrome
是 `CriOS/` 而所有 iOS 浏览器都自称 `Safari/`、iPhone 与 iPad 自称 `like Mac OS X`、Android 自称
`Linux`）决定匹配必须从最具体开始；它明确不参与任何安全判断，认不出来就说 "Unrecognised device"，
因为一个自称什么都不是的客户端本来就该得到这个答案。

两个 action 里各有一个决定值得记下来。**没有限流**：限流器是用来挡猜的，这里没有可猜的东西
（uuid 本来就是调用者自己的，两个操作幂等、且只作用于自己账户），一个桶只会用来拒绝"以为有人
进了自己账户、正在把设备踢下线"的所有者——那是最不该回答"尝试次数过多"的时刻。**审计时会话 id
放在 `targetId` 而不是 metadata**：`SECRET_WORDS` 里有 `session` 这个词，一个叫 `sessionId` 的
metadata 键会被写成 `[redacted]`，那样日志会安静地丢掉这一行唯一的标识。

验证：`tests/unit/device.test.ts` 6 例全部用真实 header，且主要断言冒名者（Edge 报成 Chrome、
iPhone 报成 Mac、Android 报成 Linux、Safari 报成一切），因为每一处的错误答案都是**可信的**——只
断言 "Chrome on Linux" 的测试对四条陷阱全反的实现照样通过；`tests/integration/session-list.test.ts`
10 例，其中投影那条断言的是**封闭的键表**（多带一个字段就失败）而不是样板检查，`lastSeenAt` 那条
破坏后读到的正好是 `604800000`——直接拿原始列会得到的那个数；排序那条把 `orderBy` 换成按活跃倒序
后恰好只有它失败；IDOR 那条确认别人的 id 返回 `false` 且两行都还在。e2e
`tests/e2e/sessions.spec.ts` 2 例 × 2 项目用真实 iPhone header 造第二台设备，所以行是**按标签**
挑的而不是按位置——两台 Chromium 的 header 一模一样，按位置挑的断言在"标签根本不起作用"时照样
通过。

最后记一条实测，因为它是这个 spec 一开始 flaky 的全部原因（16 次里 6 次失败，而失败的那几次产品
行为完全正确）：**Radix 的模态对话框会把对话框以外的整页标成 `aria-hidden`，而 `getByRole` 读的是
可访问性树而不是 DOM**，所以"这一行已经不在了"在对话框还开着的时候对**任何**页面都成立——探针
实测：同一个页面上 `getByRole('row')` 返回 0，而 `tbody tr` 仍然是两行。断言于是在动作还没提交时
就通过，测试带着"手机还活着"往下走，最后失败在手机那条 URL 断言上，看起来像产品删错了会话。修法
是把顺序本身变成断言的一部分：先等对话框消失（它只在 action 结束后关闭，所以等它也就是等删除），
再问那一行。

回归数字：lint 干净、typecheck 干净、1081 单元、1230 集成、50 e2e。

**再补一条，同一类缺陷往下一张表：`users.last_login_at` 每次登录都写，没有一个读者。**
它和设备列表那条是同一句话——"登录时写进去，没有人读"——只是挪了一张表：`resolveSession`
每次都 `select()` 整行用户，所以这个值早就握在手里，被丢掉。这次是**接上**，不是删掉，
判据是三条：这一列从 `0000` 初始迁移就在；写的位置是刻意选的（密码验过之后）；`ARCHITECTURE.md`
与本文档的表都把 `last_login_at` 列成 `users` 的关键列。一个被声明、被写入、被文档承诺、
却没有读者的能力，缺的就是读取那一半。

接在设备列表那一节的最后一行，**在表格之外**。它不是表格里最新那一行的重复：那张表是
*活着的会话*，而会话会结束——绝对 TTL 一到，`auth.prune` 把行删掉，"最后有人进过这个账号"
就跟着那一行一起从屏幕上消失。这一行留得下来，所以它自己说清楚自己是什么，而不是留给读的
人去猜。查证时顺手核对了第十节第 6 条那份"有意保留的没有读取方"清单：28 个设置键逐个查过，
确实只有 `googleVerification` 与 `commentsEnabled` 两个没有生产读取点，披露是准的。

写的那一半也改了。它原本夹在 `setSessionCookie` 与 `redirect(next)` 之间，于是一次失败的记账
会把"登录失败"告诉一个浏览器里已经攥着有效会话的人——这条路上唯一一个错误的答案。改成
best-effort 加 `console.error`，和 `touchSession`（`src/lib/auth/session.ts`）以及
`src/lib/audit.ts` 写失败时的姿势一致：值不承重，审计行才是那份耐久的记录，所以丢掉一次更新
的代价只是设置页上一条过时的时间。

两层证据，因为缺口正在两层之间。`tests/unit/session-list.test.ts` 3 例：值渲染成 `<time>`、
缺值渲染成破折号而不是编一个时间、以及这一行落在 `</table>` 之后——断言从 `</table>` 之后
切片，因为表格自己就有 `<time>`，对整篇断言会被它们的通过带过去。e2e 那条断的是**关系**而不是
值（值是个时钟）：账号那一行的时刻不早于"这台设备"那行的会话创建时刻，也不在未来——前者正是
"列没被写"的样子，后者正是"拿了浏览器时钟"的样子。这条只有浏览器能说，因为写在一支 server
action 里、读在一次渲染里，两者只在真实请求里相遇。

回归数字：lint 干净、typecheck 干净、1126 单元、1286 集成、62 e2e。

**再补一条，这次错的不是代码，是"证据"本身：上一批那次列名订正，删掉了一个真实的列。**
判据是"从 `schema.ts` 抽出真实列名，再逐行比对文档"，而那个抽取脚本的正则漏掉了**键里带
数字**的列——`sha256` 恰好是唯一一个。于是 `assets.sha256`（`not null`、有索引、上传去重
正是按它查的那一列）被以"文档写了、schema 里没有"为由删掉，和确实不存在的 `average_color`
与 `storage` 一起被删了：三个里两个是真错，一个是我造的错。

这一批的判据换成了**活库**：`information_schema.columns`。重写后的抽取器与它逐表逐列对了
一遍：16 张表、每一列都对得上。差异只有两处，而且都不是解析器读错了——`__drizzle_migrations`
是 drizzle 自己的记账表，本来就不在 `schema.ts` 里；`users.role` 则反过来，`schema.ts` 里已经
没有它了（`0002` 迁移干的就是删它），而这台开发库还没应用那条迁移，所以库里还留着。两边对
同一个问题给了不同答案，而各自都对：一个说的是代码期待的形状，一个说的是这台库此刻的样子
——顺带说明这台开发库还差一次 `0002`。

方法留在这里：**产出证据的东西，要对着一个不依赖它的东西校验过**。两个脚本两个 bug，性质
相同——一个是正则漏掉键里的数字，一个是 `pgTable(` 与 `{` 同行的表。

同批接上了 `scheduled_jobs.locked_by`。它的三处决定都写在代码里：claim 时写、失败时**故意
留着**、回队列时清掉；失败那条的注释写着"哪个 worker 最后跑过它是失败行唯一的来历"——而
"唯一的来历"在界面上从未出现过。接在 `/admin/system` 的队列表上、排在最后错误之前，显示
`worker-<host>-<pid>`；没人领过的行显示破折号（pending 行和失败后回队列的行含义相同：还没有
worker 碰过它）。判据与设备列表、登录时间那两条一致。

证据分层：claim 那一半本来就有——`tests/unit/jobs.test.ts` 断言 `claimNextJob` 回来的
`lockedBy`；新增的 `tests/e2e/queue.spec.ts` 在真实页面上断两件事：列在（按表头找而不按位置，
所以插一列不会让它悄悄变成对另一个格子的断言），以及队列里那个没人领的任务那格是破折号。
**有值的那一半这个套件造不出来**：跑 Playwright 时没有 worker 进程，"有 worker 的行长什么样"
只能由那一行表达式自己负责——这条限制连同理由写在 spec 的文件头，不写就是让下一个人以为
覆盖到了。

剩下那列 `assets.uploaded_by` 没有接，而是写进了上面第 7 条：它记的值只有一个可能（第 4 条：
本产品只有一个管理员账号），删它却要一次破坏性迁移。

回归数字：lint 干净、typecheck 干净、1126 单元、1286 集成、64 e2e。

**再补一条，仍是查证时发现的：权限系统只装了一半，而剩下的那一半只是后台页脚里的一个词。**
`users.role`（`owner` / `editor`）从 `0000` 初始迁移就在，`requireOwner` 从安全那次提交就在，两边
各说了半句话：guard 的注释是现在时的规则——"Editors can write content but not administer"，
`seed.ts` 写 `role: 'owner'`，`admin-shell.tsx` 把角色渲染在页脚（`email · owner`）。查证结果是
这条轴**两头都是死的**：没有任何路径能创建 editor（seed 是唯一的写入方，而且只写那个常量），也
没有任何代码读这一列去**决定**什么——唯一的读者是页脚，而页脚只是显示；`requireOwner` 没有任何
调用者，它要重定向到的 `/admin?error=insufficient_role` 也没有任何页面读那个参数。

为什么是删而不是接上：`project.md` 里没有角色或多作者的要求，`ARCHITECTURE.md` 第十三条把"没有
多作者工作流"记成已接受的限制。要"接上"，得先发明一套产品策略——编辑器能进哪些后台页面？内容能
写，那么设置、任务队列、导入、资源、系统算不算"管理"？那是发明需求，不是补实现。另一种做法是留着
并披露（`site_settings.googleVerification` 那种"没有读取方"），但那条先例的门槛是**这是用户能编辑
的旋钮**，删掉会毁掉用户输入；角色列不是旋钮：它没有输入框、只有一个常量，而它唯一的界面是一句
看起来像权限的名字。

于是整条轴删掉：`userRoleEnum`、`users.role`、`UserRole`、`requireOwner`、页脚里的角色、seed 里的
`role: 'owner'`。迁移 `0002_flashy_vision.sql` 是这个仓库的第一条**破坏性**迁移（`DROP COLUMN` 加
`DROP TYPE`）——它在文件里可审，并且在任何人跑 `db:migrate` 之前都不生效。同一次里删掉同一模块
另外两个"有文档、没有调用方"的导出：`isAuthenticated()`（注释说"True when the request carries a
valid session"）与 `cookiesAreSecure()`（注释写 "Mirrors the env flag, for docs"，而没有任何文档
提到它；`isProd` 这个 import 随它一起走）。

验证靠在两处，各承一半：`tsc` 是"没有人读它"的**结构性**证明——删掉列之后每一个读者都必须被逐个
处理，`requireOwner`、layout、admin-shell、seed 全是编译器点名点出来的，不需要人去 grep；而 e2e 的
`global-setup.ts` 会重置数据库、再跑真正的 `migrate.ts` 与 `seed.ts`，所以 50 条 e2e 通过就是这条
迁移在空库上跑通的证据。回归数字：lint 干净、typecheck 干净、1081 单元、1230 集成、50 e2e。

**再补一条，仍是查证时发现的：合并标签的对话框一直在说一个它不必说的上限。** `src/lib/admin/tags.ts`
里有个 `tagChangeImpact`（以及它背后那个私有函数 `documentsWithAnyTag`），**一个读者都没有**；而对话框
在需要它的位置写着另一句话——"「Linux」will end up on **up to** N documents"，N 取的是页面上两个计数
之和。这个和是错的：同时带两个标签的文档被算了两次，而那正是"合并"与"改名"的区别所在。更直白的是
两处注释自己写着要什么：`tagChangeImpact` 写"Counted before the button is pressed, not after…
an operator deciding about that needs the count, not an upper bound"，`documentsWithAnyTag` 写
"for the 'both tags present' count"——一句描述了需求，一句描述了用途，而**没有任何界面问过这个数**。
这也是这个项目重复出现的那类缺陷：数据层写好了，使用它的那一半从没接上。

于是接上，而不是删掉——判据是"这个能力是项目想要的"：合并要改写每一篇带该标签的文档的 frontmatter，
按一次不可撤销的按钮之前，操作者该看到的是确切数字。`tagChangeImpact` 现在返回三个数（并集 `documents`、
带源标签的 `carrying`、两个都带的 `overlapping`），对话框在打开时与每次改目标时问一次；句子除了报出
确切数字，还会在有人两个都带的时候说清楚：对那几篇来说这是**去掉**一个标签，不是替换。计数用的就是
重写路径自己用的那个函数，不是为对话框另写一条查询——一条规则两个实现就是两个答案。

接上它之后，发现了三件事，都不是猜的：

1. **那份报告在干净跑完的那一次根本显示不出来。** `TagOperations` 只渲染在一个标签自己的页面上
   （`/admin/tags/<slug>`），而三个操作**都可能删掉这一页所讲的那个标签**，所以跑完之后
   `router.refresh()` 会重新渲染一个 404：操作者按下 Merge、一切成功、屏幕上是 "Not found"。
   准确地说，报告之前只在**有文档写失败**的那一次活下来（失败的文件还在 frontmatter 里写着这个标签，
   标签行于是活过 prune，页面照常存在），而在**跑干净**的那一次被丢掉——正好是操作者没有别的确认渠道的
   那一次。修法是 `destinationFor`：干净跑完就走到活下来的那个标签（改名、合并）或列表（删除），
   有报告要读就留在原地。
2. **接上这个数，让代码第一次读了 `report.to.slug`，而它一直是错的。** `mergeTagAction` 传的是
   `to: { slug, name: target.name }`——**源**标签的 slug 配**目标**标签的名字。之所以一直没人发现，
   是因为没有人读过 `to.slug`：frontmatter 重写只用 `to.name`，提交标题也只用 `to.name`。新的导航
   读它，于是把操作者送到 `/admin/tags/<源标签>`，也就是刚被删掉的那一个。e2e 逮住了它（先看到的是
   "Not found"，服务端日志打出 `"to":{"slug":"e2e-source-…","name":"E2E Target …"}`），修法是一个词，
   集成测试现在同时盯住 `report.to` 的两半。
3. **同步失败的警告只有报告这一个信使，而报告可能留不住。** toast 会活过导航（它是 toast），所以
   它现在把两件事都说出来：哪些文档没写成、以及索引没对上（"the site still shows the old tags"）。

测试补在各自该在的层：单元测句子——真实站点上不特意构造就够不到的那几个分支（没人带的标签、
两篇都带的文档、还没数出来的状态、跑完落在哪里）；集成测数字——并集/重叠/各计数落在真实 Markdown
文件和真实索引上，并且合并改写的文件数正好等于对话框报出的 `carrying`，没被碰到的文件逐字节不变；
e2e 测接线——发两篇带标签的文档，断言句子里是**并集**（特别不是那个和 3），按下按钮后落在活下来的
标签上，源标签的公开 URL 变成 404。回归数字：lint 干净、typecheck 干净、1095 单元、1249 集成、52 e2e。

**再补一条，还是同一类缺陷，这次在编辑器里：一个文件在盘上、却不在索引里的时候，产品说了话、但那些话一句也到不了人眼前。** 查这条时先看到的是一串没有读者的东西：`loadEditorDocument` 的兜底分支（`loadDocumentByPath` 只有它在调，而那个分支在真实站点上走不到）、`EditorDocument.driftedFromIndex` 的横幅（除非先手工arrange 文件系统，否则永远不显示）、`afterWrite` 显式容忍"行不存在"的那一段，以及 `autosaveContentAction` 里那句 "Save once with ⌘S, or run a content sync."。它们全部来自 `a94f88e feat(admin): the CMS`——写好了，没接上。

判据跟前一条一样：这个能力是项目想要的，所以是接上而不是删掉。五处痕迹不是巧合，保存路径本身就是照它设计的（写完文件之后，没有行只是"还没索引"，不是错误）；而它要覆盖的场景是真实的：`git pull`、手工放进内容树、在别处改过又拷回来——作者知道自己刚写进去的那篇的 slug，产品却只肯回一个 404。

接上它之后，发现了三件事，都不是猜的：

1. **两处字段文档互相矛盾，而且矛盾的那一句正是这个缺陷的指纹。** `EditorDocument.driftedFromIndex` 的注释写的是"文件在盘上但不在索引里"，而客户端 payload 上对应的注释与横幅的句子说的是校验和不匹配。两种状态都是真的，处置也确实是同一件事（打开、保存、重建行），但它们**说给操作者的话必须不同**——一个是"站点没有这篇"，一个是"站点有这篇、但标题/描述/标签是旧的"。于是拆成两个具名状态：`IndexDrift = 'unindexed' | 'stale'`，各说各的实话。判定用的是行自带的 `checksum`（那正是它被写下来的原因）：`row.checksum === document.checksum` 是精确的落后判定，而仪表盘那个漂移计数只是 size+mtime 的猜测、保存时的 `baseChecksum` 只代表页面打开的那一刻——两者都不是这个问题的答案。
2. **句子不能含糊，因为含糊的那一版在描述一个不存在的 bug。** 公开页的正文**永远**来自文件，行只缓存 frontmatter 与统计——所以 `stale` 的句子只能说标题、描述、标签是旧的、正文来自文件。说成"站点在展示旧文章"就是把一个正确的设计说成故障。这一条被钉在两层：单元测试要求句子只声明索引真正持有的字段，e2e 则在公开页上断言 H1 是**旧**标题、正文是**新**正文。
3. **Revisions 链接挂在这一行上。** 修订属于行（按行的 id），所以没有行就没有修订页，而那个地址只会给 404。现在 `unindexed` 时不给这个链接——不是给了再报 404，而是没有可看的就不给入口；横幅的句子已经说清了为什么没有。

口径记两条。其一，**不在仪表盘上列出每个漂移文件**：项目对漂移的既定处置就是同步（仪表盘那句 "Run a sync from System"），列出清单是新能力，不是这次要修的半个。其二，**按 slug 找文件本质上是一次解析**——slug 可能来自 frontmatter、标题或文件名（`deriveContent` 的三级回退），所以只能逐个读文件比对，不能从文件名猜；扫描是宽容的，读不出来的文件跳过，一个坏文件不能让其他所有地址变成错误。

测试补在各自该在的层：单元测句子（两条通知各自说了什么、以及不说什么——`stale` 不许出现 "not serving it"，`unindexed` 不许出现 "still rendering"）；集成测状态判定与查找（真实文件、真实行：没有行的文件能打开、按标题给出的 slug 能找到、不会跨类型串到同名 slug、同步后为 `null`、外部改动后转为 `stale` 且表单取的是文件的值、再同步回到 `null`）；e2e 测接线，两个方向都走一遍——先 404 的未索引文件存一次就在公开站点上线，磁盘上被改过的文档在公开页上"旧标题 + 新正文"、存一次之后标题跟上。e2e 能构造出这两种状态靠的是环境本身：`CONTENT_SYNC_ON_BOOT=1` 配 `WORKER_ENABLED=0`，索引只在启动时与 admin 写入时产生，所以启动之后放进去的文件会一直是未索引的。回归数字：lint 干净、typecheck 干净、1100 单元、1258 集成、56 e2e。

**顺着这条线把"没有读者的导出"清了一遍，三条结果，两条删、一条补。** 删的判据跟前文一致：能力不是项目要的（或它已经被另一条路完整覆盖），留着就只是下一次误用的入口；补的判据是能力要、只是缺了执行的那一半。

先说删的两条。`src/lib/security/urls.ts` 里有四个导出**一个读者都没有**：两个布尔谓词（`isInternalPath`、`isLinkUrl`）和两个 Zod schema（`internalPathSchema`、`externalUrlSchema`）；另外 `MAX_URL_LENGTH` 只在本模块内用，`internalPathProblem` 的 `maxLength` 形参没有任何调用方传过。删的依据不是"没人用"，而是**这个模块自己文档里列的执行面已经全部走通了**——导航项、重定向、头像 URL、About 页链接，四个入口分别是 `hrefKindProblem`、`internalPathProblem`/`externalUrlProblem`、`internalOrExternalUrlSchema`、`linkHrefSchema`，各自都有真实调用方和测试。那四个是同一批规则的**另一种写法**，不是缺失的那一半，留着最坏的结果是以后有人挑中较窄的那个（比如给头像用了允许 mailto 的 `isLinkUrl`）。顺带核对了长度口径：确实是 `varchar(512)`，`content_links` 那两个 1024 的列走的是 Markdown 解析、不经过本模块——所以那个文档注释是准的，只是把"每个消费者一个上限"改成了"一个上限"并把理由写在常数上。`src/lib/db/migrate.ts` 里的 `waitForDatabase` 同理：注释写着"给 entrypoint 脚本用的就绪探测"，而这个项目没有 entrypoint 脚本——`Dockerfile` 的 CMD 是 `node server.js`，compose 里 `migrate` 服务靠 `depends_on: postgres: condition: service_healthy` 等就绪。删除（与本节早先删掉 `destroyAllUserSessions` 同一条判据）。

再说补的那条，它是这次清扫里唯一一处**真的漂移**：`src/lib/db/schema.ts` 末尾那八个 `relations()`。项目里所有查询都是显式 `select` 配自己的 join，**没有任何代码读它们**——读它们的是 drizzle 自己的工具（`pnpm db:studio` 是 README 里记着的命令，它按这些对象搭关系视图）。问题在于：一个产品里没有读者的声明，不会有读者因为写错而报错。核对下来，**四个外键从来没被声明过**——`content_links.asset_id`、`assets.uploaded_by`、以及两张 analytics 表的 `content_id`——没有任何地方发现过，因为没有任何地方在读。所以补的是"执行的那一半"：把四个关系补齐，并让 schema **自己检查自己**——两半本来就都写在文件里（外键写在 `.references()`，关系写在 `relations()`），`tests/unit/schema-relations.test.ts` 断言两者说的是同一件事：每个外键在持有它的表上有一个 `one()` 关系、列名与顺序一致；反过来每个 `one()` 关系都有真实外键撑着，关系不能凭空声明一条数据库不保证的边。`many()` 是可选的（drizzle 靠对面的 `one()` 反推字段），但存在时必须有一条指回来的外键。三例都做了变异验证：删掉 `asset` 关系、给 `users` 加一条无外键支撑的 `many(rateLimits)`，两例都被抓住并打印出是哪张表、两份列表各是什么。

回归数字：lint 干净、typecheck 干净、1103 单元、1261 集成、56 e2e。

**第二批：十二个没有读者的导出、七个没有读者的类型别名，以及两处"同一条规则写了两遍"。** 判据与上文一致。这一批里唯一可能被看出来的是那两处接线，而它的效果不在行为上——旧的写法与新的写法逐字等价，见下。类型别名与常量跟函数不同：`eslint` 的 `no-unused-vars` 只管模块内的名字，一旦 `export` 就算"被使用"，所以这一类不会自己冒出来，只能靠一次人工清点。

十二个导出按理由分四类，没有一类是"没人用"这么一句话：

1. **同一条规则的第二种写法。**`countByStatus`（`content/queries.ts`）的注释写"给管理后台的状态计数"，而后台读的是 `contentCounts()`（`lib/admin/queries.ts`）——同一批行、同一种分组，两处各写一遍；`AnyFrontmatter`（`content/schema.ts`）是三个 frontmatter 类型的联合，而"按类型取 schema"已经有 `frontmatterSchemaFor(type)` 的三个重载，读者要的从来不是那个联合；`isDev` / `isTest`（`env.ts`）与 `isProd` 是同一判断的三种写法，全项目只用 `isProd`；`rowUrl`（`content/sync.ts`）是 `documentUrl` 的一行包装，注释说"给 CLI 输出用"，而 CLI 用的就是 `documentUrl`。
2. **文档在描述一个不存在的调用方——这一类最该删。**`fnv1a`（`utils/text.ts`）的注释写"用于缓存键与访客盐"，而访客哈希是 `analytics/collect.ts` 里 `hashVisitor` 的 `createHmac('sha256', secret)`，缓存键一处都不用它；`typeDirPath`（`content/paths.ts`）自称"某类型的目录绝对路径"，而唯一需要目录的地方是 `requiredContentDirs()`、它自己拼，其余代码拿到的都是文档的完整路径；`documentDirectory`（`content/writer.ts`）取一个相对路径的目录名，没有任何代码想知道文档在哪个目录里。留着的代价不是那几行，是**注释本身成了误导**：下一个人按它去找那条路，只会找到它。
3. **check-then-act 的预检，在限流这件事上给不出承诺。**`peekRateLimit`（`auth/rate-limit.ts`）的注释写"用于预检"，而限流的预检天生是竞态——查完到这请求真正扣令牌之间，别的请求已经扣过了，所以它返回的"允许"不是承诺；所有真实调用点都在放行的那一刻用 `consumeRateLimit` 原子扣减。`RateLimitName`（同文件）是 `keyof typeof RATE_LIMITS` 的别名：没有读者的类型别名等于没有约束。
4. **一条绕过所有权判定的入口。**`destroySessionByToken`（`auth/session-store.ts`）按令牌哈希直接删行；活着的两条路各有分工——`destroySession(id)` 用于请求内的登出（id 来自已解析的会话），`revokeSession(userId, sessionId)` 把所有权检查与删除写成同一条语句，按令牌删会绕开后者那道作用域。删除（与本节早先删掉 `destroyAllUserSessions` 同一条判据）。

另有一个不归上面四类、证据最直白的：`CONTENT_FORM_FIELD_NAMES` 是一份手写的字段名清单，写的时候是 19 个，而 `contentFormSchema` 有 22 个——**它已经漂了**，漏掉的正是 `featured`、`toc`、`seoNoindex` 三个布尔。字段名的权威只能是 schema。那七个类型别名（`NewUser`、`NewContentRow`、`RevisionRow`、`TagRow`、`SiteSettingsRow`、`AnalyticsDailyRow`、`ContentLinkRow`）在同一个文件的同一段里，旁边十一个 `$inferSelect` 别名都有读者，这七个没有：项目里所有读路径都在自己的查询里 `select` 出确切的列（`listUserSessions` 返回的甚至是比 `Session` 更窄的 `SessionSummary`），写路径用的是 `db.insert(x).values({...})` 的对象字面量并当场被 `$inferInsert` 检查，多一个 `NewXxx` 别名只让"这个字段能不能插"多一种说法。

两处接线都不是新能力，而是**把已经写好的那一半接上**，且行为逐字等价：

1. `createContentAction` 曾经把 22 个字段的初始值**手抄一遍**（`frontmatterFromForm` 的第一个实参），而 `emptyFormValues()` 就是那份对象、只是没有任何调用方。两处当时逐个相同——包括那个 `type === 'project' ? 'active' : 'active'` 的三元（两条分支一样，那个因此从没起过作用的 `type` 形参也一并去掉，并在文档里写明为什么不需要它）。现在新文档的初始值只有一处可改。
2. 项目页的 Started 事实曾经内联 `formatDate(doc.startedAt, context, 'medium')`，而 `document-view.tsx` 里 `startedLabel()` 的函数体就是这一行、也只是这一行，同样没有调用方。

因为逐字等价，这里没有新增测试——能抓住这类漂移的测试，只能是"断言产品里只有一份定义"的结构性检查，而这正是删除与接线本身完成的：第二份副本现在不存在了。所以给的是一条口径而不是一条测试：**再看到同一份规则被抄第二遍，处置是删掉其中一份，不是补一个断言让两份暂时相等。**（本节前面为 tag 合并写过同一句话：一条规则两个实现就是两个答案。）

**一处保留，写在这里以免下次被当成漏网。**`src/components/ui/` 整棵子树里有十二个模块一个导入者都没有（avatar、card、collapsible、dropdown-menu、empty-state、popover、progress、scroll-area、select、separator、table、tooltip），连 `index.ts` 那个 barrel 也没有人 import——`src/lib/*` 的 barrel 各有几十个读者，只有它没有。保留的理由是它**不是应用代码，是库表面**：应用代码的读者是产品，没有读者就是死的；库的读者是下一个页面，而这一份是 shadcn 风格的原语集合（`ARCHITECTURE.md` 自己就是这么写的），删掉一半之后要用回来是重新生成，不是取消注释。

回归数字：lint 干净、typecheck 干净、1103 单元、1261 集成、56 e2e。

**再补一条，方向与前面几条正好相反：这次缺的不是"执行的那一半"，是"入口的那一半"。** 前面几条都是"规则/策略在、没有执行方"，`/api/preview` 反过来——一条写完了、有文档、有安全推理的路由，产品里没有任何地方指向它。它是 `GET /api/preview?type=&slug=`，`requireUser` 是函数体的第一句（在任何参数被读、任何文件被碰之前），渲染磁盘上的文档而**不看 status**。它自己的注释解释了为什么不做成 `/posts/x?preview=1`：公开路由上的一个查询参数等于给草稿留一个常开的泄漏面（一处忘掉的 status 检查、一条 CDN 规则、一层缓存中间件都足够），而 `/api/` 本来就被 `robots.txt` 整体 disallow。也就是说这不是一个顺手写的工具，是带着理由写好的——只是没有入口。

而产品里确实没有：后台列表的 View 只在 `row.status === 'published'` 时出现（`src/components/admin/content-list.tsx:261`），公开页按 status 过滤，所以一份草稿**一个能读它的地址都没有——连作者自己也没有**。而设定稿开头那份要求清单里就写着"支持后台直接创建、编辑、预览、发布 Markdown"（`project.md` 第 11 行，正文第一节之前），DELIVERY 到此为止一次都没提过这条路由。判据因此是"接上"而不是"删掉"，与前文接上 wiki 链接、接上漂移横幅同一条。

接线要解决的真问题是命名：这条路由要的是**文件名**，不是文档的 slug。两个参数喂给 `buildRelativePath`——那正是"查询串不会以路径的身份到达文件系统"的那道保证——而 slug 重命名改的是 frontmatter、不动文件，因为**已经分享出去的 URL 必须继续能用**。所以拿 `values.slug` 拼出来的地址会去要一个从来没有写过的文件，作者会从**唯一一个为看他自己的草稿而存在的页面**上拿到 404 `No document at posts/new.md`。接线因此落在服务端：编辑页用 `parseRelativePath(document.path)` 取文件名，客户端只收到一个已经拼好的 href。

第二个判断是不许撒谎。编辑器里"文件 / 缓冲区 / 草稿修订"是三件事，autosave 记的是修订、**不写文件**，所以缓冲区领先时那个位置显示 "Preview after saving" 而不是一个链接——一个链接会打开比屏幕上更旧的版本，而那正是预览最不该做的事。这句话不另加解释，因为表头下面那行 "Unsaved changes — not yet written to the file" 已经在说同一件事。入口对**未索引**的草稿也给：路由读的是盘，而一份还没进索引的草稿恰恰是作者想看的。文档随之改了两处：路由新增 `## What slug means here` 一节把这个词在这里的含义写死（文件名的主干，不是文档的 slug，以及为什么），400 的那句话从 "a valid slug" 改成 "the file's name as a slug"。

测试补在 e2e 层，两条，两个 project 都跑，因为这里新增的是一处**接线**：权限与渲染分别由 `requireUser`、`renderDocument` 自己的测试守着，而"入口对不对"只有浏览器能回答。第一条走完整的一遍——新建草稿、打字（断言此刻是 "Preview after saving" 且没有链接）、保存（链接出现）、**改 slug**、断言 href 里是**旧**名字（也就是文件名）、断言公开站点在新旧两个地址上都是 404、再从链接打开预览读到自己刚写的那段话。第二条问的是"别人能不能看"：同一个地址在没有会话时被带到登录页、`next` 原样带着这个地址、被拒的响应体里没有那段话、登录之后落回草稿，最后断言响应头上的 `x-robots-tag: noindex` 与 `cache-control: private, no-store`。

一条查证时发现、值得单独记的事：后一条的响应头一开始是用 `page.request.get()` 读的，它稳定地失败，而原因不在路由，在 `APIRequestContext` 与浏览器的差别——`page.request` 严格按 RFC 6265 办事，**`Secure` cookie 不附加到 `http:` 请求上、不看主机**，而 Chromium 把 `127.0.0.1` 当安全上下文、肯在明文 HTTP 上收下并回送它。这一套 e2e 的服务端是照部署配的（`COOKIE_SECURE=1` 配明文 HTTP，理由见 `tests/e2e/environment.ts`），于是同一个地址经 `page.request` 发出去是**未登录**的，跟着重定向拿到的是登录页的 200，那几个头一个都不在上面。所以头是从**导航**的响应上读的（`page.goto` 的返回值），并把这条差别写进了 `environment.ts` 里那段 COOKIE_SECURE 的理由旁边——它属于那里而不是这个 spec：本套件其余每一处 `page.request` / `request` 打的都是"对陌生人也要回答"的路由（`/api/search`、`/api/graph`、feed、beacon、资源文件），从没有一处需要会话，所以这个坑此前没被踩到过。

回归数字：lint 干净、typecheck 干净、1103 单元、1261 集成、60 e2e。

**再补一条，这次的读物是一张"承诺表"：七条限流策略里有两条没有消费方，一条接上、一条删掉。** 前几轮扫的是导出、类型、常量，判据是"有没有读者"；`src/lib/auth/rate-limit.ts` 的 `RATE_LIMITS` 不一样，**表里的每一条都是一个承诺**——它说这条路由被限住了。核实下来七条里五条有真实调用点（login、loginAccount、upload、import、sensitiveAction），`search` 与 `analytics` 一条都没有。

`search` 接上了。理由不只是"那条注释正好写着这个端点"，而是 `/api/search` 是这个站点上**唯一一处价格由调用方决定**的响应：它从进程内的索引作答，且按设计不缓存（`no-store`，按查询串建键的共享缓存是负债），所以每个请求都是一次分词加一次全库排序。键取调用方的地址、**按登录限流同一套 `hashIp` 先哈希再入库**（`rate_limits` 表里因此没有任何地址），因为这里的读者是匿名的、请求里其余每个值又都是调用方自己选的；部署不上报地址时全部落进 `unknown` 这一个桶，这也是登录限流已有的形状。扣减放在解析查询**之前**，因为被限的是调用方不是查询——一个因筛选项被拒的请求同样已经被受理了。答复是 429 配 `Retry-After`，正文沿用本路由的 JSON 形状。

客户端那一半也跟着改了：调色板原先把任何非 2xx 都译成 "Search is unavailable right now."，现在有服务端句子的就用服务端那句——"用完了额度、请等一秒" 和 "搜索坏了" 是两个不同的判断，后一个是假的。同时补了一处并发语义：一个非 2xx 的答复如果在读者已经又敲了一个字之后才到，它就不再是当前这个查询的答复，丢弃它（`throwIfAborted`）而不是用它覆盖屏幕上那个查询的结果。

`analytics` 删掉了，因为这条承诺**这条路由给不出**。一个桶需要一个主体，而这个端点恰好是产品里唯一一个以"不读读者的任何东西"为契约的端点（见 §9 与它自己的注释）。剩下的主体只有三种，逐一都不成立：**地址**（它不读，而且这正是它写在注释里的第一条）；**访客 cookie**（唯一另一个稳定值，可它是由响应发给客户端的——想要多一次信标的客户端不带 cookie 就行，换一个全新身份、换来一个满桶，任何调用方都能自己解除的限制不是限制）；**全站一个桶**（能拦住写入，代价是在这个站点最想要数字的那一天丢掉真实读者的浏览，而丢掉的样子和其它丢弃完全一样是 204，于是仪表盘只是偏低、而且不会有人知道）。所以它由别的东西约束：同源 `Referer`、非爬虫的 UA、本项目客户端才会发出的载荷、每次受理一次索引查询加一次插入，以及行本身的 `ANALYTICS_RAW_RETENTION_DAYS`（默认 30 天，由 worker 的任务裁剪）。判据与本节前面删掉 `peekRateLimit` 是同一条：**一条给不出承诺的规则比没有规则更糟**，因为下一个人会以为它挡住了什么。

两处口径。

其一，**没有为"每条策略都必须有消费方"补一个测试**，尽管这正是本次发现的缺陷。能写出来的版本是扫 `src/` 的源码文本、断言每个策略名都出现在某个文件里——而这个断言会被我刚写下的注释满足：路由的文档里就写着 `RATE_LIMITS.search`。一个把注释算作接线的测试，会在接线被删掉之后继续通过，那比没有测试更坏。真正的结构保证写在表自己的文档里：**一条策略与它的消费方一起加入，而不是先于消费方加入**，因为没人调用的策略比不存在的策略更坏——下一个读这张表的人会把那条路由算作已覆盖。

其二，**这道限制对读者是可见的**，所以它的数字要与调用方一起看：调色板的防抖是 150 ms，容量 60、回填 1/秒，意味着连续快速输入会先花掉突发额度、再被按 1/秒放行；若干读者共用一个地址（NAT、公司出口）时共享同一个桶。这是策略表里原有的数字，不是这次改的，写在这里是为了下次有人问"搜索为什么会被限"时不必再去推一遍。

测试放在 e2e 层，因为限流器要经请求上下文读地址（这只有在请求里才存在），桶又在这个套件本来就有的数据库里：`tests/e2e/search.spec.ts` 新增一条，先把桶清空、再**并发**打完整个额度（顺序打会随机器快慢耗时约一秒，而回填正好是 1/秒——那会把"第 61 个被拒"变成一条会飘的断言），断言额度内的每一个都是 200、接下来是 429、`Retry-After` 是正数、句子是"Too many searches"而不是"搜索不可用"，最后清空桶、断言同一个请求又被正常答复（拒绝是关于桶的，不是关于调用方的）。容量从策略里导入而不是抄一遍，两者因此不可能漂移；桶在测试前后各清一次，因为浏览器和这一套请求共用同一个 `unknown` 桶。回归数字：lint 干净、typecheck 干净、1103 单元、1261 集成、62 e2e。

**再一批，读物是"同一件事的两种写法里只有一种有读者"，外加一处错误翻译少了半边。** 从 `src/lib/content/writer.ts` 的 `writeDocument` 起手：它和 `updateDocument` 是同一次保存的两种写法，区别只在调用方自己拼好 `data` 还是交一个 mutator 回调——而生产代码一次都没调过它（保存走 `updateDocument`、新建走 `createDocument`、逐字还原走 `writeRawDocument`、导入走 `importDocument`），读它的只有测试：`content-writer.test.ts` 六处、`revision.test.ts` 四处、`authoring.test.ts` 两处。删掉，这十二处逐条改指 `updateDocument`。覆盖面没有损失，其中两例（"工作目录被清空之后仍能写"、"内容序列化失败时不碰原文件"）本来保的就是 `updateDocument` 这条路的性质。`authoring.test.ts` 里那个手工造"索引没见过的文件"的助手是唯一的例外，它改用 `fs` 直接落盘，理由写在它的注释里：那正是编辑器之外的一次 `git pull` 或 `cp` 留下的文件，被测的状态恰恰是"应用代码没碰过它"（一次保存会连索引行一起带来），而唯一能造出新文件的 `createDocument` 只能从校验过的 type 与 slug 拼路径，造不出一个文件名不等于 slug 的文档。

清的时候发现错误翻译少了一半。翻译本身是写好的：`describeActionError` 把 `ContentWriteError` 变成 "Writing X failed. The original file was not modified."——操作者在决定要不要重打一遍稿子之前，真正要知道的只有这一句。可 `updateDocument` 只在"读不到这篇文档"时抛 `ContentWriteError`，真正会出错的 `serializeFrontmatter` 与 `atomicWrite`（临时文件、rename、fsync）抛的是裸的 `ENOSPC`／`EACCES`，一路走到 guard 的兜底分支变成 "The server hit an unexpected error."：话是真的，但磁盘满了和一个 bug 在浏览器里长得一模一样。补上 `writeFailure`，装在三个门上：`createDocument`、`updateDocument`，以及 `writeRawDocument`——最后这个正是"撤销修订"写盘的那条路，它同样经 `describeActionError` 回报，此前一样是裸的。两处不装，理由各写各的：mutator 抛出的错是调用方自己的控制流（编辑器靠从 `updateDocument` 里抛出来拒绝一次保存，屏幕从那个错误上读字段级消息），原样放行；`importDocument` 的读者是一份逐文件报告，它把拿到的消息印在对应文件旁边，包一层只会把具体原因换成笼统原因。

消息怎么写，是被一个细节定下来的：`ActionFailure.detail` 是**渲染在浏览器里**的（`confirm-action.tsx`、`system-controls.tsx` 等处把它显示成失败句子下面那行小字），而 guard 对 `ContentWriteError` 的处理正是 `detail: error.message`。节点给的文件系统错误消息里带着两个绝对路径（`ENOSPC: no space left on device, rename '/…/.tmp/x.tmp' -> '/…/content/posts/x.md'`）。guard 自己的注释写着"包装的 `cause` 故意不转交：它可能带着文件系统路径，而客户端是浏览器"——把 cause 的 message 拼进 `error.message`，这条承诺在实质上就破了，尽管字面上（`cause` 属性确实没转交）还成立。所以消息只写文档名并到此为止，这也正是 `detail` 字段自己的文档写的用途：把"没有被写的是哪一个"重复一遍；cause 留在错误对象上，同时由 `writeFailure` 当场写进服务端日志——一个因为 `ENOSPC` 写不进去的服务，能对它做点什么的人在终端，不在表单前面。新测试断言两件事：失败以 `ContentWriteError` 到达，且消息里不含内容根目录（做法是在文档该在的位置放一个目录，"读回当前内容"于是以一个非 ENOENT 的失败开始，写根本没机会发生）。

**颜色那一处是同一个缺陷的另一副面孔：验证器在，但只有一半的边界经过它。** `src/lib/security/mime.ts` 的 `isSafeHexColor` 与 `src/lib/utils/tag-color.ts` 的 `safeTagColor` 是同一个判断的两种写法，生在同一个提交（`dcb84aa`）。公开站那半边接上了——`TagDot` 用它，注释还专门写了为什么不能有第二份实现（两份实现最终会对"一个畸形颜色长什么样"各有主张）；管理后台那两页却把 `tag.color` 直接插进 `style`，一次都没过验证器，而那一列是可以被直接 SQL 导入写进去的，"从来没经过验证的值"不是假想。所以接上那两条边界（拿不到合法十六进制色就不画色块，值本身照原样显示，否则这一页就没法用来诊断它），删掉没有读者的第二种写法，并把 `isSafeHexColor` 名下那批安全断言搬到真正站在 `style` 属性前面的那个函数身上——它此前**一条测试都没有**。

**这一批真正的新类别：只有测试读它的导出。** 前几轮扫"没有读者的导出"，判据是"参考数为零"；而 `eslint` 的 `no-unused-vars` 一旦 `export` 就算被使用，测试套件本身又是一个巨大的读者——于是一个只被测试调用的函数，能大摇大摆通过"一个读者都没有"的筛选。这一批清出十四个导出（另加两个模块私有的正则常量）：`containsCJK` 与 `CJK_TEST`（`utils/text.ts`）、`hasCJK` 与 `CJK_CHAR`（`search/tokenize.ts`）、`replaceFrontmatter`、`frontmatterValueToString`、`isoDate`、`isoTimestamp`（`content/frontmatter.ts`）、`buildHeadingTree`、`fallbackSlug`（`content/derive.ts`）、`referencedImageKeys`、`referencedTargets`、`targetKeyToUrl`（`content/links.ts`）、`getSetting`、`setSetting`、`assertSettingsKey`（`settings/index.ts`）。每一个都先证伪了它名义上的读者：去重规则住在 `sync.ts` 自己的循环里（`(kind, target)` 那一行就是它）、TOC 的层级树只有扁平一种用法、两个日期的显示格式化器是活的而 `isoDate`/`isoTimestamp` 不是、slug 的唯一化走 `uniqueSlug`、设置表单写的是整份 patch 而不是单键。删的时候分两种处理：**测试里还在描述活行为的断言改指活代码**——十六进制断言改指 `safeTagColor`，"只改元数据的重写不碰正文"改指 `parseFrontmatter` → `serializeFrontmatter` 这一对组合本身，设置的单字段校验改指活门 `updateSettings`，"哪些文档引用了这张图"改指 `extractLinks` 的 image 归约，`(kind, target)` 那条去重规则搬进集成套件并新加一份"同一目标写三遍、两种写法"的 fixture（wiki 两次、路由一次，断言两行且 `resolved`）；**其余随实现一起删**。

顺带核出来最后一个：`LinkExtractionResult.externalCount` 每次扫描都算、都返回，生产侧一个读者都没有（`scripts/content/stats.ts` 的链接数字读的是 `content_links` 表，而站外链接从来不入表）。删掉它之后，`classifyRef` 的 `'external'` 就成了 `null` 的第二种写法——调用方对这两者做的事完全一样（跳过），于是把三态收成两态，`null` 一以贯之地表示"这里没有要记录的东西"，与 `normalizeImageKey` 对站外图片的处理也就一致了；相关用例一条不删，只是断言的落点从计数改成"什么也没记下来"（空文档那条也从 `{ links: [], externalCount: 0 }` 收到 `{ links: [] }`），并把理由写成一段组注释：`content_links` 每一行都是一个"这篇指向本站某篇文档或某个资源"的声明，反链、坏链报告和未使用图片检查都这么读它，所以站外的引用不是"空目标的行"，而是没有行。

顺着同一条线还扫到一处**写错位置的注释**，它和这一批其他条目是同一类：一段散文在描述一个不在这里的东西。`collect.ts` 写 `analytics_events` 那个 `insert` 里，"Left empty. Filling it means reading the reader's address…" 三行压着的是 `navigationType: collected.view.navigationType`——一行并不为空的字段（它来自信标，`./beacon` 里有那四个取值）。这三行是给 `country` 写的，而 `country` 这一列在这个 insert 里根本不存在。这比"注释描述了一个已经不在的调用方"更坏一点：它描述的是**隔壁那一行**，所以看起来是对的。

处理分三处。其一，**把 `country: ''` 显式写出来，注释回到它自己的行上**，而不是改散文去迁就一个缺席的行：这个值是决定，不是遗漏（只有一种填法，就是从读者的地址推国家，而本项目不读地址；`project.md` 把该字段列为可选，空串就是符合规格的答案），显式写下来之后，将来想加地理信息的人必须先删掉一行说明为什么不加。这张表全项目只有这一处 insert，测试只读不写，所以每一行都是空的这句话是可以核对的。其二，**列本身留下，不删**：删它要动 `analytics_daily` 那条唯一索引（`day, path, referrer_domain, device, country`），而那条键是设计规定的形状；更要紧的是，一个部署完全可以**不读地址**就填上它——由代理去解（Cloudflare 的 `CF-IPCountry` 就是这种，递过来的是答案而不是地址），那时要改的是读哪个头，不是表。其三，**把"说反了"的地方说回来**：后台分析页的模块注释原本写着 "Every number on this page is a roll-up of `analytics_daily`: a day, a path, a referrer host, a device class and a country column, summed"——那句话把表的维度当成了页面的维度，读者会去找一个这个页面并不渲染的国家分组。现在它写页面真正显示的四样，并说明国家这一维每一行都是 `''`、页面上没有任何数字用它。同一句解释落在 `schema.ts` 两列的定义上（事件那列写全，日聚合那列一行指回去），因为"这列为什么永远是空的"是在那里被问的。`drizzle-kit generate` 对此的回答是 "No schema changes, nothing to migrate"：注释不产生 DDL。

另记一条**查到但没动**的：`YYYY-MM-DD` 这个"某个瞬间属于 UTC 哪一天"的规则，权威写法是 `src/lib/analytics/day.ts` 的 `utcDay()`，而生产代码里另有十一处各写各的（`toISOString().slice(0, 10)`），只有 `jobs/handlers.ts` 真的从那个模块导入东西（还不是这个函数）。逐处核对过：十一处全部是 UTC，规则本身没有分歧，所以这不是"缺了执行的那一半"，只是同一条规则有十一种写法。没在这一批动的理由也写在这里：一个共用的写法得先有个不属于 analytics 模块的家（把 `utcDay` 挪到 `utils/`、让 analytics 反过来导入，或者原地再导出一次），那是跨十一个文件的搬迁，与这一批"删死代码、补上缺的那半边"不是一件事。

删完之后又整棵扫了一遍，两次。**导出那一遍是干净的**：`only-tests5.mjs`（整棵树、解析 barrel、放行框架约定的导出）落在 54 个命中上，全部是两处早已记明的存留——`src/components/ui/` 下 43 个 shadcn 原语（它们不是应用代码，是库表面），以及 11 个 drizzle `relations()` 块（读者是 `pnpm db:studio`，`tests/unit/schema-relations.test.ts` 又用 `import * as schema` 加 `extractTablesRelationalConfig` 拿它们与外键对账，所以扫描器看不见读者）。**类型那一遍（`dead-types.mjs`）剩三个**，都在 `src/lib/content/schema.ts`：`PostFrontmatter`、`NoteFrontmatter`、`ProjectFrontmatter`。它们是前面记过的 `AnyFrontmatter` 的遗留——那个联合被删掉之后，三个成员就没有读者了，名字留在了原地。删。理由不是"参考数为零"这一条：`z.output<typeof schema>` 这个写法在本项目里是有活的用法的（二十来个 action 入参类型，如 `SaveContentInput` 既是 action 的形参类型又被表单导入），所以别名本身不是坏味道，坏的是**没人按名字要过这个形状**。读者要的形状叫 `ContentDocument`：`reader.ts` 用 `frontmatterSchemaFor(type)` 校验完之后并不把校验结果当类型交出去，而是逐字段重新取（`asString` / `asDate`）并显式 cast 成 `Record<string, unknown>`，最后给出的是那张扁平、带派生字段的表。将来若真有消费方要白本形状，从 schema 取一行就回来了。

回归数字：lint 干净、typecheck 干净、1109 单元、1268 集成、64 e2e。

---

## 附录：`ARCHITECTURE.md` 的来历

`ARCHITECTURE.md` 是按 project.md 的要求**先于实现**写成的，因此在实现过程中被推翻了若干条
描述。这些描述已经按代码改正（§4 的版本口径、§6 的插件表与 sanitize 顺序、§7 的
`SearchProvider` 接口与索引持久化、§8 的 `/graph`、§10 的缓存策略、§11 的健康检查），
所以现在这份文件与实现一致，读它不需要再对照别的东西。

记下这段来历，是因为它解释了这份文件的一处风格：它偶尔会写"为什么不是另一种做法"
（例如 §7 为什么不放 `upsert` / `remove` / `rebuild`，§10 为什么整棵树是 `force-dynamic`），
那些段落是后来补的，不是设计阶段就有的——它们是实现过程中被推翻的判断留下来的记录。
真正先于实现的判断，在文中不加标记，因为无法逐一区分。
