import {
    App,
    Editor,
    MarkdownView,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    requestUrl,
} from "obsidian";

// ============================ 类型定义 ============================

interface BeeImgSettings {
    baseUrl: string;
    authMode: "apiToken" | "password";
    apiToken: string;
    loginType: "username" | "email" | "phone";
    username: string;
    password: string;
    storageId: number;
    albumId: number;
    isPublic: boolean;
    isRemoveExif: boolean;
    enablePaste: boolean;
    enableDrop: boolean;
    enableBatchUpload: boolean;
    // 缓存（账号密码模式下）
    cachedToken: string;
}

const DEFAULT_SETTINGS: BeeImgSettings = {
    baseUrl: "https://www.beeimg.cn",
    authMode: "apiToken",
    apiToken: "",
    loginType: "username",
    username: "",
    password: "",
    storageId: 4,
    albumId: 0,
    isPublic: false,
    isRemoveExif: false,
    enablePaste: true,
    enableDrop: true,
    enableBatchUpload: true,
    cachedToken: "",
};

// API 响应信封。status 在新版接口为字符串 "success"/"error"，
// 在旧版接口（/api/v1/upload 等）为布尔 true/false。
interface ApiEnvelope<T> {
    status: string | boolean;
    message: string;
    data: T;
    time?: number;
}

// ============================ 工具函数 ============================

const MIME_TO_EXT: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
    "image/x-icon": "ico",
};

function extFromMime(mime: string): string {
    return MIME_TO_EXT[mime] || "png";
}

function timestampName(): string {
    const d = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(
        d.getHours()
    )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * 手动构造 multipart/form-data 请求体。
 * Obsidian 的 requestUrl 不直接支持 FormData，需要手动拼装以避免 CORS。
 */
function buildMultipart(
    fields: Record<
        string,
        string | { name: string; data: ArrayBuffer; type: string }
    >
): { body: ArrayBuffer; contentType: string } {
    const boundary =
        "----BeeImgBoundary" + Math.random().toString(36).slice(2);
    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [];
    const CRLF = "\r\n";

    for (const [key, value] of Object.entries(fields)) {
        parts.push(encoder.encode(`--${boundary}${CRLF}`));
        if (typeof value === "string") {
            parts.push(
                encoder.encode(
                    `Content-Disposition: form-data; name="${key}"${CRLF}${CRLF}${value}${CRLF}`
                )
            );
        } else {
            parts.push(
                encoder.encode(
                    `Content-Disposition: form-data; name="${key}"; filename="${value.name}"${CRLF}`
                )
            );
            parts.push(
                encoder.encode(`Content-Type: ${value.type}${CRLF}${CRLF}`)
            );
            parts.push(new Uint8Array(value.data));
            parts.push(encoder.encode(CRLF));
        }
    }
    parts.push(encoder.encode(`--${boundary}--${CRLF}`));

    const total = parts.reduce((s, p) => s + p.length, 0);
    const body = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
        body.set(p, offset);
        offset += p.length;
    }
    return {
        body: body.buffer,
        contentType: `multipart/form-data; boundary=${boundary}`,
    };
}

// ============================ API 客户端 ============================
//
// 经实测，蜜蜂图床（基于 Lsky Pro）的 API 全部挂在 `/api/v1` 前缀下：
//   - 上传：POST /api/v1/upload   返回 data.links.url（旧版字段格式）
//   - 用户信息：GET /api/v1/profile  返回 data.{username,name,...}
// 文档中不带前缀的路径（/upload、/user/profile 等）实际都需加 /api/v1。
// 上传响应 envelope 中 status 为布尔（true/false），而非字符串 "success"。

interface UploadLinks {
    url: string;
    markdown?: string;
    markdown_with_link?: string;
    html?: string;
    bbcode?: string;
    thumbnail_url?: string;
    delete_url?: string;
}
interface UploadResponseDataV1 {
    key: number;
    name: string;
    pathname: string;
    origin_name: string;
    size: number;
    mimetype: string;
    extension: string;
    md5: string;
    sha1: string;
    links: UploadLinks;
}

class BeeImgClient {
    constructor(private settings: BeeImgSettings) {}

    /** 获取有效 token：API Token 模式直接返回；账号密码模式按需登录。 */
    async ensureToken(): Promise<string> {
        if (this.settings.authMode === "apiToken") {
            if (!this.settings.apiToken) {
                throw new Error("未配置 API Token，请在插件设置中填写。");
            }
            return this.settings.apiToken;
        }

        // 账号密码模式：使用缓存 token，失效时由调用方触发重新登录
        if (this.settings.cachedToken) {
            return this.settings.cachedToken;
        }
        return await this.login();
    }

    /** 账号密码登录，返回 token 并写入缓存。 */
    async login(): Promise<string> {
        if (!this.settings.username || !this.settings.password) {
            throw new Error("未配置账号或密码。");
        }
        const url = `${this.apiBase()}/login`;
        const resp = await requestUrl({
            url,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify({
                login_type: this.settings.loginType,
                username: this.settings.username,
                password: this.settings.password,
                remember: true,
                token: "",
                country_code: "",
            }),
        });
        const env = this.parseJson(resp) as ApiEnvelope<{ name: string; token: string }>;
        // 旧版接口 status 为布尔 true，新版为字符串 "success"，兼容两者
        const ok =
            env.status === true || env.status === "success";
        if (!ok || !env.data?.token) {
            throw new Error(`登录失败：${env.message || "未知错误"}`);
        }
        this.settings.cachedToken = env.data.token;
        return env.data.token;
    }

    /** 清除缓存的登录 token（401 时调用）。 */
    invalidateToken() {
        this.settings.cachedToken = "";
    }

    /** 验证 token 是否有效（调用用户资料接口）。 */
    async verifyToken(): Promise<{ ok: boolean; message: string }> {
        try {
            const token = await this.ensureToken();
            const resp = await requestUrl({
                url: `${this.apiBase()}/profile`,
                method: "GET",
                headers: { ...this.authHeaders(token), Accept: "application/json" },
            });
            const env = this.parseJson(resp) as ApiEnvelope<{
                username?: string;
                name?: string;
            }>;
            const ok =
                env.status === true || env.status === "success";
            const who = env.data?.username || env.data?.name || "";
            return {
                ok,
                message: ok
                    ? `连接成功${who ? "：" + who : ""}`
                    : env.message || "认证失败",
            };
        } catch (e) {
            const any = e as { status?: number };
            if (any?.status === 401) {
                return {
                    ok: false,
                    message:
                        "Token 无效（服务端返回 Unauthenticated）。请检查：1) token 是否完整复制（含数字前缀和竖线，如 5|ll0yN65...）；2) 是否为「个人设置 → API Token」创建的持久令牌，而非临时上传 Token；3) token 是否已被删除。",
                };
            }
            return { ok: false, message: this.extractError(e) };
        }
    }

    /**
     * 上传图片，返回图床链接。
     * 失败时若为 401 且为账号密码模式，自动重试一次。
     */
    async upload(
        fileData: ArrayBuffer,
        filename: string,
        mimetype: string
    ): Promise<string> {
        const url = `${this.apiBase()}/upload`;
        const token = await this.ensureToken();

        const tryUpload = async (tok: string): Promise<string> => {
            // 动态构建字段：album_id 为 0 时省略该字段，
            // 因为蜜蜂图床会校验相册是否存在，0 不是合法相册 ID。
            const fields: Record<
                string,
                string | { name: string; data: ArrayBuffer; type: string }
            > = {
                file: { name: filename, data: fileData, type: mimetype },
                strategy_id: String(this.settings.storageId),
                permission: this.settings.isPublic ? "1" : "0",
            };
            if (this.settings.albumId > 0) {
                fields.album_id = String(this.settings.albumId);
            }
            const { body, contentType } = buildMultipart(fields);
            const resp = await requestUrl({
                url,
                method: "POST",
                headers: {
                    ...this.authHeaders(tok),
                    "Content-Type": contentType,
                    Accept: "application/json",
                },
                body,
            });
            const env = this.parseJson(resp) as ApiEnvelope<UploadResponseDataV1>;
            const ok =
                env.status === true || env.status === "success";
            const link = env.data?.links?.url;
            if (!ok || !link) {
                throw new Error(env.message || "上传失败：服务端未返回链接。");
            }
            return link;
        };

        try {
            return await tryUpload(token);
        } catch (e) {
            const msg = this.extractError(e);
            // 401 且账号密码模式：重新登录后重试一次
            if (
                this.settings.authMode === "password" &&
                /401|unauthor|认证|token/i.test(msg)
            ) {
                this.invalidateToken();
                const newToken = await this.login();
                return await tryUpload(newToken);
            }
            // "服务异常"通常是 strategy_id 不存在，附加可用策略列表帮助诊断
            if (/服务异常|异常/.test(msg)) {
                try {
                    const list = await this.listStrategies();
                    const hint =
                        list.length > 0
                            ? `可用储存策略：${list
                                  .map((s) => `ID ${s.id} (${s.name})`)
                                  .join("、")}。请在插件设置中修正「储存策略 ID」。`
                            : "站点未返回任何储存策略。";
                    throw new Error(`${msg}\n提示：${hint}`);
                } catch {
                    /* 查询失败就用原消息 */
                }
            }
            throw new Error(msg);
        }
    }

    /** 查询当前用户相册列表，返回 [{id, name}]。用于在设置面板选择合法 album_id。 */
    async listAlbums(): Promise<{ id: number; name: string; image_num: number }[]> {
        const token = await this.ensureToken();
        const resp = await requestUrl({
            url: `${this.apiBase()}/albums`,
            method: "GET",
            headers: { ...this.authHeaders(token), Accept: "application/json" },
        });
        const env = this.parseJson(resp) as ApiEnvelope<{
            data: { id: number; name: string; image_num: number }[];
        }>;
        const ok = env.status === true || env.status === "success";
        if (!ok || !env.data?.data) {
            throw new Error(env.message || "查询相册列表失败。");
        }
        return env.data.data;
    }

    /** 查询站点支持的储存策略列表，返回 [{id, name}]。用于确定合法 strategy_id。 */
    async listStrategies(): Promise<{ id: number; name: string }[]> {
        // 策略列表接口不需要鉴权也能返回，但带 token 更稳妥
        let token = "";
        try {
            token = await this.ensureToken();
        } catch {
            /* ignore */
        }
        const headers: Record<string, string> = { Accept: "application/json" };
        if (token) headers.Authorization = `Bearer ${token}`;
        const resp = await requestUrl({
            url: `${this.apiBase()}/strategies`,
            method: "GET",
            headers,
        });
        const env = this.parseJson(resp) as ApiEnvelope<{
            strategies: { id: number; name: string }[];
        }>;
        const ok = env.status === true || env.status === "success";
        if (!ok || !env.data?.strategies) {
            throw new Error(env.message || "查询策略列表失败。");
        }
        return env.data.strategies;
    }

    /** API 基地址 = 用户配置 baseUrl + /api/v1 */
    private apiBase(): string {
        return `${this.settings.baseUrl.replace(/\/+$/, "")}/api/v1`;
    }

    private authHeaders(token: string): Record<string, string> {
        return { Authorization: `Bearer ${token}` };
    }

    /**
     * 安全解析响应 JSON。
     * 当 baseUrl 配错或访问到了前端页面时，返回的是 HTML，此时给出清晰提示。
     */
    private parseJson(resp: { json: unknown; text?: string }): unknown {
        try {
            if (resp.json === undefined || resp.json === null) {
                throw new Error("空响应");
            }
            return resp.json;
        } catch (e) {
            const preview = (resp.text ?? "").slice(0, 80);
            throw new Error(
                `服务端未返回有效 JSON（可能 baseUrl 配错或该路径不存在）。响应片段：${preview || "<无法读取>"}`
            );
        }
    }

    /**
     * 从异常中提取可读错误消息。
     * Obsidian 的 requestUrl 在非 2xx 时抛出的异常带有 status / json / text 字段，
     * 需要读取服务端返回的真实消息而非 "Request failed, status XXX"。
     */
    private extractError(e: unknown): string {
        // requestUrl 抛出的 HTTP 异常
        const any = e as { status?: number; json?: any; text?: string; message?: string };
        if (any?.status && any.status >= 400) {
            const serverMsg =
                (any.json && (any.json.message || any.json.error)) ||
                any.text ||
                "";
            const preview = serverMsg ? `：${serverMsg}` : "";
            return `HTTP ${any.status}${preview}`;
        }
        if (e instanceof Error) return e.message;
        if (typeof e === "string") return e;
        try {
            return JSON.stringify(e);
        } catch {
            return "未知错误";
        }
    }
}

// ============================ 主插件 ============================

export default class BeeImgPlugin extends Plugin {
    settings!: BeeImgSettings;
    client!: BeeImgClient;

    async onload() {
        await this.loadSettings();
        this.client = new BeeImgClient(this.settings);

        // 粘贴上传
        if (this.settings.enablePaste) {
            this.registerEvent(
                this.app.workspace.on("editor-paste", this.handlePaste.bind(this))
            );
        }

        // 拖拽上传
        if (this.settings.enableDrop) {
            this.registerEvent(
                this.app.workspace.on("editor-drop", this.handleDrop.bind(this))
            );
        }

        // 命令：批量上传当前文档中的本地图片
        if (this.settings.enableBatchUpload) {
            this.addCommand({
                id: "beeimg-upload-local-images",
                name: "上传当前文档中的所有本地图片到蜜蜂图床",
                editorCallback: (editor: Editor) => {
                    this.uploadLocalImages(editor);
                },
            });
        }

        // 命令：手动上传剪贴板图片
        this.addCommand({
            id: "beeimg-upload-clipboard",
            name: "上传剪贴板中的图片到蜜蜂图床",
            editorCallback: (editor: Editor) => {
                this.uploadFromClipboard(editor);
            },
        });

        this.addSettingTab(new BeeImgSettingTab(this.app, this));
    }

    async loadSettings() {
        this.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            await this.loadData()
        );
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    // ---------- 事件处理 ----------

    private async handlePaste(event: ClipboardEvent, editor: Editor) {
        const items = event.clipboardData?.items;
        if (!items) return;
        let imageItem: DataTransferItem | null = null;
        for (const item of Array.from(items)) {
            if (item.type.startsWith("image/")) {
                imageItem = item;
                break;
            }
        }
        if (!imageItem) return;

        const file = imageItem.getAsFile();
        if (!file) return;

        event.preventDefault(); // 阻止 Obsidian 默认保存到 vault
        const ext = extFromMime(file.type);
        const filename = file.name && file.name !== "image.png"
            ? file.name
            : `Pasted_image_${timestampName()}.${ext}`;
        await this.uploadAndInsert(editor, await file.arrayBuffer(), filename, file.type);
    }

    private async handleDrop(event: DragEvent, editor: Editor) {
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0) return;
        const images = Array.from(files).filter((f) =>
            f.type.startsWith("image/")
        );
        if (images.length === 0) return;

        event.preventDefault();
        for (const f of images) {
            await this.uploadAndInsert(
                editor,
                await f.arrayBuffer(),
                f.name,
                f.type
            );
        }
    }

    /** 通过命令手动触发：读取剪贴板 */
    private async uploadFromClipboard(editor: Editor) {
        try {
            const items = await navigator.clipboard.read();
            for (const item of items) {
                const imageType = item.types.find((t) =>
                    t.startsWith("image/")
                );
                if (imageType) {
                    const blob = await item.getType(imageType);
                    const ext = extFromMime(imageType);
                    const filename = `Pasted_image_${timestampName()}.${ext}`;
                    await this.uploadAndInsert(
                        editor,
                        await blob.arrayBuffer(),
                        filename,
                        imageType
                    );
                    return;
                }
            }
            new Notice("剪贴板中没有图片");
        } catch (e) {
            new Notice(`读取剪贴板失败：${this.errMsg(e)}`);
        }
    }

    /** 插入占位符 → 上传 → 替换为图床链接 */
    private async uploadAndInsert(
        editor: Editor,
        fileData: ArrayBuffer,
        filename: string,
        mimetype: string
    ) {
        const placeholder = `![正在上传…](#beeimg-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)})`;
        editor.replaceSelection(placeholder + "\n");
        new Notice(`正在上传 ${filename}…`);

        try {
            const url = await this.client.upload(fileData, filename, mimetype);
            const markdown = `![${this.stripExt(filename)}](${url})`;
            this.replacePlaceholder(editor, placeholder, markdown);
            new Notice(`上传成功：${filename}`);
        } catch (e) {
            const msg = this.errMsg(e);
            this.replacePlaceholder(
                editor,
                placeholder,
                `<!-- 上传失败：${msg} -->`
            );
            new Notice(`上传失败：${msg}`);
        }
    }

    /** 在编辑器中把占位符替换为新文本 */
    private replacePlaceholder(
        editor: Editor,
        placeholder: string,
        replacement: string
    ) {
        const content = editor.getValue();
        const idx = content.indexOf(placeholder);
        if (idx === -1) return;
        const from = editor.offsetToPos(idx);
        const to = editor.offsetToPos(idx + placeholder.length);
        editor.replaceRange(replacement, from, to);
    }

    // ---------- 批量上传本地图片 ----------

    private async uploadLocalImages(editor: Editor) {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const file = view?.file;
        if (!file) {
            new Notice("请先打开一个 Markdown 文档");
            return;
        }

        const content = editor.getValue();
        // 匹配 Obsidian wikilink 图片 `![[xxx.png]]` 与标准 markdown 本地图片 `![alt](path)`
        const wikiRe = /!\[\[([^\]]+\.(?:png|jpe?g|gif|webp|svg|bmp|tiff?|ico))\]\]/gi;
        const mdRe = /!\[([^\]]*)\]\((?!https?:\/\/)([^)]+\.(?:png|jpe?g|gif|webp|svg|bmp|tiff?|ico))\)/gi;

        const tasks: { placeholder: string; path: string; alt: string }[] = [];

        let m: RegExpExecArray | null;
        while ((m = wikiRe.exec(content))) {
            tasks.push({ placeholder: m[0], path: m[1], alt: this.stripExt(m[1]) });
        }
        while ((m = mdRe.exec(content))) {
            tasks.push({ placeholder: m[0], path: m[2], alt: m[1] || this.stripExt(m[2]) });
        }

        if (tasks.length === 0) {
            new Notice("未在当前文档中找到本地图片");
            return;
        }

        new Notice(`找到 ${tasks.length} 张本地图片，开始上传…`);
        let ok = 0;
        for (const t of tasks) {
            try {
                const localPath = this.resolveImagePath(file, t.path);
                const localFile = this.app.vault.getAbstractFileByPath(localPath);
                if (!(localFile instanceof TFile)) {
                    new Notice(`找不到文件：${t.path}`);
                    continue;
                }
                const data = await this.app.vault.readBinary(localFile);
                const url = await this.client.upload(
                    data,
                    localFile.name,
                    this.mimeFromName(localFile.name)
                );
                this.replacePlaceholder(editor, t.placeholder, `![${t.alt}](${url})`);
                ok++;
            } catch (e) {
                new Notice(`上传失败 ${t.path}：${this.errMsg(e)}`);
            }
        }
        new Notice(`批量上传完成：${ok}/${tasks.length} 成功`);
    }

    /** 根据当前文档解析图片路径（含 Obsidian 默认附件目录） */
    private resolveImagePath(currentFile: TFile, ref: string): string {
        // 绝对路径（vault 根）
        if (this.app.vault.getAbstractFileByPath(ref) instanceof TFile) return ref;
        // 相对当前文档目录
        const dir = currentFile.parent?.path;
        if (dir) {
            const rel = `${dir}/${ref}`;
            if (this.app.vault.getAbstractFileByPath(rel) instanceof TFile) return rel;
        }
        return ref;
    }

    private mimeFromName(name: string): string {
        const ext = name.split(".").pop()?.toLowerCase() || "";
        const map: Record<string, string> = {
            png: "image/png",
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            gif: "image/gif",
            webp: "image/webp",
            svg: "image/svg+xml",
            bmp: "image/bmp",
            tiff: "image/tiff",
            tif: "image/tiff",
            ico: "image/x-icon",
        };
        return map[ext] || "application/octet-stream";
    }

    private stripExt(name: string): string {
        return name.replace(/\.[^.]+$/, "");
    }

    private errMsg(e: unknown): string {
        if (e instanceof Error) return e.message;
        return String(e);
    }
}

// ============================ 设置面板 ============================

class BeeImgSettingTab extends PluginSettingTab {
    constructor(app: App, private plugin: BeeImgPlugin) {
        super(app, plugin);
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl("h3", { text: "API 设置" });

        new Setting(containerEl)
            .setName("API 基地址")
            .setDesc("蜜蜂图床站点地址，不要以斜杠结尾。")
            .addText((text) =>
                text
                    .setPlaceholder("https://www.beeimg.cn")
                    .setValue(this.plugin.settings.baseUrl)
                    .onChange(async (v) => {
                        this.plugin.settings.baseUrl = v.trim();
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("认证方式")
            .setDesc("API Token：在图床后台创建的持久令牌（推荐）。账号密码：自动登录获取 token。")
            .addDropdown((dd) =>
                dd
                    .addOption("apiToken", "API Token")
                    .addOption("password", "账号密码")
                    .setValue(this.plugin.settings.authMode)
                    .onChange(async (v) => {
                        this.plugin.settings.authMode = v as BeeImgSettings["authMode"];
                        await this.plugin.saveSettings();
                        this.display();
                    })
            );

        if (this.plugin.settings.authMode === "apiToken") {
            new Setting(containerEl)
                .setName("API Token")
                .setDesc("在蜜蜂图床「个人设置 → API Token」中创建的持久令牌，形如 5|ll0yN65FmPPPur9...（含数字前缀和竖线，须完整复制）。注意：临时上传 Token 不能用于此插件。")
                .addText((text) =>
                    text
                        .setPlaceholder("粘贴你的 API Token")
                        .setValue(this.plugin.settings.apiToken)
                        .onChange(async (v) => {
                            this.plugin.settings.apiToken = v.trim();
                            await this.plugin.saveSettings();
                        })
                );
        } else {
            new Setting(containerEl)
                .setName("登录类型")
                .addDropdown((dd) =>
                    dd
                        .addOption("username", "用户名")
                        .addOption("email", "邮箱")
                        .addOption("phone", "手机号")
                        .setValue(this.plugin.settings.loginType)
                        .onChange(async (v) => {
                            this.plugin.settings.loginType = v as BeeImgSettings["loginType"];
                            await this.plugin.saveSettings();
                        })
                );

            new Setting(containerEl)
                .setName("账号")
                .addText((text) =>
                    text
                        .setPlaceholder("用户名 / 邮箱 / 手机号")
                        .setValue(this.plugin.settings.username)
                        .onChange(async (v) => {
                            this.plugin.settings.username = v.trim();
                            await this.plugin.saveSettings();
                        })
                );

            new Setting(containerEl)
                .setName("密码")
                .addText((text) => {
                    text.inputEl.type = "password";
                    text
                        .setPlaceholder("密码")
                        .setValue(this.plugin.settings.password)
                        .onChange(async (v) => {
                            this.plugin.settings.password = v;
                            this.plugin.settings.cachedToken = ""; // 改密码清缓存
                            await this.plugin.saveSettings();
                        });
                });
        }

        new Setting(containerEl)
            .setName("测试连接")
            .setDesc("验证当前配置的认证信息是否有效。")
            .addButton((btn) =>
                btn.setButtonText("测试").onClick(async () => {
                    btn.setButtonText("测试中…");
                    btn.setDisabled(true);
                    const r = await this.plugin.client.verifyToken();
                    btn.setButtonText("测试");
                    btn.setDisabled(false);
                    new Notice(r.ok ? `✓ ${r.message}` : `✗ ${r.message}`);
                })
            );

        containerEl.createEl("h3", { text: "上传选项" });

        new Setting(containerEl)
            .setName("储存策略 ID (strategy_id)")
            .setDesc("站点支持的储存策略 ID（蜜蜂图床通常为 4）。点击「查询策略」查看可用值。上传报「服务异常」多半是此 ID 填错。")
            .addText((text) =>
                text
                    .setPlaceholder("4")
                    .setValue(String(this.plugin.settings.storageId))
                    .onChange(async (v) => {
                        const n = parseInt(v, 10);
                        if (!isNaN(n)) {
                            this.plugin.settings.storageId = n;
                            await this.plugin.saveSettings();
                        }
                    })
            )
            .addButton((btn) =>
                btn.setButtonText("查询策略").onClick(async () => {
                    btn.setButtonText("查询中…");
                    btn.setDisabled(true);
                    try {
                        const list = await this.plugin.client.listStrategies();
                        if (list.length === 0) {
                            new Notice("站点未返回任何储存策略");
                        } else {
                            const lines = list.map((s) => `ID ${s.id}  ${s.name}`);
                            new Notice(`储存策略：\n${lines.join("\n")}\n\n请在上方填入对应 ID`, 10000);
                        }
                    } catch (e) {
                        new Notice(`查询失败：${e instanceof Error ? e.message : String(e)}`);
                    } finally {
                        btn.setButtonText("查询策略");
                        btn.setDisabled(false);
                    }
                })
            );

        new Setting(containerEl)
            .setName("相册 ID (album_id)")
            .setDesc("上传到指定相册。填 0 表示不上传到任何相册（将省略该字段）。点击「查询相册」查看你账号下的合法相册 ID。")
            .addText((text) =>
                text
                    .setPlaceholder("0")
                    .setValue(String(this.plugin.settings.albumId))
                    .onChange(async (v) => {
                        const n = parseInt(v, 10);
                        if (!isNaN(n)) {
                            this.plugin.settings.albumId = n;
                            await this.plugin.saveSettings();
                        }
                    })
            )
            .addButton((btn) =>
                btn.setButtonText("查询相册").onClick(async () => {
                    btn.setButtonText("查询中…");
                    btn.setDisabled(true);
                    try {
                        const list = await this.plugin.client.listAlbums();
                        if (list.length === 0) {
                            new Notice("你的账号下没有相册。保持相册 ID 为 0 即可（将省略该字段）。");
                        } else {
                            const lines = list.map((a) => `ID ${a.id}  ${a.name}  (${a.image_num} 张)`);
                            new Notice(`相册列表：\n${lines.join("\n")}\n\n请在上方填入对应 ID`, 10000);
                        }
                    } catch (e) {
                        new Notice(`查询失败：${e instanceof Error ? e.message : String(e)}`);
                    } finally {
                        btn.setButtonText("查询相册");
                        btn.setDisabled(false);
                    }
                })
            );

        new Setting(containerEl)
            .setName("公开图片")
            .setDesc("上传的图片是否对外公开（公开图片会出现在广场）。")
            .addToggle((tg) =>
                tg
                    .setValue(this.plugin.settings.isPublic)
                    .onChange(async (v) => {
                        this.plugin.settings.isPublic = v;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("移除 EXIF 信息")
            .setDesc("上传时是否移除图片的 EXIF 元数据。")
            .addToggle((tg) =>
                tg
                    .setValue(this.plugin.settings.isRemoveExif)
                    .onChange(async (v) => {
                        this.plugin.settings.isRemoveExif = v;
                        await this.plugin.saveSettings();
                    })
            );

        containerEl.createEl("h3", { text: "触发方式" });

        new Setting(containerEl)
            .setName("粘贴时自动上传")
            .addToggle((tg) =>
                tg
                    .setValue(this.plugin.settings.enablePaste)
                    .onChange(async (v) => {
                        this.plugin.settings.enablePaste = v;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("拖拽时自动上传")
            .addToggle((tg) =>
                tg
                    .setValue(this.plugin.settings.enableDrop)
                    .onChange(async (v) => {
                        this.plugin.settings.enableDrop = v;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("启用批量上传命令")
            .setDesc("启用「上传当前文档中的所有本地图片」命令。")
            .addToggle((tg) =>
                tg
                    .setValue(this.plugin.settings.enableBatchUpload)
                    .onChange(async (v) => {
                        this.plugin.settings.enableBatchUpload = v;
                        await this.plugin.saveSettings();
                    })
            );

        containerEl.createEl("p", {
            text: "提示：粘贴/拖拽时图片不会保存到 vault，直接上传后插入图床链接。",
            cls: "setting-item-description",
        });
    }
}
