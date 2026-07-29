# 开发技术笔记

记录蜜蜂图床 Obsidian 插件开发过程中的技术细节和踩过的坑，供后续维护者和二次开发者参考。

## 项目结构

```
obsidian-beeimg-uploader/
├── manifest.json          # Obsidian 插件清单（id/name/version/minAppVersion）
├── main.ts                # 唯一源码文件（约 800 行）
├── main.js                # esbuild 打包产物（运行时加载）
├── styles.css             # 样式（当前为空占位）
├── esbuild.config.mjs     # esbuild 构建配置
├── tsconfig.json          # TypeScript 配置
├── package.json           # npm 依赖与脚本
├── versions.json          # 版本兼容性映射
├── README.md              # 用户文档
└── DEV_NOTES.md           # 本文
```

## 构建链

- **TypeScript → JavaScript**：用 esbuild（非 tsc）打包，目标 `es2018`，CJS 格式
- **外部依赖**：`obsidian`、`electron`、`@codemirror/*`、`@lezer/*` 都标记为 external，由 Obsidian 运行时提供
- **构建命令**：`npm run build` = `tsc -noEmit -skipLibCheck && node esbuild.config.mjs production`
  - 先用 tsc 做类型检查（不产 out 文件）
  - 再用 esbuild 打包产出 `main.js`
- **开发模式**：`npm run dev` 启用 esbuild watch，配合 Obsidian 的热重载

## 架构分层

`main.ts` 单文件三段式：

1. **工具函数**（行 60-150）：`buildMultipart`、`extFromMime`、`timestampName`
2. **API 客户端 `BeeImgClient`**（行 150-360）：封装所有 HTTP 调用
3. **主插件 `BeeImgPlugin` + 设置面板 `BeeImgSettingTab`**（行 360+）：事件处理、编辑器操作、UI

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

并加「查询相册」按钮调用 `GET /api/v1/albums`，让用户看到合法 ID。

---

### 坑 6：strategy_id 导致"服务异常"（最坑的一个）

**症状**：上传报「服务异常，请稍后再试」，鉴权通过、相册 ID 也对了。

**真相**：蜜蜂图床**只有一个储存策略，ID = 4**（名为 `TEMP`）。插件默认 `storageId = 1`（PicGo 等工具的常见默认值），服务端找不到 ID=1 的策略就抛未捕获异常，返回笼统的"服务异常"。

**验证**：
```bash
curl -s https://www.beeimg.cn/api/v1/strategies
# {"status":true,"message":"success","data":{"strategies":[{"id":4,"name":"TEMP"}]}}
```

**修复**：
1. 默认 `storageId` 改为 4
2. 新增 `listStrategies()` 方法
3. 设置面板加「查询策略」按钮
4. 上传 catch 到"服务异常"时自动查策略列表，把可用 ID 拼进错误消息：
   ```
   服务异常，请稍后再试
   提示：可用储存策略：ID 4 (TEMP)。请在插件设置中修正「储存策略 ID」。
   ```

**教训**：笼统的"服务异常"几乎都是字段值非法（违反 DB 约束、外键不存在等），要主动查相关列表接口辅助诊断。**默认值不要照搬其他工具的，要用 API 查实际值**。

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
| 储存策略列表 | GET | `/api/v1/strategies` | 可选 | 查 strategy_id |
| 相册列表 | GET | `/api/v1/albums` | Bearer | 查 album_id |
| 上传图片 | POST | `/api/v1/upload` | Bearer | multipart：file, strategy_id, permission, album_id(可选) |

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
