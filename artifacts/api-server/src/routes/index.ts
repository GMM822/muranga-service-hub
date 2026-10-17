import { Router, type IRouter } from "express";
import healthRouter from "./health";
import requestRouter from "./requests";
import storageRouter from "./storage";

const router: IRouter = Router();

router.use(healthRouter);
router.use(requestRouter);
router.use(storageRouter);

export default router;
