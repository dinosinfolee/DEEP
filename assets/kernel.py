"""DEEP 분석 커널.

브라우저 안 Pyodide에서 실행된다. 서버는 없다.
JS 워커가 handle(cmd, payload_json) 하나만 호출하고, 결과는 JSON 문자열로 돌아간다.
"""

import io
import json
import math
import re
from itertools import combinations

import numpy as np
import pandas as pd

# 업로드한 원본 표. 전처리 단계는 여기서 다시 계산한다.
RAW: dict[str, pd.DataFrame] = {}
# 단계를 모두 적용한 현재 표.
TABLES: dict[str, pd.DataFrame] = {}
# 표 이름 순서(업로드 순서 유지).
ORDER: list[str] = []


# --------------------------------------------------------------------------
# JSON 직렬화
# --------------------------------------------------------------------------

def native(value):
    """numpy/pandas 값을 JSON이 아는 형태로 바꾼다. NaN·inf는 None."""
    if value is None:
        return None
    if isinstance(value, (bool, np.bool_)):
        return bool(value)
    if isinstance(value, (int, np.integer)):
        return int(value)
    if isinstance(value, (float, np.floating)):
        number = float(value)
        if math.isnan(number) or math.isinf(number):
            return None
        return number
    if isinstance(value, (np.str_, str)):
        return str(value)
    if isinstance(value, (pd.Timestamp,)):
        if pd.isna(value):
            return None
        return value.isoformat()
    if value is pd.NaT:
        return None
    if isinstance(value, (list, tuple, np.ndarray, pd.Index, pd.Series)):
        return [native(item) for item in list(value)]
    if isinstance(value, dict):
        return {str(key): native(item) for key, item in value.items()}
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    return str(value)


def jdump(obj) -> str:
    return json.dumps(native(obj), ensure_ascii=False)


class KernelError(Exception):
    """사용자에게 그대로 보여 줄 수 있는 오류."""


# --------------------------------------------------------------------------
# 표와 열 정보
# --------------------------------------------------------------------------

def get_table(name: str) -> pd.DataFrame:
    if name not in TABLES:
        raise KernelError(f"'{name}' 표를 찾을 수 없습니다.")
    return TABLES[name]


def kind_of(series: pd.Series) -> str:
    if pd.api.types.is_bool_dtype(series):
        return "bool"
    if pd.api.types.is_numeric_dtype(series):
        return "number"
    if pd.api.types.is_datetime64_any_dtype(series):
        return "datetime"
    return "text"


def column_info(series: pd.Series) -> dict:
    kind = kind_of(series)
    total = int(len(series))
    missing = int(series.isna().sum())
    info = {
        "name": str(series.name),
        "kind": kind,
        "missing": missing,
        "missingRatio": (missing / total) if total else 0.0,
        "unique": int(series.nunique(dropna=True)),
    }
    valid = series.dropna()
    if kind == "number" and len(valid):
        numeric = pd.to_numeric(valid, errors="coerce").dropna()
        if len(numeric):
            q1 = float(numeric.quantile(0.25))
            q3 = float(numeric.quantile(0.75))
            iqr = q3 - q1
            low, high = q1 - 1.5 * iqr, q3 + 1.5 * iqr
            info.update(
                min=float(numeric.min()),
                max=float(numeric.max()),
                mean=float(numeric.mean()),
                median=float(numeric.median()),
                std=float(numeric.std()) if len(numeric) > 1 else 0.0,
                q1=q1,
                q3=q3,
                outliers=int(((numeric < low) | (numeric > high)).sum()),
            )
            # 열 프로필에 그릴 작은 분포 그림. 화면에서 바로 쓰도록 미리 센다.
            if numeric.max() > numeric.min():
                counts = pd.cut(numeric, bins=12).value_counts(sort=False)
                info["hist"] = [int(value) for value in counts.tolist()]
    elif kind in ("text", "bool") and len(valid):
        # 숫자로 읽힐 값이 대부분인데 문자로 잡혀 있으면 검진표에서 알려준다.
        numericLike = float(pd.to_numeric(valid, errors="coerce").notna().mean())
        if numericLike >= 0.9:
            info["numericLike"] = numericLike
        counts = valid.astype("object").value_counts().head(5)
        info["top"] = [
            {"value": str(index), "count": int(count)}
            for index, count in counts.items()
        ]
    elif kind == "datetime" and len(valid):
        info["min"] = native(valid.min())
        info["max"] = native(valid.max())
    return info


def table_meta(name: str) -> dict:
    frame = TABLES[name]
    return {
        "name": name,
        "rows": int(len(frame)),
        "columns": [column_info(frame[column]) for column in frame.columns],
        "duplicated": int(frame.duplicated().sum()),
        "isSource": name in RAW,
    }


def all_meta() -> list[dict]:
    return [table_meta(name) for name in ORDER if name in TABLES]


def unique_name(base: str) -> str:
    name = base
    index = 2
    while name in TABLES or name in RAW:
        name = f"{base}_{index}"
        index += 1
    return name


def register(name: str, frame: pd.DataFrame) -> None:
    TABLES[name] = frame
    if name not in ORDER:
        ORDER.append(name)


# --------------------------------------------------------------------------
# CSV 읽기
# --------------------------------------------------------------------------

def read_csv_text(text: str) -> pd.DataFrame:
    text = text.lstrip("﻿")
    last_error = None
    for options in (
        {"sep": None, "engine": "python"},
        {"sep": ","},
        {"sep": "\t"},
        {"sep": ";"},
    ):
        try:
            frame = pd.read_csv(io.StringIO(text), **options)
            if frame.shape[1] >= 1:
                break
        except Exception as error:  # 구분자 추정 실패 → 다음 후보
            last_error = error
            frame = None
    if frame is None:
        raise KernelError(f"CSV를 읽지 못했습니다: {last_error}")

    frame.columns = [str(column).strip() for column in frame.columns]
    # 이름이 겹치는 열은 뒤에 번호를 붙인다.
    seen: dict[str, int] = {}
    renamed = []
    for column in frame.columns:
        if column in seen:
            seen[column] += 1
            renamed.append(f"{column}_{seen[column]}")
        else:
            seen[column] = 1
            renamed.append(column)
    frame.columns = renamed
    return auto_types(frame)


def auto_types(frame: pd.DataFrame) -> pd.DataFrame:
    """숫자처럼 보이는 문자열 열을 숫자로, 날짜처럼 보이는 열을 날짜로 바꾼다."""
    for column in frame.columns:
        series = frame[column]
        if not (series.dtype == object or pd.api.types.is_string_dtype(series)):
            continue
        stripped = series.astype("string").str.strip()
        # 1,234 처럼 천 단위 쉼표가 있는 숫자
        candidate = stripped.str.replace(",", "", regex=False)
        numeric = pd.to_numeric(candidate, errors="coerce")
        valid = stripped.notna() & (stripped != "")
        if valid.sum() and numeric[valid].notna().mean() >= 0.95:
            frame[column] = numeric
            continue
        sample = stripped[valid].head(200)
        if len(sample) and sample.str.contains(r"\d{4}[-/.]\d{1,2}").mean() >= 0.9:
            parsed = pd.to_datetime(stripped, errors="coerce", format="mixed")
            if parsed[valid].notna().mean() >= 0.95:
                frame[column] = parsed
    return frame


# --------------------------------------------------------------------------
# 전처리 단계
# --------------------------------------------------------------------------

def quote(name: str) -> str:
    return f"`{name}`"


def numeric_columns(frame: pd.DataFrame, columns=None) -> list[str]:
    candidates = columns or list(frame.columns)
    return [
        column
        for column in candidates
        if column in frame.columns and pd.api.types.is_numeric_dtype(frame[column])
    ]


def step_drop_columns(step):
    name = step["table"]
    frame = get_table(name)
    targets = [column for column in step["columns"] if column in frame.columns]
    if not targets:
        raise KernelError("삭제할 열이 없습니다.")
    TABLES[name] = frame.drop(columns=targets)


def step_rename_column(step):
    name = step["table"]
    frame = get_table(name)
    old, new = step["from"], step["to"].strip()
    if old not in frame.columns:
        raise KernelError(f"'{old}' 열이 없습니다.")
    if not new:
        raise KernelError("새 열 이름이 비어 있습니다.")
    TABLES[name] = frame.rename(columns={old: new})


def step_change_type(step):
    name = step["table"]
    frame = get_table(name).copy()
    column, target = step["column"], step["to"]
    if column not in frame.columns:
        raise KernelError(f"'{column}' 열이 없습니다.")
    if target == "number":
        cleaned = frame[column].astype("string").str.replace(",", "", regex=False)
        frame[column] = pd.to_numeric(cleaned, errors="coerce")
    elif target == "text":
        frame[column] = frame[column].astype("string")
    elif target == "datetime":
        frame[column] = pd.to_datetime(frame[column], errors="coerce", format="mixed")
    elif target == "category":
        frame[column] = frame[column].astype("category")
    else:
        raise KernelError(f"지원하지 않는 자료형: {target}")
    TABLES[name] = frame


def step_new_column(step):
    name = step["table"]
    frame = get_table(name).copy()
    new_name = step["name"].strip()
    expression = step["expr"]
    if not new_name:
        raise KernelError("새 열 이름을 입력하세요.")
    try:
        frame[new_name] = frame.eval(expression, engine="python")
    except Exception as error:
        raise KernelError(
            f"수식을 계산하지 못했습니다: {error}. "
            "열 이름에 공백이나 한글이 있으면 `열이름` 처럼 backtick으로 감싸 보세요."
        )
    TABLES[name] = frame


def step_filter_rows(step):
    name = step["table"]
    frame = get_table(name)
    expression = step["query"]
    try:
        filtered = frame.query(expression, engine="python")
    except Exception as error:
        raise KernelError(f"조건식을 계산하지 못했습니다: {error}")
    TABLES[name] = filtered.reset_index(drop=True)


def step_missing(step):
    name = step["table"]
    frame = get_table(name).copy()
    method = step.get("method", "drop_rows")
    columns = step.get("columns") or list(frame.columns)
    columns = [column for column in columns if column in frame.columns]
    if method == "drop_rows":
        frame = frame.dropna(subset=columns).reset_index(drop=True)
    elif method == "drop_columns":
        frame = frame.drop(columns=[c for c in columns if frame[c].isna().any()])
    elif method in ("mean", "median"):
        for column in numeric_columns(frame, columns):
            value = frame[column].mean() if method == "mean" else frame[column].median()
            frame[column] = frame[column].fillna(value)
    elif method == "mode":
        for column in columns:
            modes = frame[column].mode(dropna=True)
            if len(modes):
                frame[column] = frame[column].fillna(modes.iloc[0])
    elif method == "value":
        filler = step.get("value", 0)
        for column in columns:
            if pd.api.types.is_numeric_dtype(frame[column]):
                try:
                    frame[column] = frame[column].fillna(float(filler))
                except (TypeError, ValueError):
                    pass
            else:
                frame[column] = frame[column].astype("object").fillna(str(filler))
    elif method in ("ffill", "bfill"):
        frame[columns] = frame[columns].ffill() if method == "ffill" else frame[columns].bfill()
    else:
        raise KernelError(f"지원하지 않는 결측치 처리: {method}")
    TABLES[name] = frame


def outlier_mask(series: pd.Series, method: str, k: float):
    numeric = pd.to_numeric(series, errors="coerce")
    if method == "zscore":
        std = numeric.std()
        if not std or math.isnan(std):
            return pd.Series(False, index=series.index), None, None
        score = (numeric - numeric.mean()) / std
        return score.abs() > k, None, None
    q1, q3 = numeric.quantile(0.25), numeric.quantile(0.75)
    iqr = q3 - q1
    low, high = q1 - k * iqr, q3 + k * iqr
    return (numeric < low) | (numeric > high), low, high


def step_outlier(step):
    name = step["table"]
    frame = get_table(name).copy()
    method = step.get("method", "iqr")
    action = step.get("action", "remove")
    k = float(step.get("k", 1.5 if method == "iqr" else 3.0))
    columns = numeric_columns(frame, step.get("columns"))
    if not columns:
        raise KernelError("이상치를 확인할 숫자 열을 선택하세요.")
    combined = pd.Series(False, index=frame.index)
    for column in columns:
        mask, low, high = outlier_mask(frame[column], method, k)
        mask = mask.fillna(False)
        if action == "flag":
            frame[f"{column}_이상치"] = mask
        elif action == "to_missing":
            frame.loc[mask, column] = np.nan
        elif action == "clip" and low is not None:
            frame[column] = pd.to_numeric(frame[column], errors="coerce").clip(low, high)
        combined = combined | mask
    if action == "remove":
        frame = frame.loc[~combined].reset_index(drop=True)
    TABLES[name] = frame


def step_normalize(step):
    name = step["table"]
    frame = get_table(name).copy()
    method = step.get("method", "minmax")
    replace = bool(step.get("replace", False))
    columns = numeric_columns(frame, step.get("columns"))
    if not columns:
        raise KernelError("정규화할 숫자 열을 선택하세요.")
    for column in columns:
        values = pd.to_numeric(frame[column], errors="coerce")
        if method == "minmax":
            low, high = values.min(), values.max()
            scaled = (values - low) / (high - low) if high > low else values * 0
            suffix = "_정규화"
        elif method == "zscore":
            std = values.std()
            scaled = (values - values.mean()) / std if std else values * 0
            suffix = "_표준화"
        elif method == "robust":
            q1, q3 = values.quantile(0.25), values.quantile(0.75)
            iqr = q3 - q1
            scaled = (values - values.median()) / iqr if iqr else values * 0
            suffix = "_로버스트"
        elif method == "log":
            scaled = np.log1p(values.clip(lower=0))
            suffix = "_로그"
        else:
            raise KernelError(f"지원하지 않는 정규화: {method}")
        frame[column if replace else f"{column}{suffix}"] = scaled
    TABLES[name] = frame


def step_bin(step):
    name = step["table"]
    frame = get_table(name).copy()
    column = step["column"]
    count = int(step.get("bins", 5))
    mode = step.get("mode", "width")
    new_name = step.get("name") or f"{column}_구간"
    values = pd.to_numeric(frame[column], errors="coerce")
    if mode == "quantile":
        frame[new_name] = pd.qcut(values, count, duplicates="drop").astype("string")
    else:
        frame[new_name] = pd.cut(values, count).astype("string")
    TABLES[name] = frame


def step_sort(step):
    """여러 열을 기준으로 정렬한다. 방향은 열마다 따로 줄 수 있다.

    ascending이 참/거짓 하나면 모든 열에 같은 방향을 쓴다(예전 저장본 호환).
    목록이면 기준 열과 짝을 지어 쓰고, 모자라면 오름차순으로 채운다.
    """
    name = step["table"]
    frame = get_table(name)
    raw_ascending = step.get("ascending", True)
    pairs = []
    for index, column in enumerate(step["by"]):
        if column not in frame.columns:
            continue
        if isinstance(raw_ascending, list):
            direction = bool(raw_ascending[index]) if index < len(raw_ascending) else True
        else:
            direction = bool(raw_ascending)
        pairs.append((column, direction))
    if not pairs:
        raise KernelError("정렬 기준 열을 선택하세요.")
    columns = [column for column, _ in pairs]
    ascending = [direction for _, direction in pairs]
    TABLES[name] = frame.sort_values(columns, ascending=ascending).reset_index(drop=True)


def step_drop_rows(step):
    """표에서 고른 행을 지운다. 위치는 이 단계가 적용되는 시점의 순서를 따른다."""
    name = step["table"]
    frame = get_table(name)
    positions = sorted({int(i) for i in step.get("rows", []) if 0 <= int(i) < len(frame)})
    if not positions:
        raise KernelError("삭제할 행이 없습니다.")
    TABLES[name] = frame.drop(frame.index[positions]).reset_index(drop=True)


def step_drop_duplicates(step):
    name = step["table"]
    frame = get_table(name)
    subset = step.get("columns") or None
    if subset:
        subset = [column for column in subset if column in frame.columns] or None
    TABLES[name] = frame.drop_duplicates(subset=subset).reset_index(drop=True)


AGG_LABELS = {
    "mean": "평균",
    "sum": "합계",
    "count": "개수",
    "median": "중앙값",
    "min": "최소",
    "max": "최대",
    "std": "표준편차",
    "nunique": "고유값수",
}


def step_group(step):
    source = get_table(step["table"])
    keys = [column for column in step["by"] if column in source.columns]
    if not keys:
        raise KernelError("그룹 기준 열을 선택하세요.")
    aggregations = step.get("aggs") or []
    result = step["result"]
    if not aggregations:
        grouped = source.groupby(keys, dropna=False).size().reset_index(name="개수")
    else:
        spec: dict[str, list[str]] = {}
        for item in aggregations:
            spec.setdefault(item["column"], []).append(item["func"])
        grouped = source.groupby(keys, dropna=False).agg(spec)
        grouped.columns = [
            f"{column}_{AGG_LABELS.get(func, func)}" for column, func in grouped.columns
        ]
        grouped = grouped.reset_index()
    register(result, grouped)


def step_concat(step):
    names = step["tables"]
    frames = []
    for name in names:
        frame = get_table(name).copy()
        if step.get("addSource", True):
            frame["출처"] = name
        frames.append(frame)
    if len(frames) < 2:
        raise KernelError("합칠 표를 두 개 이상 선택하세요.")
    register(step["result"], pd.concat(frames, ignore_index=True, sort=False))


def step_merge(step):
    left = get_table(step["left"])
    right = get_table(step["right"])
    left_keys = step.get("leftOn") or step.get("on") or []
    right_keys = step.get("rightOn") or step.get("on") or []
    if not left_keys or not right_keys:
        raise KernelError("기준이 될 공통 열을 선택하세요.")
    how = step.get("how", "inner")
    merged = left.merge(
        right,
        left_on=left_keys,
        right_on=right_keys,
        how=how,
        suffixes=("", f"_{step['right']}"),
    )
    register(step["result"], merged)


def step_kmeans_label(step):
    from sklearn.cluster import KMeans
    from sklearn.preprocessing import StandardScaler

    name = step["table"]
    frame = get_table(name).copy()
    columns = numeric_columns(frame, step["columns"])
    if len(columns) < 1:
        raise KernelError("군집에 사용할 숫자 열을 선택하세요.")
    matrix = frame[columns].apply(pd.to_numeric, errors="coerce")
    valid = matrix.dropna()
    if len(valid) < int(step.get("k", 3)):
        raise KernelError("결측치를 먼저 처리하세요. 유효한 행이 군집 수보다 적습니다.")
    values = StandardScaler().fit_transform(valid) if step.get("scale", True) else valid.to_numpy()
    model = KMeans(n_clusters=int(step.get("k", 3)), n_init=10, random_state=42)
    labels = model.fit_predict(values)
    column_name = step.get("name") or "군집"
    frame[column_name] = pd.Series(
        [f"군집 {label + 1}" for label in labels], index=valid.index
    ).reindex(frame.index)
    TABLES[name] = frame


STEP_RUNNERS = {
    "drop_columns": step_drop_columns,
    "rename_column": step_rename_column,
    "change_type": step_change_type,
    "new_column": step_new_column,
    "filter_rows": step_filter_rows,
    "missing": step_missing,
    "outlier": step_outlier,
    "normalize": step_normalize,
    "bin": step_bin,
    "sort": step_sort,
    "drop_rows": step_drop_rows,
    "drop_duplicates": step_drop_duplicates,
    "group": step_group,
    "concat": step_concat,
    "merge": step_merge,
    "kmeans_label": step_kmeans_label,
}


def rebuild(payload):
    """원본에서 시작해 단계를 순서대로 다시 적용한다."""
    TABLES.clear()
    ORDER.clear()
    for name, frame in RAW.items():
        register(name, frame.copy())

    problems = []
    for index, step in enumerate(payload.get("steps", [])):
        if step.get("disabled"):
            continue
        runner = STEP_RUNNERS.get(step.get("op"))
        if runner is None:
            problems.append({"index": index, "id": step.get("id"), "error": f"알 수 없는 단계: {step.get('op')}"})
            continue
        try:
            runner(step)
        except KernelError as error:
            problems.append({"index": index, "id": step.get("id"), "error": str(error)})
        except Exception as error:
            problems.append(
                {"index": index, "id": step.get("id"), "error": f"{type(error).__name__}: {error}"}
            )
    return {"tables": all_meta(), "problems": problems}


# --------------------------------------------------------------------------
# 명령
# --------------------------------------------------------------------------

def cmd_load_csv(payload):
    name = unique_name(payload["name"])
    frame = read_csv_text(payload["text"])
    RAW[name] = frame
    register(name, frame.copy())
    return {"name": name, "tables": all_meta()}


def cmd_remove_table(payload):
    name = payload["name"]
    RAW.pop(name, None)
    TABLES.pop(name, None)
    if name in ORDER:
        ORDER.remove(name)
    return {"tables": all_meta()}


def cmd_reset(payload):
    """프로젝트 파일을 열 때처럼 모든 표를 비운다."""
    RAW.clear()
    TABLES.clear()
    ORDER.clear()
    return {"tables": []}


def cmd_rename_table(payload):
    old, new = payload["from"], payload["to"].strip()
    if old not in RAW:
        raise KernelError(f"'{old}' 원본 표가 없습니다.")
    if not new:
        raise KernelError("새 이름이 비어 있습니다.")
    if new != old and (new in RAW or new in TABLES):
        raise KernelError(f"'{new}' 이름이 이미 있습니다.")
    RAW[new] = RAW.pop(old)
    if old in TABLES:
        TABLES[new] = TABLES.pop(old)
    ORDER[ORDER.index(old)] = new
    return {"name": new, "tables": all_meta()}


def cmd_rebuild(payload):
    return rebuild(payload)


def cmd_preview(payload):
    frame = get_table(payload["table"])
    offset = int(payload.get("offset", 0))
    limit = int(payload.get("limit", 50))
    window = frame.iloc[offset : offset + limit]
    columns = [str(column) for column in frame.columns]
    rows = []
    for _, row in window.iterrows():
        rows.append([native(row[column]) for column in frame.columns])
    return {
        "columns": columns,
        "kinds": [kind_of(frame[column]) for column in frame.columns],
        "rows": rows,
        "total": int(len(frame)),
        "offset": offset,
    }


def cmd_locate(payload):
    """눈으로 확인할 행이 몇 번째인지 돌려준다. 표를 바꾸지는 않는다."""
    name = payload["table"]
    frame = get_table(name)
    column = payload["column"]
    if column not in frame.columns:
        raise KernelError(f"'{column}' 열이 없습니다.")
    series = frame[column]
    what = payload.get("what", "outlier")
    if what == "missing":
        mask = series.isna()
    else:
        numeric = pd.to_numeric(series, errors="coerce")
        q1 = numeric.quantile(0.25)
        q3 = numeric.quantile(0.75)
        iqr = q3 - q1
        mask = (numeric < q1 - 1.5 * iqr) | (numeric > q3 + 1.5 * iqr)
    mask = mask.fillna(False).to_numpy()
    positions = [index for index, flag in enumerate(mask) if flag]
    # 화면에서 쓸 만큼만. 수천 개를 보내도 다 표시하지 못한다.
    return {"positions": positions[:300], "count": len(positions)}


def cmd_export_csv(payload):
    frame = get_table(payload["table"])
    return {"text": frame.to_csv(index=False)}


# --------------------------------------------------------------------------
# 시각화용 데이터
# --------------------------------------------------------------------------

def category_values(series: pd.Series) -> pd.Series:
    if pd.api.types.is_datetime64_any_dtype(series):
        return series
    return series.astype("object").where(series.notna(), "(값 없음)")


def aggregate(frame: pd.DataFrame, x: str, y, how: str, color=None):
    keys = [x] + ([color] if color else [])
    working = frame.copy()
    for key in keys:
        working[key] = category_values(working[key])
    if how == "count" or not y:
        grouped = working.groupby(keys, dropna=False).size().reset_index(name="값")
    else:
        working[y] = pd.to_numeric(working[y], errors="coerce")
        grouped = working.groupby(keys, dropna=False)[y].agg(how).reset_index()
        grouped = grouped.rename(columns={y: "값"})
    return grouped


def cmd_chart_data(payload):
    frame = get_table(payload["table"])
    kind = payload["kind"]
    x = payload.get("x")
    y = payload.get("y")
    color = payload.get("color") or None
    for column in [x, y, color, payload.get("size")]:
        if column and column not in frame.columns:
            raise KernelError(f"'{column}' 열이 표에 없습니다.")

    if kind in ("bar", "line", "area"):
        how = payload.get("agg", "mean" if y else "count")
        grouped = aggregate(frame, x, y, how, color)
        if kind in ("line", "area"):
            grouped = grouped.sort_values(x)
        series = []
        if color:
            for key, part in grouped.groupby(color, dropna=False):
                series.append(
                    {
                        "name": str(key),
                        "x": native(part[x].tolist()),
                        "y": native(part["값"].tolist()),
                    }
                )
        else:
            if kind == "bar" and payload.get("sortByValue"):
                grouped = grouped.sort_values("값", ascending=False)
            series.append(
                {
                    "name": y if y else "개수",
                    "x": native(grouped[x].tolist()),
                    "y": native(grouped["값"].tolist()),
                }
            )
        return {"kind": kind, "series": series, "yTitle": label_for(y, how)}

    if kind == "map":
        lat_column = payload.get("lat")
        lon_column = payload.get("lon")
        if not lat_column or not lon_column:
            raise KernelError("위도와 경도 열을 고르세요.")
        for column in (lat_column, lon_column, payload.get("label")):
            if column and column not in frame.columns:
                raise KernelError(f"'{column}' 열이 표에 없습니다.")
        label = payload.get("label") or None
        size_column = payload.get("size") or None
        wanted = [lat_column, lon_column] + [c for c in (color, label, size_column) if c]
        subset = frame[list(dict.fromkeys(wanted))].copy()
        subset[lat_column] = pd.to_numeric(subset[lat_column], errors="coerce")
        subset[lon_column] = pd.to_numeric(subset[lon_column], errors="coerce")
        subset = subset.dropna(subset=[lat_column, lon_column])
        # 위도 -90~90, 경도 -180~180 밖이면 좌표가 아니다.
        subset = subset[
            subset[lat_column].between(-90, 90) & subset[lon_column].between(-180, 180)
        ]
        if not len(subset):
            raise KernelError("지도에 찍을 좌표가 없습니다. 위도·경도 열이 맞는지 확인하세요.")
        limit = int(payload.get("limit", 3000))
        if len(subset) > limit:
            subset = subset.sample(limit, random_state=42)

        def one(name, part):
            return {
                "name": str(name),
                "lat": native(part[lat_column].tolist()),
                "lon": native(part[lon_column].tolist()),
                "text": [str(v) for v in part[label].tolist()] if label else None,
                "size": native(pd.to_numeric(part[size_column], errors="coerce").tolist())
                if size_column
                else None,
            }

        series = []
        if color:
            for key, part in subset.groupby(category_values(subset[color]), dropna=False):
                series.append(one(key, part))
        else:
            series.append(one(f"{lat_column} · {lon_column}", subset))
        return {
            "kind": "map",
            "series": series,
            "center": {
                "lat": float(subset[lat_column].mean()),
                "lon": float(subset[lon_column].mean()),
            },
            "span": {
                "lat": float(subset[lat_column].max() - subset[lat_column].min()),
                "lon": float(subset[lon_column].max() - subset[lon_column].min()),
            },
            "count": int(len(subset)),
        }

    if kind == "scatter":
        columns = [x, y] + [c for c in (color, payload.get("size")) if c]
        subset = frame[list(dict.fromkeys(columns))].copy()
        subset[x] = pd.to_numeric(subset[x], errors="coerce")
        subset[y] = pd.to_numeric(subset[y], errors="coerce")
        subset = subset.dropna(subset=[x, y])
        # SVG로 그리므로 점이 너무 많으면 느려진다. 넘으면 무작위로 골라 보낸다.
        limit = int(payload.get("limit", 3000))
        if len(subset) > limit:
            subset = subset.sample(limit, random_state=42)
        result = {"kind": "scatter", "series": []}
        size_column = payload.get("size")
        if color:
            for key, part in subset.groupby(category_values(subset[color]), dropna=False):
                result["series"].append(
                    {
                        "name": str(key),
                        "x": native(part[x].tolist()),
                        "y": native(part[y].tolist()),
                        "size": native(pd.to_numeric(part[size_column], errors="coerce").tolist())
                        if size_column
                        else None,
                    }
                )
        else:
            result["series"].append(
                {
                    "name": f"{x} vs {y}",
                    "x": native(subset[x].tolist()),
                    "y": native(subset[y].tolist()),
                    "size": native(pd.to_numeric(subset[size_column], errors="coerce").tolist())
                    if size_column
                    else None,
                }
            )
        if payload.get("trend") and len(subset) > 2:
            slope, intercept = np.polyfit(subset[x], subset[y], 1)
            low, high = float(subset[x].min()), float(subset[x].max())
            correlation = float(subset[x].corr(subset[y]))
            result["trend"] = {
                "x": [low, high],
                "y": [slope * low + intercept, slope * high + intercept],
                "slope": float(slope),
                "intercept": float(intercept),
                "r": correlation,
                "r2": correlation ** 2,
            }
        return result

    if kind == "histogram":
        result = {"kind": "histogram", "series": [], "bins": int(payload.get("bins", 0) or 0)}
        values = pd.to_numeric(frame[x], errors="coerce")
        if color:
            groups = category_values(frame[color])
            for key, index in values.dropna().groupby(groups.reindex(values.dropna().index)):
                result["series"].append({"name": str(key), "values": native(index.tolist())})
        else:
            result["series"].append({"name": x, "values": native(values.dropna().tolist())})
        return result

    if kind == "box":
        result = {"kind": "box", "series": []}
        values = pd.to_numeric(frame[y], errors="coerce")
        if x:
            groups = category_values(frame[x])
            for key, part in values.groupby(groups):
                cleaned = part.dropna()
                if len(cleaned):
                    result["series"].append({"name": str(key), "values": native(cleaned.tolist())})
        else:
            result["series"].append({"name": y, "values": native(values.dropna().tolist())})
        return result

    if kind == "pie":
        how = payload.get("agg", "sum" if y else "count")
        grouped = aggregate(frame, x, y, how)
        grouped = grouped.sort_values("값", ascending=False)
        if len(grouped) > 12:
            head = grouped.head(11)
            other = grouped["값"].iloc[11:].sum()
            grouped = pd.concat(
                [head, pd.DataFrame({x: ["기타"], "값": [other]})], ignore_index=True
            )
        return {
            "kind": "pie",
            "labels": native(grouped[x].astype(str).tolist()),
            "values": native(grouped["값"].tolist()),
        }

    if kind == "heatmap":
        columns = payload.get("columns") or numeric_columns(frame)
        columns = numeric_columns(frame, columns)
        if len(columns) < 2:
            raise KernelError("상관 히트맵에는 숫자 열이 두 개 이상 필요합니다.")
        matrix = frame[columns].corr(numeric_only=True)
        return {
            "kind": "heatmap",
            "labels": [str(column) for column in matrix.columns],
            "z": native(matrix.to_numpy().tolist()),
        }

    raise KernelError(f"지원하지 않는 그래프 종류: {kind}")


def label_for(y, how):
    if not y:
        return "개수"
    return f"{y}의 {AGG_LABELS.get(how, how)}"


# --------------------------------------------------------------------------
# 분석
# --------------------------------------------------------------------------

def analysis_describe(frame, payload):
    columns = payload.get("columns") or list(frame.columns)
    columns = [column for column in columns if column in frame.columns]
    rows = []
    for column in columns:
        info = column_info(frame[column])
        rows.append(info)
    return {"type": "describe", "rows": rows, "total": int(len(frame))}


def analysis_quality(frame, payload):
    rows = []
    for column in frame.columns:
        series = frame[column]
        info = column_info(series)
        entry = {
            "column": str(column),
            "kind": info["kind"],
            "missing": info["missing"],
            "missingRatio": info["missingRatio"],
            "unique": info["unique"],
            "outliers": info.get("outliers", 0),
        }
        rows.append(entry)
    duplicated = int(frame.duplicated().sum())
    return {
        "type": "quality",
        "rows": rows,
        "total": int(len(frame)),
        "duplicated": duplicated,
        "missingCells": int(frame.isna().sum().sum()),
    }


def analysis_correlation(frame, payload):
    columns = numeric_columns(frame, payload.get("columns"))
    if len(columns) < 2:
        raise KernelError("상관분석에는 숫자 열이 두 개 이상 필요합니다.")
    method = payload.get("method", "pearson")
    matrix = frame[columns].corr(method=method)
    pairs = []
    for left, right in combinations(columns, 2):
        value = matrix.loc[left, right]
        if pd.notna(value):
            pairs.append({"a": left, "b": right, "r": float(value)})
    pairs.sort(key=lambda item: abs(item["r"]), reverse=True)
    return {
        "type": "correlation",
        "labels": columns,
        "z": native(matrix.to_numpy().tolist()),
        "pairs": pairs[:20],
        "method": method,
    }


def analysis_regression(frame, payload):
    import statsmodels.api as sm
    from sklearn.ensemble import RandomForestRegressor
    from sklearn.linear_model import LinearRegression
    from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
    from sklearn.model_selection import train_test_split
    from sklearn.tree import DecisionTreeRegressor

    target = payload["y"]
    if target not in frame.columns:
        raise KernelError(f"'{target}' 열이 없습니다.")
    features = [
        column
        for column in dict.fromkeys(payload["x"])
        if column in frame.columns and column != target
    ]
    if not features:
        raise KernelError(
            "설명 변수를 한 개 이상 선택하세요. (예측할 값과 같은 열은 설명 변수가 될 수 없습니다.)"
        )

    data = frame[[target] + features].apply(pd.to_numeric, errors="coerce").dropna()
    if len(data) < len(features) + 3:
        raise KernelError("분석에 쓸 수 있는 행이 너무 적습니다. 결측치를 먼저 처리해 보세요.")

    y = data[target].to_numpy()
    X = data[features].to_numpy()

    # 1) 통계적 회귀 — statsmodels OLS
    design = sm.add_constant(data[features], has_constant="add")
    ols = sm.OLS(data[target], design).fit()
    coefficients = []
    for name in design.columns:
        coefficients.append(
            {
                "name": "상수항" if name == "const" else str(name),
                "coef": float(ols.params[name]),
                "stderr": float(ols.bse[name]),
                "t": float(ols.tvalues[name]),
                "p": float(ols.pvalues[name]),
                "low": float(ols.conf_int().loc[name, 0]),
                "high": float(ols.conf_int().loc[name, 1]),
            }
        )
    ols_predicted = ols.fittedvalues.to_numpy()
    statistical = {
        "name": "통계적 회귀 (OLS)",
        "r2": float(ols.rsquared),
        "adjR2": float(ols.rsquared_adj),
        "fStat": float(ols.fvalue) if ols.fvalue is not None else None,
        "fPvalue": float(ols.f_pvalue) if ols.f_pvalue is not None else None,
        "rmse": float(np.sqrt(mean_squared_error(y, ols_predicted))),
        "coefficients": coefficients,
        "equation": build_equation(target, coefficients),
    }

    # 2) 기계학습 회귀 — 학습/검증 분리
    test_size = float(payload.get("testSize", 0.3))
    model_name = payload.get("model", "linear")
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=test_size, random_state=42
    )
    if model_name == "tree":
        model = DecisionTreeRegressor(max_depth=int(payload.get("maxDepth", 4)), random_state=42)
        label = f"결정트리 회귀 (깊이 {payload.get('maxDepth', 4)})"
    elif model_name == "forest":
        model = RandomForestRegressor(
            n_estimators=200, max_depth=int(payload.get("maxDepth", 6)), random_state=42
        )
        label = "랜덤 포레스트 회귀"
    else:
        model = LinearRegression()
        label = "선형 회귀 (기계학습)"
    model.fit(X_train, y_train)
    train_pred = model.predict(X_train)
    test_pred = model.predict(X_test)
    machine = {
        "name": label,
        "trainR2": float(r2_score(y_train, train_pred)),
        "testR2": float(r2_score(y_test, test_pred)),
        "trainRmse": float(np.sqrt(mean_squared_error(y_train, train_pred))),
        "testRmse": float(np.sqrt(mean_squared_error(y_test, test_pred))),
        "testMae": float(mean_absolute_error(y_test, test_pred)),
        "trainSize": int(len(y_train)),
        "testSize": int(len(y_test)),
    }
    if hasattr(model, "feature_importances_"):
        machine["importance"] = [
            {"name": name, "value": float(value)}
            for name, value in sorted(
                zip(features, model.feature_importances_), key=lambda item: -item[1]
            )
        ]
    elif hasattr(model, "coef_"):
        machine["importance"] = [
            {"name": name, "value": float(value)} for name, value in zip(features, model.coef_)
        ]

    residuals = y - ols_predicted
    return {
        "type": "regression",
        "target": target,
        "features": features,
        "rows": int(len(data)),
        "statistical": statistical,
        "machine": machine,
        "scatter": {
            "actual": native(y_test.tolist()),
            "predicted": native(test_pred.tolist()),
        },
        "residual": {
            "fitted": native(ols_predicted.tolist()),
            "residual": native(residuals.tolist()),
        },
        "simple": simple_line(data, features, target),
    }


def build_equation(target, coefficients):
    parts = []
    constant = 0.0
    for item in coefficients:
        if item["name"] == "상수항":
            constant = item["coef"]
        else:
            sign = "+" if item["coef"] >= 0 else "-"
            parts.append(f" {sign} {abs(item['coef']):.4g}×{item['name']}")
    return f"{target} = {constant:.4g}" + "".join(parts)


def simple_line(data, features, target):
    """설명 변수가 하나일 때 산점도 위에 그릴 회귀선."""
    if len(features) != 1:
        return None
    x = data[features[0]]
    slope, intercept = np.polyfit(x, data[target], 1)
    low, high = float(x.min()), float(x.max())
    return {
        "x": native(x.tolist()),
        "y": native(data[target].tolist()),
        "lineX": [low, high],
        "lineY": [slope * low + intercept, slope * high + intercept],
        "xName": features[0],
    }


def analysis_cluster(frame, payload):
    from sklearn.cluster import KMeans
    from sklearn.decomposition import PCA
    from sklearn.metrics import silhouette_score
    from sklearn.preprocessing import StandardScaler

    columns = numeric_columns(frame, payload["columns"])
    if len(columns) < 2:
        raise KernelError("군집 분석에는 숫자 열이 두 개 이상 필요합니다.")
    data = frame[columns].apply(pd.to_numeric, errors="coerce").dropna()
    if len(data) < 4:
        raise KernelError("분석에 쓸 수 있는 행이 너무 적습니다.")
    scale = bool(payload.get("scale", True))
    values = StandardScaler().fit_transform(data) if scale else data.to_numpy()
    k = int(payload.get("k", 3))
    k = max(2, min(k, len(data) - 1))

    model = KMeans(n_clusters=k, n_init=10, random_state=42)
    labels = model.fit_predict(values)

    # 엘보우 곡선과 실루엣 곡선
    elbow, silhouettes = [], []
    for candidate in range(2, min(9, len(data))):
        probe = KMeans(n_clusters=candidate, n_init=10, random_state=42).fit(values)
        elbow.append({"k": candidate, "inertia": float(probe.inertia_)})
        silhouettes.append(
            {"k": candidate, "score": float(silhouette_score(values, probe.labels_))}
        )

    centers = model.cluster_centers_
    if scale:
        original_centers = pd.DataFrame(
            StandardScaler().fit(data).inverse_transform(centers), columns=columns
        )
    else:
        original_centers = pd.DataFrame(centers, columns=columns)

    if len(columns) > 2:
        projected = PCA(n_components=2, random_state=42).fit_transform(values)
        axis_names = ["주성분 1", "주성분 2"]
    else:
        projected = values
        axis_names = columns[:2]

    groups = []
    for index in range(k):
        mask = labels == index
        groups.append(
            {
                "name": f"군집 {index + 1}",
                "x": native(projected[mask, 0].tolist()),
                "y": native(projected[mask, 1].tolist()),
                "count": int(mask.sum()),
            }
        )

    return {
        "type": "cluster",
        "k": k,
        "columns": columns,
        "rows": int(len(data)),
        "silhouette": float(silhouette_score(values, labels)) if k < len(data) else None,
        "inertia": float(model.inertia_),
        "elbow": elbow,
        "silhouetteCurve": silhouettes,
        "groups": groups,
        "axisNames": axis_names,
        "centers": [
            {"name": f"군집 {index + 1}", **{column: float(row[column]) for column in columns}}
            for index, row in original_centers.iterrows()
        ],
        "sizes": [{"name": group["name"], "count": group["count"]} for group in groups],
    }


def transactions_from(frame, payload):
    mode = payload.get("mode", "item_column")
    if mode == "item_column":
        column = payload["itemColumn"]
        separator = payload.get("separator", ",")
        baskets = []
        for value in frame[column].dropna().astype(str):
            items = {item.strip() for item in value.split(separator) if item.strip()}
            if items:
                baskets.append(items)
        return baskets
    if mode == "id_item":
        id_column, item_column = payload["idColumn"], payload["itemColumn"]
        grouped = frame.dropna(subset=[id_column, item_column]).groupby(id_column)[item_column]
        return [set(map(str, values)) for _, values in grouped]
    if mode == "onehot":
        columns = payload["columns"]
        baskets = []
        for _, row in frame[columns].iterrows():
            items = {column for column in columns if truthy(row[column])}
            if items:
                baskets.append(items)
        return baskets
    raise KernelError(f"지원하지 않는 장바구니 형식: {mode}")


def truthy(value):
    if pd.isna(value):
        return False
    if isinstance(value, str):
        return value.strip().lower() in ("1", "y", "yes", "true", "t", "o", "예")
    return bool(value)


def analysis_association(frame, payload):
    baskets = transactions_from(frame, payload)
    if not baskets:
        raise KernelError("장바구니를 만들지 못했습니다. 열 선택을 확인하세요.")
    total = len(baskets)
    min_support = float(payload.get("minSupport", 0.05))
    min_confidence = float(payload.get("minConfidence", 0.3))
    max_length = int(payload.get("maxLength", 3))
    min_count = max(1, math.ceil(min_support * total))

    counts: dict[frozenset, int] = {}
    current = []
    for basket in baskets:
        for item in basket:
            key = frozenset([item])
            counts[key] = counts.get(key, 0) + 1
    current = [key for key, count in counts.items() if count >= min_count]

    level = 1
    while current and level < max_length:
        candidates = set()
        for left, right in combinations(current, 2):
            union = left | right
            if len(union) == level + 1:
                candidates.add(union)
        level += 1
        next_level = []
        for candidate in candidates:
            count = sum(1 for basket in baskets if candidate <= basket)
            if count >= min_count:
                counts[candidate] = count
                next_level.append(candidate)
        current = next_level

    rules = []
    for itemset, count in counts.items():
        if len(itemset) < 2:
            continue
        support = count / total
        for size in range(1, len(itemset)):
            for antecedent in combinations(sorted(itemset), size):
                antecedent_set = frozenset(antecedent)
                consequent_set = itemset - antecedent_set
                antecedent_count = counts.get(antecedent_set)
                consequent_count = counts.get(consequent_set)
                if not antecedent_count or not consequent_count:
                    continue
                confidence = count / antecedent_count
                if confidence < min_confidence:
                    continue
                lift = confidence / (consequent_count / total)
                rules.append(
                    {
                        "if": " + ".join(sorted(antecedent_set)),
                        "then": " + ".join(sorted(consequent_set)),
                        "support": support,
                        "confidence": confidence,
                        "lift": lift,
                        "count": count,
                    }
                )
    rules.sort(key=lambda rule: (-rule["lift"], -rule["confidence"]))

    frequent = sorted(
        (
            {"items": " + ".join(sorted(itemset)), "support": count / total, "count": count}
            for itemset, count in counts.items()
        ),
        key=lambda item: -item["support"],
    )[:25]

    return {
        "type": "association",
        "transactions": total,
        "minSupport": min_support,
        "minConfidence": min_confidence,
        "frequent": frequent,
        "rules": rules[:50],
    }


def analysis_classification(frame, payload):
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import accuracy_score, confusion_matrix, f1_score
    from sklearn.model_selection import train_test_split
    from sklearn.preprocessing import StandardScaler
    from sklearn.tree import DecisionTreeClassifier

    target = payload["y"]
    if target not in frame.columns:
        raise KernelError(f"'{target}' 열이 없습니다.")
    features = [
        column for column in numeric_columns(frame, dict.fromkeys(payload["x"])) if column != target
    ]
    if not features:
        raise KernelError("설명 변수로 쓸 숫자 열을 선택하세요.")
    data = frame[[target] + features].dropna()
    if data[target].nunique() < 2:
        raise KernelError("예측할 범주가 두 종류 이상이어야 합니다.")
    y = data[target].astype(str)
    X = data[features].apply(pd.to_numeric, errors="coerce").to_numpy()

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=float(payload.get("testSize", 0.3)), random_state=42, stratify=y
    )
    name = payload.get("model", "tree")
    if name == "logistic":
        scaler = StandardScaler().fit(X_train)
        X_train, X_test = scaler.transform(X_train), scaler.transform(X_test)
        model = LogisticRegression(max_iter=1000)
        label = "로지스틱 회귀"
    elif name == "forest":
        model = RandomForestClassifier(n_estimators=200, random_state=42)
        label = "랜덤 포레스트 분류"
    else:
        model = DecisionTreeClassifier(max_depth=int(payload.get("maxDepth", 4)), random_state=42)
        label = f"결정트리 분류 (깊이 {payload.get('maxDepth', 4)})"
    model.fit(X_train, y_train)
    predicted = model.predict(X_test)
    labels = sorted(y.unique())
    matrix = confusion_matrix(y_test, predicted, labels=labels)
    result = {
        "type": "classification",
        "model": label,
        "target": target,
        "features": features,
        "accuracy": float(accuracy_score(y_test, predicted)),
        "f1": float(f1_score(y_test, predicted, average="macro")),
        "labels": [str(item) for item in labels],
        "matrix": native(matrix.tolist()),
        "trainSize": int(len(y_train)),
        "testSize": int(len(y_test)),
    }
    if hasattr(model, "feature_importances_"):
        result["importance"] = [
            {"name": name, "value": float(value)}
            for name, value in sorted(
                zip(features, model.feature_importances_), key=lambda item: -item[1]
            )
        ]
    return result


ANALYSES = {
    "describe": analysis_describe,
    "quality": analysis_quality,
    "correlation": analysis_correlation,
    "regression": analysis_regression,
    "cluster": analysis_cluster,
    "association": analysis_association,
    "classification": analysis_classification,
}


def cmd_analyze(payload):
    frame = get_table(payload["table"])
    runner = ANALYSES.get(payload["kind"])
    if runner is None:
        raise KernelError(f"지원하지 않는 분석: {payload['kind']}")
    return runner(frame, payload)


COMMANDS = {
    "load_csv": cmd_load_csv,
    "remove_table": cmd_remove_table,
    "rename_table": cmd_rename_table,
    "reset": cmd_reset,
    "rebuild": cmd_rebuild,
    "preview": cmd_preview,
    "chart_data": cmd_chart_data,
    "analyze": cmd_analyze,
    "export_csv": cmd_export_csv,
    "locate": cmd_locate,
}


def handle(cmd, payload_json):
    try:
        payload = json.loads(payload_json) if payload_json else {}
    except json.JSONDecodeError as error:
        return jdump({"ok": False, "error": f"요청을 읽지 못했습니다: {error}"})
    runner = COMMANDS.get(cmd)
    if runner is None:
        return jdump({"ok": False, "error": f"알 수 없는 명령: {cmd}"})
    try:
        return jdump({"ok": True, "result": runner(payload)})
    except KernelError as error:
        return jdump({"ok": False, "error": str(error)})
    except KeyError as error:
        return jdump({"ok": False, "error": f"필요한 값이 없습니다: {error}"})
    except Exception as error:
        return jdump({"ok": False, "error": f"{type(error).__name__}: {error}"})
