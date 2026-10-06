(function() {
  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim();
  var accent2 = style.getPropertyValue('--accent2').trim();
  var accent3 = style.getPropertyValue('--accent3').trim();
  var ink = style.getPropertyValue('--ink').trim();
  var muted = style.getPropertyValue('--muted').trim();
  var rule = style.getPropertyValue('--rule').trim();
  var bg2 = style.getPropertyValue('--bg2').trim();

  // --- Chart 1: Highlights Distribution ---
  var chart1 = echarts.init(document.getElementById('chart-overview'), null, { renderer: 'svg' });
  chart1.setOption({
    animation: false,
    grid: { top: 30, bottom: 40, left: 50, right: 30 },
    tooltip: {
      trigger: 'axis',
      appendToBody: true,
      axisPointer: { type: 'shadow' }
    },
    xAxis: {
      type: 'category',
      data: ['画布模块\n(canvas-service)', 'Agent 模块\n(agent-service)', '计费模块\n(billing-service)'],
      axisLabel: {
        color: muted,
        fontSize: 12,
        lineHeight: 16
      },
      axisLine: { lineStyle: { color: rule } },
      axisTick: { show: false }
    },
    yAxis: {
      type: 'value',
      name: '亮点数量',
      nameTextStyle: { color: muted, fontSize: 12 },
      axisLabel: { color: muted },
      splitLine: { lineStyle: { color: rule, type: 'dashed' } }
    },
    series: [{
      type: 'bar',
      data: [
        { value: 10, itemStyle: { color: accent } },
        { value: 12, itemStyle: { color: accent2 } },
        { value: 12, itemStyle: { color: accent3 } }
      ],
      barWidth: '40%',
      label: {
        show: true,
        position: 'top',
        color: ink,
        fontSize: 16,
        fontWeight: 700,
        formatter: '{c}'
      }
    }]
  });
  window.addEventListener('resize', function() { chart1.resize(); });

  // --- Chart 2: Radar Chart ---
  var chart2 = echarts.init(document.getElementById('chart-radar'), null, { renderer: 'svg' });
  chart2.setOption({
    animation: false,
    legend: {
      data: ['画布模块', 'Agent 模块', '计费模块'],
      top: 0,
      textStyle: { color: ink, fontSize: 12 }
    },
    tooltip: { appendToBody: true },
    radar: {
      indicator: [
        { name: '架构分层', max: 10 },
        { name: '数据模型', max: 10 },
        { name: '安全机制', max: 10 },
        { name: 'API设计', max: 10 },
        { name: '可扩展性', max: 10 },
        { name: '可测试性', max: 10 }
      ],
      radius: '65%',
      center: ['50%', '55%'],
      axisName: {
        color: ink,
        fontSize: 12
      },
      splitLine: { lineStyle: { color: rule } },
      splitArea: { areaStyle: { color: ['transparent', bg2] } },
      axisLine: { lineStyle: { color: rule } }
    },
    series: [{
      type: 'radar',
      data: [
        {
          value: [9, 9, 8, 8, 9, 7],
          name: '画布模块',
          itemStyle: { color: accent },
          areaStyle: { color: accent + '22' },
          lineStyle: { width: 2 }
        },
        {
          value: [9, 8, 9, 7, 8, 9],
          name: 'Agent 模块',
          itemStyle: { color: accent2 },
          areaStyle: { color: accent2 + '22' },
          lineStyle: { width: 2 }
        },
        {
          value: [8, 9, 10, 8, 7, 7],
          name: '计费模块',
          itemStyle: { color: accent3 },
          areaStyle: { color: accent3 + '22' },
          lineStyle: { width: 2 }
        }
      ]
    }]
  });
  window.addEventListener('resize', function() { chart2.resize(); });
})();
