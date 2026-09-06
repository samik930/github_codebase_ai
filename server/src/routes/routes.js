import { ingestController, queryController } from "../controllers/controller.js";
import { Router } from "express";

const router = Router();

router.post('/ingest', ingestController);
router.post('/query', queryController);

export default router;
