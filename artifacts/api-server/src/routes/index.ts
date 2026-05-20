import { Router, type IRouter } from "express";
import healthRouter from "./health";
import simulationRouter from "./simulation";

const router: IRouter = Router();

router.use(healthRouter);
router.use(simulationRouter);

export default router;
