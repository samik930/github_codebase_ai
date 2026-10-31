import { ingestController, queryController, repositoriesController } from "../controllers/controller.js";
import { Router } from "express";

const router = Router();

router.post('/ingest', ingestController);
router.post('/query', queryController);
router.get('/repositories', repositoriesController);

export default router;
