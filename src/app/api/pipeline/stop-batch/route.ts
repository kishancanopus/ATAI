import { NextRequest, NextResponse } from "next/server";
import { stopPipelineExecutions } from "@/lib/step-function";
import { logger } from "@/lib/logger";

export async function POST(request: NextRequest) {
    try {
        const body = (await request.json()) as { arns?: unknown };
        const arns = Array.isArray(body.arns)
            ? body.arns.filter((arn): arn is string => typeof arn === "string" && arn.trim().length > 0)
            : [];

        if (arns.length === 0) {
            return NextResponse.json({ error: "At least one execution ARN is required" }, { status: 400 });
        }

        logger.info(`Batch stop pipeline requested | count: ${arns.length}`);
        const result = await stopPipelineExecutions(arns);
        logger.info(
            `Batch stop completed | stopped: ${result.stopped.length} | failed: ${result.failed.length}`
        );

        return NextResponse.json({
            success: result.failed.length === 0,
            ...result,
        });
    } catch (error: unknown) {
        logger.error("Batch Stop Pipeline Error", error);
        return NextResponse.json({ error: (error as Error).message }, { status: 500 });
    }
}
