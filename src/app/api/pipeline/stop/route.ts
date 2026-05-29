import { NextRequest, NextResponse } from "next/server";
import { stopPipelineExecution } from "@/lib/step-function";
import { logger } from "@/lib/logger";

export async function POST(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const arn = searchParams.get("arn");

        if (!arn) {
            return NextResponse.json({ error: "Execution ARN is required" }, { status: 400 });
        }

        logger.info(`Stop pipeline requested | ARN: ${arn}`);
        const stopDate = await stopPipelineExecution(arn);
        logger.info(`Pipeline stopped successfully | ARN: ${arn}`);

        return NextResponse.json({
            success: true,
            stopDate
        });
    } catch (error: unknown) {
        logger.error("Stop Pipeline Error", error);
        return NextResponse.json({ error: (error as Error).message }, { status: 500 });
    }
}

