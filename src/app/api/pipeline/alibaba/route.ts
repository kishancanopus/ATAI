import { NextRequest, NextResponse } from "next/server";
import { getAlibabaStageResults } from "@/lib/step-function";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const arn = searchParams.get("arn");

        if (!arn) {
            logger.warn("Alibaba stage API called without ARN");
            return NextResponse.json(
                { error: "Execution ARN is required" },
                { status: 400 }
            );
        }

        const stageResult = await getAlibabaStageResults(arn);

        if (!stageResult.available) {
            logger.debug(`Alibaba stage not ready yet | ARN: ${arn}`);
            return NextResponse.json({
                success: false,
                message: "Alibaba marketplace stage not completed yet",
                available: false
            });
        }

        const serialized = JSON.parse(JSON.stringify(stageResult.results || [], (key, value) =>
            typeof value === "bigint" ? Number(value) : value
        ));

        logger.info(`Alibaba stage results fetched | ARN: ${arn} | Rows: ${serialized.length}`);

        return NextResponse.json({
            success: true,
            available: true,
            meta: stageResult.alibaba_clean,
            count: serialized.length,
            results: serialized
        });
    } catch (error: unknown) {
        logger.error("Alibaba Marketplace Stage API Error", error);
        return NextResponse.json(
            { error: (error as Error).message || "Failed to fetch Alibaba marketplace stage results" },
            { status: 500 }
        );
    }
}
