"""kernel.py를 CPython에서 그대로 돌려 본다. Pyodide와 같은 버전의 pandas/sklearn/statsmodels."""

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'assets'))
import kernel  # noqa: E402

SAMPLES = ROOT / 'samples'
failures = []


def call(cmd, payload=None):
    out = json.loads(kernel.handle(cmd, json.dumps(payload or {})))
    if not out['ok']:
        failures.append(f'{cmd} {payload}: {out["error"]}')
        print(f'  ✗ {cmd}: {out["error"]}')
        return None
    return out['result']


def check(label, condition, detail=''):
    if condition:
        print(f'  ✓ {label}')
    else:
        failures.append(f'{label} {detail}')
        print(f'  ✗ {label} {detail}')


print('\n[1] CSV 읽기')
for name in ['학교현황', '지역지표', '매점_구매내역']:
    text = (SAMPLES / f'{name}.csv').read_text(encoding='utf-8')
    result = call('load_csv', {'name': name, 'text': text})
    check(f'{name} 적재', result is not None)

meta = {table['name']: table for table in call('rebuild', {'steps': []})['tables']}
check('세 표 모두 있음', len(meta) == 3, list(meta))
schools = meta['학교현황']
check('학생수는 숫자로 추론', next(c for c in schools['columns'] if c['name'] == '학생수')['kind'] == 'number')
check('교원수에 결측이 잡힘', next(c for c in schools['columns'] if c['name'] == '교원수')['missing'] > 0)
check('학생수에 이상치가 잡힘', next(c for c in schools['columns'] if c['name'] == '학생수')['outliers'] > 0)

print('\n[2] 전처리 단계 이어붙이기')
steps = [
    {'id': 's1', 'op': 'missing', 'table': '학교현황', 'method': 'median', 'columns': ['교원수']},
    {'id': 's2', 'op': 'outlier', 'table': '학교현황', 'columns': ['학생수'], 'method': 'iqr', 'k': 1.5, 'action': 'remove'},
    {'id': 's3', 'op': 'new_column', 'table': '학교현황', 'name': '교원당학생수', 'expr': '`학생수` / `교원수`'},
    {'id': 's4', 'op': 'normalize', 'table': '학교현황', 'columns': ['학생수'], 'method': 'minmax', 'replace': False},
    {'id': 's5', 'op': 'bin', 'table': '학교현황', 'column': '학생수', 'bins': 4, 'mode': 'quantile', 'name': '규모구간'},
    {'id': 's6', 'op': 'merge', 'left': '학교현황', 'right': '지역지표', 'leftOn': ['시도'], 'rightOn': ['시도'],
     'how': 'inner', 'result': '병합표'},
    {'id': 's7', 'op': 'group', 'table': '병합표', 'by': ['시도'],
     'aggs': [{'column': '학생수', 'func': 'mean'}, {'column': '교원수', 'func': 'mean'}], 'result': '시도별요약'},
    {'id': 's8', 'op': 'filter_rows', 'table': '병합표', 'query': '`학생수` > 200'},
    {'id': 's9', 'op': 'sort', 'table': '병합표', 'by': ['학생수'], 'ascending': False},
    {'id': 's10', 'op': 'drop_columns', 'table': '병합표', 'columns': ['규모구간']},
    {'id': 's11', 'op': 'kmeans_label', 'table': '병합표', 'columns': ['학생수', '교원수', '학급수'],
     'k': 3, 'scale': True, 'name': '군집'},
    {'id': 's12', 'op': 'drop_duplicates', 'table': '병합표', 'columns': []},
    {'id': 's13', 'op': 'change_type', 'table': '병합표', 'column': '설립구분', 'to': 'text'},
    {'id': 's14', 'op': 'rename_column', 'table': '시도별요약', 'from': '학생수_평균', 'to': '평균학생수'},
    {'id': 's15', 'op': 'concat', 'tables': ['학교현황', '학교현황'], 'addSource': True, 'result': '두배표'},
]
built = call('rebuild', {'steps': steps})
check('모든 단계 성공', built and not built['problems'], built['problems'] if built else '')
tables = {table['name']: table for table in built['tables']}
check('병합표 생성', '병합표' in tables)
check('군집 열 추가', any(c['name'] == '군집' for c in tables['병합표']['columns']))
check('평균학생수로 이름 변경', any(c['name'] == '평균학생수' for c in tables['시도별요약']['columns']))
check('세로 결합이 두 배', tables['두배표']['rows'] == tables['학교현황']['rows'] * 2)

print('\n[3] 표 미리보기 / 내보내기')
preview = call('preview', {'table': '병합표', 'offset': 0, 'limit': 5})
check('미리보기 5행', preview and len(preview['rows']) == 5)
check('JSON 직렬화 가능', json.dumps(preview) is not None)
csv_out = call('export_csv', {'table': '시도별요약'})
check('CSV 내보내기', csv_out and '시도' in csv_out['text'])

print('\n[4] 그래프 데이터')
charts = [
    {'kind': 'bar', 'table': '병합표', 'x': '시도', 'y': '학생수', 'agg': 'mean'},
    {'kind': 'bar', 'table': '병합표', 'x': '시도', 'agg': 'count', 'color': '설립구분'},
    {'kind': 'line', 'table': '시도별요약', 'x': '시도', 'y': '평균학생수', 'agg': 'mean'},
    {'kind': 'scatter', 'table': '병합표', 'x': '학급수', 'y': '학생수', 'color': '학교급',
     'size': '교원수', 'trend': True},
    {'kind': 'histogram', 'table': '병합표', 'x': '학생수', 'bins': 12},
    {'kind': 'histogram', 'table': '병합표', 'x': '학생수', 'color': '학교급'},
    {'kind': 'box', 'table': '병합표', 'y': '학생수', 'x': '학교급'},
    {'kind': 'pie', 'table': '병합표', 'x': '설립구분', 'agg': 'count'},
    {'kind': 'heatmap', 'table': '병합표', 'columns': ['학생수', '교원수', '학급수', '인구', '재정자립도']},
]
for spec in charts:
    result = call('chart_data', spec)
    label = f"{spec['kind']}({spec.get('x') or spec.get('columns')})"
    check(label, result is not None)
    if result:
        json.dumps(result)

trend = call('chart_data', charts[3])
check('추세선 계산', trend and 'trend' in trend and -1 <= trend['trend']['r'] <= 1)

print('\n[5] 분석')
analyses = [
    {'kind': 'quality', 'table': '병합표'},
    {'kind': 'describe', 'table': '병합표', 'columns': ['학생수', '교원수', '시도']},
    {'kind': 'correlation', 'table': '병합표', 'columns': ['학생수', '교원수', '학급수', '인구'], 'method': 'pearson'},
    {'kind': 'regression', 'table': '병합표', 'y': '학생수', 'x': ['학급수'], 'model': 'linear', 'testSize': 0.3},
    {'kind': 'regression', 'table': '병합표', 'y': '학생수', 'x': ['학급수', '교원수'], 'model': 'forest',
     'maxDepth': 6, 'testSize': 0.3},
    {'kind': 'cluster', 'table': '병합표', 'columns': ['학생수', '교원수', '학급수'], 'k': 3, 'scale': True},
    {'kind': 'association', 'table': '매점_구매내역', 'mode': 'item_column', 'itemColumn': '구매품목',
     'separator': ',', 'minSupport': 0.03, 'minConfidence': 0.3},
    {'kind': 'classification', 'table': '병합표', 'y': '학교급', 'x': ['학생수', '학급수', '교원수'],
     'model': 'tree', 'maxDepth': 4, 'testSize': 0.3},
]
results = {}
for spec in analyses:
    result = call('analyze', spec)
    check(f"{spec['kind']}", result is not None)
    if result:
        json.dumps(result)
        results.setdefault(spec['kind'], result)

if 'regression' in results:
    reg = results['regression']
    check('OLS 계수 2개 (상수항 포함)', len(reg['statistical']['coefficients']) == 2)
    check('단순회귀선 데이터 있음', reg['simple'] is not None)
    check('R²가 0~1', 0 <= reg['statistical']['r2'] <= 1, reg['statistical']['r2'])
if 'cluster' in results:
    cl = results['cluster']
    check('군집 개수 일치', len(cl['groups']) == cl['k'])
    check('엘보우 곡선 있음', len(cl['elbow']) >= 3)
if 'association' in results:
    assoc = results['association']
    check('연관 규칙 발견', len(assoc['rules']) > 0, assoc['transactions'])
    if assoc['rules']:
        top = assoc['rules'][0]
        check('향상도 1 이상인 규칙', top['lift'] > 1, top)
if 'classification' in results:
    check('정확도 0~1', 0 <= results['classification']['accuracy'] <= 1)

print('\n[6] 오류 처리')
bad = json.loads(kernel.handle('analyze', json.dumps({'kind': 'regression', 'table': '병합표', 'y': '학생수', 'x': []})))
check('빈 설명변수는 친절한 오류', not bad['ok'] and '설명 변수' in bad['error'], bad)
bad2 = json.loads(kernel.handle('chart_data', json.dumps({'kind': 'bar', 'table': '없는표', 'x': 'a'})))
check('없는 표는 오류', not bad2['ok'])
broken = call('rebuild', {'steps': steps + [{'id': 'bad', 'op': 'new_column', 'table': '학교현황',
                                             'name': 'x', 'expr': '`없는열` * 2'}]})
check('잘못된 단계만 실패로 보고', broken and len(broken['problems']) == 1 and broken['problems'][0]['id'] == 'bad',
      broken['problems'] if broken else '')

print('\n[7] 인코딩')
cp949 = (SAMPLES / '학교현황.csv').read_text(encoding='utf-8')
check('BOM 붙은 CSV도 읽힘', call('load_csv', {'name': 'bom', 'text': '﻿' + cp949}) is not None)

print('\n' + '=' * 60)
if failures:
    print(f'실패 {len(failures)}건')
    for item in failures:
        print(' -', item)
    sys.exit(1)
print('모두 통과')
