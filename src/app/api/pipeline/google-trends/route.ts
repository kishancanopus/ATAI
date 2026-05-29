import { NextRequest, NextResponse } from "next/server";
import { getGoogleTrendsStageResults } from "@/lib/step-function";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const arn = searchParams.get("arn");

        if (!arn) {
            return NextResponse.json(
                { error: "Execution ARN is required" },
                { status: 400 }
            );
        }

        const stageResult = await getGoogleTrendsStageResults(arn);

        if (!stageResult.available) {
            logger.debug(`Google Trends stage not ready yet | ARN: ${arn}`);
            return NextResponse.json({
                success: false,
                message: "Google Trends stage not completed yet",
                available: false
            });
        }

        // BigInt is not JSON serializable, convert to Number/String
        const serialized = JSON.parse(JSON.stringify(stageResult.results || [], (key, value) =>
            typeof value === "bigint" ? Number(value) : value
        ));

        logger.info(`Google Trends stage results fetched | ARN: ${arn} | Rows: ${serialized.length}`);

        return NextResponse.json({
            success: true,
            available: true,
            meta: stageResult.trends_clean,
            count: serialized.length,
            results: serialized
        });
    } catch (error: unknown) {
        logger.error("Google Trends Stage API Error", error);
        return NextResponse.json(
            { error: (error as Error).message || "Failed to fetch Google Trends stage results" },
            { status: 500 }
        );
    }
}
