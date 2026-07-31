export type ImageOrder = "newest" | "earliest" | "utmost" | "least";
export type ImagePermission = "public" | "private";

export interface ImageQuery {
    page: number;
    q?: string;
    order: ImageOrder;
    permission?: ImagePermission;
    albumId?: number;
}

export interface BeeImgImageLinks {
    url: string;
    thumbnailUrl: string;
    markdown?: string;
}

export interface BeeImgImage {
    key: number;
    remoteId?: number;
    name: string;
    pathname: string;
    mimetype: string;
    extension: string;
    size: number;
    width: number;
    height: number;
    date: string;
    humanDate: string;
    links: BeeImgImageLinks;
}

export interface ImagePage {
    items: BeeImgImage[];
    currentPage: number;
    lastPage: number;
    perPage: number;
    total: number;
}

export interface V2ImageIdentity {
    id: number;
    pathname: string;
    publicUrl: string | null;
    albumIds: number[];
}

export interface V2ImageIdentityPage {
    items: V2ImageIdentity[];
    currentPage: number;
    lastPage: number;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown, context: string): UnknownRecord {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`服务端返回格式不兼容：${context} 不是对象。`);
    }
    return value as UnknownRecord;
}

function asString(value: unknown, fallback = ""): string {
    return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
    const numberValue = typeof value === "number" ? value : Number(value);
    return Number.isFinite(numberValue) ? numberValue : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
    const numberValue = Math.floor(asNumber(value, fallback));
    return numberValue > 0 ? numberValue : fallback;
}

export function buildImageListUrl(apiBase: string, query: ImageQuery): string {
    const params = new URLSearchParams();
    params.set("page", String(Math.max(1, Math.floor(query.page))));

    const keyword = query.q?.trim();
    if (keyword) params.set("q", keyword);
    if (query.permission) params.set("permission", query.permission);

    return `${apiBase.replace(/\/+$/, "")}/images?${params.toString()}`;
}

export function buildV2ImageListUrl(apiBase: string, page: number): string {
    const params = new URLSearchParams();
    params.set("page", String(Math.max(1, Math.floor(page))));
    params.set("per_page", "100");
    return `${apiBase.replace(/\/+$/, "")}/user/photos?${params.toString()}`;
}

export function normalizeImageUrl(rawUrl: string): string | null {
    try {
        const url = new URL(rawUrl.trim());
        if (url.protocol !== "http:" && url.protocol !== "https:") return null;
        url.hash = "";
        return url.href;
    } catch {
        return null;
    }
}

export function isSameOrigin(rawUrl: string, baseUrl: string): boolean {
    try {
        return new URL(rawUrl).origin === new URL(baseUrl).origin;
    } catch {
        return false;
    }
}

export function parseImagePage(response: unknown): ImagePage {
    const envelope = asRecord(response, "响应");
    const status = envelope.status;
    if (status !== true && status !== "success") {
        throw new Error(asString(envelope.message, "查询图片列表失败。"));
    }

    const pageData = asRecord(envelope.data, "data");
    if (!Array.isArray(pageData.data)) {
        throw new Error("服务端返回格式不兼容：data.data 不是数组。");
    }

    const items = pageData.data.map((rawItem, index): BeeImgImage => {
        const item = asRecord(rawItem, `data.data[${index}]`);
        const links = asRecord(item.links, `data.data[${index}].links`);
        const key = asNumber(item.key, NaN);
        const url = normalizeImageUrl(asString(links.url));
        if (!Number.isFinite(key) || !url) {
            throw new Error(`服务端返回格式不兼容：第 ${index + 1} 张图片缺少 key 或链接。`);
        }

        const pathname = asString(item.pathname);
        return {
            key,
            name: asString(item.name, pathname || `图片 ${key}`),
            pathname,
            mimetype: asString(item.mimetype, "application/octet-stream"),
            extension: asString(item.extension),
            size: Math.max(0, asNumber(item.size)),
            width: Math.max(0, asNumber(item.width)),
            height: Math.max(0, asNumber(item.height)),
            date: asString(item.date),
            humanDate: asString(item.human_date),
            links: {
                url,
                thumbnailUrl: normalizeImageUrl(asString(links.thumbnail_url)) ?? url,
                markdown: asString(links.markdown) || undefined,
            },
        };
    });

    const currentPage = positiveInteger(pageData.current_page, 1);
    const lastPage = Math.max(currentPage, positiveInteger(pageData.last_page, currentPage));
    return {
        items,
        currentPage,
        lastPage,
        perPage: positiveInteger(pageData.per_page, Math.max(1, items.length)),
        total: Math.max(0, asNumber(pageData.total, items.length)),
    };
}

export function parseV2ImageIdentityPage(response: unknown): V2ImageIdentityPage {
    const envelope = asRecord(response, "响应");
    if (envelope.status !== "success" && envelope.status !== true) {
        throw new Error(asString(envelope.message, "查询新版图片列表失败。"));
    }
    const pageData = asRecord(envelope.data, "data");
    if (!Array.isArray(pageData.data)) {
        throw new Error("服务端返回格式不兼容：data.data 不是数组。");
    }
    const meta = asRecord(pageData.meta, "data.meta");
    const items = pageData.data.map((rawItem, index): V2ImageIdentity => {
        const item = asRecord(rawItem, `data.data[${index}]`);
        const id = asNumber(item.id, NaN);
        if (!Number.isFinite(id)) {
            throw new Error(`服务端返回格式不兼容：第 ${index + 1} 张图片缺少 id。`);
        }
        const albums = Array.isArray(item.albums) ? item.albums : [];
        return {
            id,
            pathname: asString(item.pathname),
            publicUrl: normalizeImageUrl(asString(item.public_url)),
            albumIds: albums.flatMap((rawAlbum) => {
                const album = asRecord(rawAlbum, `data.data[${index}].albums[]`);
                const albumId = asNumber(album.id, NaN);
                return Number.isFinite(albumId) ? [albumId] : [];
            }),
        };
    });
    const currentPage = positiveInteger(meta.current_page, 1);
    return {
        items,
        currentPage,
        lastPage: Math.max(currentPage, positiveInteger(meta.last_page, currentPage)),
    };
}

export function attachV2ImageIdentities(
    images: BeeImgImage[],
    identities: V2ImageIdentity[],
    albumId?: number
): BeeImgImage[] {
    const byUrl = new Map<string, V2ImageIdentity>();
    const byPathname = new Map<string, V2ImageIdentity>();
    for (const identity of identities) {
        if (identity.publicUrl) byUrl.set(identity.publicUrl, identity);
        if (identity.pathname) byPathname.set(identity.pathname, identity);
    }

    const result: BeeImgImage[] = [];
    for (const image of images) {
        const normalizedUrl = normalizeImageUrl(image.links.url);
        const identity = (normalizedUrl ? byUrl.get(normalizedUrl) : undefined)
            ?? (image.pathname ? byPathname.get(image.pathname) : undefined);
        if (!identity) continue;
        if (albumId && albumId > 0 && !identity.albumIds.includes(albumId)) continue;
        result.push({ ...image, remoteId: identity.id });
    }
    return result;
}

function imageDateValue(image: BeeImgImage): number | null {
    if (!image.date) return null;
    const value = Date.parse(image.date.replace(" ", "T"));
    return Number.isFinite(value) ? value : null;
}

export function sortAndPaginateImages(
    images: BeeImgImage[],
    query: ImageQuery,
    perPage: number
): ImagePage {
    const sorted = images.slice();
    sorted.sort((left, right) => {
        let comparison = 0;
        if (query.order === "utmost" || query.order === "least") {
            comparison = left.size - right.size;
            if (query.order === "utmost") comparison *= -1;
        } else {
            const leftDate = imageDateValue(left);
            const rightDate = imageDateValue(right);
            if (leftDate === null && rightDate !== null) comparison = 1;
            else if (leftDate !== null && rightDate === null) comparison = -1;
            else if (leftDate !== null && rightDate !== null) {
                comparison = leftDate - rightDate;
                if (query.order === "newest") comparison *= -1;
            }
        }
        return comparison || right.key - left.key;
    });

    const pageSize = positiveInteger(perPage, 40);
    const lastPage = Math.max(1, Math.ceil(sorted.length / pageSize));
    const currentPage = Math.min(
        lastPage,
        Math.max(1, Math.floor(query.page))
    );
    const offset = (currentPage - 1) * pageSize;
    return {
        items: sorted.slice(offset, offset + pageSize),
        currentPage,
        lastPage,
        perPage: pageSize,
        total: sorted.length,
    };
}

export function formatFileSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const unitIndex = Math.min(
        Math.floor(Math.log(bytes) / Math.log(1024)),
        units.length - 1
    );
    const value = bytes / Math.pow(1024, unitIndex);
    const digits = unitIndex === 0 || value >= 10 ? 0 : 1;
    return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

export function imageMarkdown(image: BeeImgImage): string {
    if (image.links.markdown) return image.links.markdown;
    const alt = image.name.replace(/([\\\]])/g, "\\$1");
    return `![${alt}](${image.links.url})`;
}
