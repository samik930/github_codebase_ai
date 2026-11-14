import { 
    ingestController, 
    getJobStatusController,
    getUserJobsController,
    retryJobController,
    cancelJobController,
    queryController, 
    repositoriesController,
    getChatHistoryController,
    clearChatHistoryController,
    deleteRepositoryController,
    googleAuthController
} from "../controllers/controller.js";
import { Router } from "express";

const router = Router();

router.post('/auth/google', googleAuthController);

// Ingestion endpoints
router.post('/ingest', ingestController);
router.get('/ingest/status/:jobId', getJobStatusController);
router.get('/ingest/jobs', getUserJobsController);
router.post('/ingest/retry/:jobId', retryJobController);
router.post('/ingest/cancel/:jobId', cancelJobController);
router.delete('/ingest/job/:jobId', cancelJobController);

// Query & Repositories endpoints
router.post('/query', queryController);
router.get('/repositories', repositoriesController);

// Chat history endpoints (supports query param /api/chat?repo_id=owner/repo or /api/chat/:owner/:repo)
router.get('/chat', getChatHistoryController);
router.delete('/chat', clearChatHistoryController);
router.get('/chat/:owner/:repo', (req, res, next) => {
    req.params.repoId = `${req.params.owner}/${req.params.repo}`;
    return getChatHistoryController(req, res, next);
});
router.delete('/chat/:owner/:repo', (req, res, next) => {
    req.params.repoId = `${req.params.owner}/${req.params.repo}`;
    return clearChatHistoryController(req, res, next);
});

// Delete repository endpoints
router.delete('/repositories', deleteRepositoryController);
router.delete('/repositories/:owner/:repo', (req, res, next) => {
    req.params.repoId = `${req.params.owner}/${req.params.repo}`;
    return deleteRepositoryController(req, res, next);
});

export default router;
