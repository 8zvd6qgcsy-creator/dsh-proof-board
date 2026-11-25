# 参与贡献

谢谢愿意搭把手。这个插件很小，所以规矩也很少。

## 开发环境

不需要装任何依赖：

```bash
git clone https://github.com/8zvd6qgcsy-creator/dsh-proof-board.git
cd dsh-proof-board
node --test test/*.test.mjs   # 15 条单测，约 0.2 秒
```

改完以后在 DSH 里装一次看效果：

```text
plugin_manager action: install_bundle target: <这个目录的绝对路径>
```

改了 Host 侧代码（`lib/*.js`）之后，需要在 **插件** 里把「审阅台」关掉再打开，模块才会重新加载；只改 `web/` 的话刷新页面就够。

## 提交前

- `node --test test/*.test.mjs` 全绿；
- 动过 `lib/board.js` 的扫描或批注逻辑，就补一条对应的测试；
- 动过界面，在 DSH 里真点一遍——缩略图、批注、交接清单三个流程至少过一遍。

## 代码风格

- 原生 ESM，不加构建步骤；`web/` 里也是原生 DOM，不引入框架。
- 注释说明「为什么」，不复述代码在做什么。
- 中文注释、英文标识符；面向用户的文案走 `locale/`。

## 一个容易踩的坑

仓库里的文本文件统一 **UTF-8 无 BOM、LF 换行**。用 Windows 记事本编辑会写入 BOM 和 CRLF，PR 会变成整文件重写。编辑器里请设成 `LF` + `UTF-8`。

（顺带一提，插件自身在 1.0.1 起已经能容忍 `notes.json` 里的 BOM 了——但仓库文件还是请保持干净。）

## 分支与发版

- 改动走 PR，CI 会自动跑单测；
- 合并后在 `main` 上打 tag（`v1.1.0`）并推送，`release` 工作流会自动跑测试、打包、建 Release 并挂上 tgz；
- 发版说明由 `.github/release.yml` 按标签分类自动生成，PR 记得打上 `feature` / `bug` / `performance` 之类的标签。