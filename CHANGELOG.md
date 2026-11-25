# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.0.1] - 2026-11-25

### 修复

- **批注读不出来**：用 Windows 记事本改过 `~/.dsh/proof-board/notes.json`（或某个 `SKILL.md`）之后，插件会读空——记事本保存 UTF-8 会加 BOM，`JSON.parse` 和 frontmatter 正则都不认。现在读之前先剥 BOM，并补了一条带 BOM 的回归测试。
- 工具注册缺少 `output` 声明导致插件激活失败（1.0.0 安装时暴露，已在 1.0.1 前的开发轮次修掉）。

### 测试

- 单测从 14 条增加到 15 条。

## [1.0.0] - 2026-11-25

### 新增

- **卡片墙**：工作区里的演示 / 文档 / 表格 / 图片 / 网页 / PDF 按修改时间排开，最多 200 项，支持按类型筛选与文件名搜索。
- **真实预览**：PPT / Word / Excel 通过 DSH 的 `officeKit` 渲染首页（按 mtime + 体积缓存）；网页与 PDF 用 iframe 实时渲染；图片直出；`.md` / `.txt` 显示开头几行。
- **逐项批注**：通过 / 待改 / 待定 + 一句话，存在 `~/.dsh/proof-board/notes.json`，按工作区分组。
- **回流给 agent**：「把批注交给 agent」把批注整理成提示词填进新会话草稿；「生成交接清单」写出 `审阅清单-时间.md`。
- **三个工具**：`proof_board_scan` / `proof_board_note` / `proof_board_handoff`。
- **两个 skill**：`proof-board`（怎么用台面）、`deliverable-review`（交付物质检清单）。
- **侧栏面板**：`sidebar.panellist` 入口 + `main` 面板，主题与语言跟随 DSH 热切换。

### 说明

- HTML 交付物以 `sandbox` iframe 渲染，页面与 DSH 同源；文件访问做了越界检查（`..`、隐藏文件、逃逸的符号链接一律拒绝）。
- 没有 `officeKit` 的部署里，Office 文件退化成文件卡片，其余功能不受影响。

[Unreleased]: https://github.com/8zvd6qgcsy-creator/dsh-proof-board/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/8zvd6qgcsy-creator/dsh-proof-board/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/8zvd6qgcsy-creator/dsh-proof-board/releases/tag/v1.0.0