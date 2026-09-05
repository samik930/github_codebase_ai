import {
    parseGithubURL,
    getRepository,
    getRepositoryTree,
    isUsefulFile,
    getFileContent,
    getUsefulFiles
} from "./github/downloadRepo.js";

const githubUrl = "https://github.com/facebook/react";

const { owner, repo } = parseGithubURL(githubUrl);

console.log("Owner:", owner);
console.log("Repo:", repo);

const repository = await getRepository(owner, repo);

console.log("Repository name:", repository.name);
console.log("Default branch:", repository.default_branch);

const tree = await getRepositoryTree(
    owner,
    repo,
    repository.default_branch
);

const files = tree.filter(
    item => item.type === "blob"
);

const usefulFiles = files.filter(
    file => isUsefulFile(file.path)
);

console.log("Total files:", files.length);
console.log("Useful files:", usefulFiles.length);

const firstFile = usefulFiles[0];

console.log("Testing file:", firstFile.path);

const content = await getFileContent(
    owner,
    repo,
    firstFile.path
);

console.log("File content:");
console.log(content);

console.log(await getUsefulFiles)


