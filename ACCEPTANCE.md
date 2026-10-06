# Inkbranch 验收报告 — 2026-10-04

## 1. Acceptance Summary

本轮依据 goal-objective.md 执行基线检查、问题复现、修复、故障注入和实际浏览器/容器/数据库回归。Markdown 继续作为内容事实来源；没有把正文迁入 PostgreSQL，没有替换产品架构。所有写入、账号、数据库、容器、备份与恢复演练使用独立临时数据。没有修改真实 Markdown 或真实 `.env/.env.local`，没有使用生产凭证或部署到生产，也没有向当前项目仓库提交或推送 Git。Git 回归只在临时测试仓库中创建提交；`.env.example` 按实际配置更新。

| 验收范围 | 状态 | 实际证明 |
| --- | --- | --- |
| Markdown / posts、notes、projects / 外部编辑 | PASS | 文件创建、Admin 保存、外部修改、重命名/slug 交换、删除及索引重建的真实文件和 PG 集成测试 |
| 原子写入 / checksum / Revision | PASS | 写盘前 ENOSPC/rename/序列化/陈旧 checksum 拒绝保持原文件；写盘后 DB/Revision 故障如实返回 committed receipt 并保留私有旧字节；恢复 A 后前台、文件 SHA 与索引一致 |
| Auth / Session / CSRF / Rate Limit | PASS | Argon2id、匿名拒绝、失败登录、注销、会话失效、密码轮换竞态、真实限流、TLS cookie 标志 |
| Admin / Editor / 状态和批量操作 | PASS | 后台 107 条审查记录无违规或浏览器异常；Posts/Notes/Projects 各 2 个真实临时文档、17 组业务断言及设置恢复通过，磁盘 checksum/索引/状态一致 |
| Renderer / 代码块 / 媒体 | PASS | 富语法测试文章在桌面和移动浏览器实际加载；SSR、KaTeX、Mermaid 成功及失败降级、复制和 Tabs 键盘交互 |
| Search / Tags / Graph / Related / Backlinks | PASS | 中英混合及部分匹配、正文/标题/tag/category、陈旧索引和删除；分类权重、双向引用、未来内容不可见 |
| Import / 六个内容 CLI | PASS | 现有 13 个 Markdown 实际导入；文件、目录、ZIP、中文/空格/Unicode/嵌套/错误 YAML；默认 dry run 保持来源文件 SHA |
| SEO / RSS / Sitemap / Robots / Redirect | PASS | XML 解析、分 tag/category feed、canonical/OG/Twitter/JSON-LD、构建与运行 origin 不同、真实 301 和循环拒绝 |
| Analytics | PASS | 浏览/文章/来源域/设备、日聚合/保留、关闭后不写原始事件；schema 不保存 IP；Country 为可选空值 |
| Schema / 空库引导 / Scheduled worker | PASS | 空库 migration/bootstrap；跨时区重启补发错过任务、重复发布及过期 lease 重领保持字节与历史 |
| Responsive / Dark / Accessibility | PASS | 最后应用源码：公开 42 条、后台 107 条审查记录，axe 0 violations / pageerror 0；人工检查移动编辑器、平板 drawer、阅读与 graph |
| Docker / TLS / 健康检查 / 持久化 | PASS（兼容引擎） | 最后镜像实际 build/up/HTTPS CMS、资源删除、持久化重建、7 个配置拒绝、DB 故障 unhealthy→healthy 全通过；原生 Docker 环境限制见第 8 节 |
| Backup / Restore | PASS | PG17.11 真 dump/restore；DB 整行、Markdown/媒体 SHA、亚秒 mtime/config 恢复一致；DB 恢复失败后文件与配置回滚 |
| lint / TypeScript / Unit / Integration / Build / E2E | PASS | 最后修复后重新完成全部检查；E2E 84/84、真实 PG integration 1,534/1,534；详情见第 5 节 |
| Performance | PASS 实际节流 / PARTIAL 默认模拟 | 实际 DevTools slow-4G + 4×CPU：Home/Article/Notes/Projects 为 99/98/99/99，其他三项全部 100；默认模拟 Home=95 未满足 >95 |

## 2. Problems Found

| 级别 | 已复现问题及根因 |
| --- | --- |
| P1 | Markdown 原子替换已成功，但后续 DB/Revision 失败返回“没有任何修改”，且旧正文只在内存中，可能丢失历史。 |
| P1 | 有界扫描被当成完整扫描，可能删除未扫描文件的索引并级联丢失历史；同步错误还可能让 CLI/worker 报成功。 |
| P1 | 同 slug 的外部文件重命名重建索引 ID；slug 转移/交换按逐文件顺序更新会错误冲突或留下半完成状态。 |
| P1 | 文件锁仅凭年龄判断可被活跃进程抢占；容器重启/PID 复用留下的锁又可能永远不可回收。 |
| P1 | 资源删除只信陈旧 DB 引用；未同步正文、cover/OG、媒体指令/raw HTML/变体或 URL 别名可能遗漏正在使用的媒体。 |
| P1 | 资源路径未逐段拒绝 symlink；默认 /uploads 静态服务可绕过安全资产响应路径。 |
| P1 | 密码轮换与登录/rehash 竞态可给旧凭证签发新版本会话；密码变更需要条件更新。 |
| P1 | 备份权限、配置解析/路径、保留顺序与恢复阶段缺乏一致保障；数据库恢复失败时文件替换不能可靠回滚。 |
| P1 | 定时发布失败/不完整同步被 worker 当作成功，可能失去重试机会。 |
| P2 | 搜索失效判定只看最大 mtime，其他文件修改会被更晚时间的文件掩盖；未来 scheduled 内容的可见判断用了旧发布日期。 |
| P2 | Admin 保存响应返回期间继续输入，UI 会错误清除 dirty 并刷新；autosave/preview 取消响应和异常处理不完整。 |
| P2 | Preview 没有代码交互增强；Tabs active 属性值与 CSS 不匹配；重复 Tabs ID；Mermaid 加载/语法错误降级不完整。 |
| P2 | 全 token 词高亮被误判为无需处理；未知语言代码的复制内容丢失换行。 |
| P2 | 资产详情页删除成功后只刷新当前已删除 ID 的路由，显示 not-found 页而没有返回资产库。 |
| P2 | 资产目录初始化缓存失效后，清理目录导致后续上传缺少 .tmp；初始化失败也不能重试。 |
| P2 | 已存在链接用 singular 类型 key，与渲染器 plural 路由 key 不一致，Editor 误报断链。 |
| P2 | Redirect 未校验整组规则成环；登录 next 路径与内容 URL 接受不安全路径/编码；dotted 旧路径漏掉代理匹配。 |
| P2 | 拒绝限流请求不断累积负债；关闭 analytics 的服务端设置及流式 body 上限执行不足。 |
| P2 | 根布局构建时访问 DB 导致生产 build 失败；robots 缓存构建 origin；字体预加载硬编码旧哈希。 |
| P2 | Docker 未复制 workspace build 权限配置、构建 context 带入错误测试配置、迁移层缺运行工具链、环境转发不全。 |
| P2 | 错误生产配置被 Next instrumentation 捕获后进程仍监听但不能服务，需要明确退出。 |
| P2 | 移动 Graph 页面横向溢出、标签对比度不足；主题 radio 缺键盘操作。 |
| P2 | Admin 成功 badge 对比度 4.44:1；统计区 dl 结构错误；上传/CSV file input 缺标签；多个 modal/导航取消后不恢复触发按钮焦点；移动统计表、Assets/Tags 表的绝对定位 sr-only 内容造成页面溢出；System 审计表缺键盘滚动入口。 |
| P2 | 所有页面急切加载仅 Admin 和搜索命令需要的通知组件，字体晚到产生额外阅读等待。 |
| 测试缺陷 | 某些 DB suite 依赖其他 suite 建表；测试数据库未充分隔离；搜索 burst 测试错误假设总耗时小于一个补充令牌周期。 |

没有通过删除测试、降低校验、忽略业务错误或添加无意义 ignore 来修复这些问题。必要的清理错误保持安全副本或记录日志，主要失败仍传播。

## 3. Fixes Applied

- 同步区分完整/截断扫描；目标同步直接安全读取指定文件；保留 ID/history；slug 转移和交换使用数据库事务，故障中途整体回滚。解析失败不清空既有链接。
- 正式覆盖/删除前把旧 Markdown 精确字节原子持久化到私有 `.recovery`（目录 0700、文件 0600）。前置备份失败拒绝修改；后续索引/历史失败返回已提交路径、checksum、恢复位置，保留编辑器 buffer/dirty，重试仍受 checksum 保护。正常完成后清理本次恢复副本；后续成功重试不会清理较早失败的副本，sync 也不会补造丢失的 Revision。恢复、导入、定时发布、tag 和 bulk callers 同步处理。该目录不参与公开内容扫描、导入或资产服务，备份包含它。
- Markdown 写入使用临时文件、fsync、原子 rename、文档锁及索引锁；校验当前文件 checksum，bulk action 基于新鲜正文。锁同时检查 Linux boot ID 和进程启动身份；失败初始化可以重试。Restore 在写盘前拒绝已被其他文件占用的 slug。
- Import 保留原文件名/实际序列化 checksum，支持 .markdown，恢复先验证内容；六个 CLI 对不完整/无效扫描给非零退出状态。
- 共享媒体引用提取，覆盖图片、指令、raw HTML src/srcset/poster、编码路径、配置和兼容别名；转义为文字的 HTML 示例不再误计引用。删除前在锁内重读文件，校验不完整时拒绝删除。
- 所有资产路径逐段检查 symlink；/uploads 重写到沙箱资产 API；临时和缺失文件不能被缓存公开。每次写入安全重建上传 staging 目录。
- 会话绑定实际验证的 credential version，密码更新使用 compare-and-swap；统一安全 next/URL；整组 Redirect 检查循环；修正限流与 analytics 服务端开关、流式长度验证。
- 编辑器保留保存期间的新输入及 dirty 状态，不无故丢 undo；正式保存和 Draft revision 分开。Preview 实际增强代码/Tabs/Mermaid；错误显示可读源码；修正高亮和复制换行。
- 未来 scheduled 文档在 search/graph/related/backlinks 隐藏；Related 使用 tag/category/link/keyword/series 的真实信号并给正确说明。
- 构建延迟读取运行期 DB；robots 动态输出；字体提示从当前 CSS 解析并校验文件。采用 optional 字体显示、regular mono 字重；通知组件仅在 Admin 或延迟加载的搜索命令中挂载。
- Graph CSS、theme radio 键盘、Admin 对比度/语义/上传标签/DialogTrigger 焦点恢复已修复，保持原产品布局。资产详情页删除成功后返回资源库，避免停留在已删除资源的 not-found 页面；列表内删除保持原列表上下文。
- Docker、env、migration 连接、worker 重试、备份/恢复和英文/中文部署文档按实测修复；生产配置失败时 exit 1。

## 4. Tests Added / Updated

新增回归覆盖数据库隔离、env/instrumentation、固定迁移连接、备份恢复、任务失败、路径/URL/CSRF、资产删除和目录恢复、搜索一致性、内容操作和 CLI 完整性。扩展现有 writer/import/links/graph/redirect/session/analytics/renderer 测试。

浏览器新增：保存期间输入、Draft 不写文件、A→B→restore A→再次编辑并核对 checksum、Preview 代码/Tabs、Mermaid 加载失败、原生粘贴和 drag/drop 图片、完整 renderer、资产别名、robots 运行 origin、主题键盘/持久化。既有 authoring 增加删除 modal focus trap、Cancel/Escape 返回焦点并保留文档；资产上传验证可访问标签；详情页实际确认删除后返回库，并验证原图/缩略图 404。

本次完整 E2E 的第一轮为 82 pass / 2 fail；新增 Redirect 焦点测试的 Close locator 同时选中角标与底部按钮。修复为唯一的 dialog-footer 内语义按钮后，桌面/移动定向 2/2 通过，并重新执行完整 E2E，未删断言或降低焦点要求。

真实故障演练另覆盖：空 DB、重复/并发同步、slug 交换中途事务失败、外部修改、上传 rename EIO、数据库故障 health 503、坏配置退出、容器重建、真实备份恢复及数据库恢复失败回滚。定时 worker 停机错过期限、跨时区重启、重复发布和 lease 回收均实际执行。

## 5. Validation Results

基线（改动前）：install frozen 成功；lint/typecheck 通过；unit 35 files / 1185 pass / 106 DB-only skip；integration 44 files / 1359 pass；build 因 /admin 构建期 DB 连接失败；初始 E2E 66 pass。后续失败均先定位根因再修复；中断运行不计通过。

2026-10-04 最后源码冻结后从专用空测试库执行，结果如下。最后资产详情页修复之后重新跑了整套，早先分别通过的结果没有替代最终回归。

| 命令 / 实际检查 | 最终结果 | 记录 |
| --- | --- | --- |
| `pnpm lint` | PASS，exit 0 | [inkbranch-complete-lint.log](</tmp/inkbranch-complete-lint.log>) |
| `pnpm typecheck` | PASS，exit 0 | [inkbranch-complete-types.log](</tmp/inkbranch-complete-types.log>) |
| `pnpm test` | PASS，47 files / 1,294 passed / 111 DB-only skipped | [inkbranch-complete-unit.log](</tmp/inkbranch-complete-unit.log>) |
| `pnpm test:integration` | PASS，61 files / 1,534 passed / 0 skipped，真实 PG17.11 | [inkbranch-complete-integration.log](</tmp/inkbranch-complete-integration.log>) |
| `pnpm build` | PASS，exit 0；使用不可连接 DB 验证构建不依赖数据库；当前字体文件校验通过 | [inkbranch-complete-build.log](</tmp/inkbranch-complete-build.log>) |
| `pnpm test:e2e` | PASS，84/84，桌面 42 + 移动 42，2.0 分钟 | [inkbranch-complete-e2e.log](</tmp/inkbranch-complete-e2e.log>) |
| 资产定向 E2E | PASS，4/4：上传/解码、取消焦点、详情删除回库、原图/缩略图 404、别名 jail | [inkbranch-complete-assets-targeted.log](</tmp/inkbranch-complete-assets-targeted.log>) |
| 内容 CLI：sync / validate / reindex / import / links / stats | PASS，六条 exit 0；干净临时内容目录 14 文件 | `reports/complete-content-*.log` |
| 公开页面 / 后台无障碍与交互 | PASS，42 / 107 条记录，0 axe violations、0 pageerror、无页面横向溢出 | `ui-audit.json` / `admin-audit.json` |
| Admin 真实生命周期 / 资产交互 | PASS，17 组业务断言 + 1 条空异常汇总 / 5 组资产断言；单独 native touch 3/3 | `admin-lifecycle.json` / `admin-assets-interaction.json` / `mobile-touch.json` |
| Schema | PASS，16 个业务表的 194 列 / 52 索引 / 29 约束与 Drizzle 一致；含迁移元数据表的 public 共 17 表 / 197 列 / 53 索引 / 30 约束 | [schema.json](</tmp/inkbranch-assets-final/reports/schema.json>) |
| 实际定时 worker | PASS，未来时间、停机错过期限、跨时区重启、重复执行、lease 回收；index checksum 一致 | [schedule.json](</tmp/inkbranch-schedule-final/reports/schedule.json>) |
| 真实五种资产格式和上传 EIO | PASS，PNG/JPEG/WebP/AVIF 解码、SVG 净化、碰撞/去重；原字节和索引未损坏 | [assets.json](</tmp/inkbranch-assets-final/reports/assets.json>) |
| XML / dynamic OG | PASS，RSS global/tag/category 和 Sitemap 实际 XML parser；中文 OG PNG 1200×630，最新 TLS 镜像内 CJK 实际可见 | `complete-xml.json` / `og-chinese-final.png` |
| Docker / TLS / persistent volumes | PASS，最后镜像；正常 CMS/资源删除、重建保留会话和数据、7 配置 exit1、DB health 故障与恢复 | [final-deployment-result.json](</tmp/inkbranch-deployment-final-evidence/final-deployment-result.json>) |
| Backup / Restore | PASS，真实 PG dump/restore + 文件/媒体/config SHA/mtime；新恢复副本 237 字节和 0700/0600 完全还原；故障回滚 / drift=false | [result.json](</tmp/inkbranch-deployment-final-evidence/backup-recovery/result.json>) |

表中未写绝对前缀的浏览器/CLI 证据均在 `/tmp/inkbranch-final-acceptance/reports/`。该目录和容器报告属于临时验收证据；可复现回归测试已保留在项目 `tests/` 中。Unit 与 integration 的纯逻辑部分重叠，不能把两个测试数量相加作为独立覆盖总数。无 DB 的 unit 有意跳过 DB sections；完整 integration 必须零跳过。

实际内容 CLI 最后检查：14 个文件，0 invalid、0 errors、0 broken links，9 个可选描述/日期 warnings、1 个允许派生标题 note；全部索引一致，health status=ok / scanned=14 / indexed=14 / drift=false。Import 默认 dry run 的 1 个覆盖候选、2 个错误候选准确报告且无写入。原仓库 13 文件先在独立空内容目录实际导入，来源未修改。


最后部署镜像为 `9eb3d93f584f11981733fe71a654b1af3e08eea0a146b7696e02d46ac204fcef`（Docker v2 格式，实际 HEALTHCHECK 保留并运行）。构建副本 320 个应用/配置/文档文件逐项 SHA 一致，本轮修改的 146 个文件亦逐项匹配；验证用 Compose 仅有 3 个回环端口差异，context 额外排除了私有测试演练文件。源码 canonical map SHA256：`8553bfed86088e09b17888f9ec85cbbdec9ce269baf1dfb677f72b8f5519bf30`。容器 UID1001，旧宿主临时 Markdown 未改变，重建后 DB 行计数、会话、正文/原图/缩略图 SHA 完全保留。停止专用 Compose PostgreSQL 后健康 API 503、连续探测非零、状态 unhealthy；重启恢复 API200/healthy，未影响 55432 的独立回归数据库。

验收结束后已停止专用 Web/Caddy/PostgreSQL 服务；容器、测试 volumes、内容快照、备份和日志保留供复核。没有停止其他项目的服务。

可复现环境：pnpm12.3.4、host Node26.10 / image Node22、Next16.3.4、PG17.11、Playwright1.63/Chromium153。DB 用例必须提供独立 `TEST_DATABASE_URL`；E2E 使用第三个派生数据库及临时 content/uploads，配置会拒绝与应用数据库或 integration 数据库共用。生产构建验证使用不可连接的占位 DSN，不需要连接生产库。

## 6. Performance / Accessibility Results

测量环境：Lighthouse 13.5、Chrome 153、mobile、全新浏览器存储、生产构建、loopback、PostgreSQL 17.11。四个代表页面为 Home、Article(/posts/atomic-writes)、Notes、Projects。保持四项严格 >95 目标；默认模拟节流结果与实际 DevTools slow-4G/4×CPU 结果分别报告，不删除低分样本或称 95 为大于 95。

默认模拟从快连接 trace 推演慢连接；optional 字体在真实慢连接可能采用不同加载路径。该差别是测量推断，不能单凭差别宣称达标。方法说明：[Lighthouse 官方节流文档](https://github.com/GoogleChrome/lighthouse/blob/main/docs/throttling.md)。最终分数和 CLS/TBT 如下。

| 模式 | 页面 | Performance | Accessibility | Best Practices | SEO | LCP ms | TBT ms | CLS |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 默认 simulate | Home | 95 | 100 | 100 | 100 | 2949 | 19.5 | 0.000 |
| 默认 simulate | Article | 96 | 100 | 100 | 100 | 2712 | 18.5 | 0.000 |
| 默认 simulate | Notes | 99 | 100 | 100 | 100 | 2258 | 17.0 | 0.000 |
| 默认 simulate | Projects | 96 | 100 | 100 | 100 | 2795 | 18.0 | 0.000 |
| 实际 DevTools | Home | 99 | 100 | 100 | 100 | 1755 | 33.7 | 0.000 |
| 实际 DevTools | Article | 98 | 100 | 100 | 100 | 1967 | 51.9 | 0.000 |
| 实际 DevTools | Notes | 99 | 100 | 100 | 100 | 1594 | 54.1 | 0.000 |
| 实际 DevTools | Projects | 99 | 100 | 100 | 100 | 1738 | 36.4 | 0.000 |

所有结果均来自最后同一生产构建，浏览器存储重新开始，本轮 build/tests 已停止，无缓存页面替代真实请求。共同 mobile 412×823、DPR1.75、Slow-4G profile（模拟 RTT150ms/1638.4Kbps，实际 DevTools 参数 requestLatency562.5ms/down1474.56Kbps/up675Kbps）、CPU4×。完整 JSON/HTML 与历史低分均保留；最终 8 份结果摘要为 [lighthouse-complete-summary.json](</tmp/inkbranch-final-acceptance/reports/lighthouse-complete-summary.json>)。

实际节流四页的四项评分均 >95；默认模拟 Home=95，明确未达严格目标。字体采用 optional 后，模拟从快连接 trace 外推可能与真实慢连接的 fallback 路径不同，这是根据测量和官方方法说明作出的推断，不能证明默认低分无效，也不能保证真实生产分数。默认 Home 的余量和生产真实环境性能仍按已知限制记录，未降低门槛、反复挑高分或删除失败样本。本文没有把这组本地主机测量冒充生产 RUM。

普通页实际 JS transfer 为 191,744 bytes，Article 为 196,163 bytes；Editor/Graph 未进入普通页主 bundle，Shiki 在服务端。延迟通知组件和 mono 字体 regular 字重降低了传输量，optional 字体避免晚到时替换文字。性能优化仅保留有可验证收益的局部变更。

最终公开页面在 1440、768、393 三视口审查 13 个路由，共 39 路由样本和 3 组主题/导航/搜索交互（42 条）；Admin 为 93 个页面/主题/视口样本、11 组键盘交互、3 条空运行异常汇总（107 条）：axe WCAG 2A/AA/2.1AA 无 violations，无 pageerror。实际键盘验证 skip link、TOC、移动 drawer、scroll spy、reduced motion、搜索和主题；截图人工检查阅读布局、移动信息架构、后台资产网格/详情及内部表格/代码水平滚动。另用 Playwright Pixel 7 设备仿真与浏览器 touch 事件验证移动导航、TOC 跳转及面向触摸的完整搜索页面；未使用实体手机。自动检查不能代替完整辅助技术用户测试。

## 7. Security Findings

本轮已处理资产 jail/静态绕过/引用遗漏、密码和 session 竞态、不安全 URL/Redirect、限流和 analytics 验证缺陷。所有实际恢复/上传/删除故障使用临时文件，不接触生产数据。在文档规定的单实例、可信本地文件系统与维护窗口运行范围内，最终故障测试和完整回归未发现尚未处理的 P0/P1 或高危安全问题。

覆盖：参数化 DB 查询、明确 Zod action/API 校验、权限和 CSRF 守卫、Argon2id、HttpOnly/Secure/SameSite、会话注销/过期/轮换、无注册入口、Markdown/SVG XSS、iframe allowlist、路径 normalize/resolve/root 验证、编码及双编码 traversal、symlink、超限/伪装 MIME、非安全跳转。TLS 实际浏览器检查与沙箱 CSP/nosniff 相互验证。Analytics 仅存经归一化来源域/设备等，IP 不入库；关闭后拒绝继续写 tracking events。

## 8. Remaining Risks

只列需要目标环境、人工操作或产品取舍的边界；这些限制没有被判为 PASS：

- 默认模拟 Lighthouse Home=95，严格 >95 未通过；实际节流该页=99，四页均达标。默认模拟 Home 的严格目标尚未达到，后续目标环境测量再决定字体与首页的取舍；本轮没有使用生产环境来验证目标主机/公网性能和字体 fallback 行为。

- 生产域名/DNS/公网 ACME、真实 secret/账号、正式服务器升级未操作；本轮 HTTPS 使用临时回环端口和本地 CA。生产部署需由操作者配置其真实环境。
- 设计采用单个 Web 实例与可信本地文件系统。多实例、跨主机共享存储和主动敌对文件系统不属于当前运行合同，需要独立架构决策；外部 Git/editor 写入应避免与正在提交的管理写入同时替换同一文件。
- 多存储备份/恢复须停应用、worker 和外部编辑，使用维护窗口。普通失败可回滚；OS/机器硬中断需使用保留的旧树/备份人工恢复，不能把文件系统和 PostgreSQL 宣称为一个原子事务。
- 当前主机没有原生 Docker daemon，使用 Podman 兼容 CLI/Compose provider。Docker 格式保留并实际执行 HEALTHCHECK；provider 的 restart web 在已完成的 migrate 依赖上有缺陷，已用保留 volumes 的 down/up 验证重建。原生 Docker 的该特定 restart 子命令仍需在目标主机检查。

## 9. Files Changed

主要修改范围：Markdown/同步/导入/Revision、Auth/安全/资产/Redirect/Analytics、Editor/Renderer/Graph/Related/主题及后台无障碍、Next/font/robots、Docker/env/migration/jobs/backup、测试配置与业务回归、README/ARCHITECTURE/DEPLOYMENT 英文和中文。

完整清单为本轮 146 个应用/配置/测试/文档文件，加上本报告，共 147 个。无数据库 schema/migration 文件改动，无新增应用依赖，无真实 content 或 `.env/.env.local` 改动。最终回归后逐项 SHA 校验未发现冻结源码变化。

- [.dockerignore](</home/crackrammer/Projects/Inkbranch/.dockerignore>)
- [.env.example](</home/crackrammer/Projects/Inkbranch/.env.example>)
- [.gitignore](</home/crackrammer/Projects/Inkbranch/.gitignore>)
- [ACCEPTANCE.md](</home/crackrammer/Projects/Inkbranch/ACCEPTANCE.md>)
- [ARCHITECTURE.md](</home/crackrammer/Projects/Inkbranch/ARCHITECTURE.md>)
- [ARCHITECTURE.zh-CN.md](</home/crackrammer/Projects/Inkbranch/ARCHITECTURE.zh-CN.md>)
- [DEPLOYMENT.md](</home/crackrammer/Projects/Inkbranch/DEPLOYMENT.md>)
- [DEPLOYMENT.zh-CN.md](</home/crackrammer/Projects/Inkbranch/DEPLOYMENT.zh-CN.md>)
- [Dockerfile](</home/crackrammer/Projects/Inkbranch/Dockerfile>)
- [README.md](</home/crackrammer/Projects/Inkbranch/README.md>)
- [README.zh-CN.md](</home/crackrammer/Projects/Inkbranch/README.zh-CN.md>)
- [docker-compose.yml](</home/crackrammer/Projects/Inkbranch/docker-compose.yml>)
- [next.config.ts](</home/crackrammer/Projects/Inkbranch/next.config.ts>)
- [playwright.config.ts](</home/crackrammer/Projects/Inkbranch/playwright.config.ts>)
- [scripts/backup.sh](</home/crackrammer/Projects/Inkbranch/scripts/backup.sh>)
- [scripts/check/font-preload.ts](</home/crackrammer/Projects/Inkbranch/scripts/check/font-preload.ts>)
- [scripts/content/links.ts](</home/crackrammer/Projects/Inkbranch/scripts/content/links.ts>)
- [scripts/content/reindex.ts](</home/crackrammer/Projects/Inkbranch/scripts/content/reindex.ts>)
- [scripts/content/stats.ts](</home/crackrammer/Projects/Inkbranch/scripts/content/stats.ts>)
- [scripts/content/sync.ts](</home/crackrammer/Projects/Inkbranch/scripts/content/sync.ts>)
- [scripts/content/validate.ts](</home/crackrammer/Projects/Inkbranch/scripts/content/validate.ts>)
- [scripts/lib/backup-common.sh](</home/crackrammer/Projects/Inkbranch/scripts/lib/backup-common.sh>)
- [scripts/restore.sh](</home/crackrammer/Projects/Inkbranch/scripts/restore.sh>)
- [src/app/admin/(dashboard)/\[type\]/new/new-content-form.tsx](</home/crackrammer/Projects/Inkbranch/src/app/admin/(dashboard)/[type]/new/new-content-form.tsx>)
- [src/app/admin/(dashboard)/assets/page.tsx](</home/crackrammer/Projects/Inkbranch/src/app/admin/(dashboard)/assets/page.tsx>)
- [src/app/admin/(dashboard)/import/actions.ts](</home/crackrammer/Projects/Inkbranch/src/app/admin/(dashboard)/import/actions.ts>)
- [src/app/admin/(dashboard)/page.tsx](</home/crackrammer/Projects/Inkbranch/src/app/admin/(dashboard)/page.tsx>)
- [src/app/admin/(dashboard)/redirects/page.tsx](</home/crackrammer/Projects/Inkbranch/src/app/admin/(dashboard)/redirects/page.tsx>)
- [src/app/admin/(dashboard)/system/page.tsx](</home/crackrammer/Projects/Inkbranch/src/app/admin/(dashboard)/system/page.tsx>)
- [src/app/admin/(dashboard)/tags/page.tsx](</home/crackrammer/Projects/Inkbranch/src/app/admin/(dashboard)/tags/page.tsx>)
- [src/app/admin/actions/auth.ts](</home/crackrammer/Projects/Inkbranch/src/app/admin/actions/auth.ts>)
- [src/app/admin/actions/content.ts](</home/crackrammer/Projects/Inkbranch/src/app/admin/actions/content.ts>)
- [src/app/admin/actions/revisions.ts](</home/crackrammer/Projects/Inkbranch/src/app/admin/actions/revisions.ts>)
- [src/app/admin/layout.tsx](</home/crackrammer/Projects/Inkbranch/src/app/admin/layout.tsx>)
- [src/app/api/assets/\[...path\]/route.ts](</home/crackrammer/Projects/Inkbranch/src/app/api/assets/[...path]/route.ts>)
- [src/app/globals.css](</home/crackrammer/Projects/Inkbranch/src/app/globals.css>)
- [src/app/layout.tsx](</home/crackrammer/Projects/Inkbranch/src/app/layout.tsx>)
- [src/app/robots.ts](</home/crackrammer/Projects/Inkbranch/src/app/robots.ts>)
- [src/components/admin/admin-shell.tsx](</home/crackrammer/Projects/Inkbranch/src/components/admin/admin-shell.tsx>)
- [src/components/admin/asset-controls.tsx](</home/crackrammer/Projects/Inkbranch/src/components/admin/asset-controls.tsx>)
- [src/components/admin/asset-upload.tsx](</home/crackrammer/Projects/Inkbranch/src/components/admin/asset-upload.tsx>)
- [src/components/admin/confirm-action.tsx](</home/crackrammer/Projects/Inkbranch/src/components/admin/confirm-action.tsx>)
- [src/components/admin/content-list.tsx](</home/crackrammer/Projects/Inkbranch/src/components/admin/content-list.tsx>)
- [src/components/admin/editor/editor.tsx](</home/crackrammer/Projects/Inkbranch/src/components/admin/editor/editor.tsx>)
- [src/components/admin/editor/markdown-editor.tsx](</home/crackrammer/Projects/Inkbranch/src/components/admin/editor/markdown-editor.tsx>)
- [src/components/admin/page.tsx](</home/crackrammer/Projects/Inkbranch/src/components/admin/page.tsx>)
- [src/components/admin/redirect-controls.tsx](</home/crackrammer/Projects/Inkbranch/src/components/admin/redirect-controls.tsx>)
- [src/components/admin/session-list.tsx](</home/crackrammer/Projects/Inkbranch/src/components/admin/session-list.tsx>)
- [src/components/admin/tag-operations.tsx](</home/crackrammer/Projects/Inkbranch/src/components/admin/tag-operations.tsx>)
- [src/components/content/article-body.tsx](</home/crackrammer/Projects/Inkbranch/src/components/content/article-body.tsx>)
- [src/components/content/code-enhancer.tsx](</home/crackrammer/Projects/Inkbranch/src/components/content/code-enhancer.tsx>)
- [src/components/content/font-preload.tsx](</home/crackrammer/Projects/Inkbranch/src/components/content/font-preload.tsx>)
- [src/components/content/related-list.tsx](</home/crackrammer/Projects/Inkbranch/src/components/content/related-list.tsx>)
- [src/components/graph/graph-explorer.tsx](</home/crackrammer/Projects/Inkbranch/src/components/graph/graph-explorer.tsx>)
- [src/components/site/command-palette-dialog.tsx](</home/crackrammer/Projects/Inkbranch/src/components/site/command-palette-dialog.tsx>)
- [src/components/theme-toggle.tsx](</home/crackrammer/Projects/Inkbranch/src/components/theme-toggle.tsx>)
- [src/env.ts](</home/crackrammer/Projects/Inkbranch/src/env.ts>)
- [src/instrumentation.ts](</home/crackrammer/Projects/Inkbranch/src/instrumentation.ts>)
- [src/lib/admin/guard.ts](</home/crackrammer/Projects/Inkbranch/src/lib/admin/guard.ts>)
- [src/lib/admin/next-path.ts](</home/crackrammer/Projects/Inkbranch/src/lib/admin/next-path.ts>)
- [src/lib/admin/queries.ts](</home/crackrammer/Projects/Inkbranch/src/lib/admin/queries.ts>)
- [src/lib/admin/result.ts](</home/crackrammer/Projects/Inkbranch/src/lib/admin/result.ts>)
- [src/lib/admin/tags.ts](</home/crackrammer/Projects/Inkbranch/src/lib/admin/tags.ts>)
- [src/lib/analytics/collect.ts](</home/crackrammer/Projects/Inkbranch/src/lib/analytics/collect.ts>)
- [src/lib/assets/manage.ts](</home/crackrammer/Projects/Inkbranch/src/lib/assets/manage.ts>)
- [src/lib/assets/storage.ts](</home/crackrammer/Projects/Inkbranch/src/lib/assets/storage.ts>)
- [src/lib/auth/account.ts](</home/crackrammer/Projects/Inkbranch/src/lib/auth/account.ts>)
- [src/lib/auth/rate-limit-policy.ts](</home/crackrammer/Projects/Inkbranch/src/lib/auth/rate-limit-policy.ts>)
- [src/lib/auth/rate-limit.ts](</home/crackrammer/Projects/Inkbranch/src/lib/auth/rate-limit.ts>)
- [src/lib/auth/session-store.ts](</home/crackrammer/Projects/Inkbranch/src/lib/auth/session-store.ts>)
- [src/lib/content/import.ts](</home/crackrammer/Projects/Inkbranch/src/lib/content/import.ts>)
- [src/lib/content/links.ts](</home/crackrammer/Projects/Inkbranch/src/lib/content/links.ts>)
- [src/lib/content/paths.ts](</home/crackrammer/Projects/Inkbranch/src/lib/content/paths.ts>)
- [src/lib/content/reader.ts](</home/crackrammer/Projects/Inkbranch/src/lib/content/reader.ts>)
- [src/lib/content/recovery.ts](</home/crackrammer/Projects/Inkbranch/src/lib/content/recovery.ts>)
- [src/lib/content/schema.ts](</home/crackrammer/Projects/Inkbranch/src/lib/content/schema.ts>)
- [src/lib/content/sync.ts](</home/crackrammer/Projects/Inkbranch/src/lib/content/sync.ts>)
- [src/lib/content/writer.ts](</home/crackrammer/Projects/Inkbranch/src/lib/content/writer.ts>)
- [src/lib/db/migrate.ts](</home/crackrammer/Projects/Inkbranch/src/lib/db/migrate.ts>)
- [src/lib/font-preloads.ts](</home/crackrammer/Projects/Inkbranch/src/lib/font-preloads.ts>)
- [src/lib/fonts.ts](</home/crackrammer/Projects/Inkbranch/src/lib/fonts.ts>)
- [src/lib/graph/backlinks.ts](</home/crackrammer/Projects/Inkbranch/src/lib/graph/backlinks.ts>)
- [src/lib/graph/model.ts](</home/crackrammer/Projects/Inkbranch/src/lib/graph/model.ts>)
- [src/lib/graph/related.ts](</home/crackrammer/Projects/Inkbranch/src/lib/graph/related.ts>)
- [src/lib/graph/relations.ts](</home/crackrammer/Projects/Inkbranch/src/lib/graph/relations.ts>)
- [src/lib/jobs/handlers.ts](</home/crackrammer/Projects/Inkbranch/src/lib/jobs/handlers.ts>)
- [src/lib/markdown/rehype-code.ts](</home/crackrammer/Projects/Inkbranch/src/lib/markdown/rehype-code.ts>)
- [src/lib/markdown/remark-blocks.ts](</home/crackrammer/Projects/Inkbranch/src/lib/markdown/remark-blocks.ts>)
- [src/lib/redirects.ts](</home/crackrammer/Projects/Inkbranch/src/lib/redirects.ts>)
- [src/lib/revision/policy.ts](</home/crackrammer/Projects/Inkbranch/src/lib/revision/policy.ts>)
- [src/lib/revision/store.ts](</home/crackrammer/Projects/Inkbranch/src/lib/revision/store.ts>)
- [src/lib/search/local.ts](</home/crackrammer/Projects/Inkbranch/src/lib/search/local.ts>)
- [src/lib/security/paths.ts](</home/crackrammer/Projects/Inkbranch/src/lib/security/paths.ts>)
- [src/lib/security/urls.ts](</home/crackrammer/Projects/Inkbranch/src/lib/security/urls.ts>)
- [src/proxy.ts](</home/crackrammer/Projects/Inkbranch/src/proxy.ts>)
- [tests/database-safety.ts](</home/crackrammer/Projects/Inkbranch/tests/database-safety.ts>)
- [tests/e2e/assets.spec.ts](</home/crackrammer/Projects/Inkbranch/tests/e2e/assets.spec.ts>)
- [tests/e2e/audit.spec.ts](</home/crackrammer/Projects/Inkbranch/tests/e2e/audit.spec.ts>)
- [tests/e2e/authoring.spec.ts](</home/crackrammer/Projects/Inkbranch/tests/e2e/authoring.spec.ts>)
- [tests/e2e/dashboard.spec.ts](</home/crackrammer/Projects/Inkbranch/tests/e2e/dashboard.spec.ts>)
- [tests/e2e/editor-safety.spec.ts](</home/crackrammer/Projects/Inkbranch/tests/e2e/editor-safety.spec.ts>)
- [tests/e2e/environment.ts](</home/crackrammer/Projects/Inkbranch/tests/e2e/environment.ts>)
- [tests/e2e/global-setup.ts](</home/crackrammer/Projects/Inkbranch/tests/e2e/global-setup.ts>)
- [tests/e2e/graph.spec.ts](</home/crackrammer/Projects/Inkbranch/tests/e2e/graph.spec.ts>)
- [tests/e2e/redirects.spec.ts](</home/crackrammer/Projects/Inkbranch/tests/e2e/redirects.spec.ts>)
- [tests/e2e/renderer.spec.ts](</home/crackrammer/Projects/Inkbranch/tests/e2e/renderer.spec.ts>)
- [tests/e2e/search.spec.ts](</home/crackrammer/Projects/Inkbranch/tests/e2e/search.spec.ts>)
- [tests/e2e/structured-data.spec.ts](</home/crackrammer/Projects/Inkbranch/tests/e2e/structured-data.spec.ts>)
- [tests/e2e/tags.spec.ts](</home/crackrammer/Projects/Inkbranch/tests/e2e/tags.spec.ts>)
- [tests/e2e/theme.spec.ts](</home/crackrammer/Projects/Inkbranch/tests/e2e/theme.spec.ts>)
- [tests/integration/account-password.test.ts](</home/crackrammer/Projects/Inkbranch/tests/integration/account-password.test.ts>)
- [tests/integration/asset-deletion-safety.test.ts](</home/crackrammer/Projects/Inkbranch/tests/integration/asset-deletion-safety.test.ts>)
- [tests/integration/authoring.test.ts](</home/crackrammer/Projects/Inkbranch/tests/integration/authoring.test.ts>)
- [tests/integration/content-actions.test.ts](</home/crackrammer/Projects/Inkbranch/tests/integration/content-actions.test.ts>)
- [tests/integration/content-cli.test.ts](</home/crackrammer/Projects/Inkbranch/tests/integration/content-cli.test.ts>)
- [tests/integration/content-consistency.test.ts](</home/crackrammer/Projects/Inkbranch/tests/integration/content-consistency.test.ts>)
- [tests/integration/content-render.test.ts](</home/crackrammer/Projects/Inkbranch/tests/integration/content-render.test.ts>)
- [tests/integration/content-sync.test.ts](</home/crackrammer/Projects/Inkbranch/tests/integration/content-sync.test.ts>)
- [tests/integration/rate-limit.test.ts](</home/crackrammer/Projects/Inkbranch/tests/integration/rate-limit.test.ts>)
- [tests/integration/tag-orphans.test.ts](</home/crackrammer/Projects/Inkbranch/tests/integration/tag-orphans.test.ts>)
- [tests/integration/tags.test.ts](</home/crackrammer/Projects/Inkbranch/tests/integration/tags.test.ts>)
- [tests/integration/worker.test.ts](</home/crackrammer/Projects/Inkbranch/tests/integration/worker.test.ts>)
- [tests/setup.ts](</home/crackrammer/Projects/Inkbranch/tests/setup.ts>)
- [tests/unit/analytics.test.ts](</home/crackrammer/Projects/Inkbranch/tests/unit/analytics.test.ts>)
- [tests/unit/asset-path-security.test.ts](</home/crackrammer/Projects/Inkbranch/tests/unit/asset-path-security.test.ts>)
- [tests/unit/backup-restore.test.ts](</home/crackrammer/Projects/Inkbranch/tests/unit/backup-restore.test.ts>)
- [tests/unit/content-import.test.ts](</home/crackrammer/Projects/Inkbranch/tests/unit/content-import.test.ts>)
- [tests/unit/content-links.test.ts](</home/crackrammer/Projects/Inkbranch/tests/unit/content-links.test.ts>)
- [tests/unit/content-url-security.test.ts](</home/crackrammer/Projects/Inkbranch/tests/unit/content-url-security.test.ts>)
- [tests/unit/content-writer.test.ts](</home/crackrammer/Projects/Inkbranch/tests/unit/content-writer.test.ts>)
- [tests/unit/contrast.test.ts](</home/crackrammer/Projects/Inkbranch/tests/unit/contrast.test.ts>)
- [tests/unit/csrf.test.ts](</home/crackrammer/Projects/Inkbranch/tests/unit/csrf.test.ts>)
- [tests/unit/database-safety.test.ts](</home/crackrammer/Projects/Inkbranch/tests/unit/database-safety.test.ts>)
- [tests/unit/env.test.ts](</home/crackrammer/Projects/Inkbranch/tests/unit/env.test.ts>)
- [tests/unit/font-preloads.test.ts](</home/crackrammer/Projects/Inkbranch/tests/unit/font-preloads.test.ts>)
- [tests/unit/graph.test.ts](</home/crackrammer/Projects/Inkbranch/tests/unit/graph.test.ts>)
- [tests/unit/instrumentation.test.ts](</home/crackrammer/Projects/Inkbranch/tests/unit/instrumentation.test.ts>)
- [tests/unit/job-failures.test.ts](</home/crackrammer/Projects/Inkbranch/tests/unit/job-failures.test.ts>)
- [tests/unit/jobs.test.ts](</home/crackrammer/Projects/Inkbranch/tests/unit/jobs.test.ts>)
- [tests/unit/markdown-renderer.test.ts](</home/crackrammer/Projects/Inkbranch/tests/unit/markdown-renderer.test.ts>)
- [tests/unit/migrations.test.ts](</home/crackrammer/Projects/Inkbranch/tests/unit/migrations.test.ts>)
- [tests/unit/next-path.test.ts](</home/crackrammer/Projects/Inkbranch/tests/unit/next-path.test.ts>)
- [tests/unit/redirects.test.ts](</home/crackrammer/Projects/Inkbranch/tests/unit/redirects.test.ts>)
- [tests/unit/revision.test.ts](</home/crackrammer/Projects/Inkbranch/tests/unit/revision.test.ts>)
- [tests/unit/search-consistency.test.ts](</home/crackrammer/Projects/Inkbranch/tests/unit/search-consistency.test.ts>)
- [vitest.config.ts](</home/crackrammer/Projects/Inkbranch/vitest.config.ts>)
- [vitest.integration.config.ts](</home/crackrammer/Projects/Inkbranch/vitest.integration.config.ts>)

## 10. Production Readiness

**READY WITH KNOWN LIMITATIONS**。

功能、Markdown 数据安全、权限/输入安全、Revision/恢复、CMS、renderer/search、定时 worker、真实数据库、容器/TLS/持久化、备份恢复及最后完整回归均已通过，没有未处理的 P0/P1 或高危安全问题。该判断适用于文档明确的单实例和维护窗口运行条件。

默认模拟 Home 的严格性能目标仍为 PARTIAL；原生 Docker 特定 restart 行为、生产 DNS/ACME/真实凭证及目标环境性能属于本轮未操作/未验证的部署边界。实际 DevTools mobile 节流四页四项均 >95，不能用它抹去默认模拟的 95。没有仅因 build 成功而判为就绪，也没有部署到生产或推送代码。
