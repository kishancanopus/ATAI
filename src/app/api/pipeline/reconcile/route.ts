import { NextRequest, NextResponse } from "next/server";
import { findCategoryChildExecution } from "@/lib/step-function";
import { logger } from "@/lib/logger";

/**
 * Link a category keyword row to an existing Step Functions execution by name prefix.
 * Used when AWS started the run but the dashboard still shows PENDING (missing ARN).
 */
export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const keyword = searchParams.get("keyword")?.trim();
        const sinceParam = searchParams.get("since");
        const startedAfterMs = sinceParam ? Number(sinceParam) : undefined;

        if (!keyword) {
            return NextResponse.json({ error: "keyword is required" }, { status: 400 });
        }

        const match = await findCategoryChildExecution(keyword, {
            startedAfterMs: Number.isFinite(startedAfterMs) ? startedAfterMs : undefined,
        });

        if (!match) {
            return NextResponse.json({ found: false, executionArn: null });
        }

        logger.info(
            `Reconciled category execution for "${keyword}" → ${match.executionName} (${match.status})`
        );

        return NextResponse.json({
            found: true,
            executionArn: match.executionArn,
            executionName: match.executionName,
            status: match.status,
        });
    } catch (error: unknown) {
        logger.error("Pipeline reconcile error", error);
        return NextResponse.json(
            { error: (error as Error).message || "Failed to reconcile execution" },
            { status: 500 }
        );
    }
}
