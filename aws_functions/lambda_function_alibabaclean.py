# ALIBABA CLEAN LAMBDA FUNCTION
import json
import os
import re
import tempfile
from datetime import datetime, timezone

import boto3
import pandas as pd

# Optional: import pyarrow only if available in the runtime (lambda layer/container)
try:
    import pyarrow as pa
    import pyarrow.parquet as pq
    PYARROW_AVAILABLE = True
except Exception:
    PYARROW_AVAILABLE = False

s3 = boto3.client("s3")
OUTPUT_BUCKET = os.environ.get("OUTPUT_BUCKET", "atai-clean-layer")

# -----------------------
# Helpers
# -----------------------
def safe_get(dct, *keys):
    for k in keys:
        if isinstance(dct, dict) and k in dct and dct[k] not in ("", None):
            return dct[k]
    return None

def parse_price_ladder(price_obj):
    if not isinstance(price_obj, dict):
        return None, None

    # 1) ladder-based prices (per-quantity tiers) - use ONLY dollarPrice
    pl = price_obj.get("productLadderPrices") or []
    vals = []
    for p in pl:
        if isinstance(p, dict):
            v = p.get("dollarPrice")
            if v is not None:
                try:
                    vals.append(float(v))
                except Exception:
                    pass
    if vals:
        return float(min(vals)), float(max(vals))

    # 2) range-based prices (overall range in priceRangePrices) - ONLY dollarPrice*
    pr = price_obj.get("productRangePrices")
    if isinstance(pr, dict):
        low = pr.get("dollarPriceRangeLow")
        high = pr.get("dollarPriceRangeHigh")

        try:
            pmin = float(low) if low is not None else None
            pmax = float(high) if high is not None else pmin
            if pmin is not None:
                return pmin, pmax
        except Exception:
            pass

    fmt = price_obj.get("formatLadderPrice")
    if isinstance(fmt, str):
        m = re.findall(r"([\d]+(?:\.\d+)?)", fmt.replace(",", ""))
        if m:
            nums = [float(x) for x in m]
            if len(nums) == 1:
                return nums[0], nums[0]
            return min(nums), max(nums)

    pfrom = price_obj.get("priceFrom") or price_obj.get("minPrice")
    pto = price_obj.get("priceTo") or price_obj.get("maxPrice")
    try:
        pmin = float(pfrom) if pfrom is not None else None
        pmax = float(pto) if pto is not None else pmin
        return pmin, pmax
    except:
        return None, None

def parse_moq(val):
    if val is None:
        return None
    try:
        return int(val)
    except:
        s = str(val)
        m = re.search(r"(\d+)", s.replace(",", ""))
        if m:
            return int(m.group(1))
    return None

def try_parse_kg_from_string(s):
    if not s:
        return None
    s = str(s)
    m = re.search(r"([\d]+(?:\.\d+)?)\s*kg\b", s, re.I)
    if m:
        try:
            return float(m.group(1))
        except:
            return None
    m = re.search(r"([\d]+(?:\.\d+)?)\s*g\b", s, re.I)
    if m:
        try:
            return float(m.group(1)) / 1000.0
        except:
            return None
    m = re.search(r"([\d]+(?:\.\d+)?)\s*(lb|lbs|pound|pounds)\b", s, re.I)
    if m:
        try:
            return float(m.group(1)) * 0.45359237
        except:
            return None
    return None

def parse_weight_kg_from_item(item):
    # checks many possible attribute locations; returns float kg or None
    for list_key in ("productBasicProperties", "productOtherProperties", "productKeyIndustryProperties"):
        lst = item.get(list_key)
        if isinstance(lst, list):
            for el in lst:
                if not isinstance(el, dict):
                    continue
                val = el.get("attrValue") or el.get("attributeValue") or el.get("value") or el.get("attrValueText")
                parsed = try_parse_kg_from_string(val)
                if parsed is not None:
                    return parsed

    ad = item.get("attributeData") or {}
    if isinstance(ad, dict):
        for key in ("keyAttributes", "otherAttributes", "attributeList", "attributes"):
            arr = ad.get(key) or []
            if isinstance(arr, list):
                for el in arr:
                    if not isinstance(el, dict):
                        continue
                    val = el.get("attributeValue") or el.get("attrValue") or el.get("valueText") or el.get("value")
                    parsed = try_parse_kg_from_string(val)
                    if parsed is not None:
                        return parsed

    for text_key in ("productHtmlDescription", "htmlDescription", "description"):
        txt = item.get(text_key)
        if isinstance(txt, str):
            parsed = try_parse_kg_from_string(txt)
            if parsed is not None:
                return parsed

    finfo = item.get("FInfo") or item.get("supplierInfo") or {}
    if isinstance(finfo, dict):
        for v in finfo.values():
            if isinstance(v, str):
                parsed = try_parse_kg_from_string(v)
                if parsed is not None:
                    return parsed

    # deep fallback scan
    def deep_scan(o):
        if isinstance(o, str):
            return try_parse_kg_from_string(o)
        if isinstance(o, dict):
            for vv in o.values():
                res = deep_scan(vv)
                if res is not None:
                    return res
        if isinstance(o, list):
            for it in o:
                res = deep_scan(it)
                if res is not None:
                    return res
        return None

    return deep_scan(item)

def extract_category(item):
    cats = item.get("categories") or item.get("category") or item.get("categoryList")
    if isinstance(cats, list):
        return " > ".join([str(x).strip() for x in cats if x])
    if isinstance(cats, str):
        return cats
    return None

def extract_supplier_info(item):
    sup = item.get("supplierInfo") or {}
    supplier_country = sup.get("registerCountry") or sup.get("country") or sup.get("location")
    supplier_link = sup.get("homeUrl") or sup.get("profileUrl") or sup.get("companyUrl") or sup.get("supplierUrl")
    supplier_rating = sup.get("rating") or sup.get("supplierRating")
    try:
        if supplier_rating is not None:
            supplier_rating = float(supplier_rating)
    except:
        supplier_rating = None
    supplier_name = sup.get("name") or sup.get("companyName")
    return supplier_country, supplier_rating, supplier_link, supplier_name

def extract_place_of_origin(item):
    # search productBasicProperties/productOtherProperties for place of origin
    for list_key in ("productBasicProperties", "productOtherProperties"):
        lst = item.get(list_key)
        if isinstance(lst, list):
            for el in lst:
                an = (el.get("attrName") or "").lower()
                if "place of origin" in an or "origin" in an:
                    return el.get("attrValue") or el.get("attrValueText")
    # also search attributeData for attributeName containing origin
    ad = item.get("attributeData") or {}
    if isinstance(ad, dict):
        for key in ("keyAttributes", "otherAttributes", "attributeList"):
            for el in ad.get(key) or []:
                if isinstance(el, dict):
                    name = (el.get("attributeName") or "").lower()
                    if "place" in name and "origin" in name:
                        return el.get("attributeValue") or el.get("value")
    return None

# -----------------------
# New: shipping detection (no static assumptions)
# -----------------------
def detect_ships_to_sv(item):
    """
    Return:
      True  -> explicit evidence that item ships to El Salvador (SV)
      False -> explicit evidence that item does NOT ship to El Salvador (SV)
      None  -> no shipping info present or ambiguous
    Rules (best-effort):
      - Look for fields like 'shipTo', 'shipToCountries', 'shipToCountriesList', 'shippingTo'
        which may be string, list, or comma-separated.
      - If any shipping field mentions 'El Salvador' or 'SV' (case-insensitive), return True.
      - If shipping field exists and is a list/string that clearly lists specific countries but does NOT include SV,
        return False.
      - If 'Global'/'Worldwide'/'All countries' found, return True (optional behavior controlled by treat_global_as_true flag).
    """
    treat_global_as_true = True

    # potential shipping fields to inspect
    candidates = []
    for key in ("shipTo", "shipToCountries", "shipToCountriesList", "shipping", "shippingTo", "shipToCountry", "shipsTo"):
        v = item.get(key)
        if v is not None:
            candidates.append(v)

    # supplier-level shipping info
    sup = item.get("supplierInfo") or {}
    for key in ("shipToCountries", "shipping", "shippingTo", "shipTo"):
        if sup.get(key) is not None:
            candidates.append(sup.get(key))

    if not candidates:
        return None

    sv_patterns = re.compile(r"\b(el salvador|salvador|sv|sv\.)\b", re.I)
    global_patterns = re.compile(r"\b(global|worldwide|all countries|every country|any country|all regions)\b", re.I)

    any_ships_fields = False
    any_specific_countries = False
    found_sv = False

    for v in candidates:
        any_ships_fields = True
        # normalize to string
        if isinstance(v, list):
            entries = [str(x) for x in v if x is not None]
            joined = ", ".join(entries)
        else:
            joined = str(v)

        # check for explicit SV
        if sv_patterns.search(joined):
            found_sv = True
            break

        # check for global
        if treat_global_as_true and global_patterns.search(joined):
            # treat as ships everywhere
            found_sv = True
            break

        # if it is a list of countries and does not contain SV -> mark specific
        # we treat comma-separated strings as lists
        if "," in joined or isinstance(v, list):
            # look for country names other than SV
            entries = [e.strip() for e in re.split(r"[,\|;/]+", joined) if e.strip()]
            if entries:
                # check existence of any country names; if entries present and none matched SV,
                # we consider this "specific list" (so if SV absent, it's explicit False)
                any_specific_countries = True
                # if any of these entries is not 'global' etc and no SV found, continue
                if any(sv_patterns.search(e) for e in entries):
                    found_sv = True
                    break

    if found_sv:
        return True
    if any_specific_countries and not found_sv:
        return False
    return None

def determine_geo(item):
    """
    Return the best 'geo' derived from supplier or product fields, else None.
    """
    # supplier country
    supplier_country = safe_get(item.get("supplierInfo") or {}, "registerCountry") or safe_get(item.get("supplierInfo") or {}, "country")
    if supplier_country:
        return supplier_country

    # place of origin in properties
    po = extract_place_of_origin(item)
    if po:
        return po

    # top-level geo/country fields
    for k in ("geo", "country", "originCountry", "placeOfOrigin"):
        v = item.get(k)
        if v:
            return v

    return None

# -----------------------
# Normalize one item
# -----------------------
def normalize_item(item, data_collected_at, keyword, search_category=None):
    pid = item.get("productId") or item.get("id") or None
    title = item.get("subject") or item.get("title") or None
    category = extract_category(item)
    min_p, max_p = parse_price_ladder(item.get("price") or item.get("pricing") or {})
    # orders_count: try several fields
    orders = None
    for k in ("ordersCount", "orders_count", "orders", "monthlyPurchaseVolume", "tradeVolume", "transactionLevel"):
        v = item.get(k)
        if v:
            m = re.search(r"([\d,]+)", str(v))
            if m:
                orders = int(m.group(1).replace(",", ""))
                break
    moq = parse_moq(item.get("moq") or item.get("moqUnit") or item.get("minimumOrderQuantity"))
    weight_kg = parse_weight_kg_from_item(item)
    ships_to_sv = detect_ships_to_sv(item)
    availability = item.get("availability") or item.get("sample") or item.get("availabilityStatus") or None
    supplier_country, supplier_rating, supplier_link, supplier_name = extract_supplier_info(item)
    geo = determine_geo(item)
    source = "alibaba"
    product_link = item.get("productUrl") or item.get("url") or item.get("link")

    # NOTE:
    # The output schema keeps keyword and search_category
    # and uses data_collected_at as the timestamp column.
    # Column set:
    # keyword, product_id, title, category, search_category,
    # alibaba_price_min_usd, alibaba_price_max_usd,
    # orders_count, moq, weight_kg, ships_to_sv, availability_status,
    # supplier_country, supplier_rating, supplier_link, geo,
    # data_collected_at, source, product_link
    return {
        "keyword": keyword,
        "product_id": str(pid) if pid is not None else None,
        "title": title,
        "category": category,
        "search_category": search_category,
        "alibaba_price_min_usd": min_p,
        "alibaba_price_max_usd": max_p,
        "orders_count": orders,
        "moq": moq,
        "weight_kg": weight_kg,
        "ships_to_sv": ships_to_sv,
        "availability_status": availability,
        "supplier_country": supplier_country,
        "supplier_rating": supplier_rating,
        "supplier_link": supplier_link,
        "geo": geo,
        "data_collected_at": data_collected_at,
        "source": source,
        "product_link": product_link,
    }

def apply_alibaba_filters(df, filters):

    if not filters.get("enable_alibaba", False):
        print("🟡 Alibaba filters OFF — saving all rows")
        return df

    print("🟢 Applying Alibaba filters")

    margin_min = filters.get("margin_min")  # %
    moq_max = filters.get("moq_max")
    min_rating = filters.get("min_rating")
    verified_supplier_val = filters.get("verified_supplier")

    # Helper to check if a filter value is valid/provided
    def is_valid_filter_value(val):
        if val is None or pd.isna(val):
            return False
        if isinstance(val, str):
            val_stripped = val.strip().lower()
            if val_stripped in ("", "null", "none", "undefined"):
                return False
            try:
                if float(val_stripped) == 0.0:
                    return False
            except ValueError:
                pass
        elif isinstance(val, (int, float)):
            if float(val) == 0.0:
                return False
        return True

    has_margin_filter = is_valid_filter_value(margin_min)
    has_moq_filter = is_valid_filter_value(moq_max)
    has_rating_filter = is_valid_filter_value(min_rating)
    
    # verified_supplier should be checked if it's explicitly True or "true"
    is_verified_only = False
    if is_valid_filter_value(verified_supplier_val):
        if isinstance(verified_supplier_val, bool):
            is_verified_only = verified_supplier_val
        elif isinstance(verified_supplier_val, str):
            is_verified_only = (verified_supplier_val.strip().lower() == "true")

    filtered_rows = []

    print(f"📊 Rows before filtering: {len(df)}")

    # median price (for margin logic)
    median_price = None
    if has_margin_filter and not df.empty:
        median_price = df["alibaba_price_min_usd"].dropna().median()

    for _, row in df.iterrows():

        price = row.get("alibaba_price_min_usd")
        moq = row.get("moq")
        rating = row.get("supplier_rating")
        supplier_country = row.get("supplier_country")

        # -------- PRICE / MARGIN FILTER --------
        if has_margin_filter:
            if price is None or pd.isna(price) or median_price is None or pd.isna(median_price):
                continue
            try:
                max_allowed_price = median_price * (1 - float(margin_min))
                if price > max_allowed_price:
                    continue
            except Exception as e:
                print(f"Error checking margin filter: {e}")
                continue

        # -------- MOQ FILTER --------
        if has_moq_filter:
            if moq is None or pd.isna(moq):
                continue
            try:
                if moq > int(moq_max):
                    continue
            except Exception as e:
                print(f"Error checking MOQ filter: {e}")
                continue

        # -------- SUPPLIER RATING FILTER --------
        if has_rating_filter:
            if rating is None or pd.isna(rating):
                continue
            try:
                if rating < float(min_rating):
                    continue
            except Exception as e:
                print(f"Error checking supplier rating filter: {e}")
                continue

        # -------- VERIFIED SUPPLIER FILTER --------
        if is_verified_only:
            # assuming verified supplier has country or supplier_link
            if not supplier_country or pd.isna(supplier_country):
                continue

        filtered_rows.append(row)

    df_filtered = pd.DataFrame(filtered_rows)

    print(f"📊 Rows after filtering: {len(df_filtered)}")

    return df_filtered

# -----------------------
# Filename / date helper
# -----------------------
def extract_date_from_filename(key):
    fn = key.split("/")[-1] if isinstance(key, str) else ""
    m = re.search(r'_(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)\.json$', fn)
    if m:
        ts = m.group(1)
        try:
            dt = datetime.strptime(ts, "%Y-%m-%dT%H-%M-%SZ")
            return dt.strftime("%Y-%m-%d")
        except:
            pass
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")

# -----------------------
# S3 read / write
# -----------------------
def s3_json_to_table(input_bucket, input_key, output_bucket, output_key, filters, search_category: None):
    obj = s3.get_object(Bucket=input_bucket, Key=input_key)
    raw = json.load(obj["Body"])

    # normalize shape
    if isinstance(raw, dict) and "items" in raw and isinstance(raw["items"], list):
        items = raw["items"]
    elif isinstance(raw, list):
        items = raw
    elif isinstance(raw, dict) and isinstance(raw.get("data", {}).get("content"), list):
        items = raw["data"]["content"]
    else:
        items = [raw] if isinstance(raw, dict) else []

    data_collected_at = extract_date_from_filename(input_key)
    normalized = []
    for it in items:
        try:
            print("Keyword -------------->>>>>>>>", it["keyword"])
            keyword = it["keyword"]
            normalized.append(normalize_item(it, data_collected_at, keyword, search_category))
        except Exception as e:
            # don't fail the whole run for single item errors
            print("WARN normalize failed for an item:", e)
            continue

    # Final column order (including keyword & search_category)
    cols = [
        "keyword",
        "product_id",
        "title",
        "category",
        "search_category",
        "alibaba_price_min_usd",
        "alibaba_price_max_usd",
        "orders_count",
        "moq",
        "weight_kg",
        "ships_to_sv",
        "availability_status",
        "supplier_country",
        "supplier_rating",
        "supplier_link",
        "geo",
        "data_collected_at",
        "source",
        "product_link",
    ]

    df = pd.DataFrame(normalized, columns=cols)
    original_count = len(df)

    # coerce numeric types
    df["alibaba_price_min_usd"] = pd.to_numeric(df["alibaba_price_min_usd"], errors="coerce")
    df["alibaba_price_max_usd"] = pd.to_numeric(df["alibaba_price_max_usd"], errors="coerce")
    df["orders_count"] = pd.to_numeric(df["orders_count"], errors="coerce").astype("Int64")
    df["moq"] = pd.to_numeric(df["moq"], errors="coerce").astype("Int64")
    df["weight_kg"] = pd.to_numeric(df["weight_kg"], errors="coerce")

    # >>> APPLY FILTERS BEFORE WRITING FILE <<<
    df = apply_alibaba_filters(df, filters)

    size = filters.get("size")
    if isinstance(size, int) and size >= 0:
        df = df[:size]

    filtered_count = len(df)

    # write parquet if pyarrow is available, otherwise write csv as fallback
    if PYARROW_AVAILABLE:
        with tempfile.NamedTemporaryFile(suffix=".parquet", delete=False) as tmp:
            tmp_path = tmp.name
        table = pa.Table.from_pandas(df)
        pq.write_table(table, tmp_path)
        s3.upload_file(tmp_path, output_bucket, output_key)
        try:
            os.remove(tmp_path)
        except:
            pass
    else:
        # fallback CSV
        with tempfile.NamedTemporaryFile(suffix=".csv", delete=False, mode="w", encoding="utf-8") as tmp:
            tmp_path = tmp.name
            df.to_csv(tmp_path, index=False)
        s3.upload_file(tmp_path, output_bucket, output_key.replace(".parquet", ".csv"))
        try:
            os.remove(tmp_path)
        except:
            pass

    return original_count, filtered_count

def generate_output_key(input_key: str, search_mode) -> str:
    timestamp = input_key.split("/")[-1].replace(".json", "")
    return f"clean/{search_mode}/alibaba/{timestamp}.parquet"
# -----------------------
# Lambda handler
# -----------------------
def lambda_handler(event, context):
    try:
        print("Alibaba clean lambda triggered:", event)

        input_bucket = event.get("input_bucket")
        input_key = event.get("input_key")
        search_mode = event.get("search_mode")
        search_category = event.get("search_category") 

        if not input_bucket or not input_key:
            return {
                "stage": "alibaba_clean",
                "status": "FAILED",
                "message": "Missing input bucket or input key",
                "rows_processed": 0
            }
        
        if search_mode == "category_search" and not search_category:
            return {
                "stage": "alibaba_clean",
                "status": "FAILED",
                "message": "Missing search_category for category search",
                "rows_processed": 0
            }

        if search_mode == "manual_search":
            search_category = None

        if not search_mode:
            search_mode = "manual_search"

        filters = {
            "enable_alibaba": event.get("enable_alibaba"),
            "margin_min": event.get("margin_min"),
            "moq_max": event.get("moq_max"),
            "min_rating": event.get("supplier_rating_min"),
            "verified_supplier": event.get("verified_supplier", False),
            "size": event.get("size"),
        }

        output_bucket = OUTPUT_BUCKET
        output_key = generate_output_key(input_key, search_mode)


        # ensure prefix exists (optional)
        try:
            s3.put_object(Bucket=output_bucket, Key="clean/")
        except Exception:
            pass

        rows_before, rows_after = s3_json_to_table(input_bucket, input_key, output_bucket, output_key, filters, search_category)

        if rows_after == 0:
            return {
                "stage": "alibaba_clean",
                "status": "EMPTY",
                "message": "No Alibaba products remained after filtering",
                "rows_processed": rows_before,
                "rows_after_filtered": 0,
                "input_file": f"s3://{input_bucket}/{input_key}",
                "output_file": None
            }

        return {
            "stage": "alibaba_clean",
            "status": "SUCCEEDED",
            "message": "Alibaba clean stage completed",
            "rows_processed": rows_before,
            "rows_after_filtered": rows_after,
            "input_file": f"s3://{input_bucket}/{input_key}",
            "output_file": f"s3://{output_bucket}/{output_key if PYARROW_AVAILABLE else output_key.replace('.parquet', '.csv')}"
        }

    except Exception as e:
        print("ERROR:", str(e))
        return {
        "stage": "alibaba_clean",
        "status": "FAILED",
        "message": "Alibaba clean stage failed",
        "error": str(e),
        "rows_processed": 0
    }