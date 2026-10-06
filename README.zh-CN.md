# Inkbranch · 墨枝

[English](./README.md)

一个个人知识系统与发布平台：面向读者的前台、完整的内容管理后台，以及一条以**磁盘上的
Markdown 文件为唯一事实来源**的内容管线。

它不是 Ghost 的克隆，也不架在 headless CMS 之上。文章（posts）、笔记（notes）、项目
（projects）三个内容层共用同一条 Markdown 管线、同一份搜索索引、同一套关联关系（反向链接、
相关内容、知识图谱），以及同一个后台。

- 阅读体验、内容模型与渲染管线：[架构说明](./ARCHITECTURE.zh-CN.md)
- 在生产环境运行它：[部署手册](./DEPLOYMENT.zh-CN.md)
- 做了什么、没做什么、以及为什么：[交付说明](./DELIVERY.md)

---

## 其余一切由这个决定推导而来

文章正文永远不存进 Postgres。一篇文章只存在于一个地方：`content/` 下的一个文件。数据库保存
的是文件本身存不了的东西——内容索引（供列表、统计与搜索使用）、标签与链接边、修订、资源、
重定向、设置、导航、会话、分析与审计日志。

这一点值得写在最前面，因为它解释了代码库里的绝大多数形态：

- **编辑文件就是发布。** `git pull`、`vim`，或者把一个 `.md` 丢进 `content/`，都是受支持的
  更新站点的方式。`pnpm content:sync`（以及启动时的一次轻量检查）会按磁盘上的实际内容对
  索引做校正。
- **`src/lib/content/` 是唯一接触 `content/` 的模块。** 读、写与路径处理都经过它。写入是
  原子的——加锁、临时文件、`fsync`、`rename`、`fsync(dir)`——所以一次失败的保存永远不会
  损坏它正要替换的那个文件。
- **前台按请求渲染。** 任何依赖数据库的东西都不在构建期预渲染，因此 Docker 构建不需要
  数据库，镜像里也不可能含有你的开发内容的快照。完整理由见 `src/app/(site)/layout.tsx`
  里的注释。
- **Postgres 消失时，站点仍然读得到*内容*。** 文章正文及其元数据来自文件系统，所以数据库
  没了也不会丢东西。不过站点不会因此在没有数据库的情况下继续*服务*：前台布局每次渲染都要
  读设置与导航，所以 Postgres 故障就是一次故障。文件优先的设计换来的是——内容（那部分花了
  数年写出来的东西）永远不会被数据库锁住，而不是"站点对数据库故障免疫"。

---

## 环境要求

| 要求 | 说明 |
|------|------|
| Node.js 22+ | `engines.node` 为 `>=22`。Docker 镜像为 `node:22-alpine`。 |
| pnpm | `packageManager` 固定 `pnpm@12.3.4`，由 Corepack 读取。`corepack enable` 即可。 |
| PostgreSQL | `docker-compose.yml` 固定 `postgres:17-alpine`，测试也以 17 为准。下界是 13——schema 里用到的最新特性是 `gen_random_uuid()`（ARCHITECTURE.md §4）。 |

没有 Redis，没有 Meilisearch，没有消息队列。搜索是进程内索引，会话存在 Postgres 里，定时
工作是 worker 循环。

---

## 首次运行

```bash
# 1. 配置。`.env.local` 优先于 `.env`；两者都被 gitignore。
cp .env.example .env.local

# 2. 至少要在 .env.local 里设置 DATABASE_URL 与 SESSION_SECRET。
openssl rand -base64 48          # 粘贴到 SESSION_SECRET

# 3. 建表，然后写入第一批数据。
pnpm db:migrate
pnpm db:seed

# 4. 按 content/ 里的现有内容构建内容索引。
pnpm content:sync

# 5. 启动。
pnpm dev                          # http://localhost:3000  ·  /admin/login
```

### 管理员账号

`pnpm db:seed` 读取三个变量，创建 owner 账号、设置行与一套初始导航。它是幂等的：再跑一次
不会改变任何东西，也永远不会重置管理员后来改过的密码或站点名。

```dotenv
ADMIN_EMAIL=you@example.com
ADMIN_NAME=Your Name
ADMIN_PASSWORD=                        # 12–1024 characters, required
```

`ADMIN_PASSWORD` **在首次运行时是必需的，且永远不会被自动生成**。一个自己编出密码的 seed
脚本，要么把凭据写进日志，要么交出一个谁都登不进去的账号；拒绝执行是更好的失败方式。三个
变量中任何一个缺失或格式不对时，脚本以非零状态退出且不写入任何东西——所有检查都在第一次
写数据库之前跑完，所以 `.env.local` 里的一个笔误不会产生一个只塞了一半的数据库。

没有开放注册或用户管理页面。账号通过种子 CLI 创建；幂等性针对配置的邮箱。修改 `ADMIN_EMAIL` 会创建另一个账号，重新初始化时应使用同一邮箱。

### 内容

仓库自带 13 篇示例文档（2 篇文章、7 篇笔记、4 个项目），位于 `content/` 下。如果你有自己的
`.md` 树，把 `CONTENT_DIR` 指向别处，或者通过 `/admin/import` 导入——无论哪种方式，把它们
放进索引的都是 `pnpm content:sync`。

---

## 脚本

下面每个脚本都定义在 `package.json` 里。`db:*` 与 `content:*` 通过 `tsx` 运行，并且自己加载
`.env.local` / `.env`，所以不需要任何包装。

| 脚本 | 作用 |
|------|------|
| `pnpm dev` | 带热重载的 Next.js 开发服务器。 |
| `pnpm build` | 生产构建。产出 Docker 镜像所拷贝的 `standalone` 服务器包。 |
| `pnpm start` | 服务生产构建（`next start`）。 |
| `pnpm lint` | `eslint .` |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | 单元测试（`vitest run`）。不需要数据库。 |
| `pnpm test:watch` | watch 模式下的 Vitest。 |
| `pnpm test:integration` | 针对真实 Postgres 的集成测试。一次跑一个文件。需要 `TEST_DATABASE_URL`；没有则跳过。 |
| `pnpm test:e2e` | Playwright 针对真实生产服务器（`next build && next start`），使用它自己的数据库与自己的内容树。需要 `TEST_DATABASE_URL`。 |
| `pnpm db:generate` | `drizzle-kit generate`——按 `src/lib/db/schema.ts` 生成一份新的 SQL 迁移到 `src/lib/db/migrations/`。 |
| `pnpm db:migrate` | 应用尚未执行的 SQL 迁移。`docker compose` 的 `migrate` 服务跑的就是它。 |
| `pnpm db:seed` | 创建 owner 账号、设置行与默认导航。幂等；从不生成密码。 |
| `pnpm db:studio` | `drizzle-kit studio`——操作数据库的浏览器界面。 |
| `pnpm content:sync` | 按 checksum 对 `content_index` 与 Markdown 树做校正（新增／更新／删除）。`--check` 只报告不写入。 |
| `pnpm content:validate` | 检查每个文件的 frontmatter 与链接，不写入任何东西。按文件报告警告与错误。 |
| `pnpm content:reindex` | 重写那些 `search_index_version` 落后于当前版本的搜索文档。 |
| `pnpm content:import` | 导入器，支持 `--from` 文件、`--zip` 归档与 `--scan-dir` 目录树。除非传入 `--apply`，否则是 dry run。 |
| `pnpm content:links` | 打印指向空处的链接，按包含它们的文档分组。 |
| `pnpm content:stats` | 按类型、标签与年份统计，外加孤立文档、字数与阅读时长——读的是索引，不是文件。 |
| `pnpm worker` | 在独立进程中运行与服务器相同的任务循环：发布、同步/漂移/重建索引、统计聚合/保留、资源维护。服务器默认自动启动循环（`WORKER_ENABLED=1`）。 |
| `pnpm backup` | `scripts/backup.sh`——写出一个 `backup-<date>.tar.zst`，内含 `pg_dump`、`content/`、`uploads/` 与环境文件，在取最终名字之前完成校验与清单。 |
| `pnpm restore` | `scripts/restore.sh`——把那份归档恢复到数据库与两棵目录树上。破坏性操作；会让你手动输入 `restore`。 |

备份与恢复脚本有各自的参数与环境变量（`BACKUP_KEEP`、`BACKUP_LABEL`、`--yes`、
`--database-only`、`--files-only`）；需要传参时按 `bash scripts/backup.sh [backup-dir]` 与
`bash scripts/restore.sh <backup-file.tar.zst> [flags]` 调用。两者都记录在
[部署手册](./DEPLOYMENT.zh-CN.md)中。

---

## 内容

### 三个层

| 层 | 目录 | URL | 形态 |
|----|------|-----|------|
| 文章（Posts） | `content/posts/` | `/posts/<slug>` | 长文。`title` 必需。 |
| 笔记（Notes） | `content/notes/` | `/notes/<slug>` | 短笔记、技巧、片段、学习记录。`title` 可选（从第一个标题或第一行推导），`description` 与 `slug` 同样可选。 |
| 项目（Projects） | `content/projects/` | `/projects/<slug>` | 项目页。`title` 必需；`projectStatus`、`started`、`repo`、`website` 与 `stack` 为该类型专有。 |

状态是推导出来的，而不是默认出来的：显式的 `status` 优先；没有它时，有日期的文件是
`published`，没有日期的是 `draft`。`status: scheduled` 需要 `publishAt`；
`status: published` 需要日期。`slug` 回退到文件名，但两者都存在时 frontmatter 优先。

三个层都会被索引、可搜索、可打标签、可链接，并出现在反向链接、知识图谱与订阅源中。

```
content/
  posts/        ← 一个文件 = 一篇文档
  notes/
  projects/
  .locks/       ← 临时；写锁
  .tmp/         ← 临时；原子写入的暂存区
  .recovery/    ← 私有；未完成操作保留的旧文件原始字节
```

隐藏的运行时目录被 gitignore，并且不会参与扫描或导入。修订历史以 gzip 快照保存于数据库
（见 ARCHITECTURE.md §4）。正式修改先将旧文件的完整原始字节保存在私有 `.recovery/` 中；
确认完成后只清理本次副本，后续处理失败则保留副本并报告恢复位置。备份会包含这些副本。

### frontmatter

在 `src/lib/content/schema.ts` 里用 Zod 定义一次，由解析器、校验器、CLI 与编辑器共享。未知
键经后台一轮往返后仍然保留，所以手写的 frontmatter 永远不会被悄悄破坏。

```yaml
---
title: "Linux 网络排查笔记"
slug: "linux-network-debugging"
description: "从 tcpdump 到 netstat 的一次完整排查记录"
date: 2026-09-11
updated: 2026-09-11
status: published                # draft | scheduled | published | archived
publishAt: 2026-10-01T09:00:00Z  # required when status: scheduled
tags: [Linux, Network]
category: Technology
featured: false
toc: true
lang: zh
---
```

---

## 测试

```bash
pnpm test              # unit — no database, no server
pnpm test:integration  # needs TEST_DATABASE_URL
pnpm test:e2e          # needs TEST_DATABASE_URL
```

- **单元**（`tests/unit/`）覆盖 frontmatter 解析器、slug、Markdown 渲染器、
  内部链接解析、反向链接、内容同步、重定向、路径校验、搜索、修订、任务、分析、SEO、
  订阅源、设置、资源、关系图与 git 自动提交——最后两项针对它们真正构建出来的东西测试，
  因为被测的就是 git 与布局引擎的行为。
- **集成**（`tests/integration/`）跑在真实 Postgres 与真实的临时内容树上。
  `vitest.integration.config.ts` 刻意设置 `fileParallelism: false`：每个文件有自己的
  `CONTENT_DIR`，但它们共用一个数据库，而 `syncContent` 会删除它看不到对应文件的索引行
  ——两个文件同时跑会互相删掉对方的夹具。没有 `TEST_DATABASE_URL` 时这些套件会**跳过**，
  所以一个没有数据库的检出仍然能得到一次绿色的单元测试。
- **端到端**（`tests/e2e/`）跑一台真实生产服务器（`next build && next start`），使用它
  自己的数据库与自己的临时内容树，然后用 Chromium 驱动——桌面与移动两种 profile，单
  worker。`tests/e2e/environment.ts` 解释了为什么这套件不可以碰开发数据库或 `./content`：
  它会创建文档再删掉，指向真实内容树就等于把它变成一件丢数据的工具。它从
  `TEST_DATABASE_URL` 推导出自己的数据库名（`myblog_e2e`）并按需创建。它还在每次登录前
  清空登录限流桶（理由见 `tests/e2e/support.ts`）：那个限流器很紧，因为它存在的意义是限制
  密码猜测，而一个每分钟登录两次的测试套件不是在猜——没有这个接缝，一次运行就会把账号的
  每小时配额用光，最后几个测试会以 "Too many sign-in attempts" 失败。

`TEST_DATABASE_URL` 必须指向**与应用数据库不同、可丢弃的数据库**。测试会拒绝相同目标（包括 localhost 别名和更换凭证）。集成测试会修改索引，E2E 会重建自己的数据库；建议使用专用测试服务器或具备创建 E2E 数据库权限的测试角色。

```dotenv
DATABASE_URL=postgresql://myblog:…@localhost:5432/myblog
TEST_DATABASE_URL=postgresql://myblog:…@localhost:5432/myblog_test
```

---

## 目录结构

```
src/
  app/
    (site)/           前台阅读体验——home, posts, notes, projects,
                      tags, archive, series, about, search, graph
    admin/            后台：dashboard, editors, assets, tags, navigation,
                      redirects, analytics, settings, system, import, login
    api/              search, assets (upload + file serving), analytics, graph,
                      preview, OG images, health
    *.ts(x)           根布局、根 404、错误边界、sitemap、robots
  components/
    ui/               Radix + CVA 基础组件（shadcn 风格）
    site/             阅读体验
    admin/            后台框架与表单
    admin/editor/     CodeMirror 6 编辑器、元数据面板、分栏预览
    markdown/         渲染器输出与交互式区块包装
    graph/            知识图谱画布
  lib/
    content/          唯一接触 content/ 的模块
    markdown/         unified 管线及其插件
    db/               Drizzle schema、客户端、迁移
    auth/             密码、会话、守卫、CSRF、限流
    search/           SearchProvider 接口 + 本地 BM25 provider
    analytics/        采集、按日聚合、保留策略
    seo/              元数据、JSON-LD、订阅源、OG 图
    jobs/             定时任务运行器与处理器
    revision/         快照、diff、恢复
    assets/           上传、图片处理、模糊占位图
    security/         路径监狱、MIME 嗅探、消毒器
    settings/         类型化的站点设置读取器
    graph/            关系图构建与布局
    git/              可选的 content 自动提交（默认关闭，从不 push）
  env.ts              经过校验的环境变量（见 DEPLOYMENT.md）
  instrumentation.ts  生产姿态检查，每次服务器启动运行一次
  proxy.ts            Node 代理：数据库重定向与后台路径上下文
scripts/              CLI 入口（content:*、db:*、worker）+ backup/restore
tests/                unit · integration · e2e
content/              Markdown——事实来源
public/uploads/       上传的媒体文件，供本地 `pnpm dev` 使用
uploads/              上传的媒体文件，由 docker-compose.yml 绑定挂载到容器的
                      public/uploads 之上
```

---

## 部署

Docker Compose 是受支持的路径：

```bash
docker compose up -d
```

完整运行手册——三阶段 Dockerfile、`migrate` 服务、每一个环境变量以及哪些在生产环境必需、
生产姿态检查、卷、备份与恢复、健康检查、TLS 与升级——在[部署手册](./DEPLOYMENT.zh-CN.md)
中。
