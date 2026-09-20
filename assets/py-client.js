/* 워커와 주고받는 얇은 층. 모든 호출은 Promise 하나로 끝난다. */

export class Kernel {
  constructor(onStatus) {
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.pending = new Map();
    this.nextId = 1;
    this.onStatus = onStatus || (() => {});
    this.worker.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === 'status') {
        this.onStatus(data.stage, data.detail);
        return;
      }
      const entry = this.pending.get(data.id);
      if (!entry) return;
      this.pending.delete(data.id);
      if (data.ok) entry.resolve(data.result);
      else entry.reject(new Error(data.error || '알 수 없는 오류'));
    };
    this.worker.onerror = (event) => {
      const message = event.message || '워커를 시작하지 못했습니다.';
      this.pending.forEach((entry) => entry.reject(new Error(message)));
      this.pending.clear();
      this.onStatus('error', message);
    };
    this.ready = this.call('__init__', {});
  }

  call(cmd, payload) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, cmd, payload });
    });
  }

  /* 수업 전 예열. 분석용 파이썬 꾸러미까지 미리 받아 둔다. */
  preload() {
    return this.call('__preload__', {});
  }

  loadCsv(name, text) {
    return this.call('load_csv', { name, text });
  }

  removeTable(name) {
    return this.call('remove_table', { name });
  }

  rebuild(steps) {
    return this.call('rebuild', { steps });
  }

  preview(table, offset, limit) {
    return this.call('preview', { table, offset, limit });
  }

  chartData(spec) {
    return this.call('chart_data', spec);
  }

  analyze(spec) {
    return this.call('analyze', spec);
  }

  exportCsv(table) {
    return this.call('export_csv', { table });
  }
}

/* CSV 파일 읽기 — 공공데이터는 CP949(EUC-KR)로 내려오는 경우가 많아
   UTF-8로 먼저 시도하고 실패하면 EUC-KR로 다시 읽는다. */
export async function readCsvFile(file) {
  const buffer = await file.arrayBuffer();
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return stripBom(text);
  } catch (error) {
    for (const encoding of ['euc-kr', 'windows-1252']) {
      try {
        return stripBom(new TextDecoder(encoding).decode(buffer));
      } catch (inner) {
        /* 다음 인코딩 시도 */
      }
    }
    return stripBom(new TextDecoder('utf-8').decode(buffer));
  }
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
