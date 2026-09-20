/* Plotly 그림을 만든다. 색·굵기·축 스타일은 여기 한 곳에서만 정한다. */

export const SERIES = [
  '#2a78d6', // 파랑
  '#eb6834', // 주황
  '#1baf7a', // 청록
  '#eda100', // 노랑
  '#e87ba4', // 자홍
  '#008300', // 초록
  '#4a3aa7', // 보라
  '#e34948', // 빨강
];

const INK = '#37352f';
const INK_SOFT = '#5e646e';
const MUTED = '#898781';
const GRID = '#ececea';
const AXIS = '#c9c9c5';
const SURFACE = '#ffffff';
const FONT = '"Pretendard Variable", Pretendard, "Noto Sans KR", system-ui, sans-serif';

// 상관계수처럼 0을 기준으로 방향이 갈리는 값: 파랑 ↔ 회색 ↔ 빨강
const DIVERGING = [
  [0, '#184f95'],
  [0.25, '#86b6ef'],
  [0.5, '#f0efec'],
  [0.75, '#ef9c9b'],
  [1, '#b52b2a'],
];

const SEQUENTIAL = [
  [0, '#eef4fd'],
  [0.35, '#9ec5f4'],
  [0.7, '#3987e5'],
  [1, '#184f95'],
];

export const CONFIG = {
  responsive: true,
  displaylogo: false,
  locale: 'ko',
  modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d'],
  toImageButtonOptions: { format: 'png', scale: 2 },
};

export function color(index) {
  return SERIES[index % SERIES.length];
}

function baseLayout(options = {}) {
  const showLegend = options.showLegend ?? false;
  return {
    paper_bgcolor: SURFACE,
    plot_bgcolor: SURFACE,
    font: { family: FONT, size: 12, color: INK_SOFT },
    margin: { l: 58, r: 18, t: options.title ? 44 : 16, b: 52 },
    title: options.title
      ? { text: options.title, font: { size: 14, color: INK }, x: 0, xanchor: 'left', y: 0.97 }
      : undefined,
    showlegend: showLegend,
    legend: {
      orientation: 'h',
      y: -0.18,
      x: 0,
      font: { size: 11, color: INK_SOFT },
      bgcolor: 'rgba(0,0,0,0)',
    },
    hoverlabel: {
      bgcolor: '#ffffff',
      bordercolor: '#dededb',
      font: { family: FONT, size: 12, color: INK },
    },
    xaxis: axis(options.xTitle, options.xType),
    yaxis: axis(options.yTitle, options.yType),
    ...options.extra,
  };
}

function axis(title, type) {
  return {
    title: title ? { text: title, font: { size: 11, color: MUTED }, standoff: 12 } : undefined,
    type: type || undefined,
    gridcolor: GRID,
    zerolinecolor: AXIS,
    linecolor: AXIS,
    tickfont: { size: 11, color: MUTED },
    automargin: true,
  };
}

/* ------------------------------------------------------------------ */
/* 기본 그래프                                                          */
/* ------------------------------------------------------------------ */

export function buildFigure(data, spec) {
  switch (data.kind) {
    case 'bar':
      return barFigure(data, spec);
    case 'line':
    case 'area':
      return lineFigure(data, spec);
    case 'scatter':
      return scatterFigure(data, spec);
    case 'histogram':
      return histogramFigure(data, spec);
    case 'box':
      return boxFigure(data, spec);
    case 'pie':
      return pieFigure(data, spec);
    case 'heatmap':
      return heatmapFigure(data, spec);
    default:
      throw new Error(`그릴 수 없는 그래프: ${data.kind}`);
  }
}

function barFigure(data, spec) {
  const traces = data.series.map((series, index) => ({
    type: 'bar',
    name: series.name,
    x: spec.horizontal ? series.y : series.x,
    y: spec.horizontal ? series.x : series.y,
    orientation: spec.horizontal ? 'h' : 'v',
    marker: {
      color: color(index),
      line: { width: data.series.length > 1 ? 1 : 0, color: SURFACE },
    },
    hovertemplate: `%{${spec.horizontal ? 'y' : 'x'}}<br><b>%{${spec.horizontal ? 'x' : 'y'}:,.4~g}</b><extra>${series.name}</extra>`,
  }));
  const layout = baseLayout({
    showLegend: traces.length > 1,
    xTitle: spec.horizontal ? data.yTitle : spec.x,
    yTitle: spec.horizontal ? spec.x : data.yTitle,
    extra: { barmode: spec.barmode || 'group', bargap: 0.28, bargroupgap: 0.08 },
  });
  return { traces, layout };
}

function lineFigure(data, spec) {
  const traces = data.series.map((series, index) => ({
    type: 'scatter',
    mode: series.x.length <= 40 ? 'lines+markers' : 'lines',
    fill: data.kind === 'area' ? 'tozeroy' : undefined,
    name: series.name,
    x: series.x,
    y: series.y,
    line: { width: 2, color: color(index), shape: spec.smooth ? 'spline' : 'linear' },
    marker: { size: 6, color: color(index), line: { width: 1.5, color: SURFACE } },
    hovertemplate: `%{x}<br><b>%{y:,.4~g}</b><extra>${series.name}</extra>`,
  }));
  return {
    traces,
    layout: baseLayout({
      showLegend: traces.length > 1,
      xTitle: spec.x,
      yTitle: data.yTitle,
      extra: { hovermode: 'x unified' },
    }),
  };
}

function scatterFigure(data, spec) {
  const traces = data.series.map((series, index) => {
    const sizes = series.size;
    return {
      // cartesian 번들에는 scattergl이 없다. 점 개수는 kernel.py에서 이미 줄여 보낸다.
      type: 'scatter',
      mode: 'markers',
      name: series.name,
      x: series.x,
      y: series.y,
      marker: {
        color: color(index),
        size: sizes ? scaleSizes(sizes) : 9,
        opacity: 0.78,
        line: { width: 1, color: SURFACE },
      },
      hovertemplate: `${spec.x}: %{x:,.4~g}<br>${spec.y}: %{y:,.4~g}<extra>${series.name}</extra>`,
    };
  });
  if (data.trend) {
    traces.push({
      type: 'scatter',
      mode: 'lines',
      name: `추세선 (R²=${data.trend.r2.toFixed(3)})`,
      x: data.trend.x,
      y: data.trend.y,
      line: { width: 2, color: INK, dash: 'dash' },
      hoverinfo: 'skip',
    });
  }
  return {
    traces,
    layout: baseLayout({
      showLegend: traces.length > 1,
      xTitle: spec.x,
      yTitle: spec.y,
    }),
  };
}

function scaleSizes(values) {
  const clean = values.filter((value) => typeof value === 'number' && isFinite(value));
  if (!clean.length) return 9;
  const low = Math.min(...clean);
  const high = Math.max(...clean);
  const span = high - low || 1;
  return values.map((value) =>
    typeof value === 'number' && isFinite(value) ? 8 + ((value - low) / span) * 26 : 8
  );
}

function histogramFigure(data, spec) {
  const traces = data.series.map((series, index) => ({
    type: 'histogram',
    name: series.name,
    x: series.values,
    marker: { color: color(index), line: { width: 1, color: SURFACE } },
    opacity: data.series.length > 1 ? 0.7 : 1,
    nbinsx: data.bins || undefined,
    hovertemplate: '구간 %{x}<br><b>%{y}개</b><extra></extra>',
  }));
  return {
    traces,
    layout: baseLayout({
      showLegend: traces.length > 1,
      xTitle: spec.x,
      yTitle: '개수',
      extra: { barmode: 'overlay', bargap: 0.04 },
    }),
  };
}

function boxFigure(data, spec) {
  const traces = data.series.map((series, index) => ({
    type: 'box',
    name: series.name,
    y: series.values,
    boxpoints: series.values.length <= 400 ? 'outliers' : false,
    marker: { color: color(index), size: 5, outliercolor: '#e34948' },
    line: { width: 1.6 },
    fillcolor: color(index) + '22',
    hovertemplate: '%{y:,.4~g}<extra>%{x}</extra>',
  }));
  return {
    traces,
    layout: baseLayout({
      showLegend: false,
      xTitle: spec.x || '',
      yTitle: spec.y,
    }),
  };
}

function pieFigure(data) {
  return {
    traces: [
      {
        type: 'pie',
        labels: data.labels,
        values: data.values,
        hole: 0.45,
        sort: false,
        marker: { colors: data.labels.map((_, index) => color(index)), line: { width: 2, color: SURFACE } },
        textinfo: 'label+percent',
        textposition: 'outside',
        textfont: { size: 11, color: INK_SOFT },
        hovertemplate: '%{label}<br><b>%{value:,.4~g}</b> (%{percent})<extra></extra>',
      },
    ],
    layout: baseLayout({ showLegend: false, extra: { margin: { l: 20, r: 20, t: 20, b: 20 } } }),
  };
}

function heatmapFigure(data) {
  return {
    traces: [
      {
        type: 'heatmap',
        x: data.labels,
        y: data.labels,
        z: data.z,
        zmin: -1,
        zmax: 1,
        colorscale: DIVERGING,
        xgap: 2,
        ygap: 2,
        colorbar: { thickness: 10, outlinewidth: 0, tickfont: { size: 10, color: MUTED } },
        hovertemplate: '%{y} ↔ %{x}<br><b>r = %{z:.3f}</b><extra></extra>',
      },
    ],
    layout: baseLayout({ extra: { margin: { l: 110, r: 20, t: 16, b: 100 } } }),
  };
}

/* ------------------------------------------------------------------ */
/* 분석 결과용 그림                                                     */
/* ------------------------------------------------------------------ */

export function correlationFigure(result) {
  return heatmapFigure({ labels: result.labels, z: result.z });
}

export function actualVsPredicted(result) {
  const all = result.scatter.actual.concat(result.scatter.predicted).filter(Number.isFinite);
  const low = Math.min(...all);
  const high = Math.max(...all);
  return {
    traces: [
      {
        type: 'scatter',
        mode: 'lines',
        name: '완벽한 예측',
        x: [low, high],
        y: [low, high],
        line: { width: 2, color: AXIS, dash: 'dash' },
        hoverinfo: 'skip',
      },
      {
        type: 'scatter',
        mode: 'markers',
        name: '검증 데이터',
        x: result.scatter.actual,
        y: result.scatter.predicted,
        marker: { color: SERIES[0], size: 9, opacity: 0.8, line: { width: 1, color: SURFACE } },
        hovertemplate: '실제 %{x:,.4~g}<br>예측 %{y:,.4~g}<extra></extra>',
      },
    ],
    layout: baseLayout({ showLegend: true, xTitle: '실제값', yTitle: '예측값' }),
  };
}

export function residualFigure(result) {
  return {
    traces: [
      {
        type: 'scatter',
        mode: 'markers',
        name: '잔차',
        x: result.residual.fitted,
        y: result.residual.residual,
        marker: { color: SERIES[1], size: 8, opacity: 0.75, line: { width: 1, color: SURFACE } },
        hovertemplate: '예측 %{x:,.4~g}<br>잔차 %{y:,.4~g}<extra></extra>',
      },
    ],
    layout: baseLayout({
      xTitle: '예측값',
      yTitle: '잔차 (실제 − 예측)',
      extra: {
        shapes: [
          {
            type: 'line',
            xref: 'paper',
            x0: 0,
            x1: 1,
            y0: 0,
            y1: 0,
            line: { color: AXIS, width: 1.5, dash: 'dash' },
          },
        ],
      },
    }),
  };
}

export function simpleRegressionFigure(result) {
  const simple = result.simple;
  return {
    traces: [
      {
        type: 'scatter',
        mode: 'markers',
        name: '관측값',
        x: simple.x,
        y: simple.y,
        marker: { color: SERIES[0], size: 9, opacity: 0.75, line: { width: 1, color: SURFACE } },
        hovertemplate: `${simple.xName} %{x:,.4~g}<br>${result.target} %{y:,.4~g}<extra></extra>`,
      },
      {
        type: 'scatter',
        mode: 'lines',
        name: '회귀선',
        x: simple.lineX,
        y: simple.lineY,
        line: { width: 2.5, color: INK },
        hoverinfo: 'skip',
      },
    ],
    layout: baseLayout({ showLegend: true, xTitle: simple.xName, yTitle: result.target }),
  };
}

export function clusterFigure(result) {
  const traces = result.groups.map((group, index) => ({
    type: 'scatter',
    mode: 'markers',
    name: `${group.name} (${group.count})`,
    x: group.x,
    y: group.y,
    marker: { color: color(index), size: 9, opacity: 0.8, line: { width: 1, color: SURFACE } },
    hovertemplate: '%{x:,.3~g}, %{y:,.3~g}<extra>' + group.name + '</extra>',
  }));
  return {
    traces,
    layout: baseLayout({
      showLegend: true,
      xTitle: result.axisNames[0],
      yTitle: result.axisNames[1],
    }),
  };
}

export function elbowFigure(result) {
  return {
    traces: [
      {
        type: 'scatter',
        mode: 'lines+markers',
        name: '군집 내 거리 합',
        x: result.elbow.map((item) => item.k),
        y: result.elbow.map((item) => item.inertia),
        line: { width: 2, color: SERIES[0] },
        marker: { size: 8, color: SERIES[0], line: { width: 1.5, color: SURFACE } },
        hovertemplate: 'k=%{x}<br><b>%{y:,.4~g}</b><extra></extra>',
      },
    ],
    layout: baseLayout({ xTitle: '군집 수 k', yTitle: '군집 내 거리 합' }),
  };
}

export function silhouetteFigure(result) {
  return {
    traces: [
      {
        type: 'scatter',
        mode: 'lines+markers',
        name: '실루엣 점수',
        x: result.silhouetteCurve.map((item) => item.k),
        y: result.silhouetteCurve.map((item) => item.score),
        line: { width: 2, color: SERIES[2] },
        marker: { size: 8, color: SERIES[2], line: { width: 1.5, color: SURFACE } },
        hovertemplate: 'k=%{x}<br><b>%{y:.3f}</b><extra></extra>',
      },
    ],
    layout: baseLayout({ xTitle: '군집 수 k', yTitle: '실루엣 점수 (높을수록 뚜렷)' }),
  };
}

export function importanceFigure(items, title) {
  const rows = items.slice(0, 12).reverse();
  return {
    traces: [
      {
        type: 'bar',
        orientation: 'h',
        x: rows.map((item) => item.value),
        y: rows.map((item) => item.name),
        marker: { color: SERIES[0] },
        hovertemplate: '%{y}<br><b>%{x:,.4~g}</b><extra></extra>',
      },
    ],
    layout: baseLayout({ xTitle: title, extra: { bargap: 0.35, margin: { l: 130, r: 20, t: 16, b: 44 } } }),
  };
}

export function rulesFigure(rules) {
  const top = rules.slice(0, 60);
  return {
    traces: [
      {
        type: 'scatter',
        mode: 'markers',
        x: top.map((rule) => rule.support),
        y: top.map((rule) => rule.confidence),
        text: top.map((rule) => `${rule.if} → ${rule.then}`),
        marker: {
          size: top.map((rule) => 8 + Math.min(rule.lift, 6) * 4),
          color: top.map((rule) => rule.lift),
          colorscale: SEQUENTIAL,
          line: { width: 1, color: SURFACE },
          colorbar: { title: { text: '향상도', font: { size: 10, color: MUTED } }, thickness: 10, outlinewidth: 0 },
        },
        hovertemplate: '%{text}<br>지지도 %{x:.3f} · 신뢰도 %{y:.3f}<extra></extra>',
      },
    ],
    layout: baseLayout({ xTitle: '지지도(support)', yTitle: '신뢰도(confidence)' }),
  };
}

export function confusionFigure(result) {
  return {
    traces: [
      {
        type: 'heatmap',
        x: result.labels,
        y: result.labels,
        z: result.matrix,
        colorscale: SEQUENTIAL,
        xgap: 2,
        ygap: 2,
        colorbar: { thickness: 10, outlinewidth: 0, tickfont: { size: 10, color: MUTED } },
        hovertemplate: '실제 %{y} → 예측 %{x}<br><b>%{z}개</b><extra></extra>',
      },
    ],
    layout: baseLayout({ xTitle: '예측', yTitle: '실제', extra: { margin: { l: 90, r: 20, t: 16, b: 60 } } }),
  };
}

/* 카드가 접히고 펴지면서 그림틀 크기가 바뀐다. 창 크기 변화만 보는 responsive로는
   부족해서, 그림틀 자체를 관찰해 다시 맞춘다. */
const observed = new WeakSet();

export function draw(element, figure) {
  const drawing = Plotly.react(element, figure.traces, figure.layout, CONFIG);
  if (!observed.has(element) && typeof ResizeObserver !== 'undefined') {
    observed.add(element);
    let timer = null;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // 숨겨진 탭이나 이미 지워진 그림틀에는 손대지 않는다.
        if (!element.isConnected || !element.offsetWidth || !element.offsetHeight) return;
        try {
          const done = Plotly.Plots.resize(element);
          if (done && done.catch) done.catch(() => {});
        } catch (error) {
          /* 그리는 중이면 다음 변화 때 다시 맞춘다 */
        }
      }, 60);
    });
    observer.observe(element);
  }
  return drawing;
}
