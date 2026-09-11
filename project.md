你是一名资深全栈工程师、产品设计师和架构师。请从零设计并实现一个现代化、长期可维护的个人博客 / 数字花园 / 技术官网。

这不是 Ghost、WordPress 或传统博客模板的复刻。

目标是打造一个具有独立产品感的内容网站：

* 前台是高质量、现代、极简但有视觉辨识度的个人官网
* 后台是完整可用的内容管理系统
* 已有文章全部是 Markdown `.md` 文件
* Markdown 文件本身必须继续作为文章的主要内容源
* 支持后台直接创建、编辑、预览、发布 Markdown
* 支持未来持续扩展
* 不依赖 Ghost
* 不使用现成 Headless CMS
* 最终必须可以 Docker 自托管

请把它当作一个真正会长期投入使用的产品，而不是 Demo。

---

# 一、产品理念

网站定位不是单纯 Blog，而是：

**Personal Knowledge System + Publishing Platform**

前台包含三个内容层次：

1. Blog

   * 正式文章
   * 技术文章
   * 长文
   * 随笔

2. Notes

   * 短笔记
   * Tips
   * Snippets
   * 学习记录
   * 不一定需要完整文章结构

3. Projects

   * 项目展示
   * GitHub 项目
   * 实验项目
   * Side Project
   * 项目开发记录

三者共同组成一个个人数字空间。

整体感觉参考：

* Linear
* Vercel
* Arc
* Raycast
* Stripe Docs
* GitHub
* Apple Developer
* 高质量个人技术博客

但不要复制任何现成网站。

要求形成自己的设计语言。

---

# 二、技术栈

优先采用：

Frontend / Full-stack:

* Next.js App Router
* TypeScript
* React
* Server Components 优先

UI:

* Tailwind CSS
* shadcn/ui
* Radix UI
* Lucide Icons

Animation:

* Motion / Framer Motion
* 动画必须克制

Content:

* Markdown
* YAML Frontmatter
* remark
* rehype
* Shiki

Editor:

* CodeMirror 6 或 Monaco Editor

Database:

* PostgreSQL

ORM:

* Drizzle ORM

Validation:

* Zod

Authentication:

* 自己实现安全的后台 Session Authentication
* 密码使用 Argon2id
* HTTP-only Cookie
* CSRF 防护
* Rate Limit
* 不需要开放注册

Search:

* 优先本地全文索引
* 中文和英文均需要良好支持
* 架构上允许未来换成 Meilisearch

Deployment:

* Docker
* Docker Compose
* Nginx / Caddy 可选

测试：

* Vitest
* Playwright

包管理器：

* pnpm

所有依赖采用当前稳定且互相兼容的版本。

不要为了追求技术复杂度而引入不必要依赖。

---

# 三、内容存储设计

这是整个系统最重要的原则：

**Markdown 文件是真实内容源。**

不要把 Markdown 正文完全迁移进数据库。

目录：

content/
posts/
notes/
projects/

例如：

content/posts/linux-network-debugging.md

Frontmatter：

---

title: "Linux 网络排查笔记"
slug: "linux-network-debugging"
description: "..."
date: 2026-09-11
updated: 2026-09-11
status: published
tags:

* Linux
* Network
  category: Technology
  cover: /uploads/xxx.webp
  featured: false
  toc: true

---

正文内容……

数据库主要保存：

* 用户
* 网站设置
* 内容索引
* 搜索索引状态
* 上传资源
* 草稿状态
* Revision
* Audit Log
* View statistics
* Redirect
* Navigation
* SEO override

Markdown 文件是最终事实来源。

后台修改文章时：

Browser
↓
Admin API
↓
校验 Frontmatter
↓
原子写入 Markdown
↓
更新 Content Index
↓
Invalidate Cache
↓
前台立即更新

文件写入必须防止损坏：

* 临时文件
* fsync
* atomic rename
* 文件锁
* revision backup

不能因为后台保存失败而损坏原文章。

---

# 四、现有 Markdown 自动导入

我已经有一批 `.md` 文件。

必须提供：

Admin → Import

支持：

* 单文件上传
* 多文件上传
* ZIP 导入
* 指定服务器目录扫描

系统自动：

1. 扫描 Markdown
2. 读取 frontmatter
3. 尝试识别 title
4. 自动生成 slug
5. 自动识别日期
6. 提取 description
7. 提取 headings
8. 建立全文搜索索引
9. 检查图片链接
10. 检查内部链接
11. 检查重复 slug
12. 导入完成后生成报告

例如：

Import completed

124 Markdown files

✓ 117 imported
⚠ 5 missing descriptions
⚠ 2 duplicate slugs
⚠ 8 broken images
⚠ 3 broken internal links

提供 Fix Suggestions。

不要修改原始文件，除非管理员确认。

---

# 五、前台首页

不要做传统：

头像
↓
一句话介绍
↓
文章列表

我要更有产品感。

首页设计成一个 Personal Dashboard。

第一屏：

左侧：

NAME

一句非常简短的描述。

例如：

Data · Systems · Code

右侧动态显示：

Now
Currently exploring...

Latest
最新文章

Projects
最近项目

Activity
最近内容动态

布局可以类似动态 Bento Grid，但不要过度使用卡片。

---

首页下面：

## Featured

精选文章。

大卡片 + 编辑精选。

---

## Recent Writing

时间流：

2026

Sep 11
DeepSeek Agent Experiment

Sep 08
Building...

Aug 21
...

保持非常干净。

---

## Explore

按 Topic 浏览：

Linux
Data
AI
Engineering
Notes
Projects

Topic 可以有轻量的视觉识别。

---

## Digital Garden

展示：

最近更新的 Notes

而不是只展示发布日期。

突出：

Updated recently

体现知识是不断维护的。

---

# 六、文章页面

文章页是最重要的阅读体验。

Desktop：

┌─────────────┬─────────────────────────┬──────────────┐
│             │                         │              │
│ Site        │ Article                 │ TOC          │
│ Navigation  │                         │              │
│             │                         │              │
└─────────────┴─────────────────────────┴──────────────┘

或根据宽度动态变化。

文章顶部：

Category

Title

Description

Published
Updated
Reading time

Tags

---

Markdown 支持：

* Heading
* Table
* Quote
* Task List
* Footnotes
* Math / KaTeX
* Mermaid
* GitHub Alert
* Details
* Definition list
* 图片
* 视频
* iframe
* Code Block
* Diff
* Tabs
* Callout
* Keyboard key
* File Tree

---

# 七、代码块体验

技术博客代码展示必须优秀。

例如：

┌ config.toml ─────────────────── Copy ┐
│                                     │
│ model = "deepseek-flash"            │
│                                     │
└─────────────────────────────────────┘

支持：

* filename
* language
* copy
* line numbers
* line highlight
* word highlight
* diff
* terminal
* bash output

Shiki Server Side Rendering。

不允许因为代码高亮引入大量客户端 JS。

---

# 八、文章目录 TOC

右侧 TOC：

Introduction
Architecture
Database
API
Implementation
Conclusion

要求：

* Scroll Spy
* 当前章节高亮
* 平滑滚动
* 自动缩进
* mobile drawer

---

# 九、阅读进度

页面顶部：

━━━━━━━━━━━━━━━━━━━

随着文章阅读逐渐前进。

非常细。

不要抢视觉。

---

# 十、相关文章

文章结束以后不要简单展示：

上一篇 / 下一篇

实现：

Related Content

根据：

* tags
* category
* internal links
* keywords

计算相关文章。

不调用 AI。

本地算法即可。

---

# 十一、Backlinks

借鉴 Obsidian。

文章底部：

Referenced by

* Kubernetes Network Debugging
* Linux Routing Notes
* Cilium Investigation

解析：

[文章链接]

建立内容关系。

---

# 十二、Knowledge Graph

增加：

/graph

展示内容关系：

Post
Note
Project
Tag

节点图。

但注意：

不要为了炫技导致页面非常重。

Graph 使用动态加载。

默认不进入主 bundle。

---

# 十三、搜索体验

Cmd + K

弹出：

Search

> linux network

结果：

Articles

Linux Network Debugging
Linux Routing

Notes

Cilium Routing Notes

Projects

Network Diagnostic Tool

支持：

* 标题
* 正文
* tags
* category
* command navigation

命令：

> theme

Switch theme

> admin

Open Admin

> rss

Copy RSS URL

类似 Command Palette。

---

# 十四、后台管理

路由：

/admin

必须是真正可用的 CMS。

Dashboard：

Overview

Posts
Notes
Projects
Assets
Tags
Navigation
Redirects
Analytics
Settings
System

---

# 十五、Admin Dashboard

首页显示：

Content

124 Posts
43 Notes
7 Projects

本周：

+3 posts
+7 notes

Traffic：

Today
7 days
30 days

Latest content

Recent activity

System

Content Index ✓
Search Index ✓
Storage ✓

---

# 十六、文章管理

/admin/posts

Table：

Title
Status
Category
Tags
Updated
Published
Views

支持：

Search

Filter：

Published
Draft
Scheduled

Category

Tag

排序：

Updated
Published
Views

支持 Bulk Actions：

Publish
Unpublish
Delete
Add Tag

---

# 十七、Markdown 编辑器

这是后台核心。

布局：

┌──────── Editor ────────┬──────── Preview ────────┐
│                        │                          │
│ Markdown               │ Real-time Render        │
│                        │                          │
│                        │                          │
└────────────────────────┴──────────────────────────┘

支持：

Editor
Preview
Split

---

编辑器支持：

Markdown syntax highlighting

快捷键：

Ctrl/Cmd + S
保存

Ctrl/Cmd + P
Preview

Ctrl/Cmd + K
插入链接

Ctrl/Cmd + Shift + I
上传图片

---

右侧 Metadata：

Title

Slug

Description

Status

Publish Date

Tags

Category

Cover

SEO

---

必须实现：

Auto Save

但必须防止过度写磁盘。

例如：

用户停止输入 2 秒
↓
保存 Draft Revision

正式保存仍然使用 Ctrl + S。

---

# 十八、Draft / Publish

状态：

draft
scheduled
published
archived

支持定时发布。

Worker 定期检查 scheduled。

---

# 十九、Revision History

每次正式保存产生 revision。

Revision：

2026-09-11 21:34
Changed title
+23 -5

2026-09-11 20:51
Initial import

支持：

View Diff

Restore

Compare

正文不要整个存在数据库。

Revision 可以：

content/revisions/

或压缩 diff。

设计合理的数据模型。

---

# 二十、媒体资源

/admin/assets

上传：

PNG
JPEG
WebP
AVIF
SVG

自动：

* EXIF 清理
* image optimization
* WebP/AVIF
* thumbnail
* width
* height
* blur placeholder

Asset 页面：

Grid/List

Search

Unused

Referenced by

允许查：

这个图片在哪几篇文章中被引用。

---

# 二十一、粘贴图片

Markdown Editor：

直接 Ctrl + V 图片

自动：

上传
↓
优化
↓
生成 Markdown

例如：

![network diagram](/uploads/2026/network-diagram.webp)

---

# 二十二、Drag & Drop

拖图片进入 Markdown：

自动上传并插入。

---

# 二十三、SEO

每篇文章自动生成：

title

description

canonical

OpenGraph

Twitter Card

JSON-LD

Article Schema

Breadcrumb Schema

前台：

/sitemap.xml

/rss.xml

/robots.txt

---

# 二十四、动态 OG Image

自动生成：

┌───────────────────────────────────┐
│                                   │
│     Linux Network Debugging       │
│                                   │
│     Linux · Network               │
│                                   │
│                         SITE      │
└───────────────────────────────────┘

不要求每篇文章自己制作封面。

---

# 二十五、旧 URL Redirect

Admin：

Redirects

例如：

/ghost-old-post

301 →

/posts/new-post

数据库保存。

Middleware 高效处理。

支持 CSV 导入。

这是未来 Ghost 迁移 SEO 必须具备的能力。

---

# 二十六、RSS

支持：

全部文章：

/rss.xml

Tag：

/rss/linux.xml

Category：

/rss/category/linux.xml

---

# 二十七、Analytics

实现轻量级 Privacy-Friendly Analytics。

不要做用户追踪画像。

记录：

Page View

Article

Referer Domain

Country（可选）

Device Type

每日聚合。

后台：

Top Articles

Traffic Trend

Referrers

不要保存 IP。

原始事件保留时间可配置。

必须允许完全关闭 Analytics。

---

# 二十八、主题

支持：

Light

Dark

System

设计要求：

不是简单：

白色 → 黑色

而是真正分别设计两个主题。

Dark：

深灰而不是纯黑。

---

# 二十九、视觉设计

关键词：

Minimal
Technical
Calm
Precise
Premium

避免：

* 大量渐变
* 大量玻璃效果
* 到处圆角卡片
* 到处阴影
* 巨型 Hero
* AI SaaS 模板感
* 紫色渐变
* 满屏 Bento
* 无意义动画

使用：

Typography
Whitespace
Grid
Borders
Subtle contrast

创造视觉层级。

---

# 三十、Typography

文章阅读体验优先。

正文宽度控制。

Desktop 正文约：

680–760px

中文：

合理 line-height。

英文：

优秀 typography。

代码：

Monospace。

字体必须使用允许 Web 分发或系统字体。

---

# 三十一、响应式

必须认真设计：

Desktop

Tablet

Mobile

不能只是简单 Tailwind：

md:hidden

要求针对 Mobile 重构信息结构。

例如：

Desktop TOC：

右侧。

Mobile：

点击标题旁：

Contents

打开 Bottom Sheet。

---

# 三十二、性能指标

目标：

Lighthouse：

Performance > 95
Accessibility > 95
Best Practices > 95
SEO > 95

尽量实现：

SSR / SSG
Server Components
少客户端 JS
Image optimization
Code splitting

Graph / Editor：

只在需要时加载。

---

# 三十三、Accessibility

必须支持：

Keyboard Navigation

Screen Reader

Focus State

aria

Reduced Motion

Color Contrast

不要只追求视觉效果。

---

# 三十四、安全

Admin 必须特别注意：

Argon2id

Session Cookie：

HttpOnly
Secure
SameSite

CSRF

Login rate limit

Content validation

Path traversal

File upload MIME validation

SVG XSS

Markdown XSS

禁止后台 API 任意写入：

../../

所有文件路径都必须 normalize + validate。

管理员操作写 Audit Log。

---

# 三十五、API

采用合理 REST / Server Actions 设计。

例如：

GET /api/admin/posts

POST /api/admin/posts

PUT /api/admin/posts/:slug

DELETE ...

但不要为了 API 而 API。

能通过 Server Actions 简化且安全的场景可以使用 Server Actions。

---

# 三十六、Database

设计完整 Schema。

至少：

users

sessions

content_index

tags

content_tags

assets

redirects

site_settings

navigation

analytics_daily

audit_logs

scheduled_jobs

不要把 Markdown 正文重复存在 DB。

---

# 三十七、Content Index

content_index 保存：

id
type
title
slug
description
status
path
published_at
updated_at
checksum
word_count
reading_time
search_index_version

用于：

后台列表

搜索

统计

无需每次遍历全部 Markdown。

---

# 三十八、文件同步

必须考虑：

管理员可能：

后台编辑 Markdown

也可能：

直接 git pull

或者：

vim 修改 Markdown

因此需要：

Content Sync Engine。

实现：

pnpm content:sync

扫描 Markdown
↓
checksum
↓
检测 added / updated / deleted
↓
同步数据库 index

应用启动也执行轻量检查。

不要要求所有内容必须经过后台。

---

# 三十九、CLI

提供：

pnpm content:sync

pnpm content:validate

pnpm content:reindex

pnpm content:import

pnpm content:links

pnpm content:stats

例如：

$ pnpm content:validate

✓ 124 files

Warnings:

posts/linux.md
Missing description

notes/docker.md
Broken link → /posts/foo

Errors:

projects/demo.md
Duplicate slug

---

# 四十、Docker

最终：

docker compose up -d

启动：

web
postgres

可选：

reverse-proxy

目录挂载：

./content:/app/content

./uploads:/app/public/uploads

这样 Markdown 可以直接在宿主机管理。

---

# 四十一、Backup

提供：

scripts/backup.sh

备份：

PostgreSQL

content/

uploads/

config

生成：

backup-2026-09-11.tar.zst

提供 restore 脚本。

---

# 四十二、Git Integration

内容目录可以使用 Git。

后台保存后可配置：

auto commit。

例如：

content: update "Linux Network Debugging"

默认关闭。

后台设置：

Git Integration

[ ] Automatically commit published content

不要自动 push，除非以后明确开启。

---

# 四十三、About 页面

不是传统简历页。

设计成：

Profile

Focus

Currently

Stack

Projects

Contact

Latest writing

可从后台设置编辑。

---

# 四十四、Projects

Project：

Title

Description

Status

Started

GitHub

Website

Tech Stack

Cover

README-like Markdown content

状态：

Active
Maintained
Experiment
Archived

---

# 四十五、Notes

Notes 更轻：

Title optional

Date

Tags

Content

URL：

/notes/xxxxx

支持：

短内容

代码片段

学习记录

Notes 也进入：

Search
Backlink
Graph

---

# 四十六、Tags

/tag/linux

页面不是单纯文章列表。

顶部：

Linux

42 contents

相关文章：

Posts
Notes
Projects

提供 timeline。

---

# 四十七、Archive

/archive

设计成非常紧凑的时间轴。

例如：

2026

September

11  DeepSeek V4.1
08  Claude Code

August

21  Linux Network

不要大量卡片。

---

# 四十八、404

设计一个有产品感的 404。

提供：

Search

Recent articles

Home

不要做搞笑动画。

---

# 四十九、Loading

尽量利用 Server Rendering，减少 Loading。

必须 loading 时使用：

Skeleton

不要 spinner 满天飞。

---

# 五十、错误处理

实现：

Error Boundary

Server Error Page

Admin Error Feedback

保存失败：

绝不能让用户误以为保存成功。

例如：

Save failed

Original content has NOT been modified.

Retry

---

# 五十一、测试

必须写真实测试。

Unit：

frontmatter parser

slug

markdown renderer

internal link parser

backlinks

content sync

redirect

security path validation

Integration：

create post

edit

publish

upload

restore revision

E2E：

Login
Create article
Publish
Frontend accessible
Search
Delete

---

# 五十二、开发流程

不要一次性生成所有代码。

按阶段执行。

Phase 1

分析需求，设计：

architecture.md

database schema

folder structure

content model

security model

然后开始编码。

不要只给我设计文档后停止。

---

Phase 2

搭建项目：

Next.js
DB
Markdown pipeline
Content sync

确保：

pnpm dev

可以运行。

---

Phase 3

完成前台核心：

Home
Post
Notes
Projects
Tags
Archive

---

Phase 4

后台：

Authentication

Dashboard

Post List

Editor

Asset Manager

Settings

---

Phase 5

高级功能：

Search

Backlinks

Graph

Analytics

Redirects

Revision

---

Phase 6

测试：

Unit
Integration
E2E

---

Phase 7

Docker

Backup

README

Deployment Guide

---

# 五十三、工作方式要求

你拥有终端和项目文件访问能力。

请主动：

创建文件

安装依赖

运行 lint

运行 TypeScript check

运行 tests

运行 build

检查错误

修复错误

重新运行

不要频繁停下来询问我：

“是否继续？”

只要没有涉及不可逆外部操作，请自主推进。

---

当出现实现选择时：

优先选择：

简单

可靠

长期维护

高性能

低依赖

而不是：

炫技

过度 abstraction

过度 engineering

---

# 五十四、代码质量要求

禁止：

any 滥用

巨大 component

巨大 route handler

重复代码

无意义 abstraction

magic number

catch {}

console.log 遗留

TODO 代替实际实现

placeholder 功能假装完成

---

要求：

清晰模块边界

严格 TypeScript

错误类型

Server / Client 边界明确

安全的数据验证

合理注释

---

# 五十五、完成标准

项目只有满足以下条件才算完成：

✓ 已有 Markdown 可以直接导入

✓ Markdown 文件可以直接作为内容源

✓ 后台可以登录

✓ 后台可以创建 Markdown 文章

✓ 后台可以编辑

✓ 实时 Preview

✓ Draft

✓ Publish

✓ Scheduled

✓ Upload Image

✓ Revision

✓ Search

✓ Tags

✓ Notes

✓ Projects

✓ Backlinks

✓ RSS

✓ Sitemap

✓ SEO

✓ Redirect

✓ Analytics

✓ Responsive

✓ Dark Mode

✓ Docker

✓ Backup

✓ Tests

✓ Production Build 成功

---

# 五十六、最终交付

完成后输出：

1. Architecture Summary

2. Project Structure

3. Database Schema

4. Content Format

5. Local Development

6. Production Deployment

7. Markdown Import Guide

8. Backup / Restore

9. Security Notes

10. Future Improvements

同时生成完整：

README.md

ARCHITECTURE.md

DEPLOYMENT.md

---

最重要的一点：

**不要把这个项目做成“又一个博客模板”。**

前台应该让人感觉这是一个完整的个人数字空间。

后台应该让管理员感觉这是一个真正的 Publishing Tool。

Markdown、Git 和 Web Admin 三者必须自然共存。

最终目标：

**比 Ghost 更轻、更自由、更适合技术内容，同时拥有 Ghost 级别的发布体验。**

现在开始。

第一步先检查当前工作目录，如果为空，则初始化项目；如果已经存在项目，则先完整理解现有代码后再规划。

先创建 `ARCHITECTURE.md` 和基础项目骨架，然后立即进入实现，不要在只输出计划后停止。
