# dsh-memory-recall

DSH（DeepSeek Harness）的跨项目记忆召回插件 —— **V0.1 冻结版**。

## 它做什么

自动把与当前话题相关的长期记忆召回进上下文，不需要手动检索。

- 按项目组织记忆，跨窗口共享
- 关键词命中 + 相关性排序，挑最相关的一小段注入
- 有预算上限，不会把上下文撑爆
- 显示在聊天区的 client bar 上，召回了几条一目了然

## 目录

```
index.js            插件入口（工具注册、召回逻辑接线）
lib/db.js           记忆库读取
lib/recall.js       召回与排序
lib/text.js         分词、相关度
lib/state.js        运行状态
lib/trust.js        信任/权限判断
lib/home.js         数据目录定位
locale/             中英文文案
cordis.patch.yml    宿主 patch（insert 一行）
icon.svg            图标
```

## 安装

```bash
dsh plugin --profile web add link:/path/to/memory-recall
```

或从本仓库直接装：

```bash
dsh plugin --profile web add https://codeload.github.com/Zy082127/dsh-memory-recall/tar.gz/refs/heads/main
```

装完需要重启 DSH 才会注册客户端 UI。

## 依赖

- DSH 0.2.x（`0.2.1-rc.2` 上验证通过）
- 记忆库由 `meow-memory` 提供

## 版本

V0.1 —— 接口已冻结，详见 `V0.1-FROZEN.md`。
