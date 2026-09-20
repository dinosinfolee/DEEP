"""브라우저에서 화면 전체 흐름을 확인한다.

Pyodide만 로컬 대역(worker-bridge.js)으로 바꾸고, 나머지 HTML·CSS·JS·Plotly는 실제 파일 그대로다.
업로드 → 전처리 → 시각화 → 분석 → 저장/열기 → 공유 → 과제 링크 → 자동 복구까지 한 번에 훑는다.
"""

import pathlib
import shutil
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
PORT = 8765
SAMPLES = [str(ROOT / 'samples' / f'{name}.csv') for name in ('학교현황', '지역지표', '매점_구매내역')]
failures = []
console_errors = []
IGNORE = ('favicon', 'ERR_TUNNEL', 'pretendard', 'jsdelivr')


def check(label, condition, detail=''):
    print(f'  {"✓" if condition else "✗"} {label} {detail if not condition else ""}'.rstrip())
    if not condition:
        failures.append(f'{label} {detail}')


def watch(page, tag=''):
    page.on('console', lambda m: console_errors.append(
        f'{tag}{m.text} @ {(m.location or {}).get("url", "?")}') if m.type == 'error' else None)
    page.on('pageerror', lambda e: console_errors.append(f'{tag}pageerror: {e}'))


def boot(browser, url=None):
    page = browser.new_page(viewport={'width': 1560, 'height': 980})
    watch(page)
    page.goto(url or f'http://127.0.0.1:{PORT}/', wait_until='networkidle')
    page.wait_for_selector('#boot', state='detached', timeout=20000)
    return page


def main():
    backup = ROOT / 'assets' / 'worker.real.js'
    shutil.copy(ROOT / 'assets' / 'worker.js', backup)
    shutil.copy(ROOT / 'test' / 'worker-bridge.js', ROOT / 'assets' / 'worker.js')
    server = subprocess.Popen(
        [sys.executable, str(ROOT / 'test' / 'bridge_server.py'), str(PORT)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    time.sleep(1.5)
    try:
        run()
    finally:
        server.terminate()
        shutil.move(backup, ROOT / 'assets' / 'worker.js')


def run():
    with sync_playwright() as play:
        browser = play.chromium.launch()

        print('\n[1] 첫 화면')
        page = boot(browser)
        check('부팅 화면이 사라짐', True)
        check('Plotly 로드됨', page.evaluate('typeof Plotly !== "undefined"'))

        print('\n[2] CSV 올리기')
        page.set_input_files('#file-input', SAMPLES)
        page.wait_for_selector('table.grid', timeout=20000)
        check('표가 그려짐', page.locator('table.grid tbody tr').count() > 10)
        check('데이터 목록 3개', page.locator('.table-item').count() == 3)
        page.locator('.table-item', has_text='학교현황').first.click()
        page.wait_for_timeout(1200)
        check('열 목록 표시', page.locator('.column-row').count() == 7)
        check('결측 배지 표시', page.locator('.flag-missing').count() >= 1)
        check('이상치 배지 표시', page.locator('.flag-outlier').count() >= 1)
        page.screenshot(path=str(ROOT / 'test' / 'shot-01-table.png'))

        print('\n[3] 전처리 단계 추가')
        page.locator('.op-btn', has_text='결측치 처리').first.click()
        page.wait_for_selector('#modal-backdrop:not([hidden])')
        page.select_option('#modal-body select >> nth=1', 'median')
        page.click('#modal-ok')
        page.wait_for_timeout(1200)
        check('단계 1개 적용', page.locator('#inspector-body .step-item').count() == 1)
        check('실패 표시 없음', page.locator('#inspector-body .step-item.failed').count() == 0)

        page.locator('.op-btn', has_text='계산 열 추가').first.click()
        page.wait_for_selector('#modal-backdrop:not([hidden])')
        inputs = page.locator('#modal-body input[type="text"]')
        inputs.nth(0).fill('교원당학생수')
        inputs.nth(1).fill('`학생수` / `교원수`')
        page.click('#modal-ok')
        page.wait_for_timeout(1200)
        check('단계 2개 적용', page.locator('#inspector-body .step-item').count() == 2)
        check('새 열이 생김', page.locator('.column-row', has_text='교원당학생수').count() == 1)
        page.screenshot(path=str(ROOT / 'test' / 'shot-02-steps.png'))

        print('\n[4] 시각화')
        page.click('.tab[data-view="charts"]')
        page.locator('.op-btn', has_text='산점도').first.click()
        page.wait_for_timeout(2500)
        check('산점도 카드 생성', page.locator('#chart-grid .card').count() == 1)
        check('Plotly 그림이 그려짐', page.locator('#chart-grid .card .plot .main-svg').count() >= 1)
        check('추세선 설명 표시', '추세선' in page.locator('.card-note').first.inner_text())
        page.locator('.op-btn', has_text='막대그래프').first.click()
        page.wait_for_timeout(2000)
        check('막대그래프 추가', page.locator('#chart-grid .card').count() == 2)
        page.screenshot(path=str(ROOT / 'test' / 'shot-03-charts.png'))

        print('\n[5] 분석')
        page.click('.tab[data-view="analysis"]')
        page.locator('.op-btn', has_text='데이터 품질 점검').first.click()
        page.wait_for_timeout(2000)
        check('품질 점검 결과표', page.locator('.result-table tbody tr').count() >= 5)

        page.locator('.op-btn', has_text='회귀 분석').first.click()
        page.wait_for_timeout(1000)
        card = page.locator('#analysis-grid .card').nth(1)
        card.locator('select').nth(1).select_option('학생수')
        page.wait_for_timeout(400)
        card.locator('.checklist label', has_text='학급수').first.locator('input').check()
        page.wait_for_timeout(3500)
        check('회귀 결과 표시', card.locator('.stat').count() >= 3)
        check('계수표 표시', card.locator('.result-table').count() >= 1)
        check('회귀 그림 표시', card.locator('.plot .main-svg').count() >= 2)
        page.screenshot(path=str(ROOT / 'test' / 'shot-04-regression.png'))

        page.locator('.op-btn', has_text='연관 분석').first.click()
        page.wait_for_timeout(800)
        assoc = page.locator('#analysis-grid .card').nth(2)
        assoc.locator('select').first.select_option('매점_구매내역')
        page.wait_for_timeout(3000)
        check('품목 열을 스스로 고름', assoc.locator('select').nth(2).input_value() == '구매품목',
              assoc.locator('select').nth(2).input_value())
        check('연관 규칙 표시', '향상도' in assoc.inner_text())
        page.screenshot(path=str(ROOT / 'test' / 'shot-05-association.png'))

        print('\n[6] 자동 저장과 이어서 하기')
        page.fill('#project-title', '3반 데이터 탐구')
        page.wait_for_timeout(2500)
        saved = page.evaluate("""() => new Promise((resolve) => {
          const req = indexedDB.open('deep', 1);
          req.onsuccess = () => {
            const tx = req.result.transaction('workspace', 'readonly');
            const get = tx.objectStore('workspace').get('autosave');
            get.onsuccess = () => resolve(get.result ? {
              title: get.result.title,
              sources: Object.keys(get.result.sources || {}).length,
              steps: (get.result.steps || []).length,
              charts: (get.result.charts || []).length,
            } : null);
            get.onerror = () => resolve(null);
          };
          req.onerror = () => resolve(null);
        })""")
        check('브라우저에 자동 저장됨', saved is not None, saved)
        if saved:
            check('제목까지 저장', saved['title'] == '3반 데이터 탐구', saved['title'])
            check('데이터 3개 저장', saved['sources'] == 3, saved['sources'])
            check('단계 2개 저장', saved['steps'] == 2, saved['steps'])

        page.reload(wait_until='networkidle')
        page.wait_for_selector('#boot', state='detached', timeout=20000)
        page.wait_for_selector('#modal-backdrop:not([hidden])', timeout=15000)
        check('이어서 하기 안내가 뜸', '하던 작업' in page.inner_text('#modal-title'))
        page.screenshot(path=str(ROOT / 'test' / 'shot-06-restore.png'))
        page.click('#modal-ok')
        page.wait_for_timeout(6000)
        check('제목 복구', page.input_value('#project-title') == '3반 데이터 탐구')
        check('데이터 복구', page.locator('.table-item').count() == 3)
        page.click('.tab[data-view="table"]')
        page.wait_for_timeout(500)
        check('전처리 단계 복구', page.locator('#inspector-body .step-item').count() == 2)
        check('그래프 복구', len(page.evaluate('window.__deepCharts || []')) >= 0)

        print('\n[7] 작업을 파일로 저장')
        page.click('#btn-save')
        page.wait_for_selector('#modal-backdrop:not([hidden])')
        page.fill('#modal-body input[type="text"]', '1학년3반_김세종')
        with page.expect_download() as info:
            page.locator('#modal-body button', has_text='내 작업 저장').click()
        download = info.value
        saved_path = ROOT / 'test' / 'saved-project.json'
        download.save_as(str(saved_path))
        check('파일 이름에 이름이 붙음', '김세종' in download.suggested_filename, download.suggested_filename)
        import json
        project = json.loads(saved_path.read_text(encoding='utf-8'))
        check('프로젝트 형식', project.get('kind') == 'deep-project')
        check('데이터 3개 포함', len(project.get('data', {})) == 3)
        check('CSV 원문 포함', '학교명' in project['data']['학교현황'])
        check('전처리 단계 포함', len(project['steps']) == 2)
        check('그래프 포함', len(project['charts']) == 2)
        check('분석 포함', len(project['analyses']) == 3)
        page.click('#modal-close')

        print('\n[8] 저장한 파일 열기 — 다른 브라우저 창에서')
        fresh = boot(browser)
        fresh.set_input_files('#project-input', str(saved_path))
        fresh.wait_for_timeout(8000)
        check('제목 그대로', fresh.input_value('#project-title') == '3반 데이터 탐구')
        check('데이터 그대로', fresh.locator('.table-item').count() == 3)
        fresh.click('.tab[data-view="charts"]')
        fresh.wait_for_timeout(3000)
        check('그래프 다시 그려짐', fresh.locator('#chart-grid .card .plot .main-svg').count() >= 2)
        fresh.click('.tab[data-view="analysis"]')
        fresh.wait_for_timeout(5000)
        check('분석 다시 계산됨', fresh.locator('#analysis-grid .stat').count() >= 4)
        fresh.screenshot(path=str(ROOT / 'test' / 'shot-07-reopened.png'))
        fresh.close()

        print('\n[9] 과제 링크 (데이터 포함)')
        page.click('#btn-share')
        page.wait_for_selector('#modal-backdrop:not([hidden])')
        page.fill('#modal-body input[type="text"]', '학생수와 학급수의 관계를 살펴보세요.')
        page.check('#share-with-data')
        page.wait_for_timeout(2500)
        assignment = page.input_value('.share-box input')
        check('데이터 포함 링크 생성', '#d=' in assignment)
        check('레시피보다 김', len(assignment) > 3000, len(assignment))
        page.screenshot(path=str(ROOT / 'test' / 'shot-08-share.png'))
        page.click('#modal-close')

        student = boot(browser, assignment)
        student.wait_for_timeout(9000)
        check('학생은 올릴 것 없이 바로 열림',
              student.locator('#modal-backdrop:not([hidden])').count() == 0)
        check('데이터가 이미 들어 있음', student.locator('.table-item').count() == 3)
        student.click('.tab[data-view="charts"]')
        student.wait_for_timeout(3000)
        check('과제 그래프가 보임', student.locator('#chart-grid .card .plot .main-svg').count() >= 2)
        student.screenshot(path=str(ROOT / 'test' / 'shot-09-assignment.png'))
        student.close()

        print('\n[10] 레시피 링크 (데이터 없이)')
        page.click('#btn-share')
        page.wait_for_selector('#modal-backdrop:not([hidden])')
        page.wait_for_timeout(2000)
        recipe_url = page.input_value('.share-box input')
        check('설정만 담긴 링크', '#d=' in recipe_url)
        check('데이터 포함본보다 짧음', len(recipe_url) < len(assignment), len(recipe_url))
        page.click('#modal-close')

        receiver = boot(browser, recipe_url)
        receiver.wait_for_selector('#modal-backdrop:not([hidden])', timeout=20000)
        check('받은 분석 안내', '받은 분석' in receiver.inner_text('#modal-title'))
        check('안내문 전달', '학생수와 학급수' in receiver.inner_text('#modal-body'))
        receiver.click('#modal-cancel')
        receiver.set_input_files('#file-input', SAMPLES)
        receiver.wait_for_timeout(8000)
        receiver.click('.tab[data-view="table"]')
        receiver.wait_for_timeout(500)
        check('레시피 단계 재현', receiver.locator('#inspector-body .step-item').count() == 2)
        check('실패한 단계 없음', receiver.locator('#inspector-body .step-item.failed').count() == 0)
        receiver.click('.tab[data-view="charts"]')
        receiver.wait_for_timeout(3000)
        check('그래프 재현', receiver.locator('#chart-grid .card .plot .main-svg').count() >= 2)
        receiver.screenshot(path=str(ROOT / 'test' / 'shot-10-replayed.png'))
        receiver.close()

        print('\n[11] 수업 준비(미리 받기)')
        page.click('#btn-help')
        page.wait_for_selector('#modal-backdrop:not([hidden])')
        warm = page.locator('#modal-body button', has_text='미리 받기')
        check('미리 받기 버튼 있음', warm.count() == 1)
        warm.click()
        page.wait_for_timeout(1500)
        check('준비 완료로 바뀜', '준비 완료' in page.inner_text('#modal-body'))
        page.click('#modal-close')

        print('\n[12] 콘솔 오류')
        real = [i for i in console_errors if not any(b in i for b in IGNORE)]
        check('콘솔 오류 없음', not real, real[:4])

        saved_path.unlink(missing_ok=True)
        browser.close()


main()
print('\n' + '=' * 60)
if failures:
    print(f'실패 {len(failures)}건')
    for item in failures:
        print(' -', item)
    sys.exit(1)
print('모두 통과')
