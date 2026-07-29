# BeeImg 蜜蜂图床上传

一个 Obsidian 插件，在粘贴或拖拽图片时自动上传到[蜜蜂图床](https://www.beeimg.cn/)（基于 Lsky Pro），并把文档中的图片链接替换为图床外链。

## 功能

- **粘贴自动上传**：在 Markdown 编辑器里 Ctrl+V 粘贴图片，直接上传到蜜蜂图床，插入 `![文件名](图床链接)`
- **拖拽自动上传**：拖入图片文件自动上传，支持多图
- **手动上传剪贴板**：命令面板搜「上传剪贴板中的图片到蜜蜂图床」
- **批量上传本地图片**：命令「上传当前文档中的所有本地图片到蜜蜂图床」，扫描 `![[xxx.png]]` 和 `![](path)` 本地引用，上传后替换为图床链接
- **占位符策略**：上传中先插入 `![正在上传…](#beeimg-xxx)`，成功替换为链接，失败替换为 HTML 注释，不丢失上下文
- **两种认证模式**：API Token（推荐）或账号密码自动登录
- **设置面板内置诊断**：「测试连接」「查询策略」「查询相册」按钮，一键排查配置问题

## 安装

### 方式一：手动安装

1. 从 [Releases](https://github.com/guyu-guyu/beeimg-uploader/releases) 下载最新版的 `beeimg-uploader-x.y.z.zip`
2. 解压得到 `manifest.json`、`main.js`、`styles.css` 三个文件
3. 在你的 vault 中创建目录 `.obsidian/plugins/beeimg-uploader/`
4. 把三个文件放入该目录
5. 打开 Obsidian → 设置 → 第三方插件 → 关闭安全模式
6. 在已安装插件列表中找到「BeeImg 蜜蜂图床上传」并启用

### 方式二：通过 BRAT 安装

Releases 里同时附带了 `main.js`、`manifest.json`、`styles.css` 三个单独文件，可被 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 等 Obsidian 插件管理器直接识别：

1. 安装 BRAT 插件
2. BRAT → Add Beta plugin → 填入 `https://github.com/guyu-guyu/beeimg-uploader`
3. BRAT 会自动拉取最新 Release 的三个文件并安装

### 从源码构建

```bash
git clone <repo-url>
cd obsidian-beeimg-uploader
npm install
npm run build      # 产出 main.js
# 或开发模式（监听改动自动 rebuild）：
npm run dev
```

构建产物 `main.js` 与 `manifest.json`、`styles.css` 一起复制到插件目录即可。

## 配置

启用插件后，在设置里配置：

1. **API 基地址**：默认 `https://www.beeimg.cn`，一般不用改
2. **认证方式**：
   - **API Token（推荐）**：到蜜蜂图床「个人设置 → API Token」创建一个持久令牌，完整复制（含数字前缀和竖线，如 `5|ll0yN65FmPPPur9...`）填入。注意：**临时上传 Token 不能用于此插件**。
   - **账号密码**：填入用户名/邮箱/手机号 + 密码，插件自动登录获取 token 并缓存，遇到 401 自动重新登录。
3. **储存策略 ID**：默认 `4`（蜜蜂图床目前只有 ID=4 的 `TEMP` 策略）。如不确定点「查询策略」按钮。
4. **相册 ID**：填 `0` 表示不上传到任何相册（插件会省略该字段）；想归入相册则点「查询相册」查看合法 ID。
5. 点「测试」按钮验证配置，显示 `✓ 连接成功：你的用户名` 即可。

## 使用

### 粘贴图片
直接在 Markdown 编辑器里 Ctrl+V，图片不会保存到 vault，直接上传后插入图床链接。

### 拖拽图片
把图片文件拖到编辑器，自动上传并插入。

### 批量上传本地图片
打开含本地图片引用的文档，命令面板执行「上传当前文档中的所有本地图片到蜜蜂图床」，插件会扫描：
- Obsidian wikilink 格式：`![[xxx.png]]`
- 标准 markdown 本地引用：`![](相对路径.png)`

逐张上传后原地替换为图床链接。

## 设置项一览

| 设置 | 默认值 | 说明 |
|------|--------|------|
| API 基地址 | `https://www.beeimg.cn` | 站点地址 |
| 认证方式 | API Token | API Token 或账号密码 |
| 储存策略 ID | `4` | 对应 `/api/v1/strategies` 返回的 id |
| 相册 ID | `0` | 0 = 省略该字段；>0 = 上传到指定相册 |
| 公开图片 | 关 | 是否对外公开（公开会出现在广场） |
| 粘贴时自动上传 | 开 | 拦截 `editor-paste` |
| 拖拽时自动上传 | 开 | 拦截 `editor-drop` |
| 启用批量上传命令 | 开 | 注册命令面板项 |

## 故障排查

| 现象 | 原因与解决 |
|------|-----------|
| `Unexpected token '<'` | baseUrl 配错或路径返回了 HTML。确认 baseUrl 是 `https://www.beeimg.cn` |
| `Token 无效（Unauthenticated）` | token 复制不完整或用了临时上传 Token。重新到「个人设置 → API Token」创建并完整复制 |
| `服务异常，请稍后再试` | **储存策略 ID 填错**。点「查询策略」确认正确 ID（蜜蜂图床通常是 4） |
| `相册不存在` | 相册 ID 填了不存在的值。填 0（省略字段）或点「查询相册」选合法 ID |
| 粘贴无反应 | 检查设置里「粘贴时自动上传」是否开启；确认插件已启用 |

## 许可

MIT
