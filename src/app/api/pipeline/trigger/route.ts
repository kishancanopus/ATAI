
import { NextRequest, NextResponse } from "next/server";
import { startPipelineExecution } from "@/lib/step-function";
import { logger } from "@/lib/logger";

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { keyword, filters, search_mode } = body;
        const category = filters?.category;

        if (!keyword && !category) {
            return NextResponse.json(
                { error: "Keyword or Category is required" },
                { status: 400 }
            );
        }

        logger.info(`Triggering pipeline for ${keyword ? `keyword: ${keyword}` : `category: ${category}`} | Mode: ${search_mode}`);
        logger.debug(`Payload: ${JSON.stringify(body)}`);
        
        const result = await startPipelineExecution(keyword, filters, search_mode);

        logger.info(`Pipeline triggered successfully. ARN: ${result.executionArn}`);

        return NextResponse.json({
            execution_details: result.execution_details,
            success: !!result.status,
            executionArn: result.executionArn,
            message: result.message
        });

    } catch (error: unknown) {
        logger.error("Pipeline Trigger Error", error);
        return NextResponse.json(
            { error: (error as Error).message || "Failed to start pipeline" },
            { status: 500 }
        );
    }
}