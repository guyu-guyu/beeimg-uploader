import { App, Component, TFile } from "obsidian";
import {
    extractImageUrls,
    ImageUsageStore,
    ImageUsageSummary,
} from "./image-usage";

export type ImageUsageStatus = "idle" | "indexing" | "ready" | "error";
type UsageListener = (changedUrls: Set<string> | null) => void;

export class ImageUsageIndex extends Component {
    private readonly store = new ImageUsageStore();
    private readonly listeners = new Set<UsageListener>();
    private readonly fileRevisions = new Map<string, number>();
    private status: ImageUsageStatus = "idle";
    private started = false;
    private rebuildGeneration = 0;

    constructor(private readonly app: App) {
        super();
    }

    onload(): void {
        this.registerEvent(
            this.app.metadataCache.on("changed", (file, data) => {
                if (!this.started || file.extension !== "md") return;
                this.bumpRevision(file.path);
                this.notify(this.store.updateFile(file.path, extractImageUrls(data)));
            })
        );
        this.registerEvent(
            this.app.metadataCache.on("deleted", (file) => {
                if (!this.started) return;
                this.bumpRevision(file.path);
                this.notify(this.store.removeFile(file.path));
            })
        );
        this.registerEvent(
            this.app.vault.on("rename", (file, oldPath) => {
                if (!this.started || !(file instanceof TFile) || file.extension !== "md") {
                    return;
                }
                this.bumpRevision(oldPath);
                this.bumpRevision(file.path);
                this.notify(this.store.renameFile(oldPath, file.path));
            })
        );
    }

    start(): void {
        if (this.started) return;
        this.started = true;
        this.status = "indexing";
        this.store.clear();
        this.fileRevisions.clear();
        const generation = ++this.rebuildGeneration;
        this.notify(null);
        void this.rebuild(generation);
    }

    getStatus(): ImageUsageStatus {
        return this.status;
    }

    getUsage(url: string): ImageUsageSummary {
        return this.store.getUsage(url);
    }

    onDidChange(listener: UsageListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    onunload(): void {
        this.rebuildGeneration++;
        this.listeners.clear();
        this.fileRevisions.clear();
        this.store.clear();
        this.status = "idle";
        this.started = false;
    }

    private async rebuild(generation: number): Promise<void> {
        let hadError = false;
        for (const file of this.app.vault.getMarkdownFiles()) {
            if (!this.started || generation !== this.rebuildGeneration) return;
            const revision = this.fileRevisions.get(file.path) ?? 0;
            try {
                const markdown = await this.app.vault.cachedRead(file);
                if (!this.started || generation !== this.rebuildGeneration) return;
                if ((this.fileRevisions.get(file.path) ?? 0) !== revision) continue;
                this.store.updateFile(file.path, extractImageUrls(markdown));
            } catch {
                hadError = true;
            }
        }
        if (!this.started || generation !== this.rebuildGeneration) return;
        this.status = hadError ? "error" : "ready";
        this.notify(null);
    }

    private bumpRevision(path: string): void {
        this.fileRevisions.set(path, (this.fileRevisions.get(path) ?? 0) + 1);
    }

    private notify(changedUrls: Set<string> | null): void {
        if (changedUrls?.size === 0) return;
        for (const listener of this.listeners) listener(changedUrls);
    }
}
