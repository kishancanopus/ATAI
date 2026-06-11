import { NextRequest, NextResponse } from "next/server";
import { fetchKeywordsFromPlanner } from "@/lib/step-function";
import { logger } from "@/lib/logger";
import { resolveVariantLimitMax } from "@/lib/searchFilters";

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const {
            category,
            geo,
            limit,
            search_volume_min,
            search_volume_max,
            blacklist
        } = body;

        if (!category) {
            return NextResponse.json(
                { error: "Category is required" },
                { status: 400 }
            );
        }

        const resolvedLimit = resolveVariantLimitMax(limit);
        logger.info(`Generating keywords | Category: ${category} | Geo: ${geo || 'US'} | Limit: ${resolvedLimit}`);

        const keywords = await fetchKeywordsFromPlanner(
            category,
            geo || "US",
            resolvedLimit,
            search_volume_min,
            search_volume_max,
            blacklist || []
        );

        logger.info(`Keywords generated | Category: ${category} | Count: ${keywords.length}`);

        return NextResponse.json({
            success: true,
            keywords: keywords.length > 0 ? keywords : [category]
        });

    } catch (error: any) {
        logger.error("Generate Keywords API Error", error);
        return NextResponse.json(
            {
                error: error.message || "Failed to generate keywords",
                stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined,
                cause: error.cause
            },
            { status: 500 }
        );
    }
}
