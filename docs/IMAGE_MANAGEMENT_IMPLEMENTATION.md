# 蜜蜂图库实施与维护指南

本文记录 2.0.0 图库管理功能的最终实现、开发中确认的服务端差异、Obsidian 适配方式和后续维护约束。设计目标见 [IMAGE_MANAGEMENT_DESIGN.md](./IMAGE_MANAGEMENT_DESIGN.md)，通用项目说明见 [DEV_NOTES.md](../DEV_NOTES.md)。

最后验证日期：2026-07-31。单元测试、构建以及真实 Obsidian + 蜜蜂图床环境中的浏览、相册筛选、排序、引用统计和删除均已通过。

## 1. 功能范围

- 上传固定使用注册用户储存策略 ID `5`。
- 设置页以相册名称展示下拉框，展开或聚焦时刷新全部相册。
- 在独立 `ItemView` 中浏览、搜索、筛选、排序、预览和删除图床图片。
- 统计图片在当前 Vault Markdown 文件中的引用次数和涉及笔记数。
- 删除前展示引用影响，删除后验证远端状态再提示成功。

## 2. 模块边界

| 文件 | 职责 |
|---|---|
| `main.ts` | 插件生命周期、设置、上传、认证和 BeeImg API 客户端 |
| `image-manager.ts` | 图库 `ItemView`、卡片、预览 Modal、删除确认 Modal |
| `image-utils.ts` | v1/v2 类型、URL 构建、响应校验、身份映射、本地排序分页 |
| `image-usage.ts` | Markdown 图片地址提取、双向引用计数存储 |
| `image-usage-index.ts` | Vault 初始扫描和 Obsidian 增量事件适配 |
| `styles.css` | 工具栏、正方形缩略图、预览、引用和删除 UI |
| `tests/` | 不依赖 Obsidian 运行时的纯函数与计数回归测试 |

`image-manager.ts` 只依赖最小的 `ImageManagerClient` 接口，不直接导入 `main.ts`。API 数据和 Vault 引用状态分别由 `BeeImgClient`、`ImageUsageIndex` 提供，避免 UI 承担数据一致性逻辑。

## 3. API 兼容策略

蜜蜂图床同时存在 v1 和 v2 接口，实际行为与 OpenAPI 描述并不完全一致。当前实现有意组合两套接口。

| 能力 | 接口 | 使用原因 |
|---|---|---|
| 登录、资料 | `/api/v1/login`、`/api/v1/profile` | 与既有认证链路兼容 |
| 上传 | `POST /api/v1/upload` | 返回现有上传格式和原图链接 |
| 相册列表 | `GET /api/v1/albums` | 设置页和图库相册下拉框 |
| 图片元数据 | `GET /api/v1/images` | 提供 `size`、`date`、缩略图及原图链接 |
| 图片身份和相册关系 | `GET /api/v2/user/photos` | 提供稳定 `id` 和 `albums[]` |
| 删除 | `DELETE /api/v2/user/photos` | 请求体为图片 ID 数组，实际删除可靠 |

所有请求都携带 `Authorization: Bearer {token}`。API Token 至少需要图库读取权限；删除还需要图片写入权限。v2 返回 HTTP 403 时应展示真实错误，不能降级成 v1 删除。

参考文档：

- [API 索引](https://beeimg.apifox.cn/llms.txt)
- [v1 图片列表](https://beeimg.apifox.cn/450605924e0.md)
- [v2 图片列表](https://beeimg.apifox.cn/450605962e0.md)
- [v2 删除图片](https://beeimg.apifox.cn/450605965e0.md)

### 3.1 已确认的接口差异

| 现象 | 原因或风险 | 最终处理 |
|---|---|---|
| v1 图片列表传 `album_id` 返回 HTTP 500 | 生产接口实现与文档不一致 | v1 不再发送 `album_id`，使用 v2 `albums[]` 本地筛选 |
| v1 `order` 参数不改变结果 | 服务端忽略排序参数 | 获取完整结果后在插件内排序 |
| v2 列表没有文件大小 | 无法单独支持“最大/最小” | 保留 v1 元数据，再与 v2 身份合并 |
| v1 删除返回成功但图片仍存在 | HTTP 2xx 或响应状态不足以证明删除 | 改用 v2 删除，并重新查询 v2 列表验证 ID 已消失 |
| v1 `key` 与 v2 `id` 语义不同 | 直接混用存在误删风险 | 按原图 URL、其次按 `pathname` 显式映射 |

## 4. 上传与相册设置

注册用户的上传储存策略固定为：

```ts
const REGISTERED_USER_STORAGE_STRATEGY_ID = 5;
```

上传 multipart 字段包含 `file`、`strategy_id=5` 和 `permission`。只有 `albumId > 0` 时才发送 `album_id`；“不使用相册”必须完全省略该字段，不能发送 `0` 或空字符串。

设置页相册选择器的行为：

1. 初始保留当前相册值，避免设置页打开时闪烁或丢失选择。
2. `pointerdown`、`focus` 和设置页首次显示时调用 `listAlbums()`。
3. `listAlbums()` 遍历 v1 相册分页并以 ID 去重。
4. 下拉选项值使用相册 ID，显示文字使用相册名称。
5. 原相册已不存在时回退到“不使用相册”并保存设置。

## 5. 图库数据流水线

一次未命中缓存的图库查询按以下顺序执行：

```text
ImageQuery
   |
   +--> 遍历 v1 /images 分页 --------> BeeImgImage（大小、时间、链接）
   |
   +--> 遍历 v2 /user/photos 分页 ---> V2ImageIdentity（ID、相册关系）
                                           |
                 URL / pathname 显式映射 --+
                                           |
                         相册筛选 -> 本地排序 -> 本地分页 -> ImagePage
```

### 5.1 v1 请求参数

v1 只发送：

- `page`：远端分页页码。
- `q`：非空搜索词。
- `permission`：`public` 或 `private`。

不要重新加入 `album_id` 或 `order`，除非真实生产接口重新验证通过并补充回归测试。

### 5.2 v1/v2 身份映射

`attachV2ImageIdentities()` 建立两张索引：

- 规范化 `public_url -> V2ImageIdentity`。
- `pathname -> V2ImageIdentity`。

匹配时先比较规范化原图 URL，再使用 `pathname` 兜底。匹配成功后把 v2 `id` 写入 `BeeImgImage.remoteId`。无法映射的 v1 残留记录不进入管理列表，避免误删，也避免删除后 v1 短暂缓存产生残留卡片。

URL 规范化只接受 HTTP(S)，移除 fragment，保留 query string，不做模糊域名或文件名匹配。

### 5.3 排序和分页

四种排序全部作用于完整合并结果：

| 选项 | 字段 | 方向 |
|---|---|---|
| 最新 | `date` | 降序 |
| 最早 | `date` | 升序 |
| 最大 | `size` | 降序 |
| 最小 | `size` | 升序 |

日期无法解析的项目排在有效日期之后；值相同时用 `key` 提供稳定次序。排序完成后再按 v1 返回的 `per_page` 本地切页，因此切换排序不会只重排当前远端页。

### 5.4 缓存和并发

完整合并结果缓存 30 秒，缓存键包含：

```text
q + permission + albumId
```

排序和页码不进入缓存键，因为它们只改变本地结果。以下操作必须清除缓存：

- 手动刷新图库。
- 上传成功。
- 删除成功。

搜索框防抖 300 ms。视图使用递增的 `requestSequence` 忽略过期响应，防止快速切换筛选条件时旧请求覆盖新结果。

## 6. 删除一致性

删除属于不可恢复操作，不能仅凭请求未抛错就提示成功。

最终流程：

1. 卡片使用已经映射并验证的 `remoteId`。
2. 删除确认框展示图片信息、当前 Vault 引用次数和涉及笔记。
3. 发送 `DELETE /api/v2/user/photos`，JSON 请求体为 `[remoteId]`。
4. 删除请求返回后重新遍历 v2 图片列表。
5. 目标 ID 仍存在时抛出错误，保留卡片，不显示成功 Notice。
6. 目标 ID 已消失时清除缓存、刷新列表，然后提示删除成功。
7. HTTP 404 视为远端状态已经同步；401 可在账号密码模式下刷新 Token 后重试；403 必须提示权限不足。

以后增加批量删除时也必须复用身份映射和删除后验证，不能直接传 v1 `key`。

## 7. 当前 Vault 引用统计

### 7.1 为什么不使用 `CachedMetadata.embeds`

真实 Obsidian 环境中，外部 HTTP 图片不一定进入 `CachedMetadata.embeds`。只读取该缓存会导致已经粘贴到笔记中的图床图片仍显示 0 次引用。

当前实现直接解析 Markdown 原文：

- 初始索引通过 `vault.getMarkdownFiles()` 和 `vault.cachedRead(file)` 读取全部笔记。
- `metadataCache.changed(file, data)` 直接解析事件携带的最新原文。
- `metadataCache.deleted` 移除文件贡献。
- `vault.rename` 迁移文件路径。

### 7.2 统计语法

计入：

- Markdown 图片：`![alt](https://example/image.png)`。
- 尖括号目标和标题：`![alt](<https://example/image.png> "title")`。
- 原始 HTML：`<img src="https://example/image.png">`。
- 同一文件中同一 URL 的重复图片嵌入。

不计入：

- 普通 Markdown 链接和纯文本 URL。
- 围栏代码块、行内代码和 HTML 注释。
- 转义后的图片语法。
- Canvas、PDF、附件元数据和其他 Vault。

### 7.3 数据结构和竞争控制

`ImageUsageStore` 同时维护：

- `filePath -> URL/count`，用于文件更新时撤销旧贡献。
- `URL -> filePath/count`，用于图库按 URL 常数时间查询。

初始读取是异步的，用户可能同时粘贴或编辑图片。`ImageUsageIndex` 为每个文件维护修订号；异步读取结束时若修订号已经变化，就丢弃旧读取结果，避免覆盖更新事件写入的新统计。

状态包括 `idle`、`indexing`、`ready` 和 `error`。读取部分笔记失败时保留其他统计并显示不完整提示，不能把未知状态显示成确定的 0 次引用。

## 8. UI 与 Obsidian 样式兼容

### 8.1 正方形缩略图

只设置 `aspect-ratio: 1 / 1` 不足以覆盖 Obsidian 主题对 `button` 的固定控件高度，实际会显示成很薄的横条。最终样式同时使用：

- 高优先级选择器 `.beeimg-manager-view button.beeimg-image-preview-trigger`。
- `height: auto !important` 清除宿主按钮高度。
- `::before { padding-top: 100% }` 实际撑开正方形，作为比例兼容层。
- 缩略图使用 `position: absolute; inset: 0; object-fit: cover` 铺满区域。

以后调整预览比例时必须同时修改 `aspect-ratio` 和伪元素的 `padding-top`，并在默认主题及至少一个第三方主题中验证。

### 8.2 私有图片预览

卡片先使用返回的缩略图 URL。原图直接加载失败时，客户端通过 `requestUrl` 获取二进制并创建临时 Blob URL。只有图片 URL 与设置的 `baseUrl` 完全同源时才附带 Bearer Token；跨域 CDN URL 不携带认证头，避免泄露 Token。

Modal 关闭时必须调用 `URL.revokeObjectURL()` 释放临时资源。

## 9. 错误处理约束

- 使用 `requestUrl` 时读取异常对象的 `status`、`json` 和 `text`，优先展示服务端 `message`。
- v1 成功状态可能是布尔 `true`，v2 通常是字符串 `success`，解析器兼容两者。
- 响应结构必须先校验对象、数组和关键字段，禁止把缺失 ID 或 URL 的项目静默渲染。
- 删除、相册查询和排序失败时保留最后一次成功内容，不能清空后伪装成空图库。
- 所有服务端名称和错误按纯文本写入 DOM，不使用 `innerHTML`。
- 账号密码模式仅在 401 或明确认证错误时清除缓存 Token 并重试一次。

## 10. 测试策略

`npm run build` 顺序执行：

1. `npm test`：esbuild 打包纯 TypeScript 测试，在 Node 运行。
2. `tsc -noEmit -skipLibCheck`：严格类型检查。
3. esbuild production：生成 Obsidian 加载的 `main.js`。

当前回归测试覆盖：

- v1/v2 URL 参数构建和响应格式校验。
- URL 规范化和认证同源判断。
- v1 图片与 v2 ID/相册关系映射，包括 `key !== id`。
- 最新、最早、最大、最小全量排序和本地分页。
- Markdown/HTML 图片提取，普通链接、代码、注释和转义排除。
- 同一笔记重复引用、多个笔记、更新、删除和重命名计数。

无法用 Node 单元测试覆盖的内容必须在真实 Obsidian 中验证：

- 相册筛选请求不再出现 HTTP 500。
- 四种排序视觉顺序正确。
- 粘贴、撤销和删除图片语法后引用数字更新。
- 缩略图在实际主题中保持正方形。
- 删除后蜜蜂图床网页中图片确实消失。

上述真实环境项目已于 2026-07-31 验证通过。

## 11. 后续修改检查清单

修改图库 API 时：

- 检查官方文档，也必须用真实账号验证生产行为。
- 不直接假设 v1 `key` 等于 v2 `id`。
- 新增筛选条件时同步决定它属于远端查询、本地处理还是缓存键。
- 改动删除逻辑时保留删除后远端复核。
- API 响应新增可选字段时继续使用结构化解析，不在 UI 内访问未知 JSON。

修改引用统计时：

- 明确新语法是否代表“渲染中的图片”，避免把普通链接计为引用。
- 为解析边界补纯函数测试。
- 保留异步初始读取与增量事件之间的修订号保护。
- 不持久化笔记路径和引用关系。

修改 UI 时：

- 检查 Obsidian 默认样式是否给 `button`、`select` 或 Modal 设置固定尺寸。
- 在窄窗口和移动宽度检查工具栏、卡片文字和 Modal。
- 图标按钮保留 `aria-label`、`title` 和键盘焦点样式。

## 12. 发布流程

发布前执行：

```bash
npm ci
npm run build
git diff --check
```

同步更新 `package.json`、`manifest.json` 和 `versions.json` 中的版本。推送 `main` 会触发 CI；推送形如 `v2.0.0` 的 tag 会触发 GitHub Release，构建并上传：

- `beeimg-uploader-{version}.zip`
- `main.js`
- `manifest.json`
- `styles.css`

tag 版本应与 `manifest.json` 一致，且必须指向已经通过 CI 的提交。
