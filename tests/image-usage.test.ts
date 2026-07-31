import { extractImageUrls, ImageUsageStore } from "../image-usage";
import { equal, test } from "./test-harness";

test("counts repeated references separately from note counts", () => {
    const store = new ImageUsageStore();
    store.updateFile("one.md", [
        "https://img.example/a.png",
        "https://img.example/a.png#preview",
        "not-a-url",
    ]);
    store.updateFile("two.md", ["https://img.example/a.png"]);
    const usage = store.getUsage("https://img.example/a.png");
    equal(usage.referenceCount, 3);
    equal(usage.noteCount, 2);
    equal(usage.notePaths.join(","), "one.md,two.md");
});

test("updates and removes per-file contributions", () => {
    const store = new ImageUsageStore();
    store.updateFile("note.md", ["https://img.example/a.png"]);
    store.updateFile("note.md", ["https://img.example/b.png"]);
    equal(store.getUsage("https://img.example/a.png").referenceCount, 0);
    equal(store.getUsage("https://img.example/b.png").referenceCount, 1);
    store.removeFile("note.md");
    equal(store.getUsage("https://img.example/b.png").referenceCount, 0);
});

test("renames notes without changing reference totals", () => {
    const store = new ImageUsageStore();
    store.updateFile("old.md", ["https://img.example/a.png"]);
    store.renameFile("old.md", "folder/new.md");
    const usage = store.getUsage("https://img.example/a.png");
    equal(usage.referenceCount, 1);
    equal(usage.notePaths.join(","), "folder/new.md");
});

test("extracts Markdown and HTML image sources with repeated references", () => {
    const urls = extractImageUrls([
        "![first](https://img.example/a.png)",
        "![second](<https://img.example/a.png>)",
        "![title](https://img.example/b.png \"caption\")",
        '<img alt="html" src="https://img.example/c.png">',
    ].join("\n"));
    equal(
        urls.join(","),
        "https://img.example/a.png,https://img.example/a.png,https://img.example/b.png,https://img.example/c.png"
    );
});

test("does not count ordinary links, escaped images, comments, or code", () => {
    const urls = extractImageUrls([
        "[ordinary](https://img.example/link.png)",
        "\\![escaped](https://img.example/escaped.png)",
        "`![inline](https://img.example/inline.png)`",
        "<!-- ![comment](https://img.example/comment.png) -->",
        "```md",
        "![fenced](https://img.example/fenced.png)",
        "```",
        "![real](https://img.example/real_(1).png)",
    ].join("\n"));
    equal(urls.join(","), "https://img.example/real_(1).png");
});

test("updates pasted Markdown image references in the usage store", () => {
    const store = new ImageUsageStore();
    store.updateFile("note.md", extractImageUrls("before paste"));
    store.updateFile(
        "note.md",
        extractImageUrls([
            "![one](https://img.example/pasted.png)",
            "![two](https://img.example/pasted.png)",
        ].join("\n"))
    );
    const usage = store.getUsage("https://img.example/pasted.png");
    equal(usage.referenceCount, 2);
    equal(usage.noteCount, 1);
});
