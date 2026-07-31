import {
    App,
    ButtonComponent,
    ItemView,
    Modal,
    Notice,
    TFile,
    WorkspaceLeaf,
    setIcon,
} from "obsidian";
import {
    BeeImgImage,
    ImagePage,
    ImagePermission,
    ImageQuery,
    formatFileSize,
    imageMarkdown,
    normalizeImageUrl,
} from "./image-utils";
import { ImageUsageIndex } from "./image-usage-index";
import { ImageUsageSummary } from "./image-usage";

export const IMAGE_MANAGER_VIEW_TYPE = "beeimg-image-manager";

interface ImageAlbum {
    id: number;
    name: string;
}

export interface ImageManagerClient {
    listImages(query: ImageQuery): Promise<ImagePage>;
    invalidateImageCache?(): void;
    deleteImage(id: number): Promise<void>;
    fetchImage(url: string): Promise<ArrayBuffer>;
    listAlbums(): Promise<ImageAlbum[]>;
}

function createIconButton(
    container: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void | Promise<void>,
    className = ""
): HTMLButtonElement {
    const button = container.createEl("button", {
        cls: `beeimg-icon-button ${className}`.trim(),
        attr: { type: "button", "aria-label": label, title: label },
    });
    setIcon(button, icon);
    button.addEventListener("click", (event) => {
        event.stopPropagation();
        void onClick();
    });
    return button;
}

function addOption(select: HTMLSelectElement, value: string, label: string): void {
    const option = select.createEl("option", { text: label });
    option.value = value;
}

async function copyText(text: string, successMessage: string): Promise<void> {
    try {
        await navigator.clipboard.writeText(text);
        new Notice(successMessage);
    } catch (error) {
        new Notice(`复制失败：${error instanceof Error ? error.message : String(error)}`);
    }
}

export class BeeImgImageManagerView extends ItemView {
    private query: ImageQuery = { page: 1, order: "newest" };
    private currentPage: ImagePage | null = null;
    private requestSequence = 0;
    private searchTimer: number | null = null;
    private unsubscribeUsage: (() => void) | null = null;

    private statusEl!: HTMLElement;
    private gridEl!: HTMLElement;
    private paginationEl!: HTMLElement;
    private albumSelect!: HTMLSelectElement;
    private usageBadges = new Map<string, HTMLElement[]>();

    constructor(
        leaf: WorkspaceLeaf,
        private readonly client: ImageManagerClient,
        private readonly usageIndex: ImageUsageIndex
    ) {
        super(leaf);
        this.navigation = false;
        this.icon = "images";
    }

    getViewType(): string {
        return IMAGE_MANAGER_VIEW_TYPE;
    }

    getDisplayText(): string {
        return "蜜蜂图库";
    }

    getIcon(): string {
        return "images";
    }

    protected async onOpen(): Promise<void> {
        this.renderShell();
        this.usageIndex.start();
        this.unsubscribeUsage = this.usageIndex.onDidChange((changedUrls) => {
            this.updateUsageBadges(changedUrls);
        });
        await this.loadImages();
        void this.loadAlbums();
    }

    protected async onClose(): Promise<void> {
        this.requestSequence++;
        if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
        this.unsubscribeUsage?.();
        this.unsubscribeUsage = null;
        this.usageBadges.clear();
        this.contentEl.empty();
    }

    private renderShell(): void {
        this.contentEl.empty();
        this.contentEl.addClass("beeimg-manager-view");

        const toolbar = this.contentEl.createDiv({ cls: "beeimg-manager-toolbar" });
        const search = toolbar.createEl("input", {
            cls: "beeimg-manager-search",
            attr: {
                type: "search",
                placeholder: "搜索图片",
                "aria-label": "搜索图片",
            },
        });
        this.registerDomEvent(search, "input", () => {
            if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
            this.searchTimer = window.setTimeout(() => {
                this.query.q = search.value.trim() || undefined;
                this.query.page = 1;
                void this.loadImages();
            }, 300);
        });

        this.albumSelect = toolbar.createEl("select", {
            cls: "beeimg-manager-select",
            attr: { "aria-label": "筛选相册" },
        });
        addOption(this.albumSelect, "", "全部相册");
        this.registerDomEvent(this.albumSelect, "change", () => {
            const albumId = Number(this.albumSelect.value);
            this.query.albumId = albumId > 0 ? albumId : undefined;
            this.query.page = 1;
            void this.loadImages();
        });

        const permission = toolbar.createEl("select", {
            cls: "beeimg-manager-select",
            attr: { "aria-label": "筛选公开状态" },
        });
        addOption(permission, "", "全部状态");
        addOption(permission, "public", "公开");
        addOption(permission, "private", "私有");
        this.registerDomEvent(permission, "change", () => {
            this.query.permission =
                (permission.value as ImagePermission) || undefined;
            this.query.page = 1;
            void this.loadImages();
        });

        const order = toolbar.createEl("select", {
            cls: "beeimg-manager-select",
            attr: { "aria-label": "图片排序" },
        });
        addOption(order, "newest", "最新");
        addOption(order, "earliest", "最早");
        addOption(order, "utmost", "最大");
        addOption(order, "least", "最小");
        this.registerDomEvent(order, "change", () => {
            this.query.order = order.value as ImageQuery["order"];
            this.query.page = 1;
            void this.loadImages();
        });

        createIconButton(toolbar, "refresh-cw", "刷新图库", () => {
            this.client.invalidateImageCache?.();
            return this.loadImages();
        });

        this.statusEl = this.contentEl.createDiv({ cls: "beeimg-manager-status" });
        this.gridEl = this.contentEl.createDiv({ cls: "beeimg-image-grid" });
        this.paginationEl = this.contentEl.createDiv({ cls: "beeimg-pagination" });
    }

    private async loadAlbums(): Promise<void> {
        try {
            const albums = await this.client.listAlbums();
            const selected = this.albumSelect.value;
            this.albumSelect.replaceChildren();
            addOption(this.albumSelect, "", "全部相册");
            for (const album of albums) addOption(this.albumSelect, String(album.id), album.name);
            if (Array.from(this.albumSelect.options).some((option) => option.value === selected)) {
                this.albumSelect.value = selected;
            }
        } catch (error) {
            new Notice(`相册筛选加载失败：${this.errorMessage(error)}`);
        }
    }

    private async loadImages(): Promise<void> {
        const requestId = ++this.requestSequence;
        this.renderLoading();
        try {
            const page = await this.client.listImages({ ...this.query });
            if (requestId !== this.requestSequence) return;
            this.currentPage = page;
            this.query.page = page.currentPage;
            this.renderPage(page);
        } catch (error) {
            if (requestId !== this.requestSequence) return;
            this.renderError(this.errorMessage(error));
        }
    }

    private renderLoading(): void {
        this.statusEl.empty();
        this.statusEl.createSpan({ text: "正在加载图片…" });
        this.statusEl.addClass("is-loading");
        if (!this.currentPage) {
            this.gridEl.empty();
            this.paginationEl.empty();
        }
    }

    private renderPage(page: ImagePage): void {
        this.statusEl.removeClass("is-loading", "is-error");
        this.statusEl.empty();
        this.statusEl.createSpan({ text: `共 ${page.total} 张图片` });
        if (this.usageIndex.getStatus() === "indexing") {
            this.statusEl.createSpan({
                cls: "beeimg-usage-index-status",
                text: "正在统计当前仓库引用…",
            });
        } else if (this.usageIndex.getStatus() === "error") {
            this.statusEl.createSpan({
                cls: "beeimg-usage-index-status is-warning",
                text: "部分引用可能尚未统计",
            });
        }

        this.gridEl.empty();
        this.usageBadges.clear();
        if (page.items.length === 0) {
            const empty = this.gridEl.createDiv({ cls: "beeimg-manager-empty" });
            const icon = empty.createDiv({ cls: "beeimg-manager-empty-icon" });
            setIcon(icon, "image-off");
            empty.createEl("p", {
                text: this.query.q || this.query.permission || this.query.albumId
                    ? "没有符合筛选条件的图片"
                    : "图库中还没有图片",
            });
        } else {
            for (const image of page.items) this.renderCard(image);
        }
        this.renderPagination(page);
    }

    private renderCard(image: BeeImgImage): void {
        const card = this.gridEl.createEl("article", { cls: "beeimg-image-card" });
        const previewButton = card.createEl("button", {
            cls: "beeimg-image-preview-trigger",
            attr: { type: "button", "aria-label": `预览 ${image.name}` },
        });
        const img = previewButton.createEl("img", {
            cls: "beeimg-image-thumbnail",
            attr: {
                src: image.links.thumbnailUrl || image.links.url,
                alt: image.name,
                loading: "lazy",
            },
        });
        img.addEventListener("error", () => {
            img.addClass("is-broken");
            img.alt = `${image.name}（缩略图加载失败）`;
        }, { once: true });
        previewButton.addEventListener("click", () => this.openPreview(image));

        const body = card.createDiv({ cls: "beeimg-image-card-body" });
        const nameButton = body.createEl("button", {
            cls: "beeimg-image-name",
            text: image.name,
            attr: { type: "button", title: image.name },
        });
        nameButton.addEventListener("click", () => this.openPreview(image));

        const metadata = body.createDiv({ cls: "beeimg-image-meta" });
        const dimensions = image.width > 0 && image.height > 0
            ? `${image.width} × ${image.height}`
            : image.extension.toUpperCase() || "图片";
        metadata.createSpan({ text: dimensions });
        metadata.createSpan({ text: formatFileSize(image.size) });
        metadata.createSpan({ text: image.humanDate || image.date || "未知时间" });

        const footer = body.createDiv({ cls: "beeimg-image-card-footer" });
        const usageBadge = footer.createEl("button", {
            cls: "beeimg-usage-badge",
            attr: { type: "button", "aria-label": "查看当前仓库引用" },
        });
        usageBadge.addEventListener("click", () => this.openPreview(image));
        const normalized = normalizeImageUrl(image.links.url);
        if (normalized) {
            const badges = this.usageBadges.get(normalized) ?? [];
            badges.push(usageBadge);
            this.usageBadges.set(normalized, badges);
        }
        this.renderUsageBadge(usageBadge, image);

        const actions = footer.createDiv({ cls: "beeimg-image-actions" });
        createIconButton(actions, "link", "复制图片链接", () =>
            copyText(image.links.url, "图片链接已复制")
        );
        createIconButton(actions, "copy", "复制 Markdown", () =>
            copyText(imageMarkdown(image), "Markdown 已复制")
        );
        const deleteButton = createIconButton(
            actions,
            "trash-2",
            image.remoteId ? "删除图片" : "无法确认图片 ID",
            () => this.openDeleteConfirmation(image),
            "is-danger"
        );
        deleteButton.disabled = !image.remoteId;
    }

    private renderUsageBadge(element: HTMLElement, image: BeeImgImage): void {
        element.empty();
        const icon = element.createSpan({ cls: "beeimg-usage-icon" });
        setIcon(icon, "notebook-tabs");
        const status = this.usageIndex.getStatus();
        const usage = this.usageIndex.getUsage(image.links.url);
        let text = String(usage.referenceCount);
        let label = `当前仓库引用 ${usage.referenceCount} 次`;
        if (status === "indexing" || status === "idle") {
            text = "…";
            label = "正在统计当前仓库引用";
        } else if (status === "error") {
            text = usage.referenceCount > 0 ? `${usage.referenceCount}+` : "?";
            label = "引用统计可能不完整";
        }
        element.createSpan({ text });
        element.setAttribute("aria-label", label);
        element.setAttribute("title", label);
    }

    private updateUsageBadges(changedUrls: Set<string> | null): void {
        if (!this.currentPage) return;
        for (const image of this.currentPage.items) {
            const normalized = normalizeImageUrl(image.links.url);
            if (!normalized || (changedUrls && !changedUrls.has(normalized))) continue;
            for (const badge of this.usageBadges.get(normalized) ?? []) {
                this.renderUsageBadge(badge, image);
            }
        }
        if (!changedUrls) this.renderPage(this.currentPage);
    }

    private renderPagination(page: ImagePage): void {
        this.paginationEl.empty();
        if (page.lastPage <= 1) return;

        const previous = createIconButton(this.paginationEl, "chevron-left", "上一页", () => {
            if (page.currentPage <= 1) return;
            this.query.page = page.currentPage - 1;
            void this.loadImages();
        });
        previous.disabled = page.currentPage <= 1;

        this.paginationEl.createSpan({
            cls: "beeimg-pagination-label",
            text: `${page.currentPage} / ${page.lastPage}`,
        });

        const next = createIconButton(this.paginationEl, "chevron-right", "下一页", () => {
            if (page.currentPage >= page.lastPage) return;
            this.query.page = page.currentPage + 1;
            void this.loadImages();
        });
        next.disabled = page.currentPage >= page.lastPage;
    }

    private renderError(message: string): void {
        this.statusEl.removeClass("is-loading");
        this.statusEl.addClass("is-error");
        this.statusEl.empty();
        this.statusEl.createSpan({ text: message });
        const retry = this.statusEl.createEl("button", {
            cls: "beeimg-retry-button",
            attr: { type: "button" },
            text: "重试",
        });
        retry.addEventListener("click", () => void this.loadImages());
        if (!this.currentPage) {
            this.gridEl.empty();
            this.paginationEl.empty();
        }
    }

    private openPreview(image: BeeImgImage): void {
        let preview: ImagePreviewModal;
        preview = new ImagePreviewModal(
            this.app,
            image,
            this.client,
            this.usageIndex,
            () => this.openDeleteConfirmation(image, () => preview.close())
        );
        preview.open();
    }

    private openDeleteConfirmation(image: BeeImgImage, onDeleted?: () => void): void {
        if (!image.remoteId) {
            new Notice("无法确认图片的新版 ID，请刷新图库后重试。");
            return;
        }
        const usage = this.usageIndex.getUsage(image.links.url);
        new DeleteImageModal(
            this.app,
            image,
            usage,
            this.usageIndex.getStatus() === "ready",
            async () => {
                await this.client.deleteImage(image.remoteId!);
                new Notice(`已删除：${image.name}`);
                await this.refreshAfterDelete();
                onDeleted?.();
            }
        ).open();
    }

    private async refreshAfterDelete(): Promise<void> {
        if (this.currentPage?.items.length === 1 && this.query.page > 1) {
            this.query.page--;
        }
        await this.loadImages();
    }

    private errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}

class ImagePreviewModal extends Modal {
    private objectUrl: string | null = null;

    constructor(
        app: App,
        private readonly image: BeeImgImage,
        private readonly client: ImageManagerClient,
        private readonly usageIndex: ImageUsageIndex,
        private readonly onDelete: () => void
    ) {
        super(app);
    }

    onOpen(): void {
        this.modalEl.addClass("beeimg-preview-modal");
        this.titleEl.setText(this.image.name);
        const imageWrap = this.contentEl.createDiv({ cls: "beeimg-preview-image-wrap" });
        const img = imageWrap.createEl("img", {
            cls: "beeimg-preview-image",
            attr: { src: this.image.links.url, alt: this.image.name },
        });
        let attemptedAuthenticatedLoad = false;
        img.addEventListener("error", async () => {
            if (attemptedAuthenticatedLoad) {
                imageWrap.addClass("is-error");
                return;
            }
            attemptedAuthenticatedLoad = true;
            try {
                const data = await this.client.fetchImage(this.image.links.url);
                this.objectUrl = URL.createObjectURL(
                    new Blob([data], { type: this.image.mimetype })
                );
                img.src = this.objectUrl;
            } catch (error) {
                imageWrap.addClass("is-error");
                new Notice(`图片预览失败：${error instanceof Error ? error.message : String(error)}`);
            }
        });

        const details = this.contentEl.createDiv({ cls: "beeimg-preview-details" });
        this.addDetail(details, "尺寸", this.image.width && this.image.height
            ? `${this.image.width} × ${this.image.height}`
            : "未知");
        this.addDetail(details, "大小", formatFileSize(this.image.size));
        this.addDetail(details, "类型", this.image.mimetype);
        this.addDetail(details, "上传时间", this.image.date || this.image.humanDate || "未知");

        this.renderUsage(this.usageIndex.getUsage(this.image.links.url));

        const actions = this.contentEl.createDiv({ cls: "beeimg-preview-actions" });
        this.actionButton(actions, "link", "复制链接", () =>
            copyText(this.image.links.url, "图片链接已复制")
        );
        this.actionButton(actions, "copy", "复制 Markdown", () =>
            copyText(imageMarkdown(this.image), "Markdown 已复制")
        );
        this.actionButton(actions, "external-link", "浏览器打开", () => {
            window.open(this.image.links.url, "_blank", "noopener,noreferrer");
        });
        this.actionButton(actions, "trash-2", "删除", () => this.onDelete(), true);
    }

    onClose(): void {
        if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
        this.objectUrl = null;
        this.contentEl.empty();
    }

    private addDetail(container: HTMLElement, label: string, value: string): void {
        const item = container.createDiv({ cls: "beeimg-preview-detail" });
        item.createSpan({ cls: "beeimg-preview-detail-label", text: label });
        item.createSpan({ text: value });
    }

    private renderUsage(usage: ImageUsageSummary): void {
        const section = this.contentEl.createDiv({ cls: "beeimg-preview-usage" });
        section.createEl("h3", { text: "当前仓库引用" });
        section.createEl("p", {
            text: this.usageIndex.getStatus() === "ready"
                ? `${usage.referenceCount} 次引用，涉及 ${usage.noteCount} 篇笔记`
                : "引用统计尚未完整",
        });
        if (usage.notePaths.length === 0) return;

        const details = section.createEl("details");
        details.createEl("summary", { text: "查看引用笔记" });
        const list = details.createEl("ul", { cls: "beeimg-reference-list" });
        for (const path of usage.notePaths) {
            const item = list.createEl("li");
            const button = item.createEl("button", {
                text: path,
                attr: { type: "button", title: path },
            });
            button.addEventListener("click", () => {
                const file = this.app.vault.getAbstractFileByPath(path);
                if (file instanceof TFile) {
                    void this.app.workspace.getLeaf("tab").openFile(file);
                }
            });
        }
    }

    private actionButton(
        container: HTMLElement,
        icon: string,
        label: string,
        onClick: () => void | Promise<void>,
        danger = false
    ): void {
        const button = container.createEl("button", {
            cls: `beeimg-preview-action${danger ? " is-danger" : ""}`,
            attr: { type: "button" },
        });
        const iconEl = button.createSpan();
        setIcon(iconEl, icon);
        button.createSpan({ text: label });
        button.addEventListener("click", () => void onClick());
    }
}

class DeleteImageModal extends Modal {
    constructor(
        app: App,
        private readonly image: BeeImgImage,
        private readonly usage: ImageUsageSummary,
        private readonly usageComplete: boolean,
        private readonly onConfirm: () => Promise<void>
    ) {
        super(app);
    }

    onOpen(): void {
        this.modalEl.addClass("beeimg-delete-modal");
        this.titleEl.setText("永久删除图片");

        const summary = this.contentEl.createDiv({ cls: "beeimg-delete-summary" });
        summary.createEl("img", {
            attr: {
                src: this.image.links.thumbnailUrl || this.image.links.url,
                alt: this.image.name,
            },
        });
        const text = summary.createDiv();
        text.createEl("strong", { text: this.image.name });
        text.createEl("p", {
            text: this.usageComplete
                ? `当前仓库引用 ${this.usage.referenceCount} 次，涉及 ${this.usage.noteCount} 篇笔记。`
                : "当前仓库引用统计尚未完整。",
        });

        this.contentEl.createEl("p", {
            cls: "beeimg-delete-warning",
            text: "删除后图床链接将永久失效，笔记中的引用不会自动移除。",
        });

        if (this.usage.notePaths.length > 0) {
            const list = this.contentEl.createEl("ul", { cls: "beeimg-delete-references" });
            for (const path of this.usage.notePaths.slice(0, 5)) {
                list.createEl("li", { text: path });
            }
            if (this.usage.notePaths.length > 5) {
                list.createEl("li", { text: `另有 ${this.usage.notePaths.length - 5} 篇笔记` });
            }
        } else if (this.usageComplete) {
            this.contentEl.createEl("p", {
                cls: "setting-item-description",
                text: "未在当前仓库的 Markdown 图片嵌入中发现引用；其他仓库或外部系统仍可能使用此链接。",
            });
        }

        const errorEl = this.contentEl.createDiv({ cls: "beeimg-delete-error" });
        const footer = this.contentEl.createDiv({ cls: "beeimg-delete-actions" });
        new ButtonComponent(footer)
            .setButtonText("取消")
            .onClick(() => this.close());
        const deleteButton = new ButtonComponent(footer)
            .setButtonText("永久删除")
            .setWarning()
            .onClick(async () => {
                deleteButton.setDisabled(true).setButtonText("正在删除…");
                errorEl.empty();
                try {
                    await this.onConfirm();
                    this.close();
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    errorEl.setText(`删除失败：${message}`);
                    deleteButton.setDisabled(false).setButtonText("永久删除");
                }
            });
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
