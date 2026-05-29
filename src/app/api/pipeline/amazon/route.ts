import { NextRequest, NextResponse } from "next/server";
import { getAmazonStageResults } from "@/lib/step-function";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const arn = searchParams.get("arn");

        if (!arn) {
            logger.warn("Amazon stage API called without ARN");
            return NextResponse.json(
                { error: "Execution ARN is required" },
                { status: 400 }
            );
        }

        const stageResult = await getAmazonStageResults(arn);

        if (!stageResult.available) {
            logger.debug(`Amazon stage not ready yet | ARN: ${arn}`);
            return NextResponse.json({
                success: false,
                message: "Amazon marketplace stage not completed yet",
                available: false
            });
        }

        const serialized = JSON.parse(JSON.stringify(stageResult.results || [], (key, value) =>
            typeof value === "bigint" ? Number(value) : value
        ));

        logger.info(`Amazon stage results fetched | ARN: ${arn} | Rows: ${serialized.length}`);

        return NextResponse.json({
            success: true,
            available: true,
            meta: stageResult.amazon_clean,
            count: serialized.length,
            results: serialized
        });
    } catch (error: unknown) {
        logger.error("Amazon Marketplace Stage API Error", error);
        return NextResponse.json(
            { error: (error as Error).message || "Failed to fetch Amazon marketplace stage results" },
            { status: 500 }
        );
    }
}
