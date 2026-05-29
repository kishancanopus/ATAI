# ATAI Hybrid Dashboard - Phase 1 Backend

This is a Next.js 16 (App Router) backend providing server-side APIs to interact with the ATAI product sourcing pipeline hosted on AWS. It powers the "hybrid" dashboard by orchestrating AWS Step Functions, Lambda, S3 and Parquet-backed datasets for ranked products and discovery criteria.

## 🚀 Setup & Local Development

1. **Prerequisites**
   - Node.js 18+ (Node 20 LTS recommended)
   - npm (comes with Node)
   - AWS credentials with access to the relevant S3 buckets and Step Functions state machine

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   Create a `.env.local` file in the project root. Do **not** commit real keys to git.

   ```env
   # AWS region and credentials
   AWS_REGION=eu-north-1
   AWS_ACCESS_KEY_ID=your_access_key
   AWS_SECRET_ACCESS_KEY=your_secret_key

   # S3 buckets / keys
   S3_CLEAN_BUCKET=your-clean-layer-bucket              # optional, for cleaned intermediate data
   S3_RANKED_BUCKET=your-ranked-results-bucket          # e.g. atai-result-data
   S3_RANKED_KEY=ranked/manual_search/ranked_results.parquet

   S3_CONFIG_BUCKET=atai-config
   S3_CRITERIA_KEY=discovery_criteria.json

   # Orchestration (Step Functions / Lambda)
   STEP_FUNCTION_ARN=arn:aws:states:...:stateMachine:your-state-machine
   CRITERIA_EVALUATOR_FUNCTION=your-criteria-evaluator-lambda-name-or-arn

   # External services
   SERPAPI_KEY=your_serpapi_key
   ```

4. **Run the development server**
   ```bash
   npm run dev
   ```
   The server will be available at `http://localhost:3000`.

5. **Build & production**
   ```bash
   npm run build
   npm start
   ```

---

## 🛠️ API Documentation (Backend Endpoints)

### 1. Products API – Get Ranked Data

- **Endpoint**: `GET /api/products`
- **Description**: Fetches the latest ranked product results from S3 with advanced keyword, location, and source-specific filters.
- **Query params** (all optional unless stated otherwise):
  - `keyword` (string): Filter products by keyword.
  - `category` (string): Filter by search or leaf category.
  - `location` (string): Location / geo filter (e.g. `us`, `se`); applied to trend and source geo fields.
  - `blacklist` (string): Comma-separated list of words to exclude from title/keyword.
  - `search_volume_min` (number): Minimum monthly searches (Keyword Planner).
  - `google_trend_score` (number): Minimum Google Trends score (0–100).
  - `search_mode` (string): `"manual_search"` (default) or `"category_search"`.
  - `amazonFilters` (string): `"false"` to hide Amazon-based results, anything else (or omitted) keeps them enabled.
  - `alibabaFilters` (string): `"false"` to hide Alibaba-based results, anything else (or omitted) keeps them enabled.
  - **Amazon filters** (applied when `amazonFilters` is enabled and product `source === "amazon"`):
    - `amz_price_min` / `amz_price_max` (number): Price range in USD.
    - `reviews_min` / `reviews_max` (number): Review count range.
    - `rating_min` (number): Minimum rating (0–5).
    - `fcl_min` / `fcl_max` (number): FCL price range.
  - **Alibaba filters** (applied when `alibabaFilters` is enabled and product `source === "alibaba"`):
    - `margin_min` (number): Minimum margin percentage (Cost Below %).
    - `moq_max` (number): Maximum MOQ.
    - `supplier_rating_min` (number): Minimum supplier rating.
    - `verified_supplier` (boolean string): `"true"` to require verified suppliers.

- **Output format** (simplified):
  ```json
  [
    {
      "product_id": "...",
      "title": "...",
      "final_score": 85.5,
      "margin_pct": 32.2
      // other Amazon / Alibaba / trend fields...
    }
  ]
  ```

### 2. Criteria API – Manage Discovery Criteria

- **GET** `/api/criteria`  
  Returns the current set of discovery criteria loaded from the config bucket.

- **POST** `/api/criteria`  
  Creates or updates a criteria entry in S3. If a `criteria_id` already exists, it is merged; otherwise it is appended.

  **Request body example**:
  ```json
  {
    "criteria_id": "cs_001",
    "name": "Trending Electronics",
    "keywords": ["smart home", "iot"],
    "active": true,
    "...": "..."
  }
  ```

### 3. Pipeline Orchestration APIs

These endpoints orchestrate the AWS Step Functions pipeline used to refresh ranked data.

- **Trigger pipeline**
  - **Endpoint**: `POST /api/pipeline/trigger`
  - **Body**:
    ```json
    {
      "keyword": "air purifier",
      "search_mode": "manual_search",
      "filters": {
        "category": "Home & Kitchen",
        "location": "us",
        "search_volume_min": 1000,
        "google_trend_score": 50,
        "amazonFilters": true,
        "alibabaFilters": true
      }
    }
    ```
  - **Response**: Contains `executionArn`, `execution_details` (for category search), `success`, and a `message`.

- **Check pipeline status**
  - **Endpoint**: `GET /api/pipeline/status?arn=<executionArn>`
  - **Description**: Returns execution status (`RUNNING`, `SUCCEEDED`, `FAILED`, etc.) and timestamps.

- **Stop pipeline execution**
  - **Endpoint**: `POST /api/pipeline/stop?arn=<executionArn>`
  - **Description**: Stops a running execution (no-op for category-search pseudo ARNs).

- **Preliminary results**
  - **Endpoint**: `GET /api/pipeline/preliminary`
  - **Query params**:
    - `keyword` (string, optional): Filter manual-search preliminary results by keyword.
    - `search_mode` (string, default `"manual_search"`): `"manual_search"` or `"category_search"`.
    - `category` (string, optional): Category filter for category-search results.
  - **Description**: Returns early-stage consolidated results from S3 while the full pipeline may still be running.

### 4. Trends & Keyword Discovery API

- **Endpoint**: `GET /api/trends/related-queries`
- **Description**: Returns related queries / keywords for a category using SerpAPI discovery first, then Google Trends as a fallback.
- **Query params**:
  - `category` (string, required): Category/topic to discover keywords for.
  - `geo` (string, optional): Geo code (e.g. `US`, `SE`).
  - `limit` (number, optional, default 50, max 100): Max keywords to return.
  - `trendPeriod` (number, optional, default 12): Lookback window in months for Google Trends when used as a fallback.
- **Response**:
  ```json
  {
    "keywords": ["...", "..."]
  }
  ```

---

## 📦 Key Technologies & Dependencies

- **Next.js 16.1.1** (App Router) – API routes under `src/app/api`.
- **React 19** – UI layer (if/when frontend is added in this repo).
- **AWS SDK v3** – `@aws-sdk/client-s3`, `@aws-sdk/client-sfn`, `@aws-sdk/client-lambda` for S3, Step Functions and Lambda integration.
- **hyparquet** – High-performance Parquet reader used to load ranked and intermediate datasets from S3.
- **google-trends-api** – Google Trends integration for keyword and trend signals.
- **Tailwind CSS 4** – Utility-first styling (already wired into the Next.js build).

## 📂 Source Structure (Backend)

- `src/app/api/products/route.ts` – Ranked products API with filtering logic.
- `src/app/api/criteria/route.ts` – CRUD-like access for discovery criteria stored in S3.
- `src/app/api/pipeline/*` – Pipeline orchestration endpoints (`trigger`, `status`, `stop`, `preliminary`, and stage helpers).
- `src/app/api/trends/related-queries/route.ts` – Category/geo keyword discovery using SerpAPI + Google Trends.
- `src/lib/s3.ts` – Shared S3 utilities for reading/writing Parquet and JSON config.
- `src/lib/step-function.ts` – Step Functions integration, pipeline input builder, and stage-result helpers.
- `src/lib/*.ts` – Supporting libraries for category seeds and Google Trends keyword discovery.
