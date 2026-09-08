import axios from "axios";
import "dotenv/config";
import { isSensitiveFile } from "../rag/sensitiveGuard.js";

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

    return response.data.tree;
}

const IGNORED_DIRECTORIES = [
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "coverage"
];

const IGNORED_EXTENSIONS = [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
    ".ico",
    ".mp4",
    ".mp3",
    ".zip",
    ".exe"
];

export function isUsefulFile(filePath) {
    if (isSensitiveFile(filePath)) {
        return false;
    }

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

    if (IGNORED_EXTENSIONS.includes(extension)) {
        return false;
    }
    return true;
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

export async function getUsefulFiles(owner, repo, tree) {
    const files = tree.filter(
        item =>
            item.type === "blob" &&
            isUsefulFile(item.path)
    );

    const results = [];

    for (const file of files) {
        const content = await getFileContent(
            owner,
            repo,
            file.path
        );

        results.push({
            path: file.path,
            content: content
        });
    }

    return results;
}