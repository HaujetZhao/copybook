<script setup>
import { ref, watch, watchEffect } from 'vue';

const themes = [
  { name: '暗夜', vars: { '--bg': '#1e1f24', '--canvas': '#26272c', '--text': '#e6e4e0', '--muted': '#8b8d94', '--accent': '#aeb9ff', '--border': '#33353c' } },
  { name: '宣纸', vars: { '--bg': '#e9e2d5', '--canvas': '#f5f0e6', '--text': '#3a332a', '--muted': '#9a8f7d', '--accent': '#b08347', '--border': '#d8cfbc' } },
  { name: '黛蓝', vars: { '--bg': '#171a21', '--canvas': '#1e222c', '--text': '#dfe3ec', '--muted': '#828a9b', '--accent': '#9db4f0', '--border': '#282c37' } },
];

// 持久化:主题/字号/可编辑状态存 localStorage,刷新后恢复
const saved = JSON.parse(localStorage.getItem('jxp') || '{}');
const editable = ref(saved.editable ?? true);
const size = ref(saved.size ?? 64);
const laserMode = ref(saved.laserMode ?? 'dot'); // 'dot' 点跟随 | 'trail' 荧光笔迹
const theme = ref(themes.find(t => t.name === saved.theme) ?? themes[0]);

// 限制最大宽度后,页面外的 body 露出区域也要跟主题同色
watchEffect(() => {
  document.body.style.background = theme.value.vars['--bg'];
});

// 预览态全页禁选中/禁长按呼出菜单,防止临摹时误选画布外文字
watchEffect(() => {
  document.body.style.userSelect = editable.value ? '' : 'none';
  document.body.style.webkitUserSelect = editable.value ? '' : 'none';
  document.body.style.webkitTouchCallout = editable.value ? '' : 'none';
});

watch([editable, size, theme], () => {
  localStorage.setItem('jxp', JSON.stringify({
    editable: editable.value, size: size.value, laserMode: laserMode.value, theme: theme.value.name,
  }));
}, { deep: true });

// 激光笔:预览态下,触控笔/鼠标在画布上只留一个跟随光点(不滚动不选中);
// 手指则手动转发滚动(画布 touch-action:none 是为了拦下笔的滚动,手指的滚动在这里补回)
const laser = ref(null); // { x, y } 视口坐标
let lastTouch = null;
function laserMove(e) {
  if (editable.value) return;
  if (e.pointerType === 'touch') {
    laser.value = null;
    if (lastTouch) {
      e.currentTarget.scrollBy(lastTouch.x - e.clientX, lastTouch.y - e.clientY);
    }
    lastTouch = { x: e.clientX, y: e.clientY };
  } else {
    laser.value = { x: e.clientX, y: e.clientY };
  }
}
function laserEnd(e) {
  if (e.pointerType === 'touch') lastTouch = null;
  else laser.value = null;
}

// 荧光笔迹模式:性能方案 —— 抬笔后的旧笔迹「烘焙」进离屏画布,
// 每帧只需 drawImage(烘焙层) + 重绘当前这一笔,成本恒定不随笔迹总量增长。
// 纯红色笔迹,线宽随笔压力变化。
const trailFading = ref(false);
// ?debug 打开右侧日志面板:记录关键事件与采样,可一键 POST 到 dev server 终端
const debug = ref(location.search.includes('debug'));
const debugLogs = ref([]);
function dlog(msg) {
  if (!debug.value) return;
  debugLogs.value.push(`${new Date().toLocaleTimeString()} ${msg}`);
}
function snapshot() {
  const c = trailEl.value, host = canvasEl.value;
  return `dpr ${window.devicePixelRatio} bitmap ${c ? c.width + 'x' + c.height : '-'} css ${c ? c.style.width + 'x' + c.style.height : '-'} scroll ${host ? host.scrollWidth + 'x' + host.scrollHeight : '-'}`;
}
function updateDebug(e) {
  dlog(`${e.type} type=${e.pointerType} press=${e.pressure} buttons=${e.buttons} ${snapshot()}`);
}
async function sendLogs() {
  await fetch('/debug-log', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(debugLogs.value),
  });
  dlog('已发送到 dev server 终端');
}
if (debug.value) {
  window.addEventListener('error', ev => dlog(`ERROR ${ev.message}`));
  window.addEventListener('resize', () => dlog(`resize ${snapshot()}`));
  document.addEventListener('visibilitychange', () => dlog(`visibility hidden=${document.hidden} ${snapshot()}`));
  document.fonts?.ready?.then(() => dlog(`fonts.ready ${snapshot()}`));
  dlog(`页面加载 ${snapshot()}`);
}
let fadeTimer = null;
let drawing = false;
const canvasEl = ref(null);
const trailEl = ref(null); // 显示用 canvas
let ctx = null;
let baked = null; // 离屏画布,存已抬笔的笔迹
let cur = []; // 当前正在画的笔画 [{x,y,p}] 内容坐标
let rafId = null;

function contentPoint(e) {
  const r = canvasEl.value.getBoundingClientRect();
  return { x: e.clientX - r.left + canvasEl.value.scrollLeft, y: e.clientY - r.top + canvasEl.value.scrollTop, p: e.pressure || 0.5 };
}
// canvas 尺寸跟随滚动区域(含 devicePixelRatio,保证光晕不糊)
function fitTrail() {
  const c = trailEl.value, host = canvasEl.value;
  if (!c || !host) return;
  const dpr = window.devicePixelRatio || 1;
  const w = host.scrollWidth * dpr, h = host.scrollHeight * dpr;
  if (c.width === w && c.height === h) return;
  // 扩容时把烘焙层内容搬到新尺寸
  const old = baked;
  c.width = w; c.height = h;
  c.style.width = host.scrollWidth + 'px';
  c.style.height = host.scrollHeight + 'px';
  ctx = c.getContext('2d');
  baked = document.createElement('canvas');
  baked.width = w; baked.height = h;
  if (old) baked.getContext('2d').drawImage(old, 0, 0);
  renderTrail();
}
// Safari 画布合成层bug:位图会被低分辨率缓存,切回标签页才清晰。
// 视口/dpr 变化或页面重新可见时,重置位图强制以当前 dpr 重新光栅化。
function refreshTrailLayer() {
  const c = trailEl.value;
  if (!c || !ctx) return;
  fitTrail();
  c.width = c.width; // 重置位图(清空),内容随后由 renderTrail 从烘焙层重画
  renderTrail();
}
window.addEventListener('resize', refreshTrailLayer);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshTrailLayer(); });
// 字体加载完成后布局会变高,重新适配画布,避免位图被拉伸发糊
document.fonts?.ready?.then(refreshTrailLayer);
// 每点带压力 p(笔 0~1,鼠标恒 0.5),线宽随压力变化;低起点让提笔能收尖
function widthOf(pt) {
  const dpr = window.devicePixelRatio || 1;
  return (1.5 + 6 * (pt.p ?? 0.5)) * dpr;
}
// 画整条笔画:先把全部红外圈画完,再画全部白芯 ——
// 若逐段红白交替,后一段的红圈会盖住前一段的白芯,接头处出现红斑。
// 锯齿平滑:中点二次曲线 —— 以采样点为控制点、相邻中点为端点连圆滑曲线。
function strokePath(c2d, pts, dpr) {
  c2d.lineCap = 'round';
  c2d.lineJoin = 'round';
  // 构建第 i 段路径:中点(i-1,i)→中点(i,i+1),控制点 i;首尾段接原端点
  const seg = (i) => {
    const a = pts[i], b = pts[i + 1];
    c2d.beginPath();
    if (i === 0) {
      c2d.moveTo(a.x * dpr, a.y * dpr);
    } else {
      const m0x = (pts[i - 1].x + a.x) / 2, m0y = (pts[i - 1].y + a.y) / 2;
      c2d.moveTo(m0x * dpr, m0y * dpr);
    }
    if (i + 2 >= pts.length) {
      c2d.lineTo(b.x * dpr, b.y * dpr);
    } else {
      const m1x = (a.x + b.x) / 2, m1y = (a.y + b.y) / 2;
      c2d.quadraticCurveTo(b.x * dpr, b.y * dpr, m1x * dpr, m1y * dpr);
    }
    return Math.max(widthOf(a), widthOf(b));
  };
  if (pts.length === 1) {
    const w = widthOf(pts[0]);
    c2d.beginPath();
    c2d.arc(pts[0].x * dpr, pts[0].y * dpr, w / 2, 0, Math.PI * 2);
    c2d.strokeStyle = '#ff3b30';
    c2d.lineWidth = w;
    c2d.stroke();
    c2d.strokeStyle = '#fff';
    c2d.lineWidth = Math.max(1, w - 3 * dpr);
    c2d.stroke();
    return;
  }
  for (let i = 0; i + 1 < pts.length; i++) {
    c2d.strokeStyle = '#ff3b30';
    c2d.lineWidth = seg(i);
    c2d.stroke();
  }
  for (let i = 0; i + 1 < pts.length; i++) {
    c2d.strokeStyle = '#fff';
    c2d.lineWidth = Math.max(1, seg(i) - 3 * dpr);
    c2d.stroke();
  }
}
// 每帧:烘焙层贴回来 + 当前笔画整条重画(清了再画,无叠加色差)
function renderTrail() {
  const c = trailEl.value;
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, c.width, c.height);
  if (baked) ctx.drawImage(baked, 0, 0);
  if (cur.length) strokePath(ctx, cur, dpr);
}
function requestRender() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = null;
    renderTrail();
  });
}
function trailDown(e) {
  clearTimeout(fadeTimer);
  drawing = true;
  // 淡出中落笔:取消淡出,旧笔迹保留(瞬间恢复,不清空),继续接着画
  trailFading.value = false;
  // 每次落笔强制重置位图:字体加载/布局变化会让 scrollWidth 变,
  // 旧位图被 CSS 拉伸就会模糊(Safari),重画一次即按当前布局对齐
  fitTrail();
  const c = trailEl.value;
  if (c) { c.width = c.width; ctx = c.getContext('2d'); }
  renderTrail();
  cur = [contentPoint(e)];
  requestRender();
}
let debugMoveCount = 0;
function trailMove(e) {
  // 每 20 个 move 采样一条,够诊断又不刷屏
  if (debug.value && ++debugMoveCount % 20 === 0) updateDebug(e);
  const p = contentPoint(e), last = cur.at(-1);
  // 太密的点跳过,减绘计量也减轻慢画时的光晕叠色
  if (Math.hypot(p.x - last.x, p.y - last.y) < 1.5) return;
  cur.push(p);
  requestRender();
}
function trailUp() {
  // pointerup 后还会紧跟一个 pointerleave(释放隐式捕获),
  // drawing 标记保证一次抬笔只起一个淡出定时器
  if (!drawing) return;
  drawing = false;
  clearTimeout(fadeTimer);
  // 当前笔画烘焙进离屏层,后续帧不再重画它
  if (baked && cur.length) {
    strokePath(baked.getContext('2d'), cur, window.devicePixelRatio || 1);
  }
  cur = [];
  requestRender();
  // 抬笔立即开始淡出,0.8s 后清空;淡出中再落笔则恢复(trailDown 已处理)
  trailFading.value = true;
  fadeTimer = setTimeout(() => {
    trailFading.value = false;
    const b = baked && baked.getContext('2d');
    b && b.clearRect(0, 0, baked.width, baked.height);
    ctx && renderTrail();
  }, 800);
}

// 统一分发:预览态下笔/鼠标 → 按模式处理;手指 → 转发滚动
function onPointerDown(e) {
  updateDebug(e);
  if (editable.value || e.pointerType === 'touch') { laserMove(e); return; }
  if (laserMode.value === 'trail') trailDown(e);
  else laserMove(e);
}
function onPointerMove(e) {
  if (editable.value || e.pointerType === 'touch') { laserMove(e); return; }
  if (laserMode.value === 'trail') { if (e.buttons) trailMove(e); }
  else laserMove(e);
}
function onPointerUp(e) {
  if (debug.value) updateDebug(e);
  laserEnd(e);
  if (!editable.value && e.pointerType !== 'touch' && laserMode.value === 'trail') trailUp();
}
</script>

<template>
  <div class="page" :style="theme.vars">
    <div class="toolbar">
      <label class="size">
        <input type="range" v-model.number="size" min="16" max="200" />
        <span>{{ size }}px</span>
      </label>
      <div class="seg">
        <button
          v-for="t in themes" :key="t.name"
          :class="{ active: t === theme }"
          @click="theme = t"
        >{{ t.name }}</button>
      </div>
      <div v-if="!editable" class="seg">
        <button :class="{ active: laserMode === 'dot' }" @click="laserMode = 'dot'">光点</button>
        <button :class="{ active: laserMode === 'trail' }" @click="laserMode = 'trail'">笔迹</button>
      </div>
      <button
        class="toggle"
        :class="{ on: editable }"
        @click="editable = !editable"
      >{{ editable ? '可编辑' : '仅预览' }}</button>
    </div>
    <div
      ref="canvasEl"
      class="canvas"
      :class="{ laser: !editable }"
      :contenteditable="editable"
      :style="{ fontSize: size + 'px' }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @pointerleave="onPointerUp"
    >
      荆霄鹏行楷
      <canvas v-if="laserMode === 'trail' && !editable" ref="trailEl" class="trail" :class="{ fading: trailFading }"></canvas>
    </div>
    <!-- 激光点放 body 层级,fixed 定位避免被画布滚动影响 -->
    <Teleport to="body">
      <div v-if="laser" class="laser-dot" :style="{ left: laser.x + 'px', top: laser.y + 'px' }"></div>
      <div v-if="debug" class="debug-panel">
        <div class="debug-head">
          <span>日志 ({{ debugLogs.length }})</span>
          <button @click="sendLogs">发送</button>
        </div>
        <div class="debug-list">
          <div v-for="(l, i) in debugLogs" :key="i">{{ l }}</div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.page {
  height: 100%;
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  padding: 12px 16px 16px;
  gap: 12px;
  box-sizing: border-box;
  background: var(--bg);
  color: var(--text);
  transition: background 0.2s, color 0.2s;
}
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.size {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 160px;
  max-width: 320px;
  color: var(--muted);
  font-size: 13px;
}
.size input[type='range'] { flex: 1; accent-color: var(--accent); }
.size span { min-width: 44px; text-align: right; font-variant-numeric: tabular-nums; }

.seg {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 999px;
  overflow: hidden;
}
.seg button {
  border: none;
  padding: 6px 14px;
  font-size: 13px;
  color: var(--muted);
  background: transparent;
  cursor: pointer;
  transition: all 0.15s;
}
.seg button + button { border-left: 1px solid var(--border); }
.seg button.active {
  color: var(--bg);
  background: var(--accent);
}

.toggle {
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 6px 16px;
  font-size: 13px;
  color: var(--muted);
  background: var(--canvas);
  cursor: pointer;
  transition: all 0.15s;
}
.toggle.on {
  color: var(--bg);
  background: var(--accent);
  border-color: var(--accent);
}

.canvas {
  flex: 1;
  overflow: auto;
  padding: 24px;
  font-family: '荆霄鹏行楷', KaiTi, serif;
  background: var(--canvas);
  border: 1px solid transparent;
  border-radius: 12px;
  line-height: 1.5;
  word-break: break-all;
  outline: none;
  caret-color: var(--accent);
  transition: background 0.2s;
}
.canvas[contenteditable='true'] { border-color: var(--border); }
.canvas[contenteditable='true']:focus { border-color: var(--accent); }

/* 激光笔模式:画布吃掉所有触控,不滚动不选中 */
.canvas.laser {
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  cursor: none;
}
/* 荧光笔迹层:绝对定位于滚动内容原点,随内容一起滚动 */
.canvas { position: relative; }
.trail {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
}
/* transition 只挂在淡出态:取消淡出时旧迹瞬间恢复,不回放动画 */
.trail.fading {
  opacity: 0;
  transition: opacity 0.8s;
}
.debug-panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 33vw;
  min-width: 260px;
  z-index: 10000;
  display: flex;
  flex-direction: column;
  font-family: monospace;
  font-size: 11px;
  color: #fff;
  background: #000d;
  border-left: 1px solid #fff3;
}
.debug-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 10px;
  border-bottom: 1px solid #fff3;
}
.debug-head button {
  font-size: 12px;
  padding: 2px 12px;
  border: none;
  border-radius: 6px;
  background: #4263eb;
  color: #fff;
}
.debug-list {
  flex: 1;
  overflow: auto;
  padding: 6px 10px;
  line-height: 1.6;
  word-break: break-all;
}
.laser-dot {
  position: fixed;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 8px 3px #ff3b30cc, 0 0 18px 6px #ff3b3066;
  transform: translate(-50%, -50%);
  pointer-events: none;
  z-index: 9999;
}
</style>
