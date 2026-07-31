# 开发技术笔记

记录蜜蜂图床 Obsidian 插件开发过程中的技术细节和踩过的坑，供后续维护者和二次开发者参考。

图库管理 2.0.0 的完整数据流、API 兼容决策、引用索引和删除一致性说明见 [docs/IMAGE_MANAGEMENT_IMPLEMENTATION.md](docs/IMAGE_MANAGEMENT_IMPLEMENTATION.md)。

## 项目结构

```
obsidian-beeimg-uploader/
├── manifest.json          # Obsidian 插件清单（id/name/version/minAppVersion）
├── main.ts                # 插件生命周期、上传与 API 客户端
├── image-manager.ts       # 图库视图、预览与删除确认
├── image-utils.ts         # 图片 API 类型、响应规范化和 URL 工具
├── image-usage.ts         # 可测试的图片引用双向计数存储
├── image-usage-index.ts   # Obsidian 元数据缓存事件适配
├── tests/                 # 纯数据层与引用索引单元测试
├── main.js                # esbuild 打包产物（运行时加载）
├── styles.css             # 图库、预览和删除确认样式
├── esbuild.config.mjs     # esbuild 构建配置
├── test.config.mjs        # esbuild 测试打包与 Node 测试入口
├── tsconfig.json          # TypeScript 配置
├── package.json           # npm 依赖与脚本
├── versions.json          # 版本兼容性映射
├── README.md              # 用户文档
├── docs/                  # 设计文档与图库实施维护指南
└── DEV_NOTES.md           # 本文
```

## 构建链

- **TypeScript → JavaScript**：用 esbuild（非 tsc）打包，目标 `es2018`，CJS 格式
- **外部依赖**：`obsidian`、`electron`、`@codemirror/*`、`@lezer/*` 都标记为 external，由 Obsidian 运行时提供
- **构建命令**：`npm run build` = 单元测试 + TypeScript 类型检查 + esbuild 生产打包
  - 先用 `test.config.mjs` 打包并运行纯数据层测试
  - 再用 tsc 做类型检查（不产 out 文件）
  - 最后用 esbuild 打包产出 `main.js`
- **开发模式**：`npm run dev` 启用 esbuild watch，配合 Obsidian 的热重载

## 架构分层

1. **工具与领域层**：`image-utils.ts`、`image-usage.ts`
2. **Obsidian 适配层**：`image-usage-index.ts`、`image-manager.ts`
3. **插件与 API 客户端**：`main.ts`

图库 UI 通过最小 `ImageManagerClient` 接口依赖 API 客户端，避免 `image-manager.ts` 反向导入 `main.ts`。远端图片数据与当前 Vault 引用统计保持独立。

### 为什么手动构造 multipart/form-data？

Obsidian 的 `requestUrl` API 不直接支持 `FormData`（在 Electron 渲染进程里 FormData 与 Node 端不互通），且直接用 `fetch` 会撞 CORS。所以 `buildMultipart()` 手动拼 `multipart/form-data` body：

```ts
function buildMultipart(fields: Record<string, string | {name, data, type}>)
```

用 `TextEncoder` 处理文本部分，二进制部分直接拼接 `Uint8Array`，最后用随机 boundary 包裹。注意每个部分结尾必须有 `\r\n`，结尾 boundary 是 `--${boundary}--\r\n`。

### 占位符替换策略

上传是异步的，用户可能继续编辑文档，直接用字符串查找替换可能错位。当前做法：

1. 上传前 `editor.replaceSelection(placeholder + "\n")` 插入占位符
2. 上传完成后用 `editor.getValue()` 全文查找占位符位置，`editor.offsetToPos` 转坐标，`editor.replaceRange` 精确替换

**潜在问题**：如果用户在上传期间编辑了占位符那一行，替换会找不到。当前用 `#beeimg-${Date.now()}-${random}` 保证占位符唯一，但仍可能被用户删除。失败时替换为 `<!-- 上传失败：msg -->` 而非删除，保留上下文。

---

## 踩坑记录

### 坑 1：API 路径前缀

**症状**：测试连接返回 `Unexpected token '<'`，响应是 `<!DOCTYPE html>...`

**误判**：以为 baseUrl 配错。

**真相**：蜜蜂图床（基于 Lsky Pro）的 API **全部挂在 `/api/v1` 前缀下**，但 Apifox 文档里写的路径是 `/upload`、`/user/profile`（相对于 `/api/v1`）。直接拼 `https://www.beeimg.cn/upload` 命中的是 SPA 前端路由，返回 HTML。

**验证方法**：
```bash
curl -s -o /dev/null -w "%{content_type}" https://www.beeimg.cn/upload
# text/html  ← 错

curl -s -o /dev/null -w "%{content_type}" https://www.beeimg.cn/api/v1/upload
# application/json  ← 对
```

**修复**：新增 `apiBase()` 方法统一拼接 `/api/v1`，所有调用走它。

**教训**：Apifox 文档的路径不一定是完整 URL，要看 `servers` 字段或实际探测。Lsky Pro 文档的 `servers` 写的是 `http://127.0.0.1:8000/api/v2`，但旧版接口实际在 `/api/v1`。

---

### 坑 2：用户信息接口路径

**症状**：修正前缀后测试连接仍返回 HTML。

**真相**：文档标注的新版接口 `/user/profile` 在蜜蜂图床站点不存在（返回 SPA HTML）。实际可用的是旧版接口 **`/api/v1/profile`**（无 `/user` 前缀）。

**验证**：
```bash
curl -s https://www.beeimg.cn/api/v1/profile
# {"status":"error","message":"Unauthenticated.","time":...}

curl -s https://www.beeimg.cn/api/v1/user/profile
# {"message":"The route api/v1/user/profile could not be found."}
```

**修复**：`verifyToken()` 用 `${apiBase()}/profile`。

**教训**：蜜蜂图床对"新版接口"的适配可能不完整，优先用旧版接口（`/api/v1/*`）。

---

### 坑 3：响应 envelope 的 status 字段类型

**症状**：上传成功但代码判断 `env.status !== "success"` 走了错误分支。

**真相**：Lsky Pro 的 envelope 有两种风格：
- 新版接口：`status: "success" | "error"`（字符串）
- 旧版接口：`status: true | false`（布尔）

同一个 `/api/v1/upload` 接口返回 `{"status": false, "message": "..."}`。

**修复**：`ApiEnvelope.status` 类型放宽为 `string | boolean`，所有成功判断统一写：
```ts
const ok = env.status === true || env.status === "success";
```

---

### 坑 4：Token 401 错误信息不透明

**症状**：测试连接显示 `Request failed, status 401`，看不出原因。

**真相**：Obsidian 的 `requestUrl` 在非 2xx 时抛异常，但异常对象里带 `status`、`json`、`text` 字段，默认 `e.message` 只是 `"Request failed, status 401"`，丢失了服务端返回的 `{"message":"Unauthenticated."}`。

**修复**：重写 `extractError()`：
```ts
const any = e as { status?: number; json?: any; text?: string };
if (any?.status && any.status >= 400) {
    const serverMsg = any.json?.message || any.text || "";
    return `HTTP ${any.status}${serverMsg ? "：" + serverMsg : ""}`;
}
```

并在 `verifyToken` 里对 401 给专项诊断建议（token 复制不完整 / 用错类型 / 已删除）。

---

### 坑 5：album_id 严格校验

**症状**：上传报「相册不存在」，填 0 或真实 ID 都失败。

**真相**：蜜蜂图床的 `/api/v1/upload` 对 `album_id` 做**严格存在性校验**，`0` 不是合法值（不像 PicGo 约定 0 = 无相册）。文档 example 是空字符串 `''`，但传空字符串在某些版本也会校验失败。

**修复**：当 `albumId === 0` 时**完全不发送 `album_id` 字段**（从 multipart 字段对象里省略），让服务端用默认行为：
```ts
const fields: Record<...> = { file, strategy_id, permission };
if (this.settings.albumId > 0) fields.album_id = String(this.settings.albumId);
```

1.1.0 起设置页改为相册下拉框；打开设置页或展开下拉框时调用 `GET /api/v1/albums`，自动遍历分页，并以相册名称作为选项文字。

---

### 坑 6：注册用户的 strategy_id 必须固定为 5

**症状**：上传报「服务异常，请稍后再试」，鉴权通过、相册 ID 也正确。

**真相**：注册用户应使用储存策略 **ID = 5**。旧版允许用户手填 `storageId`，错误值会触发服务端异常，也给设置增加了不必要的复杂度。

**1.1.0 修复**：

1. 从 `BeeImgSettings` 和设置面板删除 `storageId`
2. 上传时始终发送 `strategy_id=5`
3. 加载旧配置时删除遗留的 `storageId` 字段并重新保存
4. 删除不再需要的策略列表查询逻辑

**教训**：当业务身份已经唯一确定储存策略时，应在代码中固定领域规则，不把无效选择暴露为用户设置。

---

### 坑 7：Obsidian 事件回调签名

**症状**：TypeScript 编译报 `Argument of type '"editor-paste"' is not assignable to parameter of type '"quit"'`。

**真相**：Obsidian 的事件回调签名是 `(event, editor, info)`，我最初按常见习惯写成 `(editor, event)`，参数顺序反了导致类型推断落到兜底重载。

**修复**：
```ts
// 错：handlePaste(editor: Editor, event: ClipboardEvent)
// 对：handlePaste(event: ClipboardEvent, editor: Editor)
```

**教训**：Obsidian 的 `workspace.on(name, callback)` 是重载的，callback 签名必须精确匹配 `obsidian.d.ts` 里的声明，否则类型推断会失败到 `'quit'` 兜底。查 `node_modules/obsidian/obsidian.d.ts` 里对应事件名的声明。

---

## API 速查表（实测蜜蜂图床可用）

| 接口 | 方法 | 路径 | 鉴权 | 用途 |
|------|------|------|------|------|
| 用户资料 | GET | `/api/v1/profile` | Bearer | 验证 token |
| 相册列表 | GET | `/api/v1/albums` | Bearer | 查 album_id |
| 上传图片 | POST | `/api/v1/upload` | Bearer | multipart：file, strategy_id=5, permission, album_id(可选) |
| 图片列表 | GET | `/api/v1/images` | Bearer | 获取完整元数据、搜索和公开状态筛选 |
| 相册图片 | GET | `/api/v2/user/photos` | Bearer | 按 album_id 查询相册成员 ID |
| 删除图片 | DELETE | `/api/v2/user/photos` | Bearer | JSON 图片 ID 数组；删除后重新查询列表确认结果 |

**鉴权头**：`Authorization: Bearer {token}`，token 格式 `数字|随机串`（如 `5|ll0yN65...`）

**上传响应**：
```json
{
  "status": true,
  "message": "上传成功",
  "data": {
    "key": 21,
    "name": "xxx",
    "links": {
      "url": "https://...",
      "markdown": "![xxx](https://...)"
    }
  }
}
```

注意取 `data.links.url`（旧版格式），不是 `data.public_url`（新版格式，蜜蜂图床不返回）。

---

## 图库管理与引用索引

2.0.0 增加独立 `ItemView` 类型 `beeimg-image-manager`，通过功能区图标或命令面板打开。旧版列表接口的 `album_id` 在生产环境会触发 HTTP 500，`order` 也可能被忽略，因此客户端遍历 v1 分页取得完整元数据，使用 v2 接口取得相册成员 ID，再在本地完成相册筛选、四种排序和分页。完整结果按筛选条件缓存 30 秒；手动刷新、上传和删除会立即清除缓存。搜索输入防抖 300 ms，并用请求序号忽略过期响应。

图片引用统计直接解析 Markdown 原文，避免外部 HTTP 图片未进入 `CachedMetadata.embeds` 时始终显示 0：

- `ImageUsageStore` 维护 `file -> URL/count` 与 `URL -> file/count` 两个方向
- 支持 Markdown 图片语法和 HTML `<img src>`，排除普通链接、代码和注释
- 同一笔记重复嵌入分别计数，引用笔记数按文件去重
- 初次索引通过 `vault.cachedRead` 读取全部 Markdown；`metadataCache.changed/deleted` 增量更新内容变化
- `vault.rename` 单独迁移路径，因为重命名不会触发 metadata `changed`
- URL 使用标准 `URL` API 规范化，忽略 fragment、保留 query
- 索引只存在于插件会话内，不写入 `data.json`

删除始终经过确认 Modal。只有服务端成功后才刷新图库；确认框显示引用次数和最多 5 个受影响笔记，且明确说明其他 Vault 与外部系统不在统计范围内。

删除不能直接把 v1 `key` 当成 v2 ID。列表加载时按规范化原图 URL、其次按 `pathname` 将 v1 图片与 v2 图片身份映射；无法确认 v2 身份的旧版残留记录不进入管理列表。`DELETE /api/v2/user/photos` 返回后重新遍历 v2 图片列表，只有目标 ID 已消失时才向用户提示删除成功。

私有图片直接加载失败时可以通过 `requestUrl` 获取二进制并创建临时 Blob URL，但只有图片 URL 与配置的 `baseUrl` 完全同源时才附带 Bearer Token。跨域 CDN 地址不得携带认证头。

---

## 调试技巧

### 用 curl 实测端点

开发时遇到错误，先用 curl 隔离是插件问题还是 API 问题：
```bash
# 探测路径是否存在（看 content-type）
curl -s -o /dev/null -w "%{http_code} %{content_type}" https://www.beeimg.cn/api/v1/xxx

# 看真实错误消息
curl -s -H "Authorization: Bearer YOUR_TOKEN" https://www.beeimg.cn/api/v1/profile
```

### Obsidian 开发者工具

`Ctrl+Shift+I` 打开 DevTools，Console 里能看到 `Notice` 之外的 `console.error` 和插件抛出的未捕获异常。

### 热重载

`npm run dev` 启用 watch，配合 Obsidian 的「禁用→启用」插件或 `[Hot-Reload](https://github.com/pjeby/hot-reload)` 插件实现改代码即时生效。

---

## 后续可改进点

- [ ] 支持新版接口 `/api/v2/upload`（当蜜蜂图床完全迁移后）
- [ ] 上传队列与并发控制（当前批量是串行）
- [ ] 图片压缩/缩放后再上传（减少流量）
- [ ] 失败重试与断点续传
- [ ] 国际化（i18n）
- [ ] BRAT 安装支持（发布 release）
