"""Pyodide를 이 폴더 안에 받아 둔다 — 바깥 CDN 없이 도는 DEEP을 만든다.

왜 필요한가
  1) 교육청 망에서 cdn.jsdelivr.net 이 막혀 있으면 수업이 로딩 화면에서 끝난다.
     받아 두면 바깥 도메인이 0개가 되어, 망 담당자에게도 우리 주소 하나만 열어 달라고 하면 된다.
  2) 캐시 수명을 우리가 정할 수 있다(_headers에서 1년 고정).

쓰는 법
  python tools/fetch_pyodide.py

  받고 나면 vendor/pyodide/ 가 생기고, 앱이 알아서 그쪽을 먼저 본다.
  코드는 한 줄도 고칠 필요가 없다. 되돌리려면 vendor/pyodide 폴더를 지우면 된다.

용량은 약 90MB이고 한 번만 받으면 된다.
"""

import json
import pathlib
import sys
import urllib.error
import urllib.request

VERSION = '314.0.7'
BASE = f'https://cdn.jsdelivr.net/pyodide/v{VERSION}/full/'

# 앱이 실제로 쓰는 것만. 지연 로딩 대상도 미리 받아 둬야 수업 중에 네트워크를 안 탄다.
WANTED = ['numpy', 'pandas', 'scipy', 'scikit-learn', 'statsmodels']

CORE = [
    'pyodide.js',
    'pyodide.mjs',
    'pyodide.asm.js',
    'pyodide.asm.mjs',
    'pyodide.asm.wasm',
    'python_stdlib.zip',
    'pyodide-lock.json',
]

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'vendor' / 'pyodide'


def fetch(name: str, required: bool = True) -> bytes | None:
    url = BASE + name
    try:
        with urllib.request.urlopen(url, timeout=120) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        if error.code == 404 and not required:
            return None
        raise
    except urllib.error.URLError as error:
        raise SystemExit(
            f'\n{url} 에 연결하지 못했습니다: {error.reason}\n'
            '이 컴퓨터에서 인터넷이 되는지, 방화벽이 막고 있지 않은지 확인해 주세요.'
        )


def save(name: str, data: bytes) -> None:
    path = OUT / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def human(size: int) -> str:
    return f'{size / 1048576:.1f}MB'


def closure(lock: dict, names: list[str]) -> set[str]:
    packages = lock['packages']
    seen: set[str] = set()
    stack = list(names)
    while stack:
        name = stack.pop()
        if name in seen:
            continue
        entry = packages.get(name)
        if entry is None:
            print(f'  ! {name} 은(는) 이 Pyodide 배포본에 없습니다 — 건너뜁니다')
            continue
        seen.add(name)
        stack.extend(entry.get('depends', []))
    return seen


def main() -> None:
    print(f'Pyodide {VERSION} 를 {OUT} 에 받습니다.\n')

    total = 0
    for name in CORE:
        # pyodide.asm.js 와 pyodide.asm.mjs 는 버전에 따라 한쪽만 있다.
        data = fetch(name, required=name not in ('pyodide.asm.js', 'pyodide.asm.mjs'))
        if data is None:
            continue
        save(name, data)
        total += len(data)
        print(f'  {name:24} {human(len(data))}')

    lock = json.loads((OUT / 'pyodide-lock.json').read_text(encoding='utf-8'))
    packages = closure(lock, WANTED)
    print(f'\n꾸러미 {len(packages)}개')
    for name in sorted(packages):
        file_name = lock['packages'][name]['file_name']
        data = fetch(file_name)
        save(file_name, data)
        total += len(data)
        print(f'  {name:24} {human(len(data))}')

    print(f'\n끝났습니다. 모두 {human(total)}')
    print('이제 DEEP은 바깥 CDN 없이 돕니다. 브라우저에서 한 번 새로고침해 확인해 보세요.')
    print('(되돌리려면 vendor/pyodide 폴더를 지우면 됩니다.)')


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        sys.exit('\n중단했습니다.')
