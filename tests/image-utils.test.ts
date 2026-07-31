import {
    BeeImgImage,
    attachV2ImageIdentities,
    buildImageListUrl,
    buildV2ImageListUrl,
    formatFileSize,
    imageMarkdown,
    isSameOrigin,
    normalizeImageUrl,
    parseImagePage,
    parseV2ImageIdentityPage,
    sortAndPaginateImages,
} from "../image-utils";
import { equal, test, throws } from "./test-harness";

test("builds encoded image list queries and omits empty filters", () => {
    const url = buildImageListUrl("https://www.beeimg.cn/api/v1/", {
        page: 2,
        q: "  中文 image  ",
        order: "newest",
        permission: "private",
        albumId: 9,
    });
    equal(
        url,
        "https://www.beeimg.cn/api/v1/images?page=2&q=%E4%B8%AD%E6%96%87+image&permission=private"
    );
    equal(
        buildImageListUrl("https://host/api/v1", {
            page: 0,
            q: "  ",
            order: "earliest",
        }),
        "https://host/api/v1/images?page=1"
    );
    equal(
        buildV2ImageListUrl("https://host/api/v2/", 2),
        "https://host/api/v2/user/photos?page=2&per_page=100"
    );
});

test("normalizes HTTP image URLs while preserving query strings", () => {
    equal(
        normalizeImageUrl(" HTTPS://Example.COM:443/a%20b.png?size=2#preview "),
        "https://example.com/a%20b.png?size=2"
    );
    equal(normalizeImageUrl("file:///tmp/a.png"), null);
    equal(normalizeImageUrl("not a url"), null);
});

test("only treats exact origins as safe for authenticated image requests", () => {
    equal(
        isSameOrigin("https://www.beeimg.cn/uploads/a.png", "https://www.beeimg.cn"),
        true
    );
    equal(
        isSameOrigin("https://cdn.beeimg.cn/a.png", "https://www.beeimg.cn"),
        false
    );
    equal(isSameOrigin("not-a-url", "https://www.beeimg.cn"), false);
});

test("parses v1 image pages into the view model", () => {
    const page = parseImagePage({
        status: true,
        message: "success",
        data: {
            current_page: 2,
            last_page: 3,
            per_page: 15,
            total: 31,
            data: [
                {
                    key: 21,
                    name: "sample.png",
                    pathname: "2026/sample.png",
                    mimetype: "image/png",
                    extension: "png",
                    size: 2048,
                    width: 640,
                    height: 480,
                    date: "2026-07-31 10:00:00",
                    human_date: "刚刚",
                    links: {
                        url: "https://img.example/sample.png",
                        thumbnail_url: "https://img.example/thumb.png",
                    },
                },
            ],
        },
    });
    equal(page.currentPage, 2);
    equal(page.lastPage, 3);
    equal(page.total, 31);
    equal(page.items[0].key, 21);
    equal(page.items[0].links.thumbnailUrl, "https://img.example/thumb.png");
});

test("rejects unsuccessful and malformed image list responses", () => {
    throws(
        () => parseImagePage({ status: false, message: "无权限", data: {} }),
        /无权限/
    );
    throws(
        () => parseImagePage({ status: true, data: { data: [{ key: 1, links: {} }] } }),
        /缺少 key 或链接/
    );
    throws(
        () => parseImagePage({
            status: true,
            data: { data: [{ key: 1, links: { url: "javascript:alert(1)" } }] },
        }),
        /缺少 key 或链接/
    );
});

test("parses v2 image identities and album relationships", () => {
    const page = parseV2ImageIdentityPage({
        status: "success",
        data: {
            data: [{
                id: 83,
                pathname: "2026/a.png",
                public_url: "https://img.example/a.png",
                albums: [{ id: 9 }, { id: 12 }],
            }],
            meta: { current_page: 1, last_page: 2 },
        },
    });
    equal(page.items[0].id, 83);
    equal(page.items[0].albumIds.join(","), "9,12");
    equal(page.currentPage, 1);
    equal(page.lastPage, 2);
});

test("maps v1 images to verified v2 IDs before filtering or deletion", () => {
    const first = {
        key: 3,
        name: "a.png",
        pathname: "2026/a.png",
        mimetype: "image/png",
        extension: "png",
        size: 100,
        width: 1,
        height: 1,
        date: "",
        humanDate: "",
        links: {
            url: "https://img.example/a.png",
            thumbnailUrl: "https://img.example/a.png",
        },
    } as BeeImgImage;
    const second = {
        ...first,
        key: 4,
        pathname: "2026/b.png",
        links: {
            url: "https://cdn.example/b.png",
            thumbnailUrl: "https://cdn.example/b.png",
        },
    };
    const identities = [
        {
            id: 83,
            pathname: "2026/a.png",
            publicUrl: "https://img.example/a.png",
            albumIds: [9],
        },
        {
            id: 84,
            pathname: "2026/b.png",
            publicUrl: null,
            albumIds: [],
        },
    ];
    const unmatched = {
        ...first,
        key: 5,
        pathname: "2026/unmatched.png",
        links: {
            url: "https://img.example/unmatched.png",
            thumbnailUrl: "https://img.example/unmatched.png",
        },
    };
    const all = attachV2ImageIdentities([first, second, unmatched], identities);
    equal(all.length, 2);
    equal(all[0].remoteId, 83);
    equal(all[1].remoteId, 84);
    const album = attachV2ImageIdentities([first, second], identities, 9);
    equal(album.length, 1);
    equal(album[0].remoteId, 83);
});

test("sorts the complete image set before local pagination", () => {
    const image = (key: number, size: number, date: string): BeeImgImage => ({
        key,
        size,
        date,
        name: String(key),
        pathname: "",
        mimetype: "image/png",
        extension: "png",
        width: 1,
        height: 1,
        humanDate: "",
        links: {
            url: `https://img.example/${key}.png`,
            thumbnailUrl: `https://img.example/${key}.png`,
        },
    });
    const images = [
        image(1, 300, "2026-01-02 00:00:00"),
        image(2, 100, "2026-01-03 00:00:00"),
        image(3, 200, "2026-01-01 00:00:00"),
    ];
    const keys = (order: "newest" | "earliest" | "utmost" | "least") =>
        sortAndPaginateImages(images, { page: 1, order }, 10).items
            .map((item) => item.key)
            .join(",");
    equal(keys("newest"), "2,1,3");
    equal(keys("earliest"), "3,1,2");
    equal(keys("utmost"), "1,3,2");
    equal(keys("least"), "2,3,1");

    const secondPage = sortAndPaginateImages(
        images,
        { page: 2, order: "newest" },
        2
    );
    equal(secondPage.items[0].key, 3);
    equal(secondPage.total, 3);
    equal(secondPage.lastPage, 2);
});

test("formats sizes and produces escaped markdown fallbacks", () => {
    equal(formatFileSize(0), "0 B");
    equal(formatFileSize(1536), "1.5 KB");
    equal(formatFileSize(10 * 1024 * 1024), "10 MB");

    const image = {
        name: "a]b.png",
        links: { url: "https://img.example/a.png", thumbnailUrl: "" },
    } as BeeImgImage;
    equal(imageMarkdown(image), "![a\\]b.png](https://img.example/a.png)");
});
