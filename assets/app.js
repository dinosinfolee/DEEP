/* DEEP — 브라우저 안에서 도는 데이터 분석 화면.
   서버 호출은 한 군데도 없다. 파일은 사용자의 브라우저를 떠나지 않는다. */

import { Kernel, readCsvFile } from './py-client.js';
import * as C from './charts.js';
import {
  buildProject, buildRecipe, linkFor, tokenFromHash, decodePayload,
  downloadJson, readJsonFile, hasData, dataBytes,
} from './share.js';
import { saveSnapshot, loadSnapshot, clearSnapshot } from './store.js';

/* ------------------------------------------------------------------ 상태 */

const state = {
  title: '새 분석',
  author: '',
  note: '',
  tables: [],
  // 올린 CSV의 원문. 저장·과제 링크·자동 복구가 모두 이것을 쓴다.
  sources: {},
  activeTable: null,
  steps: [],
  redo: [],
  selCols: [],
  selRows: [],
  selTable: null,
  charts: [],
  analyses: [],
  problems: [],
  view: 'table',
  page: 0,
  pendingRecipe: null,
};

const PAGE_SIZE = 50;
let kernel = null;
let busyCount = 0;

/* ------------------------------------------------------------------ 도구 */

const $ = (selector) => document.querySelector(selector);
const uid = () => Math.random().toString(36).slice(2, 9);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(path) {
  return `<svg viewBox="0 0 24 24">${path}</svg>`;
}

const ICONS = {
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  eye: '<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.6"/>',
  eyeOff: '<path d="M4 4l16 16M10 5.2A8.9 8.9 0 0112 5c6.4 0 10 6 10 6a17 17 0 01-3.3 3.8M6.5 7.3A16.6 16.6 0 002 11s3.6 6 10 6a9.7 9.7 0 003.8-.75"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v2M12 19.5v2M21.5 12h-2M4.5 12h-2M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4M18.7 18.7l-1.4-1.4M6.7 6.7L5.3 5.3"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h8"/>',
  download: '<path d="M12 3v12M7 11l5 5 5-5M4 20h16"/>',
};

function toast(message, kind = '') {
  const node = el('div', `toast ${kind}`.trim(), message);
  $('#toast-stack').append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .3s ease';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 320);
  }, kind === 'error' ? 6500 : 3200);
}

function setBusy(delta) {
  busyCount = Math.max(0, busyCount + delta);
  const chip = $('#kernel-chip');
  const text = $('#kernel-chip-text');
  if (!chip.dataset.ready) return;
  chip.className = busyCount ? 'chip chip-busy' : 'chip chip-ok';
  text.textContent = busyCount ? '계산 중' : '준비됨';
}

async function run(promise, what) {
  setBusy(1);
  try {
    return await promise;
  } catch (error) {
    toast(`${what}: ${error.message}`, 'error');
    throw error;
  } finally {
    setBusy(-1);
  }
}

const numberFormat = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 4 });
const fmt = (value, digits = 4) => {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (typeof value !== 'number') return String(value);
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1e6 || (Math.abs(value) < 1e-4 && value !== 0)) return value.toExponential(2);
  return numberFormat.format(Number(value.toFixed(digits)));
};
const pct = (value) => (value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`);

/* ------------------------------------------------------- 자동 저장 */

let autosaveTimer = null;
let autosaveOn = true;

function snapshot() {
  return {
    title: state.title,
    author: state.author,
    note: state.note,
    sources: state.sources,
    steps: state.steps,
    charts: state.charts.map(({ editing, ...rest }) => rest),
    analyses: state.analyses.map(({ editing, result, ...rest }) => rest),
    activeTable: state.activeTable,
    savedAt: new Date().toISOString(),
  };
}

function markSaved(text) {
  const mark = $('#autosave-mark');
  mark.textContent = text;
  mark.classList.add('visible');
  clearTimeout(markSaved.timer);
  markSaved.timer = setTimeout(() => mark.classList.remove('visible'), 2200);
}

function touch() {
  if (!autosaveOn) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(async () => {
    if (!Object.keys(state.sources).length) return;
    const ok = await saveSnapshot(snapshot());
    if (ok) markSaved('자동 저장됨');
  }, 1200);
}

const tableMeta = (name) => state.tables.find((table) => table.name === name) || null;
const columnsOf = (name, kinds) => {
  const meta = tableMeta(name);
  if (!meta) return [];
  return meta.columns.filter((column) => !kinds || kinds.includes(column.kind));
};

/* ------------------------------------------------------- 모달 / 메뉴 */

let modalResolve = null;

function openModal({ title, build, okLabel = '적용', hideFoot = false }) {
  return new Promise((resolve) => {
    modalResolve = resolve;
    $('#modal-title').textContent = title;
    $('#modal-ok').textContent = okLabel;
    $('#modal-foot').hidden = hideFoot;
    const body = $('#modal-body');
    body.innerHTML = '';
    build(body, () => closeModal(true));
    $('#modal-backdrop').hidden = false;
  });
}

function closeModal(accepted) {
  $('#modal-backdrop').hidden = true;
  const resolve = modalResolve;
  modalResolve = null;
  if (resolve) resolve(accepted === true);
}

function openMenu(anchor, items) {
  document.querySelectorAll('.menu').forEach((node) => node.remove());
  const menu = el('div', 'menu');
  items.forEach((item) => {
    if (item === '-') {
      menu.append(el('hr'));
      return;
    }
    const button = el('button', item.danger ? 'danger' : '', item.label);
    button.onclick = () => {
      menu.remove();
      item.run();
    };
    menu.append(button);
  });
  document.body.append(menu);
  const box = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(box.left, window.innerWidth - menu.offsetWidth - 12)}px`;
  menu.style.top = `${Math.min(box.bottom + 4, window.innerHeight - menu.offsetHeight - 12)}px`;
  setTimeout(() => {
    const close = (event) => {
      if (!menu.contains(event.target)) {
        menu.remove();
        document.removeEventListener('mousedown', close);
      }
    };
    document.addEventListener('mousedown', close);
  }, 0);
}

/* ------------------------------------------------------- 폼 만들기 */

const AGG_OPTIONS = [
  ['mean', '평균'], ['sum', '합계'], ['count', '개수'],
  ['median', '중앙값'], ['max', '최대'], ['min', '최소'], ['std', '표준편차'],
];

/* 카드에서 표를 바꾸면 이전 표의 열 이름이 남아 엉뚱한 설정이 된다.
   표가 바뀌면 나머지 설정을 비우고 새 표에 맞는 기본값을 다시 고른다. */
function mountSettings(container, fields, item, defaultsFor, onUpdate) {
  let lastTable = item.table;
  const handle = () => {
    if (item.table !== lastTable) {
      lastTable = item.table;
      fields.forEach((field) => {
        if (field.key !== 'table') delete item[field.key];
      });
      Object.assign(item, defaultsFor(item.kind, item.table));
      buildFields(container, fields, item, handle);
    }
    onUpdate();
  };
  buildFields(container, fields, item, handle);
}

function buildFields(container, fields, values, onChange) {
  container.innerHTML = '';
  const rerender = () => buildFields(container, fields, values, onChange);

  fields.forEach((field) => {
    if (field.when && !field.when(values)) return;
    const isCheck = field.type === 'checkbox';
    const wrap = el('div', `field${field.wide ? ' field-wide' : ''}${isCheck ? ' field-check' : ''}`);
    const id = `f-${uid()}`;
    const label = el('label', null, field.label || field.key);
    label.htmlFor = id;

    let input;
    const emit = () => {
      onChange(values);
      if (field.affects !== false) rerender();
    };

    switch (field.type) {
      case 'table':
      case 'column':
      case 'select': {
        input = el('select');
        let options = [];
        if (field.type === 'table') options = state.tables.map((table) => [table.name, table.name]);
        else if (field.type === 'column') {
          const skip = field.exclude ? field.exclude(values) : [];
          options = columnsOf(values.table, field.kinds)
            .filter((column) => !skip.includes(column.name))
            .map((column) => [column.name, column.name]);
        } else options = field.options(values);
        if (field.optional) options = [['', '(없음)']].concat(options);
        options.forEach(([value, text]) => {
          const option = el('option', null, text);
          option.value = value;
          input.append(option);
        });
        if (!options.some(([value]) => value === values[field.key])) {
          values[field.key] = options.length ? options[0][0] : '';
        }
        input.value = values[field.key] ?? '';
        input.onchange = () => { values[field.key] = input.value; emit(); };
        break;
      }
      case 'columns': {
        input = el('div', 'checklist');
        const available = columnsOf(values.table, field.kinds);
        const selected = new Set(values[field.key] || []);
        available.forEach((column) => {
          const row = el('label');
          const box = el('input');
          box.type = 'checkbox';
          box.checked = selected.has(column.name);
          box.onchange = () => {
            if (box.checked) selected.add(column.name);
            else selected.delete(column.name);
            values[field.key] = available
              .map((item) => item.name)
              .filter((name) => selected.has(name));
            onChange(values);
          };
          row.append(box, el('span', null, column.name));
          input.append(row);
        });
        if (!available.length) input.append(el('span', 'hint', '선택할 수 있는 열이 없습니다.'));
        values[field.key] = (values[field.key] || []).filter((name) =>
          available.some((column) => column.name === name)
        );
        break;
      }
      case 'tables': {
        input = el('div', 'checklist');
        const selected = new Set(values[field.key] || []);
        state.tables.forEach((table) => {
          const row = el('label');
          const box = el('input');
          box.type = 'checkbox';
          box.checked = selected.has(table.name);
          box.onchange = () => {
            if (box.checked) selected.add(table.name);
            else selected.delete(table.name);
            values[field.key] = state.tables
              .map((item) => item.name)
              .filter((name) => selected.has(name));
            onChange(values);
          };
          row.append(box, el('span', null, table.name));
          input.append(row);
        });
        break;
      }
      case 'checkbox': {
        input = el('input');
        input.type = 'checkbox';
        input.checked = Boolean(values[field.key] ?? field.default);
        values[field.key] = input.checked;
        input.onchange = () => { values[field.key] = input.checked; emit(); };
        break;
      }
      case 'number': {
        input = el('input');
        input.type = 'number';
        if (field.min !== undefined) input.min = field.min;
        if (field.max !== undefined) input.max = field.max;
        if (field.step !== undefined) input.step = field.step;
        if (values[field.key] === undefined) values[field.key] = field.default;
        input.value = values[field.key];
        input.oninput = () => {
          values[field.key] = input.value === '' ? field.default : Number(input.value);
          onChange(values);
        };
        break;
      }
      default: {
        input = el('input');
        input.type = 'text';
        if (values[field.key] === undefined) values[field.key] = field.default ?? '';
        input.value = values[field.key];
        if (field.placeholder) input.placeholder = field.placeholder;
        input.oninput = () => { values[field.key] = input.value; onChange(values); };
      }
    }

    input.id = id;
    if (isCheck) wrap.append(input, label);
    else wrap.append(label, input);
    if (field.hint) wrap.append(el('span', 'hint', field.hint));
    container.append(wrap);
  });
}

/* ------------------------------------------------------- 전처리 단계 */

const NUM = ['number'];

const STEP_SCHEMAS = {
  drop_columns: {
    label: '열 삭제', group: '열', hidden: true,
    fields: [
      { key: 'table', type: 'table', label: '대상 표' },
      { key: 'columns', type: 'columns', label: '삭제할 열', wide: true },
    ],
    describe: (s) => `${s.table} · ${(s.columns || []).join(', ')}`,
  },
  rename_column: {
    label: '열 이름 변경', group: '열', hidden: true,
    fields: [
      { key: 'table', type: 'table', label: '대상 표' },
      { key: 'from', type: 'column', label: '바꿀 열' },
      { key: 'to', type: 'text', label: '새 이름' },
    ],
    describe: (s) => `${s.from} → ${s.to}`,
  },
  change_type: {
    label: '자료형 변경', group: '열',
    fields: [
      { key: 'table', type: 'table', label: '대상 표' },
      { key: 'column', type: 'column', label: '열' },
      {
        key: 'to', type: 'select', label: '바꿀 자료형',
        options: () => [['number', '숫자'], ['text', '문자'], ['datetime', '날짜'], ['category', '범주']],
      },
    ],
    describe: (s) => `${s.column} → ${s.to}`,
  },
  new_column: {
    label: '계산 열 추가', group: '열',
    fields: [
      { key: 'table', type: 'table', label: '대상 표' },
      { key: 'name', type: 'text', label: '새 열 이름' },
      {
        key: 'expr', type: 'text', label: '수식', wide: true,
        placeholder: '`학생수` / `교원수`',
        hint: '열 이름에 한글·공백이 있으면 `학생수` 처럼 backtick으로 감싸세요.',
      },
    ],
    describe: (s) => `${s.name} = ${s.expr}`,
  },
  filter_rows: {
    label: '행 걸러내기', group: '행',
    fields: [
      { key: 'table', type: 'table', label: '대상 표' },
      {
        key: 'query', type: 'text', label: '남길 조건', wide: true,
        placeholder: '`학생수` > 500 and `시도` == "세종특별자치시"',
      },
    ],
    describe: (s) => s.query,
  },
  missing: {
    label: '결측치 처리', group: '정리',
    fields: [
      { key: 'table', type: 'table', label: '대상 표' },
      {
        key: 'method', type: 'select', label: '방법',
        options: () => [
          ['drop_rows', '행 삭제'], ['mean', '평균으로 채우기'], ['median', '중앙값으로 채우기'],
          ['mode', '최빈값으로 채우기'], ['value', '지정한 값으로 채우기'],
          ['ffill', '앞 값으로 채우기'], ['drop_columns', '결측 있는 열 삭제'],
        ],
      },
      { key: 'value', type: 'text', label: '채울 값', default: '0', when: (v) => v.method === 'value' },
      { key: 'columns', type: 'columns', label: '대상 열 (비우면 전체)', wide: true },
    ],
    describe: (s) => `${s.table} · ${s.method}`,
  },
  outlier: {
    label: '이상치 처리', group: '정리',
    fields: [
      { key: 'table', type: 'table', label: '대상 표' },
      { key: 'columns', type: 'columns', kinds: NUM, label: '대상 숫자 열', wide: true },
      {
        key: 'method', type: 'select', label: '기준',
        options: () => [['iqr', 'IQR (사분위수)'], ['zscore', 'Z-점수']],
      },
      { key: 'k', type: 'number', label: '계수', default: 1.5, step: 0.1, min: 0.5 },
      {
        key: 'action', type: 'select', label: '처리',
        options: () => [['remove', '해당 행 삭제'], ['flag', '표시 열 추가'], ['to_missing', '결측치로'], ['clip', '경계값으로 자르기']],
      },
    ],
    describe: (s) => `${(s.columns || []).join(', ')} · ${s.method} ${s.k} · ${s.action}`,
  },
  normalize: {
    label: '정규화 · 표준화', group: '정리',
    fields: [
      { key: 'table', type: 'table', label: '대상 표' },
      { key: 'columns', type: 'columns', kinds: NUM, label: '대상 숫자 열', wide: true },
      {
        key: 'method', type: 'select', label: '방법',
        options: () => [['minmax', '최소-최대 (0~1)'], ['zscore', '표준화 (Z)'], ['robust', '로버스트'], ['log', '로그']],
      },
      { key: 'replace', type: 'checkbox', label: '원래 열을 덮어쓰기' },
    ],
    describe: (s) => `${(s.columns || []).join(', ')} · ${s.method}`,
  },
  bin: {
    label: '구간 나누기', group: '정리',
    fields: [
      { key: 'table', type: 'table', label: '대상 표' },
      { key: 'column', type: 'column', kinds: NUM, label: '열' },
      { key: 'bins', type: 'number', label: '구간 수', default: 5, min: 2, max: 20 },
      { key: 'mode', type: 'select', label: '방식', options: () => [['width', '같은 폭'], ['quantile', '같은 개수']] },
      { key: 'name', type: 'text', label: '새 열 이름 (비우면 자동)' },
    ],
    describe: (s) => `${s.column} · ${s.bins}구간`,
  },
  sort: {
    label: '정렬', group: '행', hidden: true,
    fields: [
      { key: 'table', type: 'table', label: '대상 표' },
      { key: 'by', type: 'columns', label: '기준 열', wide: true },
      { key: 'ascending', type: 'checkbox', label: '오름차순', default: true },
    ],
    describe: (s) => `${(s.by || []).join(', ')} ${s.ascending ? '↑' : '↓'}`,
  },
  drop_rows: {
    label: '행 삭제', group: '행', hidden: true,
    fields: [{ key: 'table', type: 'table', label: '대상 표' }],
    describe: (s) => `${(s.rows || []).length}개 행`,
  },
  drop_duplicates: {
    label: '중복 행 제거', group: '행',
    fields: [
      { key: 'table', type: 'table', label: '대상 표' },
      { key: 'columns', type: 'columns', label: '기준 열 (비우면 전체)', wide: true },
    ],
    describe: (s) => s.table,
  },
  group: {
    label: '그룹별 요약', group: '합치기',
    fields: [
      { key: 'table', type: 'table', label: '원본 표' },
      { key: 'by', type: 'columns', label: '그룹 기준 열', wide: true },
      { key: 'aggColumns', type: 'columns', kinds: NUM, label: '요약할 숫자 열', wide: true },
      { key: 'func', type: 'select', label: '요약 방법', options: () => AGG_OPTIONS },
      { key: 'result', type: 'text', label: '결과 표 이름', default: '요약' },
    ],
    prepare: (s) => ({
      ...s,
      aggs: (s.aggColumns || []).map((column) => ({ column, func: s.func })),
    }),
    describe: (s) => `${s.table} → ${s.result} (${(s.by || []).join(', ')} 기준)`,
  },
  concat: {
    label: '세로로 이어붙이기', group: '합치기',
    fields: [
      { key: 'tables', type: 'tables', label: '합칠 표 (2개 이상)', wide: true },
      { key: 'addSource', type: 'checkbox', label: '출처 열 추가', default: true },
      { key: 'result', type: 'text', label: '결과 표 이름', default: '합친표' },
    ],
    describe: (s) => `${(s.tables || []).join(' + ')} → ${s.result}`,
  },
  merge: {
    label: '공통 열로 병합', group: '합치기',
    fields: [
      { key: 'left', type: 'table', label: '왼쪽 표' },
      { key: 'leftOn', type: 'columns', label: '왼쪽 기준 열', wide: true, tableKey: 'left' },
      { key: 'right', type: 'table', label: '오른쪽 표' },
      { key: 'rightOn', type: 'columns', label: '오른쪽 기준 열', wide: true, tableKey: 'right' },
      {
        key: 'how', type: 'select', label: '방식',
        options: () => [['inner', '양쪽 모두 있는 행만'], ['left', '왼쪽 전체'], ['outer', '양쪽 전체']],
      },
      { key: 'result', type: 'text', label: '결과 표 이름', default: '병합표' },
    ],
    describe: (s) => `${s.left} ⨝ ${s.right} → ${s.result}`,
  },
  kmeans_label: {
    label: '군집 번호를 열로 추가', group: '합치기',
    fields: [
      { key: 'table', type: 'table', label: '대상 표' },
      { key: 'columns', type: 'columns', kinds: NUM, label: '기준 숫자 열', wide: true },
      { key: 'k', type: 'number', label: '군집 수', default: 3, min: 2, max: 12 },
      { key: 'scale', type: 'checkbox', label: '표준화 후 계산', default: true },
      { key: 'name', type: 'text', label: '새 열 이름', default: '군집' },
    ],
    describe: (s) => `${s.table} · k=${s.k}`,
  },
};

/* merge 단계처럼 열 목록을 left/right 표에서 따로 가져와야 하는 필드가 있어,
   필드를 하나씩 그리면서 values.table을 잠시 그 표로 바꿔 끼운다. */
function buildStepFields(container, op, values, onChange, skipKeys) {
  const fields = STEP_SCHEMAS[op].fields.filter((field) => !(skipKeys || []).includes(field.key));
  container.innerHTML = '';
  const rerender = () => buildStepFields(container, op, values, onChange, skipKeys);
  fields.forEach((field) => {
    const holder = el('div', 'field-holder');
    const original = values.table;
    if (field.tableKey) values.table = values[field.tableKey];
    buildFields(holder, [field], values, (next) => {
      onChange(next);
      rerender();
    });
    if (field.tableKey) values.table = original;
    while (holder.firstChild) container.append(holder.firstChild);
  });
}

/* ------------------------------------------------------- 그래프 정의 */

const CHART_KINDS = {
  bar: {
    label: '막대그래프',
    fields: [
      { key: 'table', type: 'table', label: '표' },
      { key: 'x', type: 'column', label: '가로축 (분류)' },
      { key: 'y', type: 'column', kinds: NUM, label: '값', optional: true },
      { key: 'agg', type: 'select', label: '요약', options: () => AGG_OPTIONS },
      { key: 'color', type: 'column', label: '색 구분', optional: true },
      { key: 'barmode', type: 'select', label: '배치', options: () => [['group', '나란히'], ['stack', '쌓기']] },
      { key: 'horizontal', type: 'checkbox', label: '가로 막대' },
      { key: 'sortByValue', type: 'checkbox', label: '값 순 정렬' },
    ],
  },
  line: {
    label: '선그래프',
    fields: [
      { key: 'table', type: 'table', label: '표' },
      { key: 'x', type: 'column', label: '가로축' },
      { key: 'y', type: 'column', kinds: NUM, label: '값', optional: true },
      { key: 'agg', type: 'select', label: '요약', options: () => AGG_OPTIONS },
      { key: 'color', type: 'column', label: '선 구분', optional: true },
      { key: 'smooth', type: 'checkbox', label: '곡선으로' },
    ],
  },
  scatter: {
    label: '산점도',
    fields: [
      { key: 'table', type: 'table', label: '표' },
      { key: 'x', type: 'column', kinds: NUM, label: '가로축' },
      { key: 'y', type: 'column', kinds: NUM, label: '세로축', exclude: (v) => [v.x] },
      { key: 'color', type: 'column', label: '색 구분', optional: true },
      { key: 'size', type: 'column', kinds: NUM, label: '점 크기', optional: true },
      { key: 'trend', type: 'checkbox', label: '추세선 표시', default: true },
    ],
  },
  histogram: {
    label: '히스토그램',
    fields: [
      { key: 'table', type: 'table', label: '표' },
      { key: 'x', type: 'column', kinds: NUM, label: '값' },
      { key: 'bins', type: 'number', label: '구간 수 (0이면 자동)', default: 0, min: 0, max: 100 },
      { key: 'color', type: 'column', label: '색 구분', optional: true },
    ],
  },
  box: {
    label: '상자그림',
    fields: [
      { key: 'table', type: 'table', label: '표' },
      { key: 'y', type: 'column', kinds: NUM, label: '값' },
      { key: 'x', type: 'column', label: '그룹', optional: true },
    ],
  },
  pie: {
    label: '원그래프',
    fields: [
      { key: 'table', type: 'table', label: '표' },
      { key: 'x', type: 'column', label: '분류' },
      { key: 'y', type: 'column', kinds: NUM, label: '값', optional: true },
      { key: 'agg', type: 'select', label: '요약', options: () => AGG_OPTIONS },
    ],
  },
  heatmap: {
    label: '상관 히트맵',
    fields: [
      { key: 'table', type: 'table', label: '표' },
      { key: 'columns', type: 'columns', kinds: NUM, label: '숫자 열', wide: true },
    ],
  },
};

/* ------------------------------------------------------- 분석 정의 */

const ANALYSIS_KINDS = {
  quality: {
    label: '데이터 품질 점검',
    standard: '[12데과02-02]',
    fields: [{ key: 'table', type: 'table', label: '표' }],
  },
  describe: {
    label: '기술통계 요약',
    standard: '[12데과02-01]',
    fields: [
      { key: 'table', type: 'table', label: '표' },
      { key: 'columns', type: 'columns', label: '열 (비우면 전체)', wide: true },
    ],
  },
  correlation: {
    label: '상관분석',
    standard: '[12데과02-03] · [12데과03-04]',
    fields: [
      { key: 'table', type: 'table', label: '표' },
      { key: 'columns', type: 'columns', kinds: NUM, label: '숫자 열', wide: true },
      { key: 'method', type: 'select', label: '방법', options: () => [['pearson', '피어슨'], ['spearman', '스피어만']] },
    ],
  },
  regression: {
    label: '회귀 분석 (통계 vs 기계학습)',
    standard: '[12데과03-02] · [12데과03-05]',
    fields: [
      { key: 'table', type: 'table', label: '표' },
      { key: 'y', type: 'column', kinds: NUM, label: '예측할 값 (종속변수)' },
      { key: 'x', type: 'columns', kinds: NUM, label: '설명 변수 (독립변수)', wide: true },
      {
        key: 'model', type: 'select', label: '기계학습 모델',
        options: () => [['linear', '선형 회귀'], ['tree', '결정트리'], ['forest', '랜덤 포레스트']],
      },
      { key: 'maxDepth', type: 'number', label: '트리 깊이', default: 4, min: 1, max: 12, when: (v) => v.model !== 'linear' },
      { key: 'testSize', type: 'number', label: '검증 비율', default: 0.3, min: 0.1, max: 0.5, step: 0.05 },
    ],
  },
  cluster: {
    label: '군집 분석 (k-평균)',
    standard: '[12데과03-03]',
    fields: [
      { key: 'table', type: 'table', label: '표' },
      { key: 'columns', type: 'columns', kinds: NUM, label: '기준 숫자 열', wide: true },
      { key: 'k', type: 'number', label: '군집 수 k', default: 3, min: 2, max: 10 },
      { key: 'scale', type: 'checkbox', label: '표준화 후 계산', default: true },
    ],
  },
  association: {
    label: '연관 분석 (장바구니)',
    standard: '[12데과03-04]',
    fields: [
      { key: 'table', type: 'table', label: '표' },
      {
        key: 'mode', type: 'select', label: '데이터 형태',
        options: () => [
          ['item_column', '한 칸에 여러 품목 (구분기호)'],
          ['id_item', '거래번호 + 품목 두 열'],
          ['onehot', '품목마다 열 (0/1)'],
        ],
      },
      { key: 'itemColumn', type: 'column', label: '품목 열', when: (v) => v.mode !== 'onehot' },
      { key: 'separator', type: 'text', label: '구분기호', default: ',', when: (v) => v.mode === 'item_column' },
      { key: 'idColumn', type: 'column', label: '거래번호 열', when: (v) => v.mode === 'id_item' },
      { key: 'columns', type: 'columns', label: '품목 열들', wide: true, when: (v) => v.mode === 'onehot' },
      { key: 'minSupport', type: 'number', label: '최소 지지도', default: 0.05, min: 0.001, max: 1, step: 0.01 },
      { key: 'minConfidence', type: 'number', label: '최소 신뢰도', default: 0.3, min: 0.01, max: 1, step: 0.05 },
    ],
  },
  classification: {
    label: '분류 (기계학습)',
    standard: '[12인기02-03] · [12인기02-04]',
    fields: [
      { key: 'table', type: 'table', label: '표' },
      { key: 'y', type: 'column', label: '예측할 범주' },
      { key: 'x', type: 'columns', kinds: NUM, label: '설명 변수', wide: true },
      {
        key: 'model', type: 'select', label: '모델',
        options: () => [['tree', '결정트리'], ['logistic', '로지스틱 회귀'], ['forest', '랜덤 포레스트']],
      },
      { key: 'maxDepth', type: 'number', label: '트리 깊이', default: 4, min: 1, max: 12, when: (v) => v.model === 'tree' },
      { key: 'testSize', type: 'number', label: '검증 비율', default: 0.3, min: 0.1, max: 0.5, step: 0.05 },
    ],
  },
};

/* ------------------------------------------------------- 사이드바 */

function renderSidebar() {
  const list = $('#table-list');
  list.innerHTML = '';
  if (!state.tables.length) {
    list.append(el('div', 'empty-note', '아직 데이터가 없습니다.'));
  }
  state.tables.forEach((table) => {
    const item = el('button', `table-item${table.name === state.activeTable ? ' active' : ''}`);
    item.type = 'button';
    const main = el('div', 'table-item-main');
    main.append(
      el('span', 'table-item-name', table.name),
      el('span', 'table-item-meta', `${numberFormat.format(table.rows)}행 · ${table.columns.length}열`)
    );
    item.append(main);
    if (!table.isSource) item.append(el('span', 'badge-derived', '파생'));
    if (table.isSource) {
      const remove = el('button', 'row-x');
      remove.type = 'button';
      remove.innerHTML = icon(ICONS.close);
      remove.title = '이 데이터 제거';
      remove.onclick = async (event) => {
        event.stopPropagation();
        const result = await run(kernel.removeTable(table.name), '데이터 제거');
        state.tables = result.tables;
        delete state.sources[table.name];
        state.steps = state.steps.filter((step) => !stepUsesTable(step, table.name));
        state.charts = state.charts.filter((chart) => chart.table !== table.name);
        state.analyses = state.analyses.filter((analysis) => analysis.table !== table.name);
        if (state.activeTable === table.name) state.activeTable = state.tables[0]?.name || null;
        await rebuildAll();
      };
      item.append(remove);
    }
    item.onclick = () => {
      state.activeTable = table.name;
      state.page = 0;
      renderSidebar();
      renderTable();
      renderInspector();
    };
    list.append(item);
  });

  const meta = tableMeta(state.activeTable);
  $('#column-panel-title').textContent = meta ? `${meta.name}의 열` : '열';
  $('#column-count').textContent = meta ? `${meta.columns.length}개` : '';
  const columns = $('#column-list');
  columns.innerHTML = '';
  if (!meta) return;
  meta.columns.forEach((column) => {
    const row = el('div', 'column-row');
    const tag = el('span', `kind-tag kind-${column.kind}`, kindLetter(column.kind));
    tag.title = kindName(column.kind);
    row.append(tag, el('span', 'column-name', column.name));
    const flags = el('div', 'column-flags');
    if (column.missing) flags.append(el('span', 'flag flag-missing', `결측 ${column.missing}`));
    if (column.outliers) flags.append(el('span', 'flag flag-outlier', `이상 ${column.outliers}`));
    row.append(flags);
    const more = el('button', 'column-menu-btn');
    more.type = 'button';
    more.innerHTML = icon(ICONS.more);
    more.onclick = () => columnMenu(more, meta.name, column);
    row.append(more);
    row.title = columnTooltip(column);
    columns.append(row);
  });
}

const kindLetter = (kind) => ({ number: '#', text: 'A', datetime: '⏱', bool: '✓' }[kind] || '?');
const kindName = (kind) => ({ number: '숫자', text: '문자', datetime: '날짜', bool: '참/거짓' }[kind] || kind);

function columnTooltip(column) {
  const parts = [`${column.name} · ${kindName(column.kind)}`, `결측 ${column.missing}개`, `고유값 ${column.unique}개`];
  if (column.kind === 'number' && column.mean !== undefined) {
    parts.push(`평균 ${fmt(column.mean)} · 최소 ${fmt(column.min)} · 최대 ${fmt(column.max)}`);
  }
  if (column.top) parts.push(column.top.map((item) => `${item.value}(${item.count})`).join(', '));
  return parts.join('\n');
}

function columnMenu(anchor, table, column) {
  const items = [];
  if (column.kind === 'number') {
    items.push({ label: '히스토그램 그리기', run: () => addChart('histogram', { table, x: column.name }) });
    items.push({ label: '상자그림 그리기', run: () => addChart('box', { table, y: column.name }) });
  } else {
    items.push({ label: '막대그래프 그리기', run: () => addChart('bar', { table, x: column.name, y: '', agg: 'count' }) });
    items.push({ label: '원그래프 그리기', run: () => addChart('pie', { table, x: column.name, y: '', agg: 'count' }) });
  }
  items.push('-');
  items.push({ label: '이름 변경', run: () => openStepDialog('rename_column', { table, from: column.name, to: column.name }) });
  items.push({ label: '자료형 변경', run: () => openStepDialog('change_type', { table, column: column.name }) });
  if (column.kind === 'number') {
    items.push({ label: '정규화', run: () => openStepDialog('normalize', { table, columns: [column.name] }) });
    items.push({ label: '이상치 처리', run: () => openStepDialog('outlier', { table, columns: [column.name] }) });
    items.push({ label: '구간 나누기', run: () => openStepDialog('bin', { table, column: column.name }) });
  }
  if (column.missing) {
    items.push({ label: '결측치 처리', run: () => openStepDialog('missing', { table, columns: [column.name] }) });
  }
  items.push('-');
  items.push({
    label: '열 삭제', danger: true,
    run: () => addStep({ op: 'drop_columns', table, columns: [column.name] }),
  });
  openMenu(anchor, items);
}

/* ------------------------------------------------------- 표 화면 */

async function renderTable() {
  const scroll = $('#table-scroll');
  const foot = $('#table-foot');
  if (state.selTable !== state.activeTable) {
    state.selCols = [];
    state.selRows = [];
    state.selTable = state.activeTable;
  }
  if (!state.activeTable) {
    foot.hidden = true;
    renderSelectBar();
    if (!$('#table-empty')) {
      scroll.innerHTML = '';
      scroll.append(buildEmpty());
    }
    return;
  }
  const data = await run(
    kernel.preview(state.activeTable, state.page * PAGE_SIZE, PAGE_SIZE),
    '표 읽기'
  );
  const table = el('table', 'grid');
  const head = el('thead');
  const headRow = el('tr');
  const corner = el('th', 'row-index');
  const pagePositions = data.rows.map((_, i) => data.offset + i);
  const allBox = selectBox(
    pagePositions.length > 0 && pagePositions.every((i) => state.selRows.includes(i)),
    '이 쪽의 행을 모두 선택',
    async (checked) => {
      state.selRows = checked
        ? [...new Set([...state.selRows, ...pagePositions])]
        : state.selRows.filter((i) => !pagePositions.includes(i));
      await afterSelect();
    }
  );
  const cornerInner = el('div', 'row-index-inner');
  cornerInner.append(allBox);
  corner.append(cornerInner);
  headRow.append(corner);
  data.columns.forEach((name, index) => {
    const cell = el('th');
    const picked = state.selCols.includes(name);
    if (picked) cell.classList.add('col-selected');
    const inner = el('div', 'th-inner');
    const box = selectBox(picked, '이 열을 선택', async (checked) => {
      state.selCols = checked ? [...state.selCols, name] : state.selCols.filter((c) => c !== name);
      await afterSelect();
    });
    const tag = el('span', `kind-tag kind-${data.kinds[index]}`, kindLetter(data.kinds[index]));
    const label = el('span', 'th-label', name);
    const mark = sortMark(state.activeTable, name);
    inner.append(box, tag, label);
    if (mark) inner.append(el('span', 'sort-mark', mark));
    cell.append(inner);
    cell.classList.add('sortable');
    cell.title = '누르면 정렬 · 두 번 누르면 이름 고치기';
    cell.onclick = () => cycleSort(state.activeTable, name);
    cell.ondblclick = (event) => {
      event.preventDefault();
      startRename(cell, label, name);
    };
    headRow.append(cell);
  });
  head.append(headRow);
  table.append(head);

  const body = el('tbody');
  data.rows.forEach((row, rowIndex) => {
    const position = data.offset + rowIndex;
    const picked = state.selRows.includes(position);
    const tr = el('tr');
    if (picked) tr.classList.add('row-selected');
    const indexCell = el('td', 'row-index');
    const indexInner = el('div', 'row-index-inner');
    indexInner.append(
      selectBox(picked, '이 행을 선택', async (checked) => {
        state.selRows = checked
          ? [...state.selRows, position]
          : state.selRows.filter((i) => i !== position);
        await afterSelect();
      }),
      el('span', 'row-no', String(position + 1))
    );
    indexCell.append(indexInner);
    tr.append(indexCell);
    row.forEach((value, index) => {
      const isNumber = data.kinds[index] === 'number';
      const empty = value === null || value === undefined || value === '';
      const cell = tdCell(
        empty ? '—' : isNumber ? fmt(value) : String(value),
        `${isNumber ? 'num' : ''}${empty ? ' na' : ''}`.trim()
      );
      if (state.selCols.includes(data.columns[index])) cell.classList.add('col-selected');
      tr.append(cell);
    });
    body.append(tr);
  });
  table.append(body);
  scroll.innerHTML = '';
  scroll.append(table);

  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  foot.hidden = pages <= 1;
  $('#page-label').textContent = `${state.page + 1} / ${pages} 쪽 · 전체 ${numberFormat.format(data.total)}행`;
  $('#page-prev').disabled = state.page === 0;
  $('#page-next').disabled = state.page >= pages - 1;
  renderSelectBar();
}

function thCell(text, className) {
  const cell = el('th', className, text);
  return cell;
}
function tdCell(text, className) {
  return el('td', className, text);
}

/* ------------------------------------ 표에서 바로 고르고, 지우고, 정렬하기 */

function selectBox(checked, title, onToggle) {
  const box = el('input');
  box.type = 'checkbox';
  box.className = 'sel-box';
  box.checked = checked;
  box.title = title;
  // 머리글은 누르면 정렬이므로, 선택 상자 클릭이 정렬까지 번지지 않게 막는다.
  box.onclick = (event) => event.stopPropagation();
  box.onchange = () => {
    state.selTable = state.activeTable;
    onToggle(box.checked);
  };
  return box;
}

/* 머리글에서 바로 이름 고치기. 빈 이름이나 그대로면 아무 일도 없다. */
function startRename(cell, label, name) {
  if (cell.querySelector('.rename-input')) return;
  const input = el('input', 'rename-input');
  input.value = name;
  label.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const next = input.value.trim();
    if (!commit || !next || next === name) {
      await renderTable();
      return;
    }
    state.steps.push({ id: uid(), op: 'rename_column', table: state.activeTable, from: name, to: next });
    state.redo = [];
    await rebuildAll();
  };
  input.onclick = (event) => event.stopPropagation();
  input.ondblclick = (event) => event.stopPropagation();
  input.onkeydown = (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') finish(true);
    if (event.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
}

async function afterSelect() {
  renderSelectBar();
  await renderTable();
}

function sortStepFor(name) {
  return state.steps.find((step) => step.op === 'sort' && step.table === name) || null;
}

function sortMark(name, column) {
  const step = sortStepFor(name);
  if (!step || (step.by || [])[0] !== column) return '';
  return step.ascending ? '↑' : '↓';
}

/* 머리글을 누를 때마다 오름차순 → 내림차순 → 해제로 돈다. */
async function cycleSort(name, column) {
  const current = sortStepFor(name);
  const same = current && (current.by || [])[0] === column;
  const next = !same ? 'asc' : current.ascending ? 'desc' : null;
  state.steps = state.steps.filter((step) => step !== current);
  if (next) {
    state.steps.push({ id: uid(), op: 'sort', table: name, by: [column], ascending: next === 'asc' });
  }
  state.redo = [];
  await rebuildAll();
}

function renderSelectBar() {
  const info = $('#select-info');
  const button = $('#btn-delete-selection');
  if (!info || !button) return;
  const cols = state.selCols.length;
  const rows = state.selRows.length;
  const parts = [];
  if (cols) parts.push(`열 ${cols}개`);
  if (rows) parts.push(`행 ${rows}개`);
  info.hidden = !parts.length;
  info.textContent = parts.length ? `${parts.join(' · ')} 선택됨` : '';
  button.disabled = !parts.length;
}

async function deleteSelection() {
  const name = state.activeTable;
  if (!name) return;
  const columns = [...state.selCols];
  // 행 위치는 지금 보고 있는 순서 기준이라, 열보다 먼저 지워야 어긋나지 않는다.
  const rows = [...state.selRows];
  state.selCols = [];
  state.selRows = [];
  if (rows.length) state.steps.push({ id: uid(), op: 'drop_rows', table: name, rows });
  if (columns.length) state.steps.push({ id: uid(), op: 'drop_columns', table: name, columns });
  state.redo = [];
  await rebuildAll();
}

async function undoStep() {
  if (!state.steps.length) return;
  state.redo.push(state.steps.pop());
  state.selCols = [];
  state.selRows = [];
  await rebuildAll();
}

async function redoStep() {
  if (!state.redo.length) return;
  state.steps.push(state.redo.pop());
  await rebuildAll();
}

async function resetSteps() {
  if (!state.steps.length) return;
  const ok = await openModal({
    title: '데이터 초기화',
    okLabel: '초기화',
    build: (body) => {
      body.append(el('p', null, '전처리한 내용을 모두 되돌려 올린 그대로의 상태로 돌아갑니다.'));
      body.append(el('p', 'hint', '올린 파일과 그래프·분석은 그대로 남습니다.'));
    },
  });
  if (!ok) return;
  state.steps = [];
  state.redo = [];
  state.selCols = [];
  state.selRows = [];
  await rebuildAll();
}

function buildEmpty() {
  const wrap = el('div', 'empty');
  wrap.id = 'table-empty';
  wrap.innerHTML = `
    <div class="empty-art">${icon('<path d="M3 5h18v14H3z"/><path d="M3 9h18M9 9v10M15 9v10"/>')}</div>
    <h2>CSV 파일을 올려 시작하세요</h2>
    <p>여러 개를 한 번에 올려도 됩니다. 파일은 이 브라우저 밖으로 나가지 않습니다.</p>`;
  const add = el('button', 'btn btn-primary', '데이터 추가');
  add.onclick = () => $('#file-input').click();
  const sample = el('button', 'ghost-btn', '가상 데이터로 둘러보기');
  sample.onclick = loadSamples;
  wrap.append(add, sample);
  return wrap;
}

/* ------------------------------------------------------- 검사 패널 */

function renderInspector() {
  const title = { table: '전처리', charts: '그래프 추가', analysis: '분석 추가' }[state.view];
  $('#inspector-title').textContent = title;
  const body = $('#inspector-body');
  body.innerHTML = '';

  if (state.view === 'charts') {
    body.append(el('div', 'section-label', '그래프 종류'));
    const grid = el('div', 'op-grid');
    Object.entries(CHART_KINDS).forEach(([kind, schema]) => {
      const button = el('button', 'op-btn');
      button.type = 'button';
      button.textContent = schema.label;
      button.onclick = () => addChart(kind, {});
      grid.append(button);
    });
    body.append(grid);
    body.append(
      el('div', 'callout callout-info',
        '그래프는 모두 상호작용형입니다. 끌어서 확대하고, 범례를 눌러 계열을 감추고, 오른쪽 위 카메라로 PNG를 저장할 수 있습니다.')
    );
    return;
  }

  if (state.view === 'analysis') {
    body.append(el('div', 'section-label', '분석 종류'));
    Object.entries(ANALYSIS_KINDS).forEach(([kind, schema]) => {
      const button = el('button', 'op-btn');
      button.type = 'button';
      button.style.width = '100%';
      button.append(el('span', null, schema.label));
      if (schema.standard) {
        const tag = el('span', 'hint', schema.standard);
        tag.style.marginLeft = 'auto';
        button.append(tag);
      }
      button.onclick = () => addAnalysis(kind, {});
      body.append(button);
    });
    return;
  }

  // 전처리
  const tools = el('div', 'undo-row');
  const mk = (label, disabled, onClick, extra) => {
    const button = el('button', extra || null);
    button.type = 'button';
    button.textContent = label;
    button.disabled = disabled;
    button.onclick = onClick;
    return button;
  };
  tools.append(
    mk('되돌리기', !state.steps.length, undoStep),
    mk('다시 하기', !state.redo.length, redoStep),
    mk('데이터 초기화', !state.steps.length, resetSteps, 'danger-btn')
  );
  body.append(tools);
  body.append(el('div', 'hint undo-hint',
    (state.steps.length ? `전처리 ${state.steps.length}번 적용됨` : '올린 그대로의 상태입니다.')
    + (state.problems.length ? ` · ${state.problems.length}개 실패` : '')));

  const groups = {};
  Object.entries(STEP_SCHEMAS).forEach(([op, schema]) => {
    if (schema.hidden) return;
    (groups[schema.group] ||= []).push([op, schema]);
  });
  Object.entries(groups).forEach(([group, entries]) => {
    body.append(el('div', 'section-label', group));
    const grid = el('div', 'op-grid');
    entries.forEach(([op, schema]) => {
      if (schema.hidden) return;
      const button = el('button', 'op-btn');
      button.type = 'button';
      button.textContent = schema.label;
      button.onclick = () => openStepDialog(op, {});
      grid.append(button);
    });
    body.append(grid);
  });

}

function toolButton(path, title, run) {
  const button = el('button');
  button.type = 'button';
  button.title = title;
  button.innerHTML = icon(path);
  button.onclick = run;
  return button;
}

/* ------------------------------------------------------- 단계 다루기 */

function stepUsesTable(step, name) {
  return [step.table, step.left, step.right].includes(name) || (step.tables || []).includes(name);
}

function openStepDialog(op, preset, editId) {
  const schema = STEP_SCHEMAS[op];
  const values = { table: state.activeTable, ...JSON.parse(JSON.stringify(preset || {})) };
  openModal({
    title: schema.label,
    okLabel: editId ? '수정' : '추가',
    build: (body) => {
      const form = el('div');
      form.style.display = 'flex';
      form.style.flexWrap = 'wrap';
      form.style.gap = '.7rem';
      buildStepFields(form, op, values, () => {}, values.table ? ['table'] : []);
      body.append(form);
    },
  }).then(async (accepted) => {
    if (!accepted) return;
    const prepared = schema.prepare ? schema.prepare(values) : values;
    if (editId) {
      const index = state.steps.findIndex((step) => step.id === editId);
      state.steps[index] = { ...prepared, id: editId, op };
    } else {
      state.steps.push({ ...prepared, id: uid(), op });
    }
    await rebuildAll();
  });
}

async function addStep(step) {
  state.steps.push({ ...step, id: uid() });
  await rebuildAll();
}

async function rebuildAll() {
  const result = await run(kernel.rebuild(state.steps), '전처리 적용');
  state.tables = result.tables;
  state.problems = result.problems;
  if (!tableMeta(state.activeTable)) state.activeTable = state.tables[0]?.name || null;
  $('#step-summary').textContent = state.steps.length ? `전처리 ${state.steps.length}단계` : '';
  if (result.problems.length) {
    toast(`${result.problems.length}개 단계가 실패했습니다. 왼쪽 목록에서 확인하세요.`, 'error');
  }
  renderSidebar();
  renderInspector();
  await renderTable();
  state.charts.forEach(refreshChart);
  state.analyses.forEach(refreshAnalysis);
  touch();
}

/* ------------------------------------------------------- 그래프 카드 */

/* 처음 열었을 때 바로 말이 되는 그림이 나오도록 축을 골라 준다. */
function chartDefaults(kind, table) {
  const meta = tableMeta(table);
  if (!meta) return {};
  const numbers = meta.columns.filter((column) => column.kind === 'number');
  const groups = meta.columns
    .filter((column) => column.kind !== 'number' && column.unique >= 2 && column.unique <= 20)
    .sort((a, b) => a.unique - b.unique);
  const time = meta.columns.find((column) => column.kind === 'datetime');
  switch (kind) {
    case 'bar':
    case 'pie':
      return { x: (groups[0] || meta.columns[0])?.name, y: '', agg: 'count' };
    case 'line':
      return { x: (time || groups[0] || meta.columns[0])?.name, y: numbers[0]?.name, agg: 'mean' };
    case 'scatter':
      return { x: numbers[0]?.name, y: (numbers[1] || numbers[0])?.name };
    case 'histogram':
      return { x: numbers[0]?.name };
    case 'box':
      return { y: numbers[0]?.name, x: groups[0]?.name || '' };
    case 'heatmap':
      return { columns: numbers.slice(0, 8).map((column) => column.name) };
    default:
      return {};
  }
}

function addChart(kind, preset) {
  const table = preset.table || state.activeTable;
  const chart = {
    id: uid(), kind, table, editing: true,
    ...chartDefaults(kind, table), ...preset,
  };
  state.charts.push(chart);
  touch();
  switchView('charts');
  renderCharts();
  refreshChart(chart);
}

function renderCharts() {
  const grid = $('#chart-grid');
  grid.innerHTML = '';
  if (!state.charts.length) {
    const empty = el('div', 'empty');
    empty.innerHTML = `
      <div class="empty-art">${icon('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>')}</div>
      <h2>오른쪽에서 그래프를 골라 추가하세요</h2>
      <p>열 목록의 ⋯ 메뉴에서도 바로 그릴 수 있습니다.</p>`;
    empty.style.gridColumn = '1 / -1';
    grid.append(empty);
    return;
  }
  state.charts.forEach((chart) => grid.append(buildChartCard(chart)));
  state.charts.forEach(refreshChart);
}

function buildChartCard(chart) {
  const schema = CHART_KINDS[chart.kind];
  const card = el('div', `card${chart.editing ? ' editing' : ''}`);
  card.dataset.id = chart.id;

  const head = el('div', 'card-head');
  head.append(el('span', 'card-title', chartTitle(chart)));
  const toggle = el('button', 'btn btn-icon');
  toggle.type = 'button';
  toggle.title = '설정';
  toggle.innerHTML = icon(ICONS.gear);
  toggle.onclick = () => {
    chart.editing = !chart.editing;
    card.classList.toggle('editing', chart.editing);
  };
  const copy = el('button', 'btn btn-icon');
  copy.type = 'button';
  copy.title = '복제';
  copy.innerHTML = icon(ICONS.copy);
  copy.onclick = () => {
    const clone = { ...chart, id: uid() };
    state.charts.push(clone);
    renderCharts();
  };
  const remove = el('button', 'btn btn-icon btn-danger');
  remove.type = 'button';
  remove.title = '삭제';
  remove.innerHTML = icon(ICONS.trash);
  remove.onclick = () => {
    state.charts = state.charts.filter((item) => item.id !== chart.id);
    touch();
    renderCharts();
  };
  head.append(toggle, copy, remove);
  card.append(head);

  const settings = el('div', 'card-settings');
  mountSettings(settings, schema.fields, chart, chartDefaults, () => {
    head.querySelector('.card-title').textContent = chartTitle(chart);
    scheduleChart(chart);
  });
  card.append(settings);

  const body = el('div', 'card-body');
  const plot = el('div', 'plot');
  plot.id = `plot-${chart.id}`;
  body.append(plot);
  card.append(body);
  card.append(el('div', 'card-note'));
  return card;
}

function chartTitle(chart) {
  const schema = CHART_KINDS[chart.kind];
  const parts = [];
  if (chart.y) parts.push(chart.y);
  if (chart.x) parts.push(chart.x);
  if (chart.columns?.length) parts.push(`${chart.columns.length}개 열`);
  return `${schema.label}${parts.length ? ' · ' + parts.join(' ~ ') : ''}`;
}

const chartTimers = new Map();
function scheduleChart(chart) {
  touch();
  clearTimeout(chartTimers.get(chart.id));
  chartTimers.set(chart.id, setTimeout(() => refreshChart(chart), 400));
}

async function refreshChart(chart) {
  const plot = document.getElementById(`plot-${chart.id}`);
  if (!plot) return;
  const card = plot.closest('.card');
  const note = card.querySelector('.card-note');
  const spec = { ...chart };
  delete spec.editing;
  if (!spec.table) return;
  if (spec.y === '') delete spec.y;
  if (spec.color === '') delete spec.color;
  if (spec.size === '') delete spec.size;
  if (!spec.y && ['bar', 'line', 'pie'].includes(spec.kind)) spec.agg = 'count';
  try {
    setBusy(1);
    const data = await kernel.chartData(spec);
    const figure = C.buildFigure(data, spec);
    await C.draw(plot, figure);
    note.textContent = '';
    if (data.trend) {
      note.textContent = `추세선: y = ${fmt(data.trend.slope)}x + ${fmt(data.trend.intercept)} · 상관계수 r = ${fmt(data.trend.r, 3)} · R² = ${fmt(data.trend.r2, 3)}`;
    } else if (spec.kind === 'scatter' && data.series.length > 3) {
      note.textContent = '색 구분이 4개를 넘으면 점 색을 구별하기 어렵습니다. 그룹을 줄이거나 그래프를 나눠 보세요.';
    }
  } catch (error) {
    plot.innerHTML = `<div class="callout callout-error" style="margin:1rem">${icon('<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16v.01"/>')}<span>${error.message}</span></div>`;
  } finally {
    setBusy(-1);
  }
}

/* ------------------------------------------------------- 분석 카드 */

function analysisDefaults(kind, table) {
  const meta = tableMeta(table);
  if (!meta) return {};
  const numbers = meta.columns.filter((column) => column.kind === 'number').map((column) => column.name);
  const groups = meta.columns
    .filter((column) => column.kind !== 'number' && column.unique >= 2 && column.unique <= 20)
    .sort((a, b) => a.unique - b.unique)
    .map((column) => column.name);
  switch (kind) {
    case 'correlation':
      return { columns: numbers.slice(0, 8) };
    case 'cluster':
      return { columns: numbers.slice(0, 3) };
    case 'regression':
      return { y: numbers[0], x: numbers.slice(1, 3) };
    case 'classification':
      return { y: groups[0], x: numbers.slice(0, 4) };
    case 'association': {
      const texts = meta.columns.filter((column) => column.kind !== 'number');
      // 쉼표로 여러 품목이 들어 있는 열을 먼저 찾는다.
      const packed = texts.find((column) =>
        (column.top || []).some((item) => String(item.value).includes(','))
      );
      const wide = [...texts].sort((a, b) => b.unique - a.unique)[0];
      const item = packed || texts.find((column) => column !== wide) || wide;
      return {
        mode: 'item_column',
        itemColumn: item?.name,
        idColumn: (wide && wide !== item ? wide : texts[0])?.name,
        separator: ',',
      };
    }
    default:
      return {};
  }
}

function addAnalysis(kind, preset) {
  const table = preset.table || state.activeTable;
  const analysis = {
    id: uid(), kind, table, editing: true,
    ...analysisDefaults(kind, table), ...preset,
  };
  state.analyses.push(analysis);
  touch();
  switchView('analysis');
  renderAnalyses();
}

function renderAnalyses() {
  const grid = $('#analysis-grid');
  grid.innerHTML = '';
  if (!state.analyses.length) {
    const empty = el('div', 'empty');
    empty.innerHTML = `
      <div class="empty-art">${icon('<path d="M4 19h16M7 15l3-5 3 3 4-7"/>')}</div>
      <h2>오른쪽에서 분석을 골라 추가하세요</h2>
      <p>데이터 과학 과목의 성취기준에 맞춘 분석이 준비돼 있습니다.</p>`;
    empty.style.gridColumn = '1 / -1';
    grid.append(empty);
    return;
  }
  state.analyses.forEach((analysis) => grid.append(buildAnalysisCard(analysis)));
  state.analyses.forEach(refreshAnalysis);
}

function buildAnalysisCard(analysis) {
  const schema = ANALYSIS_KINDS[analysis.kind];
  const card = el('div', `card${analysis.editing ? ' editing' : ''}`);
  card.dataset.id = analysis.id;
  if (['regression', 'cluster', 'association', 'classification'].includes(analysis.kind)) {
    card.style.gridColumn = '1 / -1';
  }

  const head = el('div', 'card-head');
  const title = el('span', 'card-title');
  title.append(el('span', null, schema.label));
  if (schema.standard) title.append(el('span', 'card-sub', ` ${schema.standard}`));
  head.append(title);
  const toggle = el('button', 'btn btn-icon');
  toggle.type = 'button';
  toggle.title = '설정';
  toggle.innerHTML = icon(ICONS.gear);
  toggle.onclick = () => {
    analysis.editing = !analysis.editing;
    card.classList.toggle('editing', analysis.editing);
  };
  const remove = el('button', 'btn btn-icon btn-danger');
  remove.type = 'button';
  remove.title = '삭제';
  remove.innerHTML = icon(ICONS.trash);
  remove.onclick = () => {
    state.analyses = state.analyses.filter((item) => item.id !== analysis.id);
    touch();
    renderAnalyses();
  };
  head.append(toggle, remove);
  card.append(head);

  const settings = el('div', 'card-settings');
  mountSettings(settings, schema.fields, analysis, analysisDefaults, () => scheduleAnalysis(analysis));
  card.append(settings);

  const body = el('div', 'card-body');
  body.id = `result-${analysis.id}`;
  card.append(body);
  return card;
}

const analysisTimers = new Map();
function scheduleAnalysis(analysis) {
  touch();
  clearTimeout(analysisTimers.get(analysis.id));
  analysisTimers.set(analysis.id, setTimeout(() => refreshAnalysis(analysis), 500));
}

async function refreshAnalysis(analysis) {
  const body = document.getElementById(`result-${analysis.id}`);
  if (!body) return;
  const spec = { ...analysis };
  delete spec.editing;
  delete spec.result;
  if (!spec.table) return;
  body.innerHTML = '<div class="hint" style="padding:1rem">계산 중…</div>';
  try {
    setBusy(1);
    const result = await kernel.analyze(spec);
    analysis.result = result;
    body.innerHTML = '';
    RENDER_ANALYSIS[result.type](body, result, analysis);
  } catch (error) {
    body.innerHTML = `<div class="callout callout-error" style="margin:.6rem">${icon('<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16v.01"/>')}<span>${error.message}</span></div>`;
  } finally {
    setBusy(-1);
  }
}

/* ------------------------------------------------------- 분석 결과 그리기 */

function statRow(items) {
  const row = el('div', 'stat-row');
  items.forEach(([label, value, note]) => {
    const stat = el('div', 'stat');
    stat.append(el('div', 'stat-label', label), el('div', 'stat-value', value));
    if (note) stat.append(el('div', 'stat-note', note));
    row.append(stat);
  });
  return row;
}

function resultTable(headers, rows) {
  const wrap = el('div');
  wrap.style.overflowX = 'auto';
  wrap.style.padding = '0 .75rem .75rem';
  const table = el('table', 'result-table');
  const head = el('thead');
  const headRow = el('tr');
  headers.forEach((header) => headRow.append(el('th', null, header)));
  head.append(headRow);
  table.append(head);
  const body = el('tbody');
  rows.forEach((row) => {
    const tr = el('tr');
    row.forEach((cell, index) => {
      if (cell && cell.node) {
        const td = el('td', cell.className);
        td.append(cell.node);
        tr.append(td);
      } else {
        tr.append(el('td', index > 0 ? 'num' : '', cell === null || cell === undefined ? '—' : String(cell)));
      }
    });
    body.append(tr);
  });
  table.append(body);
  wrap.append(table);
  return wrap;
}

function plotBlock(figure, tall) {
  const holder = el('div', `plot${tall ? ' plot-tall' : ''}`);
  setTimeout(() => C.draw(holder, figure), 0);
  return holder;
}

function subhead(text) {
  return el('div', 'subhead', text);
}

const RENDER_ANALYSIS = {
  quality(body, result) {
    body.append(statRow([
      ['전체 행', numberFormat.format(result.total)],
      ['빈 칸', numberFormat.format(result.missingCells)],
      ['중복 행', numberFormat.format(result.duplicated)],
      ['열', String(result.rows.length)],
    ]));
    body.append(resultTable(
      ['열', '자료형', '결측', '결측 비율', '고유값', 'IQR 이상치'],
      result.rows.map((row) => [
        row.column, kindName(row.kind), row.missing, pct(row.missingRatio), row.unique,
        row.kind === 'number' ? row.outliers : '—',
      ])
    ));
    body.append(el('div', 'callout callout-info',
      '결측 비율이 높은 열, 이상치가 많은 열을 먼저 살펴보세요. 왼쪽 전처리에서 바로 처리할 수 있습니다.'));
  },

  describe(body, result) {
    body.append(resultTable(
      ['열', '자료형', '결측', '고유값', '평균', '중앙값', '표준편차', '최소', '최대'],
      result.rows.map((row) => [
        row.name, kindName(row.kind), row.missing, row.unique,
        row.mean !== undefined ? fmt(row.mean) : '—',
        row.median !== undefined ? fmt(row.median) : '—',
        row.std !== undefined ? fmt(row.std) : '—',
        row.min !== undefined ? fmt(row.min) : '—',
        row.max !== undefined ? fmt(row.max) : '—',
      ])
    ));
  },

  correlation(body, result) {
    body.append(plotBlock(C.correlationFigure(result), true));
    body.append(subhead('상관이 뚜렷한 조합'));
    body.append(resultTable(
      ['열 A', '열 B', '상관계수 r', '해석'],
      result.pairs.slice(0, 10).map((pair) => [
        pair.a, pair.b, fmt(pair.r, 3), interpretR(pair.r),
      ])
    ));
    body.append(el('div', 'callout callout-warn',
      '상관관계가 크다고 해서 한쪽이 다른 쪽의 원인이라는 뜻은 아닙니다.'));
  },

  regression(body, result, analysis) {
    const stat = result.statistical;
    const machine = result.machine;
    body.append(statRow([
      ['분석에 쓴 행', numberFormat.format(result.rows)],
      ['R² (통계 회귀)', fmt(stat.r2, 3), '설명력'],
      ['R² (기계학습 검증)', fmt(machine.testR2, 3), '처음 보는 데이터'],
      ['RMSE (검증)', fmt(machine.testRmse), '평균적인 오차'],
    ]));

    const compare = el('div', 'compare');
    const left = el('div');
    left.append(el('h4', null, stat.name));
    [['R²', fmt(stat.r2, 4)], ['수정된 R²', fmt(stat.adjR2, 4)], ['F 통계량', fmt(stat.fStat, 2)],
     ['F의 p값', fmt(stat.fPvalue, 5)], ['RMSE(전체)', fmt(stat.rmse)]]
      .forEach(([key, value]) => {
        const row = el('div', 'kv');
        row.append(el('span', null, key), el('span', null, value));
        left.append(row);
      });
    const right = el('div');
    right.append(el('h4', null, machine.name));
    [['학습 R²', fmt(machine.trainR2, 4)], ['검증 R²', fmt(machine.testR2, 4)],
     ['학습 RMSE', fmt(machine.trainRmse)], ['검증 RMSE', fmt(machine.testRmse)],
     ['학습/검증 행 수', `${machine.trainSize} / ${machine.testSize}`]]
      .forEach(([key, value]) => {
        const row = el('div', 'kv');
        row.append(el('span', null, key), el('span', null, value));
        right.append(row);
      });
    compare.append(left, right);
    body.append(compare);

    const gap = machine.trainR2 - machine.testR2;
    if (gap > 0.25) {
      body.append(el('div', 'callout callout-warn',
        `학습 데이터에서는 잘 맞는데 검증 데이터에서 크게 떨어집니다(차이 ${fmt(gap, 3)}). 과적합을 의심해 보세요.`));
    }

    body.append(subhead('회귀식'));
    const equation = el('div', 'card-note');
    equation.style.fontFamily = 'ui-monospace, Menlo, Consolas, monospace';
    equation.textContent = stat.equation;
    body.append(equation);

    body.append(subhead('계수와 통계적 유의성'));
    body.append(resultTable(
      ['항', '계수', '표준오차', 't', 'p값', '유의성', '95% 신뢰구간'],
      stat.coefficients.map((item) => [
        item.name, fmt(item.coef), fmt(item.stderr), fmt(item.t, 3), fmt(item.p, 5),
        { node: significance(item.p), className: '' },
        `${fmt(item.low)} ~ ${fmt(item.high)}`,
      ])
    ));

    if (result.simple) {
      body.append(subhead('회귀선'));
      body.append(plotBlock(C.simpleRegressionFigure(result)));
    }
    body.append(subhead('검증 데이터: 실제값과 예측값'));
    body.append(plotBlock(C.actualVsPredicted(result)));
    body.append(subhead('잔차 그림 — 점이 0선 주변에 고르게 흩어져야 좋은 모형입니다'));
    body.append(plotBlock(C.residualFigure(result)));
    if (machine.importance) {
      body.append(subhead(analysis.model === 'linear' ? '변수별 계수' : '변수 중요도'));
      body.append(plotBlock(C.importanceFigure(machine.importance, analysis.model === 'linear' ? '계수' : '중요도')));
    }
  },

  cluster(body, result, analysis) {
    body.append(statRow([
      ['군집 수 k', String(result.k)],
      ['분석에 쓴 행', numberFormat.format(result.rows)],
      ['실루엣 점수', fmt(result.silhouette, 3), '1에 가까울수록 뚜렷'],
      ['군집 내 거리 합', fmt(result.inertia, 1)],
    ]));
    body.append(subhead(`군집 흩어보기 (${result.axisNames.join(' / ')})`));
    body.append(plotBlock(C.clusterFigure(result), true));
    body.append(subhead('군집의 중심값'));
    body.append(resultTable(
      ['군집', '크기', ...result.columns],
      result.centers.map((center, index) => [
        center.name, result.sizes[index].count,
        ...result.columns.map((column) => fmt(center[column])),
      ])
    ));
    const half = el('div', 'compare');
    const a = el('div');
    a.append(el('h4', null, '엘보우: 꺾이는 지점이 적당한 k'));
    a.append(plotBlock(C.elbowFigure(result)));
    const b = el('div');
    b.append(el('h4', null, '실루엣: 높을수록 뚜렷한 군집'));
    b.append(plotBlock(C.silhouetteFigure(result)));
    half.append(a, b);
    body.append(half);
    const addButton = el('button', 'btn', '이 군집 번호를 표에 열로 추가');
    addButton.style.margin = '.25rem .75rem .75rem';
    addButton.onclick = () => openStepDialog('kmeans_label', {
      table: analysis.table,
      columns: result.columns,
      k: result.k,
      name: '군집',
    });
    body.append(addButton);
  },

  association(body, result) {
    body.append(statRow([
      ['장바구니 수', numberFormat.format(result.transactions)],
      ['찾은 규칙', String(result.rules.length)],
      ['최소 지지도', fmt(result.minSupport, 3)],
      ['최소 신뢰도', fmt(result.minConfidence, 3)],
    ]));
    if (!result.rules.length) {
      body.append(el('div', 'callout callout-warn',
        '조건을 만족하는 규칙이 없습니다. 최소 지지도나 신뢰도를 낮춰 보세요.'));
    } else {
      body.append(subhead('연관 규칙'));
      body.append(resultTable(
        ['이것을 샀다면', '이것도 산다', '지지도', '신뢰도', '향상도', '건수'],
        result.rules.slice(0, 25).map((rule) => [
          rule.if, rule.then, fmt(rule.support, 3), fmt(rule.confidence, 3), fmt(rule.lift, 3), rule.count,
        ])
      ));
      body.append(subhead('규칙 흩어보기 — 오른쪽 위, 색이 진할수록 좋은 규칙'));
      body.append(plotBlock(C.rulesFigure(result.rules)));
      body.append(el('div', 'callout callout-info',
        '향상도가 1보다 크면 두 품목이 함께 팔릴 가능성이 우연보다 높다는 뜻입니다.'));
    }
    body.append(subhead('자주 나온 조합'));
    body.append(resultTable(
      ['조합', '지지도', '건수'],
      result.frequent.slice(0, 15).map((item) => [item.items, fmt(item.support, 3), item.count])
    ));
  },

  classification(body, result) {
    body.append(statRow([
      ['모델', result.model],
      ['정확도', pct(result.accuracy)],
      ['F1 (거시평균)', fmt(result.f1, 3)],
      ['학습/검증', `${result.trainSize} / ${result.testSize}`],
    ]));
    body.append(subhead('혼동 행렬 — 대각선이 맞힌 개수'));
    body.append(plotBlock(C.confusionFigure(result)));
    if (result.importance) {
      body.append(subhead('변수 중요도'));
      body.append(plotBlock(C.importanceFigure(result.importance, '중요도')));
    }
  },
};

function significance(p) {
  const span = el('span', p < 0.05 ? 'sig' : 'sig sig-no', p < 0.001 ? '***' : p < 0.01 ? '**' : p < 0.05 ? '*' : 'n.s.');
  span.title = p < 0.05 ? '통계적으로 유의함 (p < 0.05)' : '유의하다고 보기 어려움';
  return span;
}

function interpretR(r) {
  const size = Math.abs(r);
  const direction = r > 0 ? '양의' : '음의';
  if (size >= 0.7) return `강한 ${direction} 상관`;
  if (size >= 0.4) return `뚜렷한 ${direction} 상관`;
  if (size >= 0.2) return `약한 ${direction} 상관`;
  return '거의 상관 없음';
}

/* ------------------------------------------------------- 화면 전환 */

function switchView(view) {
  state.view = view;
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.view === view);
  });
  $('#view-table').hidden = view !== 'table';
  $('#view-charts').hidden = view !== 'charts';
  $('#view-analysis').hidden = view !== 'analysis';
  if (view === 'charts') renderCharts();
  if (view === 'analysis') renderAnalyses();
  renderInspector();
}

/* ------------------------------------------------------- 데이터 넣기 */

async function addFiles(fileList) {
  const files = [...fileList].filter((file) => /\.(csv|tsv|txt)$/i.test(file.name));
  if (!files.length) {
    toast('CSV 파일만 올릴 수 있습니다.', 'error');
    return;
  }
  for (const file of files) {
    const text = await readCsvFile(file);
    const base = file.name.replace(/\.[^.]+$/, '');
    try {
      setBusy(1);
      const result = await kernel.loadCsv(base, text);
      state.tables = result.tables;
      state.sources[result.name] = text;
      state.activeTable = result.name;
      await matchPendingSource(result.name);
    } catch (error) {
      toast(`${file.name}: ${error.message}`, 'error');
    } finally {
      setBusy(-1);
    }
  }
  state.page = 0;
  await rebuildAll();
  if (state.pendingRecipe) await tryRunPendingRecipe();
}

async function loadSamples() {
  try {
    setBusy(1);
    for (const name of ['학교현황.csv', '지역지표.csv', '매점_구매내역.csv']) {
      const response = await fetch(`samples/${encodeURIComponent(name)}`);
      if (!response.ok) throw new Error('예제 파일을 찾지 못했습니다.');
      const text = await response.text();
      const result = await kernel.loadCsv(name.replace(/\.csv$/, ''), text);
      state.tables = result.tables;
      state.sources[result.name] = text;
      state.activeTable = result.name;
    }
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(-1);
  }
  await rebuildAll();
  toast('둘러보기용으로 만든 가상 데이터입니다. 실제 통계가 아니니 수업에서 사실로 인용하지 마세요.');
}

/* ------------------------------------------------------- 저장과 열기 */

function fileSizeText(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

function openSave() {
  if (!Object.keys(state.sources).length) {
    toast('먼저 데이터를 올려 주세요.', 'error');
    return;
  }
  openModal({
    title: '작업 저장하기',
    okLabel: '닫기',
    build: (body) => {
      body.append(el('p', 'modal-desc',
        '올린 데이터와 전처리 단계, 그래프, 분석 설정을 파일 하나에 담습니다. ' +
        '이 파일을 다시 열면 지금 화면이 그대로 돌아옵니다. 선생님께 제출할 때 이 파일을 내면 됩니다.'));

      const nameField = el('div', 'field');
      nameField.append(el('label', null, '이름 (파일 이름 앞에 붙습니다)'));
      const nameInput = el('input');
      nameInput.type = 'text';
      nameInput.value = state.author;
      nameInput.placeholder = '예: 1학년3반_김세종';
      nameInput.oninput = () => { state.author = nameInput.value; touch(); };
      nameField.append(nameInput);
      body.append(nameField);

      const info = el('div', 'callout callout-info');
      info.textContent =
        `데이터 ${Object.keys(state.sources).length}개 · 약 ${fileSizeText(dataBytes(state))} · ` +
        `전처리 ${state.steps.length}단계 · 그래프 ${state.charts.length}개 · 분석 ${state.analyses.length}개`;
      body.append(info);

      const full = el('button', 'btn btn-primary', '내 작업 저장 (.deep.json)');
      full.onclick = () => {
        downloadJson(buildProject(state), 'deep');
        markSaved('파일로 저장함');
      };
      const light = el('button', 'btn', '설정만 저장 (데이터 없이)');
      light.onclick = () => downloadJson(buildRecipe(state), 'recipe');
      body.append(full, light);

      body.append(el('p', 'modal-desc',
        '작업은 이 브라우저 안에도 자동으로 저장되고 있습니다. 실수로 새로고침해도 다시 들어오면 이어서 할 수 있어요. ' +
        '다만 다른 컴퓨터에서 이어 하려면 위 파일로 저장해 가져가야 합니다.'));
    },
  });
}

/** 프로젝트 파일이나 과제 링크의 내용을 화면에 올린다. */
async function applyPayload(payload) {
  autosaveOn = false;
  try {
    state.title = payload.title || '새 분석';
    state.author = payload.author || '';
    state.note = payload.note || '';
    $('#project-title').value = state.title;
    state.steps = payload.steps || [];
    state.charts = (payload.charts || []).map((chart) => ({ ...chart, editing: false }));
    state.analyses = (payload.analyses || []).map((analysis) => ({ ...analysis, editing: false }));

    if (hasData(payload)) {
      await run(kernel.call('reset', {}), '작업 공간 비우기');
      state.sources = {};
      state.tables = [];
      for (const [name, text] of Object.entries(payload.data)) {
        const result = await kernel.loadCsv(name, text);
        state.tables = result.tables;
        state.sources[result.name] = text;
      }
      state.activeTable = state.tables[0]?.name || null;
      state.pendingRecipe = null;
    } else {
      state.pendingRecipe = payload;
    }
  } finally {
    autosaveOn = true;
  }

  state.page = 0;
  await rebuildAll();
  renderCharts();
  renderAnalyses();
  switchView(state.charts.length ? 'charts' : 'table');
}

async function openProjectFile(file) {
  try {
    const payload = await readJsonFile(file);
    await applyPayload(payload);
    if (state.pendingRecipe) {
      showRecipeGate(payload);
    } else {
      toast('파일을 열었습니다.', 'ok');
    }
  } catch (error) {
    toast(`파일을 열지 못했습니다: ${error.message}`, 'error');
  }
}

/* ------------------------------------------------------- 공유 */

async function openShare() {
  const bytes = dataBytes(state);
  const options = { withData: false };

  const render = async (body) => {
    body.innerHTML = '';

    const noteField = el('div', 'field');
    noteField.append(el('label', null, '받는 사람에게 보여 줄 안내문 (선택)'));
    const noteInput = el('input');
    noteInput.type = 'text';
    noteInput.value = state.note;
    noteInput.placeholder = '예: 학생수와 학급수의 관계를 추세선으로 확인해 보세요.';
    noteInput.oninput = () => { state.note = noteInput.value; touch(); };
    noteField.append(noteInput);
    body.append(noteField);

    const toggle = el('div', 'field field-check');
    const box = el('input');
    box.type = 'checkbox';
    box.id = 'share-with-data';
    box.checked = options.withData;
    box.onchange = () => { options.withData = box.checked; render(body); };
    const label = el('label', null, `데이터도 함께 담기 (약 ${fileSizeText(bytes)})`);
    label.htmlFor = 'share-with-data';
    toggle.append(box, label);
    body.append(toggle);

    body.append(el('p', 'modal-desc', options.withData
      ? '과제 링크가 됩니다. 학생은 링크만 열면 데이터와 분석이 바로 뜹니다. 데이터가 주소 안에 들어가므로 개인정보가 담긴 파일에는 쓰지 마세요.'
      : '설정만 담깁니다. 받은 사람이 같은 열 이름의 CSV를 올리면 똑같은 분석이 다시 계산됩니다. 데이터는 링크에 들어가지 않습니다.'));

    const payload = options.withData ? buildProject(state) : buildRecipe(state);
    const url = await linkFor(payload);

    const boxRow = el('div', 'share-box');
    const input = el('input');
    input.type = 'text';
    input.value = url;
    input.readOnly = true;
    input.onclick = () => input.select();
    const copy = el('button', 'btn btn-primary', '복사');
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(url);
        copy.textContent = '복사됨';
        setTimeout(() => (copy.textContent = '복사'), 1500);
      } catch (error) {
        input.select();
        document.execCommand('copy');
      }
    };
    boxRow.append(input, copy);
    body.append(boxRow);
    body.append(el('div', 'hint', `주소 길이 ${url.length.toLocaleString('ko-KR')}자`));

    if (url.length > 30000) {
      body.append(el('div', 'callout callout-warn',
        '주소가 너무 깁니다. 메신저나 LMS에서 잘릴 수 있으니 아래 과제 파일로 나눠 주세요.'));
    } else if (url.length > 8000) {
      body.append(el('div', 'callout callout-warn',
        '주소가 깁니다. 일부 메신저에서 잘릴 수 있으니 짧은 주소 서비스나 과제 파일을 함께 준비해 두세요.'));
    }

    if (!options.withData) {
      body.append(el('div', 'section-label', '받는 사람에게 필요한 데이터'));
      payload.sources.forEach((source) => {
        const item = el('div', 'step-item');
        const main = el('div', 'step-main');
        main.append(el('div', 'step-label', source.name));
        main.append(el('div', 'step-detail', `${source.columns.length}개 열: ${source.columns.join(', ')}`));
        item.append(main);
        body.append(item);
      });
    }

    const save = el('button', 'btn', options.withData ? '과제 파일로 저장 (.deep.json)' : '설정 파일로 저장');
    save.onclick = () => downloadJson(payload, options.withData ? 'deep' : 'recipe');
    body.append(save);
  };

  await openModal({ title: '공유하기', okLabel: '닫기', build: (body) => { render(body); } });
}

/* ------------------------------------------------------- 받는 쪽 */

async function matchPendingSource(uploadedName) {
  const recipe = state.pendingRecipe;
  if (!recipe) return;
  const meta = tableMeta(uploadedName) || state.tables.find((table) => table.name === uploadedName);
  if (!meta) return;
  const names = new Set(meta.columns.map((column) => column.name));
  let best = null;
  let bestScore = 0;
  (recipe.sources || []).forEach((source) => {
    if (state.tables.some((table) => table.name === source.name)) return;
    const hit = source.columns.filter((column) => names.has(column)).length;
    const score = hit / Math.max(1, source.columns.length);
    if (score > bestScore) {
      bestScore = score;
      best = source;
    }
  });
  if (best && bestScore >= 0.6 && best.name !== uploadedName) {
    const result = await kernel.call('rename_table', { from: uploadedName, to: best.name });
    state.tables = result.tables;
    state.sources[best.name] = state.sources[uploadedName];
    delete state.sources[uploadedName];
    state.activeTable = best.name;
    toast(`'${uploadedName}' 을(를) '${best.name}' 자리에 맞췄습니다.`, 'ok');
  }
}

async function tryRunPendingRecipe() {
  const recipe = state.pendingRecipe;
  if (!recipe) return;
  const missing = (recipe.sources || []).filter(
    (source) => !state.tables.some((table) => table.name === source.name)
  );
  if (missing.length) {
    toast(`아직 ${missing.map((source) => source.name).join(', ')} 데이터가 필요합니다.`);
    return;
  }
  state.pendingRecipe = null;
  await rebuildAll();
  renderCharts();
  renderAnalyses();
  toast('받은 분석을 그대로 다시 그렸습니다.', 'ok');
  switchView(state.charts.length ? 'charts' : 'table');
}

function showRecipeGate(recipe) {
  openModal({
    title: '받은 분석',
    okLabel: '데이터 올리기',
    build: (body) => {
      body.append(el('p', 'modal-desc',
        `"${recipe.title || '분석'}" 을(를) 열었습니다. 아래 데이터를 올리면 전처리 ${(recipe.steps || []).length}단계와 ` +
        `그래프 ${(recipe.charts || []).length}개, 분석 ${(recipe.analyses || []).length}개가 그대로 다시 계산됩니다.`));
      if (recipe.note) body.append(el('div', 'callout callout-info', recipe.note));
      (recipe.sources || []).forEach((source) => {
        const item = el('div', 'step-item');
        const main = el('div', 'step-main');
        main.append(el('div', 'step-label', `${source.name}.csv`));
        main.append(el('div', 'step-detail', `필요한 열: ${source.columns.join(', ')}`));
        item.append(main);
        body.append(item);
      });
      body.append(el('div', 'callout callout-info',
        '파일 이름이 달라도 괜찮습니다. 열 이름이 비슷하면 자동으로 맞춥니다.'));
    },
  }).then((accepted) => {
    if (accepted) $('#file-input').click();
  });
}

/* ------------------------------------------------------- 이어서 하기 */

async function offerRestore(saved) {
  const when = new Date(saved.savedAt);
  const ago = Math.round((Date.now() - when.getTime()) / 60000);
  const timeText = ago < 1 ? '방금 전' : ago < 60 ? `${ago}분 전` : `${Math.round(ago / 60)}시간 전`;
  const accepted = await openModal({
    title: '하던 작업이 남아 있습니다',
    okLabel: '이어서 하기',
    build: (body) => {
      body.append(el('p', 'modal-desc',
        `${timeText}에 이 브라우저에 저장된 작업이 있습니다. 이어서 하시겠어요?`));
      const item = el('div', 'step-item');
      const main = el('div', 'step-main');
      main.append(el('div', 'step-label', saved.title || '제목 없음'));
      main.append(el('div', 'step-detail',
        `데이터 ${Object.keys(saved.sources || {}).length}개 · 전처리 ${(saved.steps || []).length}단계 · ` +
        `그래프 ${(saved.charts || []).length}개 · 분석 ${(saved.analyses || []).length}개`));
      item.append(main);
      body.append(item);
      body.append(el('p', 'modal-desc', '새로 시작하면 저장된 작업은 지워집니다.'));
      $('#modal-cancel').textContent = '새로 시작';
    },
  });
  $('#modal-cancel').textContent = '취소';
  if (!accepted) {
    await clearSnapshot();
    return;
  }
  await applyPayload({ ...saved, data: saved.sources });
  if (saved.activeTable && tableMeta(saved.activeTable)) {
    state.activeTable = saved.activeTable;
    renderSidebar();
    await renderTable();
  }
  toast('이어서 하기로 불러왔습니다.', 'ok');
}
/* ------------------------------------------------------- 도움말 */

function openHelp() {
  openModal({
    title: 'DEEP 사용법',
    okLabel: '닫기',
    build: (body) => {
      const sections = [
        ['1. 데이터 올리기', 'CSV 여러 개를 한 번에 올릴 수 있습니다. 한글이 깨지는 CP949(엑셀에서 저장한) 파일도 자동으로 읽습니다.'],
        ['2. 전처리', '오른쪽 패널에서 단계를 쌓습니다. 각 단계는 껐다 켜거나 순서를 바꿀 수 있고, 원본은 그대로 남아 있어 언제든 되돌릴 수 있습니다.'],
        ['3. 시각화', '그래프 종류를 고르고 축에 열을 지정합니다. 확대·범례 끄기·PNG 저장이 모두 됩니다.'],
        ['4. 분석', '기술통계, 상관, 회귀(통계 vs 기계학습), 군집, 연관, 분류를 제공합니다. 각 카드에 관련 성취기준을 적어 두었습니다.'],
        ['5. 저장', '[저장]을 누르면 데이터와 전처리, 그래프, 분석이 모두 담긴 .deep.json 파일 하나가 내려받아집니다. 선생님께 제출할 때 이 파일을 내면 되고, [열기]로 다시 열면 화면이 그대로 돌아옵니다. 작업은 이 브라우저 안에도 자동으로 저장되어 실수로 새로고침해도 이어서 할 수 있습니다.'],
        ['6. 공유', '설정만 담은 링크와 데이터까지 담은 과제 링크 두 가지를 만들 수 있습니다. 선생님이 과제 링크를 주면 학생은 열기만 하면 데이터와 분석이 바로 뜹니다.'],
        ['데이터는 어디로 가나요?', '아무 데도 가지 않습니다. 파이썬(pandas·scikit-learn·statsmodels)이 브라우저 안에서 직접 돌기 때문에 서버로 파일을 보내지 않습니다. 자동 저장도 이 브라우저 안(IndexedDB)에만 남습니다.'],
        ['인터넷이 느린 교실이라면', '처음 한 번만 파이썬 환경을 내려받고, 그 뒤로는 브라우저가 붙잡아 둡니다. 수업 시작 전에 미리 한 번 열어 두면 훨씬 매끄럽습니다.'],
      ];
      sections.forEach(([title, text]) => {
        const block = el('div');
        block.append(el('div', 'section-label', title));
        block.append(el('div', 'modal-desc', text));
        body.append(block);
      });

      body.append(el('div', 'section-label', '수업 준비'));
      body.append(el('div', 'modal-desc',
        '쉬는 시간에 한 번 눌러 두면 회귀·군집·분류에 쓰는 파이썬 꾸러미까지 미리 받아 둡니다. ' +
        '수업 중에는 네트워크를 거의 쓰지 않게 되고, 한 반이 동시에 내려받느라 느려지는 일도 줄어듭니다.'));
      const warm = el('button', 'btn', '분석 꾸러미 미리 받기');
      warm.onclick = async () => {
        warm.disabled = true;
        warm.textContent = '받는 중… (1~2분 걸릴 수 있습니다)';
        try {
          setBusy(1);
          await kernel.preload();
          warm.textContent = '준비 완료';
          toast('수업 준비를 마쳤습니다. 이제 인터넷이 느려도 분석이 바로 돕니다.', 'ok');
        } catch (error) {
          warm.disabled = false;
          warm.textContent = '다시 시도';
          toast(`미리 받기에 실패했습니다: ${error.message}`, 'error');
        } finally {
          setBusy(-1);
        }
      };
      body.append(warm);
    },
  });
}

/* ------------------------------------------------------- 시작 */

function wireEvents() {
  $('#file-input').onchange = (event) => {
    addFiles(event.target.files);
    event.target.value = '';
  };
  const openPicker = () => $('#file-input').click();
  $('#btn-add-data').onclick = openPicker;
  $('#btn-add-data-2').onclick = openPicker;

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.onclick = () => switchView(tab.dataset.view);
  });

  $('#project-title').oninput = (event) => { state.title = event.target.value; touch(); };
  $('#btn-share').onclick = openShare;
  $('#btn-help').onclick = openHelp;
  $('#btn-save').onclick = openSave;
  $('#btn-open').onclick = () => $('#project-input').click();
  $('#project-input').onchange = async (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    if (file) await openProjectFile(file);
  };

  $('#btn-delete-selection').onclick = deleteSelection;

  $('#btn-export-csv').onclick = async () => {
    if (!state.activeTable) return;
    const result = await run(kernel.exportCsv(state.activeTable), 'CSV 내보내기');
    const blob = new Blob(['﻿' + result.text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${state.activeTable}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  $('#page-prev').onclick = () => { state.page -= 1; renderTable(); };
  $('#page-next').onclick = () => { state.page += 1; renderTable(); };

  $('#modal-close').onclick = () => closeModal(false);
  $('#modal-cancel').onclick = () => closeModal(false);
  $('#modal-ok').onclick = () => closeModal(true);
  $('#modal-backdrop').onclick = (event) => {
    if (event.target.id === 'modal-backdrop') closeModal(false);
  };
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#modal-backdrop').hidden) closeModal(false);
  });

  const shell = document.body;
  ['dragenter', 'dragover'].forEach((type) =>
    shell.addEventListener(type, (event) => {
      if (![...event.dataTransfer.types].includes('Files')) return;
      event.preventDefault();
      $('#view-table').classList.add('drop-active');
    })
  );
  ['dragleave', 'drop'].forEach((type) =>
    shell.addEventListener(type, (event) => {
      if (type === 'drop') event.preventDefault();
      $('#view-table').classList.remove('drop-active');
    })
  );
  shell.addEventListener('drop', (event) => {
    if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
  });

  const emptyAdd = $('#btn-empty-add');
  if (emptyAdd) emptyAdd.onclick = openPicker;
  const sample = $('#btn-sample');
  if (sample) sample.onclick = loadSamples;
}

const BOOT_STEPS = { pyodide: [25, '파이썬 실행기를 내려받는 중'], packages: [65, '분석 꾸러미를 준비하는 중'], kernel: [88, '분석 커널을 여는 중'], ready: [100, '준비 완료'] };

async function main() {
  wireEvents();
  switchView('table');

  kernel = new Kernel((stage, detail) => {
    const step = BOOT_STEPS[stage];
    // 부팅 화면은 준비가 끝나면 사라진다. 꾸러미 지연 로딩처럼 그 뒤에 오는 소식도 있다.
    const fill = $('#boot-bar-fill');
    const text = $('#boot-text');
    if (step && fill) fill.style.width = `${step[0]}%`;
    if (step && text) text.textContent = detail ? `${step[1]} — ${detail}` : step[1];
    if (stage === 'error') {
      if (text) text.textContent = detail;
      $('#kernel-chip').className = 'chip chip-error';
      $('#kernel-chip-text').textContent = '오류';
    }
  });

  try {
    await kernel.ready;
  } catch (error) {
    const text = $('#boot-text');
    if (text) text.textContent = error.message;
    return;
  }

  $('#kernel-chip').dataset.ready = '1';
  $('#kernel-chip').className = 'chip chip-ok';
  $('#kernel-chip-text').textContent = '준비됨';
  $('#boot').classList.add('done');
  setTimeout(() => $('#boot').remove(), 400);

  renderSidebar();
  renderInspector();
  await renderTable();

  const token = tokenFromHash();
  if (token) {
    // 링크로 받은 과제나 레시피가 먼저다. 자동 저장본보다 우선한다.
    try {
      const payload = await decodePayload(token);
      await applyPayload(payload);
      if (state.pendingRecipe) showRecipeGate(payload);
      else if (payload.note) toast(payload.note, 'ok');
    } catch (error) {
      toast(`링크를 읽지 못했습니다: ${error.message}`, 'error');
    }
    return;
  }

  const saved = await loadSnapshot();
  if (saved && Object.keys(saved.sources || {}).length) {
    await offerRestore(saved);
  }
}

/* 수업용 오프라인 캐시. https나 localhost에서만 등록된다. */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const secure = location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname);
  if (!secure) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('../sw.js', import.meta.url)).catch(() => {
      /* 캐시는 있으면 좋고 없어도 그만이다 */
    });
  });
}

registerServiceWorker();
main();
