# 部署

[English](./DEPLOYMENT.md)

单主机上的 Docker Compose 部署。整个应用就是一个 Node 进程，它的数据库就是一个 Postgres，而它对外提供的、不属于代码的一切，都放在两个你能直接打开的目录里。除此之外没有任何东西需要安装：搜索在进程内完成，会话是 Postgres 里的行，任务队列就是一张表。

如果你想弄清系统*为什么*是这个形状，请先读 [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md)；本文档是运维手册。

---

## 1. 受支持的路径

```bash
git clone <repo> inkbranch && cd inkbranch
cp .env.example .env             # compose 读取的是 .env，而不是 .env.local
$EDITOR .env                     # POSTGRES_PASSWORD、SESSION_SECRET、HTTPS SITE_URL、COOKIE_SECURE=1
mkdir -p content uploads
sudo chown -R 1001:1001 content uploads   # 见 §6 —— bind mount 会保留宿主的属主
docker compose up -d
```

`docker compose up -d` 会启动三个服务：

| 服务 | 镜像 | 职责 |
|---------|-------|------|
| `postgres` | `postgres:17-alpine` | 数据库。PostgreSQL 17 是受支持且实际验证的部署版本。 |
| `migrate` | 本仓库，`build` 阶段 | 应用待执行的迁移，然后退出。 |
| `web` | 本仓库，`runner` 阶段 | 站点。只有在 `migrate` 以 0 退出之后才会启动。 |

第四个服务 `reverse-proxy` 藏在一个 compose profile 之后，除非明确要求，否则不会启动：

```bash
echo 'DOMAIN=blog.example.com' >> .env    # 读者使用的主机名
docker compose --profile proxy up -d
```

这样一来 Caddy 就被放到前面，它会为 `DOMAIN` 申请并续期证书，并从此成为进入 `web` 的唯一通道 —— 见 §9。

Compose 从 `.env` 读取下面这些变量（compose 加载的正是这个文件，而*不是* `.env.local` —— 后者是应用和 CLI 脚本加载的文件）：

| 变量 | 是否必需 | 说明 |
|----------|----------|-------|
| `POSTGRES_PASSWORD` | 是 | 缺了它 Compose 会拒绝启动（`docker-compose.yml` 里的 `:?`）。 |
| `SESSION_SECRET` | 是 | 同时传给 `migrate` 和 `web`。 |
| `SITE_URL` | 生产环境必需 | 必须是 `https://…`；见 §5。 |
| `COOKIE_SECURE` | 生产环境必需 | 必须是 `1`；见 §5。 |
| `DOMAIN` | 启用 `proxy` profile 时必需 | 必须是 `SITE_URL` 里的那个主机名，否则登录和保存都会被当作跨域而拒绝。默认是 `localhost`，此时 Caddy 用自己内部的 CA 提供服务。 |
| `POSTGRES_USER` / `POSTGRES_DB` / `PORT` | 否 | 默认分别是 `myblog`、`myblog`、`3000`。 |

然后是 owner 账号的种子数据 —— 手工做一次，因为它需要一个由人给出的密码，并且刻意不属于 `docker compose up` 的一部分（§4）：

```bash
# 在一个用 `build` 阶段构建出的容器里运行它，那里有 tsx 和 scripts/。
docker compose run --rm \
  -e ADMIN_EMAIL=you@example.com -e ADMIN_NAME='Your Name' -e ADMIN_PASSWORD='…' \
  migrate pnpm db:seed
```

`migrate` 是在 `build` 阶段构建出来的服务，所以只有它能运行 `pnpm db:seed` —— `docker compose run` 会覆盖它的 command，同时保留它的环境和 `depends_on`。`web` 容器做不到：运行时镜像里既没有 `tsx` 也没有 `scripts/`（§2）。在同一个数据库上，从一份 checkout 里跑种子脚本，效果完全相同。

### compose 文件里没有的东西，以及为什么

没有 Redis，没有 Meilisearch，也没有单独的 worker 容器。搜索是进程内的索引，会话存在 Postgres 里，所以缓存服务并没有任何不本来就在本地的东西可缓存；而定时工作只是 `web` 内部的 worker 循环（`WORKER_ENABLED`，§10）。

`reverse-proxy` 之所以是一个 profile 而不是默认提供，是因为 TLS 终止是关于*你的*主机的决定。如果你已经在主机上跑了 nginx 或 Caddy，就关掉这个 profile，让那个代理指向 `127.0.0.1:3000` —— §9 列出了它必须做到的事。如果你没有代理，这个 profile 就是完整答案：`docker compose --profile proxy up -d` 会为 `DOMAIN` 申请证书并自动续期，不需要再惦记一个 certbot 定时器。

数据库端口默认**不会**发布到主机上。如果你想在主机上用 `psql`，请取消 `docker-compose.yml` 里 `ports:` 块的注释；让它保持关闭，则意味着 Postgres 只能从 compose 网络访问。

---

## 2. 镜像

`Dockerfile` 有四行 `FROM`：一个共享的 `base`（Node 22 Alpine，为 `sharp` 和 `@node-rs/argon2` 准备了 `libc6-compat`，并启用 Corepack，好让 pnpm 的版本来自 `package.json` 里的 `packageManager`），然后在它之上叠了三个工作阶段。

| 阶段 | 产出 | 关键特性 |
|-------|----------|----------------|
| `deps` | `node_modules` | 复制 `package.json`、`pnpm-lock.yaml` 与 `pnpm-workspace.yaml`，所以改一个源文件不会重新跑安装。`--frozen-lockfile` 会直接失败，而不是去解析出任何新东西。 |
| `build` | `.next/` | 复制源码并使用**占位**环境值构建（`DATABASE_URL`、固定的假 `SESSION_SECRET`、`CONTENT_SYNC_ON_BOOT=0`），因为 `src/env.ts` 在导入时校验配置。运行时凭据和站点来源在容器启动时提供；构建无需真实凭据。Next.js 构建不保证字节级一致。 |
| `runner` | 服务器 | `NODE_ENV=production`、`PORT=3000`、非 root 用户 `nextjs`（uid 1001），以及 standalone 产物加上 `.next/static` 加上 `public/`。 |

关于运行时阶段，有三件事是承重的。

**它只包含追踪到的运行时依赖，不含完整开发依赖树。** `next.config.ts` 设置了 `output: 'standalone'`，所以构建只会产出包含应用真正触达过的模块的服务器产物。随镜像发布的是应用及其被追踪到的依赖，包括 standalone 的 `node_modules`。（base 阶段确实启用了 Corepack，所以 `PATH` 上有一个 `pnpm` 垫片；调用它会尝试下载 pnpm，而它并没有可供安装的依赖树。）

**`public/` 和 `.next/static/` 是手工复制进去的。** 它们不属于 standalone 输出 —— 这是 `output: 'standalone'` 唯一值得知道的后果，忘了它就会得到一个没有 CSS 的站点。

**`/app/content` 和 `/app/public/uploads` 在镜像里就被创建并改好属主**，这样 §6 里的卷才能挂载到它们上面。

镜像带有一个 `HEALTHCHECK`，它用 `node -e` 而不是 `curl` 来轮询 `/api/health`，因为运行时镜像里没有 HTTP 客户端，而为了跑一个健康检查就往里塞一个客户端并不划算。

---

## 3. 迁移

迁移是 `src/lib/db/migrations/` 下的 SQL 文件，由 `pnpm db:generate` 生成，由 `src/lib/db/migrate.ts` 应用。在 Compose 里，它们在自己的服务中运行：

```yaml
migrate:
  build: { context: ., target: build }
  command: ['pnpm', 'db:migrate']
  depends_on: { postgres: { condition: service_healthy } }
  restart: 'no'
```

而 `web` 会等待 `service_completed_successfully`，所以一次部署绝不可能服务于与自己不匹配的 schema。

**为什么迁移不在运行时镜像里跑。** 迁移器是 TypeScript，跑在 `tsx` 下，而它是 devDependency；standalone 产物是从应用的入口点追踪出来的，既不包含 `tsx` 也不包含 `scripts/`。把 `src/`、`scripts/` 和 `drizzle/` 拷进 runner 阶段会*看起来*能用，然后在第一次真有人试的时候失败。`migrate` 服务改为在 `build` 阶段构建同一个提交，那里有完整的工具链和同一份 lockfile —— 所以 schema 和代码永远不会差一个版本。

该服务使用的数据库 URL 从 `POSTGRES_*` 变量拼出，不读取 `.env` 的 `DATABASE_URL`。使用 `openssl rand -hex 32` 生成 `POSTGRES_PASSWORD`，避免 URL 分隔符。迁移的 advisory lock、事务和解锁使用同一条专用 PostgreSQL 连接。

从一份 checkout 手工执行的等价命令：

```bash
pnpm db:migrate        # 应用待执行的迁移，并打印数量
```

迁移只能向前，不能回退。升级前请先做备份（§7）。

---

## 4. 环境变量

应用读取的每一个变量都在 `src/env.ts` 里声明一次，并在导入时校验。布尔值仅接受 `0`、`1`、`true`、`false`；数据库 URL 必须包含 PostgreSQL 主机与数据库名称，站点 URL 必须使用 HTTP(S) 且不带凭证。`.env.example` 用注释记录了同一组变量。

### 应用

| 变量 | 默认值 | 生产环境是否必需 | 作用 |
|----------|---------|:---:|--------------|
| `NODE_ENV` | `development` | — | 由镜像设为 `production`。决定 §5 中的姿态检查是否生效。 |
| `DATABASE_URL` | — | **是** | `postgres://` 或 `postgresql://`。在导入时校验；没有它应用不会启动。 |
| `DATABASE_POOL_MAX` | `10` | 否 | 连接池上限。 |
| `SESSION_SECRET` | — | **是** | 至少 32 个字符。`openssl rand -base64 48`。如果它等于开发环境默认值，同样会被拒绝。 |
| `SESSION_COOKIE_NAME` | `myblog_session` | 否 | 只有在多个实例共用一个主机时才需要改。 |
| `SESSION_ABSOLUTE_TTL` | `2592000`（30 天） | 否 | 秒。 |
| `SESSION_IDLE_TTL` | `604800`（7 天） | 否 | 秒。 |
| `COOKIE_SECURE` | `0` | **是（=1）** | 给 cookie 加上 `Secure`。在生产环境为 `0` 会被拒绝。 |
| `SITE_URL` | `http://localhost:3000` | **是（https）** | 规范 URL、sitemap、feed、OG 卡片，以及 CSRF 来源白名单。必须是读者会输入的那个地址。 |
| `TRUSTED_ORIGINS` | `localhost:3000` | 否 | 以逗号分隔的、额外被接受为请求来源的主机名。`SITE_URL` 的主机总是会被加上，所以只有在有别名域名时才需要它。 |
| `CONTENT_DIR` | `./content` | 否 | Markdown 树的根。镜像里是 `/app/content`。 |
| `CONTENT_MAX_FILES` | `5000` | 否 | 防止卷挂错时，启动变成一次对 `/` 的文件系统遍历。 |
| `CONTENT_SYNC_ON_BOOT` | `1` | 否 | 使已启用 worker 的首次漂移检查立即执行。设为 `0` 时等待一个间隔，不会禁用后续同步。只读内容挂载需 `WORKER_ENABLED=0`，并提前准备索引。Docker 的**构建**阶段设为 0。 |
| `SEARCH_PROVIDER` | `local` | 否 | 目前只有一个取值的枚举；这是 Meilisearch 将来接入的接缝。不在 `.env.example` 里。 |
| `UPLOAD_DIR` | `./public/uploads` | 否 | 镜像里是 `/app/public/uploads`，也就是 `./uploads` bind mount 落地的位置。 |
| `UPLOAD_URL_PREFIX` | `/uploads` | 否 | 映射到 `UPLOAD_DIR` 的公开 URL 前缀。必须以 `/` 开头。 |
| `MAX_UPLOAD_SIZE` | `20971520`（20 MiB） | 否 | 单文件上传上限。你的反向代理需要设置至少同样高的限制（§9）。 |
| `ANALYTICS_ENABLED` | `1` | 否 | 设为 `0` 会完全关闭采集（采集器停止写入）。 |
| `ANALYTICS_RAW_RETENTION_DAYS` | `30` | 否 | 原始事件在转为只保留聚合数据之前会保存多久。 |
| `GIT_INTEGRATION_ENABLED` | `0` | 否 | 允许内容自动提交的许可。设置里说的是站点是否想要提交，这里说的是进程是否可以做出提交，而这个功能需要两者同时成立 —— 见 §10。默认关闭：没有做任何改动的部署根本不会运行 `git` 进程。 |
| `WORKER_ENABLED` | `1` | 否 | 在服务器内启动 worker；见 §10。 |
| `WORKER_INTERVAL_MS` | `60000` | 否 | 后台维护扫描间隔；期间仍会轮询并领取任务。 |
| `JOB_RETENTION_DAYS` | `7` | 否 | 已完成与失败任务记录的保留天数。 |
| `TEST_DATABASE_URL` | — | 否 | 只被测试套件读取，应用从不读它。 |

### 由工具读取，而不是由应用读取

| 变量 | 使用方 | 说明 |
|----------|---------|-------|
| `ADMIN_EMAIL`、`ADMIN_NAME`、`ADMIN_PASSWORD` | 仅 `pnpm db:seed` | 应用从不持有 owner 的密码。`ADMIN_PASSWORD` 为 12–1024 个字符，并且**从不自动生成** —— 种子脚本会以非零状态退出，而不是凭空造一个出来。 |
| `POSTGRES_USER`、`POSTGRES_PASSWORD`、`POSTGRES_DB` | `docker-compose.yml` | `POSTGRES_PASSWORD` 是必填的；其余有默认值。 |
| `PORT` | compose、镜像 | `web` 服务的宿主端口，只发布在回环地址上；容器内是 `3000`。 |
| `BACKUP_KEEP` | `scripts/backup.sh` | 保留的备份份数。默认 14；`0` 关闭清理。 |
| `E2E_PORT`、`E2E_BASE_URL` | `playwright.config.ts` | 仅用于测试套件。 |
| `NEXT_TELEMETRY_DISABLED` | 在镜像中设为 `1` | Next.js 的标准开关。 |

每个变量在导入时都会校验**形状**：类型、是否必填、允许的取值，并且凡是有默认值的都有默认值。`DATABASE_URL` 和 `SESSION_SECRET` 没有默认值，因此凡是加载该模块的地方 —— 包括在 CLI 脚本里 —— 它们都是硬性要求。另外还有三个变量会在生产环境接受**姿态**检查，那就是 §5。

---

## 5. 生产环境的姿态检查

有三个设置出错时是静默失效而不是显式报错，所以只要其中任何一个不对，应用就拒绝提供服务：

```ts
// src/env.ts
export function assertProductionPosture(): void {
  if (env.NODE_ENV !== 'production') return
  // 以下情况会抛出：开发环境的 SESSION_SECRET、
  //                 COOKIE_SECURE != 1、
  //                 SITE_URL 以 http:// 开头
}
```

它从 `src/instrumentation.ts` 中被调用，Next.js 会在**每个服务器进程启动时、第一个请求之前运行一次 —— 而不会在 `next build` 期间运行**。这个区分是刻意的：`next build` 会强制 `NODE_ENV=production` 并导入每个路由来收集页面数据，所以如果在导入时就检查姿态，一次构建就只能在一台已经配置得和线上服务器一样的机器上成功。形状检查留在导入处（缺少 `DATABASE_URL` 在哪里都是 bug）；姿态检查则在取值真正要紧的地方运行。除非 `NEXT_RUNTIME === 'nodejs'`，`register()` 会提前返回，因为 edge runtime 不读其中任何一个。

| 被拒绝的情况 | 消息 | 修复 |
|---------|---------|-----|
| `SESSION_SECRET` 仍是开发环境默认值 | `SESSION_SECRET is still the development default.` | `openssl rand -base64 48` |
| `COOKIE_SECURE=0`（或未设置） | `COOKIE_SECURE must be 1 in production…` | 终止 TLS 并设为 `1` |
| `SITE_URL` 以 `http://` 开头 | `SITE_URL must use https:// in production.` | 设置为公开的 `https://` 源 |

失败是致命且响亮的：一份本应被拒绝的配置会让进程直接倒下，而不是被拿来提供服务。一个容器在 `migrate` 完成后立刻带着上述某条消息退出，正是按设计工作。

---

## 6. 卷

| 宿主路径 | 容器内路径 | 模式 | 内容 |
|-----------|----------------|------|----------|
| `./content` | `/app/content` | 读写 | Markdown —— 事实来源。 |
| `./uploads` | `/app/public/uploads` | 读写 | 上传的媒体文件。 |
| `postgres-data`（命名卷） | `/var/lib/postgresql/data` | — | 数据库。 |
| `caddy-data`、`caddy-config`（命名卷） | `/data`、`/config` | — | 证书，配合 `proxy` profile 使用。 |

两个应用卷都是 **bind mount，而不是命名卷**，这正是重点：Markdown 本来就该在宿主上编辑 —— 在编辑器里、在 git 里、通过 SSH —— 所以它必须是一个你能打开的目录，而不是 Docker 管理的一个数据块。上传目录同理：这些文件本来就该能被访问、能被复制，并被与 Markdown 相同的那份备份脚本一并取走。

宿主路径与容器路径不同。本地 `pnpm dev` 写入 `public/uploads/`；Compose 把宿主的 `uploads/` 挂载到对应容器路径。`/uploads/**` 请求被重写到沙箱化的资源路由，执行与 `/api/assets/**` 相同的文件校验和响应头策略。

值得知道的后果：

- **bind mount 保留宿主的属主。** 容器以 uid 1001（`nextjs`）运行，所以这两个目录都必须对该 uid 可写，否则后台保存和上传会以 `EACCES` 失败。在一台全新的宿主上：
  `sudo chown -R 1001:1001 content uploads`。Docker 会把*缺失的* bind mount 源目录创建为 `root`，所以应在第一次 `up` 前执行 `mkdir -p content uploads` 和 `chown`。
- **在宿主上编辑需要一次同步。** 应用会在启动时以及每次后台保存之后对齐索引。如果你在它运行时改了文件又不想重启，请运行 `pnpm content:sync`（§11）。
- **镜像里不含任何内容。** 正因如此，回滚才是一次 tag 变更而不是一次恢复 —— 同一个镜像服务于挂载进来的任何东西。

---

## 7. 备份与恢复

一致性备份需要先暂停 `web`、独立 worker 和外部内容编辑。这两个脚本无法在写入持续进行时，同时快照数据库和文件系统。

宿主机需要 Bash、GNU `tar`/`realpath`/`find`、`flock`、`zstd` 和 PostgreSQL 17 客户端。宿主的 `DATABASE_URL` 必须能连接 Compose 使用的同一个数据库；默认 Compose 网络不向宿主开放数据库。使用宿主客户端时只在回环地址发布数据库端口，或在 Compose 网络内运行客户端。宿主脚本的 `CONTENT_DIR`、`UPLOAD_DIR` 应使用宿主路径：Compose 是 `./content`、`./uploads`；本地开发的上传路径是 `./public/uploads`。

```bash
# 优先读取导出的变量，然后 .env.local，再 .env。
# 先配置宿主可连接的 DATABASE_URL。
CONTENT_DIR=./content UPLOAD_DIR=./uploads bash scripts/backup.sh
BACKUP_KEEP=30 bash scripts/backup.sh /mnt/backups
BACKUP_LABEL=pre-upgrade bash scripts/backup.sh
```

经过校验的 `backup-<UTC 日期>[-标签][-序号].tar.zst` 包含：

```
database.dump        自定义格式 pg_dump
content/             Markdown 快照，排除运行时 .locks/ 和 .tmp/
uploads/             资源快照
config/              存在时保存 .env 和 .env.local
MANIFEST             版本、原始路径、时间与脱敏后的数据库 URL
```

内容备份包含正式修改中断后保留的私有 `.recovery/` 副本。它保存旧文件完整原始字节，可能包含未发布内容；
文件权限为 0600、目录为 0700。后台错误或 worker 日志给出相对恢复路径。先暂停写入，保留当前文件与副本，
比较内容后明确选择要恢复的字节写回报告中的原文档路径，再执行 `pnpm content:sync` 与
`pnpm content:sync --check`。同步只修复索引，不会将副本变成修订。完成恢复和备份验证后才能人工删除旧副本；
后续重试与普通保留策略都不会自动删除之前失败操作的副本。

第 2 版固定使用 `content` 与 `uploads` 成员名，即使源目录使用自定义名称。缺失目录和符号链接会被拒绝。目录先复制到暂存区，再压缩归档；需预留暂存数据与最终压缩包的空间。PAX tar 保留亚秒级修改时间。归档和暂存文件使用私有权限（`umask 077`）；它包含凭证、密码哈希、Session 与修订历史，应按 `.env` 的标准保护。

发布最终文件名前会验证压缩流、tar 成员和 `pg_restore --list`。同一天备份追加可用数字序号，目标目录的备份操作通过独占锁串行化；保留策略按文件修改时间排序。`BACKUP_KEEP=0` 关闭裁剪。标签只能含字母、数字、下划线和连字符。

```bash
bash scripts/restore.sh backups/backup-<日期>.tar.zst
bash scripts/restore.sh <归档> --yes
bash scripts/restore.sh <归档> --database-only
bash scripts/restore.sh <归档> --files-only
```

恢复前验证校验和、成员名称/类型/重复项、manifest 与数据库归档。符号链接、路径穿越、设备文件、未知成员、带符号链接的目标与重叠数据目录会被拒绝。旧脚本生成的归档仍受支持，但必须满足这些检查。

文件先完整解压到私有暂存目录，然后才交换目录。原目录保留为 `*.before-<UTC 时间>`，恢复内容采用替换而非合并。环境副本进入 `config.restored/`，不会覆盖正在使用的 `.env`。数据库恢复采用 `--clean --if-exists --single-transaction --exit-on-error`；如果失败，数据库事务与已交换的文件/config 目录都会回滚。暂存目录会保留现有目标目录的属主，使 Compose 的 uid 1001 继续具备写权限；无权保留属主时会在替换文件前失败。恢复应使用必要的宿主属主权限。如果目标目录原本不存在，应在重启前设置应用属主（提供的 rootful Docker 配置可用 `sudo chown -R 1001:1001 content uploads`）。成功恢复仍保留原目录便于人工恢复。每个检出目录的恢复操作使用独占锁。

即使使用 `--yes` 也会显示数据库和文件目标；导出的 `DATABASE_URL` 与 dotenv 不同会明确提示。保持所有写入方暂停，直到恢复和校正完成：

```bash
pnpm content:sync
pnpm content:sync --check
```

之后重启应用并比较 `config.restored/` 与当前环境。恢复验证完成前，保留归档和 `*.before-*` 目录。若宿主在跨数据库/文件的恢复过程中突然停电，回滚 trap 无法执行；应在重新开放写入前使用保留的原目录和备份归档恢复一致状态。

---

## 8. 健康检查

```
GET /api/health
```

```json
{
  "status": "ok",
  "database": { "ok": true, "latencyMs": 3 },
  "contentIndex": { "ok": true, "drift": false, "scanned": 12, "indexed": 12 }
}
```

| `status` | HTTP | 含义 |
|----------|:---:|---------|
| `ok` | 200 | 数据库在应答，索引与文件一致。 |
| `degraded` | 200 | 数据库正常，但内容索引与目录树不一致。 |
| `unavailable` | 503 | 数据库没有应答。 |

只问两个问题，别的都不问。漂移**不是** 503，这是有意的：页面仍然能渲染，而解决漂移的手段是一次同步，不是一次重启 —— 返回 503 会把一个本来工作正常的容器推进一个它帮不上忙的重启循环。这个端点是公开的，因为健康检查无法持有会话，所以它被写成不透露任何运维者不会公开的东西：不转储环境变量，不给版本号，不给连接信息，不给文件系统路径，也绝不给驱动自己的错误消息（那里可能带出主机、用户或 socket —— 那些只进容器日志）。响应为 `no-store`。

```bash
curl -fsS https://blog.example.com/api/health
docker inspect --format '{{.State.Health.Status}}' myblog-web-1
```

镜像自带一个 `HEALTHCHECK`，起始等待 20 秒、间隔 30 秒、超时 5 秒、重试 3 次。如果你的主机比较慢，或者首次启动时的内容同步很大，请调高起始等待时间。

---

## 9. 反向代理与 TLS

容器在 3000 端口上提供纯 HTTP 服务，并且**必须**待在一个终止 TLS 的代理之后，因为生产环境要求 `SITE_URL` 是 `https://` 且 `COOKIE_SECURE=1`。最低可用配置：

1. 把应用绑定到回环地址，让它无法被直接访问：
   `ports: ['127.0.0.1:3000:3000']`。
2. 转发标准请求头 —— `Host`、`X-Forwarded-Proto`、`X-Forwarded-For`。
3. 把 `client_max_body_size`（nginx）或等价设置调到至少和 `MAX_UPLOAD_SIZE` 一样大（默认 20 MiB）。代理默认的 1 MiB 会让每一次图片上传都得到 413，而且应用日志里没有一行能解释它。
4. 不要设置应用自己会设置的头。CSP、`X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy` 和 `Permissions-Policy` 都来自 `next.config.ts`；代理里同时设置它们的规则会静默覆盖应用的值，尤其是 `/api/assets`，它对上传的 SVG 有一个更窄的 CSP，绝不能被替换掉。
5. 由代理发送 HSTS —— 应用不发。

边缘代理必须用实际连接地址覆盖客户端提供的 `X-Forwarded-For`，不能追加不可信的链。登录限流使用代理传来的首个 IP（哈希后作为限流键，Analytics 不读取它）；多层代理需要明确配置可信代理与来源覆盖策略。

```nginx
server {
  listen 443 ssl;
  server_name blog.example.com;

  ssl_certificate     /etc/letsencrypt/live/blog.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/blog.example.com/privkey.pem;
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

  client_max_body_size 25m;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Caddy 用更少的行做到同样的事，并且自动获得证书：

```
blog.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

然后设置 `SITE_URL=https://blog.example.com`、`COOKIE_SECURE=1` 并重启。

站点自身的来源检查会把浏览器的 `Origin` 与 `SITE_URL` 里的主机加上 `TRUSTED_ORIGINS` 做比较，所以**`SITE_URL` 必须是读者实际使用的主机名**。如果站点能在不止一个主机名下访问（apex 和 `www`，或者一个 staging 别名），请把多出来的写进 `TRUSTED_ORIGINS` —— 否则登录和后台保存会因跨域而被拒绝。

---

## 10. 运维

### worker

`src/instrumentation.ts` 在 `WORKER_ENABLED=1` 时自动启动内嵌 worker，Compose 的 standalone 服务器同样如此。任务涵盖定时发布、内容同步/漂移检查、搜索索引、统计聚合/保留、资源引用检查与过期认证记录。数据库启动失败会按退避策略重试，日志每行一个 JSON。

`pnpm worker` 在独立进程中运行同一循环，不受 `WORKER_ENABLED` 控制。它需要仓库的 TypeScript 工具链，应在 `build` 阶段镜像或宿主检出目录运行，而不是 `runner` 镜像。CLI 收到第一次 `SIGINT`/`SIGTERM` 会完成当前任务后退出；第二次信号会强制退出。

领取任务使用 `FOR UPDATE SKIP LOCKED` 与 15 分钟租约。服务器突然重启后，原领取可能保留到租约过期；handler 从源文件校正状态，定时发布在文件锁内重新检查排期，因此重复执行是安全的。失败和未完成的同步/发布任务会记录失败并重试。到期内容在后台记账完成前，读路径也会允许公开。

只有同一数据库/内容树已由其他 worker 维护时才设置 `WORKER_ENABLED=0`。`CONTENT_SYNC_ON_BOOT=0` 关闭启动校正检查，不关闭 worker 后续周期。

### 不经过后台到达的内容

一次 `git pull`、一次 SSH 编辑，或者把一个文件丢进 `content/`，都是受支持的发布方式。应用会在启动时对齐，所以重启总是足够的。不想重启的话：

```bash
pnpm content:sync        # 完整对齐，输出详细
pnpm content:sync --check # 索引是否与文件不同步？不写任何东西
```

### 把内容目录提交到 git

另一个方向：`src/lib/git/` 可以提交后台写下的内容，让 Markdown 树积累出自己的历史。两个开关必须同时点头 —— 设置 → Git（**Git integration** 加 **Commit content changes automatically**）以及应用环境里的 `GIT_INTEGRATION_ENABLED=1`。把设置打开而把标志留在 `0`，编辑器会在每次保存之后告诉你这件事，这是刻意的：一个悄悄什么都不做的开关，比一个会解释自己的开关更糟。两者默认都关闭。

打开它需要三样出厂镜像没有提供的东西：

- **镜像里有 `git`。** `runner` 阶段只装了 `libc6-compat`，别的什么都没有。把 `git` 加到 `base` 阶段的 `apk add` 那一行，或者在容器外运行应用。没有它，每次保存都会报告“git is not installed on the server”，而文件照样会被写下去。
- **一个进程可以写的仓库。** 要么就是站点仓库本身 —— `/app/content` 就在它里面 —— 要么是在卷里新建一个：在 `/app/content` 里 `git init`。bind mount 或卷必须允许 uid 1001 写 `.git/`。
- **一个身份。** `git config user.name` 和 `user.email`，全局的或在那个仓库里的。没有它，提交会被拒绝并报告为 `no-identity`，而不是让一次保存失败。

运维层面：

- 每次保存、每次删除、每次修订恢复各产生一个提交；一次批量或 tag 操作则无论涉及多少文档，都只产生一个。
- 提交消息来自设置里的模板 —— 默认是 `content: update "Linux Network Debugging"`。
- 只有该操作改动过的文件会被 stage。你自己已经 stage 好的东西不会被碰。
- **它从不 push。** `src/lib/git/index.ts` 里的子命令白名单中没有任何远端相关命令；部署仍然是在你存放 origin 的地方执行 `git push`。
- 一次失败的提交会被记录，并在编辑器里显示出来。它从不让保存失败：文件是先写下的。

单元测试和集成测试套件在 `GIT_INTEGRATION_ENABLED=0` 下运行，所以那里不会触达任何仓库。E2E 套件则在它打开的情况下运行，针对的是一个由 `global-setup.ts` 在一次性内容树里创建、并且留下时里面没有任何提交的仓库：`tests/e2e/git.spec.ts` 打开自动提交、保存、检查仓库以及编辑器对它的报告，然后再次关掉这些设置 —— 包括它失败的时候。那次运行中的其他每个 spec 都让设置保持关闭并且不做任何提交，而这正是该套件的仓库要检验的东西。

### 升级

```bash
pnpm backup                       # 总是要做；迁移只能向前
git pull
docker compose build
docker compose up -d              # migrate 先运行，然后才是 web
```

`docker compose up -d` 只会重建发生了变化的部分，而 `web` 会等 `migrate` 成功退出。内容树是一个卷，部署不会碰它，所以一次回滚就是：checkout 上一个提交，`docker compose build`，`docker compose up -d`。无论如何都先做备份 —— 一个 drop 掉列的迁移不会被更旧的镜像撤销。

### 扩容之前值得知道的限制

- 设计目标是一个应用实例。搜索索引保存在进程内；第二个实例有独立缓存，管理员保存只会失效当前进程的缓存。
- Analytics 不读取 IP 或地理定位。页面 beacon 和每日聚合已连通；country 目前为空，关闭采集后不写入新跟踪事件。
- 数据库重定向由 Node proxy 执行，只处理允许路径上的 GET/HEAD；保留路由、无效目标与循环规则会被拒绝。
- Git 自动提交只在单进程内串行化。多实例可能竞争 Git index 锁；失败会报告，但不会损坏 Markdown，也不会 push。
- 备份/恢复需要维护窗口。暂停服务器、worker 和外部编辑，恢复并校正索引后再启动。
- 当前后台按登录状态授权，没有编辑协作审批或角色级权限。账号通过种子 CLI 创建。

---

## 11. 故障排查

**容器立刻退出，日志里点名了某个姿态检查。** 这是按设计工作 —— 见 §5。开发用的 `SESSION_SECRET`、没有设为 `1` 的 `COOKIE_SECURE`，或者 `http://` 的 `SITE_URL`，在生产环境都是致命的。

**`Invalid environment configuration: - DATABASE_URL: …`** 在启动时出现，来自任何进程，包括 `pnpm db:migrate`。该变量缺失，或者不是一个 `postgres://` 字符串。注意：在 `tsx` 下运行的脚本会先加载 `.env.local`，再加载 `.env`，顺序如此，而且不会展开 `${VAR}`。

**`/api/health` 报告 `unavailable`（503）。** 数据库没有应答。检查 `docker compose ps` —— 如果 `postgres` 不健康，`web` 根本不会启动。`docker compose logs postgres`。健康端点故意不告诉你*为什么*；原因在应用的那行日志里（`[health] database check failed`）。

**`/api/health` 报告 `degraded`。** 索引和文件不一致 —— 通常发生在一次恢复、一次没有重启的 `git pull`，或者一个在宿主上被编辑过的 bind mount 之后。运行 `pnpm content:sync`。它不是错误状态，这是有意的（§8）。

**站点能加载，但每个页面都是空的，或者后台什么都列不出来。** 几乎总是 `CONTENT_DIR` 指向了空目录，或者 `content/` 没有挂载。`docker compose exec web ls /app/content`。然后运行 `pnpm content:sync`。

**登录看起来成功了，却立刻回到登录页。** `Secure` cookie 被拒绝或丢弃了：站点正通过纯 HTTP 提供服务，或者浏览器看到的主机与 `SITE_URL` 指定的不同。终止 TLS 并设置 `COOKIE_SECURE=1`（§9）。不要在生产环境用 `COOKIE_SECURE=0` 来“修复”它 —— 它会在启动时被拒绝，而绕过它意味着会话 cookie 以明文传输。

**后台保存或上传失败，报 `EACCES` / 一个权限错误。** bind mount 进来的目录对 uid 1001 不可写。`sudo chown -R 1001:1001 content uploads`。

**上传失败并返回 413，应用日志里什么都没有。** 反向代理的请求体限制。把 `client_max_body_size` 调到至少 `MAX_UPLOAD_SIZE`（§9）。

**`migrate` 以非零状态退出，`web` 永远不启动。** 迁移失败了；数据库 URL 是从 `docker-compose.yml` 里的 `POSTGRES_*` 拼出来的，错误在 `docker compose logs migrate` 里。常见原因：角色缺少 `CREATE`/`ALTER`，或者某个迁移在被应用之后被手工改过。

**保存的重定向不生效。** 检查规则是否启用、源路径是否允许公开。Node proxy 在路由前解析规则；保留路由、非 GET/HEAD 方法和无效/循环目标会被排除。

**分析显示为零或停止增长。** 环境 `ANALYTICS_ENABLED=1` 和站点设置都需开启。检查 `worker.start`、`job.analytics-aggregate` 日志以及 `/admin/system` 里的失败任务，并等待聚合周期。来源被拒绝或隐私 opt-out 的请求会被丢弃。

**保存之后搜索返回过期的结果。** 索引在进程内，并且每次后台保存都会被 `revalidateContentChange` 置为失效，所以这不应该持续存在。如果确实如此，你很可能跑了不止一个实例（§10）。

**在很大的目录树上启动很慢。** 启动时的同步是轻量的（mtime 和大小，不做哈希），但它仍然要遍历 `CONTENT_DIR`。设置 `CONTENT_SYNC_ON_BOOT=0` 并显式对齐，或者调高健康检查的起始等待时间。
