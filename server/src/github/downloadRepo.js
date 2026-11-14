import axios from "axios";
import "dotenv/config";

const githubHeaders = {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json"
};

export function parseGithubURL(github_url) {
    const url = new URL(github_url);

    const parts = url.pathname
        .split("/")
        .filter(Boolean);

    if (parts.length < 2) {
        throw new Error("Invalid GitHub repository URL");
    }

    const owner = parts[0];
    const repo = parts[1].replace(".git", "");

    return {
        owner,
        repo
    };
}

export async function getRepository(owner, repo) {
    const response = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}`,
        {
            headers: githubHeaders
        }
    );

    return response.data;
}

export async function getRepositoryTree(owner, repo, branch) {
    const response = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
        {
            headers : githubHeaders
        }
    );

    return {
        tree: response.data.tree,
        sha: response.data.sha
    };
}

const IGNORED_DIRECTORIES = [
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "coverage",
    ".venv",
    "venv",
    "env",
    "__pycache__",
    ".turbo",
    ".cache"
];

const IGNORED_FILENAMES = [
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
    "cargo.lock",
    "poetry.lock",
    "composer.lock",
    "gemfile.lock",
    ".ds_store",
    "thumbs.db"
];

const SUPPORTED_IMAGE_EXTENSIONS = [
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".svg"
];

const IGNORED_EXTENSIONS = [
    ".ico",
    ".gif",
    ".mp4",
    ".mp3",
    ".zip",
    ".exe",
    ".pdf",
    ".tar",
    ".gz",
    ".woff",
    ".woff2",
    ".ttf",
    ".eot",
    ".map"
];

export function isUsefulFile(filePath) {
    if (!filePath) return false;
    const normalized = filePath.replace(/\\/g, "/").toLowerCase();
    const parts = normalized.split("/");
    const fileName = parts[parts.length - 1];

    // 1. Check ignored directories
    if (parts.some(part => IGNORED_DIRECTORIES.includes(part))) {
        return false;
    }

    // 2. Check ignored filenames (lockfiles, system files)
    if (IGNORED_FILENAMES.includes(fileName)) {
        return false;
    }

    // 3. Check minified or source map files
    if (fileName.endsWith(".min.js") || fileName.endsWith(".min.css") || fileName.endsWith(".map")) {
        return false;
    }

    // 4. Check extension
    const dotIndex = fileName.lastIndexOf(".");
    if (dotIndex !== -1) {
        const extension = fileName.substring(dotIndex);
        if (IGNORED_EXTENSIONS.includes(extension) || SUPPORTED_IMAGE_EXTENSIONS.includes(extension)) {
            return false;
        }
    }

    return true;
}

export function isVisualFile(filePath) {
    const parts = filePath.split("/");

    const hasIgnoredDirectory = parts.some(
        part => IGNORED_DIRECTORIES.includes(part)
    );

    if (hasIgnoredDirectory) {
        return false;
    }

    const extension = filePath
        .substring(filePath.lastIndexOf("."))
        .toLowerCase();

    return SUPPORTED_IMAGE_EXTENSIONS.includes(extension);
}

export async function getFileContent(owner, repo, filePath) {
    const response = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
        { headers: githubHeaders }
    );

    const content = response.data.content;

    return Buffer
        .from(content, "base64")
        .toString("utf-8");
}

export async function getImageContent(owner, repo, filePath) {
    try {
        const response = await axios.get(
            `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
            { headers: githubHeaders }
        );

        const content = response.data.content;
        if (!content) return null;
        return content.replace(/\s/g, "");
    } catch (error) {
        console.error(`[WARN] Failed to fetch visual asset ${filePath}:`, error.message);
        return null;
    }
}

export async function getUsefulFiles(owner, repo, tree) {
    const files = tree.filter(
        item =>
            item.type === "blob" &&
            isUsefulFile(item.path)
    );

    const results = [];

    for (const file of files) {
        try {
            const content = await getFileContent(
                owner,
                repo,
                file.path
            );

            results.push({
                path: file.path,
                content: content
            });
        } catch (err) {
            console.error(`[WARN] Failed to fetch code file ${file.path}:`, err.message);
        }
    }

    return results;
}

export async function getVisualFiles(owner, repo, tree, branch = "main") {
    const visualItems = tree.filter(
        item =>
            item.type === "blob" &&
            isVisualFile(item.path)
    );

    const results = [];

    for (const file of visualItems) {
        // Skip excessively large images (> 8MB)
        if (file.size && file.size > 8 * 1024 * 1024) {
            console.log(`[SKIP] Image ${file.path} is too large (${file.size} bytes)`);
            continue;
        }

        const base64Content = await getImageContent(owner, repo, file.path);
        if (base64Content) {
            const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file.path}`;
            results.push({
                path: file.path,
                content: base64Content,
                raw_url: rawUrl,
                type: "image"
            });
        }
    }

    return results;
}